"use strict";

import type * as NodeCrypto from "node:crypto";
import type { Event, RenderProcessGoneDetails } from "electron";
import type { NativeReplicaReply, NativeReplicaRequest } from "../shared/native-replica.d.ts";
import type { createNativeReplicaFiles, NativeReplicaFileSystem } from "./native-replica-files.ts";

const { randomBytes }: typeof NodeCrypto = require("node:crypto");
const filesModule: { createNativeReplicaFiles: typeof createNativeReplicaFiles; MAX_REPLICA_UPDATE_BYTES: number } =
  require("./native-replica-files.ts");

const SCRIPT_ID = /^[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_-]{1,64})?(?![\s\S])/;
const LEASE_ID = /^[a-f0-9]{32}(?![\s\S])/;
const BLOCKED = { kind: "failed", reason: "blocked" } as const;
const CLOSED = { kind: "failed", reason: "closed" } as const;
const STORED = { kind: "stored" } as const;

type RendererEndListener = {
  (event: "destroyed", listener: () => void): unknown;
  (event: "render-process-gone", listener: (event: Event, details: RenderProcessGoneDetails) => void): unknown;
};
interface Renderer {
  readonly once: RendererEndListener;
  readonly removeListener: RendererEndListener;
  readonly isDestroyed: () => boolean;
}
type Replica = Awaited<ReturnType<ReturnType<typeof createNativeReplicaFiles>["open"]>>;

interface Lease {
  readonly owner: Renderer;
  readonly id: string;
  readonly replica: Promise<Replica>;
  done: Promise<unknown>;
  close?: Promise<void>;
  detach?: () => void;
}

function generation(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isRequest(value: unknown): value is NativeReplicaRequest {
  if (!Array.isArray(value)) return false;
  const [op, name, lease, through, checkpoint, bytes]: unknown[] = value;
  if (typeof name !== "string" || !SCRIPT_ID.test(name)) return false;
  if (op === "open" || op === "delete") return value.length === 2;
  if (typeof lease !== "string" || !LEASE_ID.test(lease)) return false;
  if (op === "close") return value.length === 3;
  if (op === "read") return value.length === 4 && (through === null || generation(through, 0));
  return op === "write" && value.length === 6 && generation(through, 1) && typeof checkpoint === "boolean"
    && bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.buffer instanceof ArrayBuffer;
}

function failure(error: unknown): NativeReplicaReply {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return { kind: "failed", reason: code === "ENOSPC" || code === "EDQUOT" ? "quota" : "io" };
}

function createNativeReplicaIpc(userData: string, disk?: NativeReplicaFileSystem) {
  const files = filesModule.createNativeReplicaFiles(userData, disk);
  const leases = new Map<string, Lease | null>();

  function release(name: string, lease: Lease): Promise<void> {
    lease.close ??= lease.done.then(() => {
      lease.detach?.();
      leases.delete(name);
    });
    return lease.close;
  }

  async function open(name: string, owner: Renderer): Promise<NativeReplicaReply> {
    if (leases.has(name)) return BLOCKED;
    if (owner.isDestroyed()) return CLOSED;
    const id = randomBytes(16).toString("hex");
    const replica = files.open(name);
    const lease: Lease = { owner, id, replica, done: replica.catch(() => {}) };
    leases.set(name, lease);
    const disconnect = () => { void release(name, lease); };
    owner.once("destroyed", disconnect);
    owner.once("render-process-gone", disconnect);
    lease.detach = () => {
      owner.removeListener("destroyed", disconnect);
      owner.removeListener("render-process-gone", disconnect);
    };
    try {
      await replica;
      return lease.close ? CLOSED : { kind: "opened", lease: id };
    } catch (error) {
      await release(name, lease);
      return failure(error);
    }
  }

  async function handle(owner: Renderer, request: unknown): Promise<NativeReplicaReply> {
    if (!isRequest(request)) throw new TypeError("Invalid native replica request");
    if (request[0] === "write" && request[5].buffer.byteLength > filesModule.MAX_REPLICA_UPDATE_BYTES) {
      if (request[4]) return { kind: "failed", reason: "quota" };
      throw new TypeError("Invalid native replica request");
    }
    const [op, name, id] = request;
    if (op === "open") return open(name, owner);
    if (op === "delete") {
      if (leases.has(name)) return BLOCKED;
      if (owner.isDestroyed()) return CLOSED;
      leases.set(name, null);
      try { await files.remove(name); return STORED; }
      catch (error) { return failure(error); }
      finally { leases.delete(name); }
    }
    const lease = leases.get(name);
    if (!lease || lease.close || lease.owner !== owner || lease.id !== id) return CLOSED;
    if (op === "close") { await release(name, lease); return STORED; }
    const operation = lease.done.then(async (): Promise<NativeReplicaReply> => {
      const replica = await lease.replica;
      if (request[0] === "read") return { kind: "read", entries: replica.read(request[3]) };
      if (request[0] !== "write") return CLOSED;
      const [, , , generation, checkpoint, bytes] = request;
      await replica.write({ generation, checkpoint, bytes });
      return STORED;
    }).catch(failure);
    lease.done = operation;
    return operation;
  }

  return handle;
}

export type { createNativeReplicaIpc };
module.exports = { createNativeReplicaIpc };
