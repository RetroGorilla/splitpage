"use strict";

import type * as NodeCrypto from "node:crypto";
import type { Event, RenderProcessGoneDetails } from "electron";
import type { readNativeMembership as ReadNativeMembership } from "../shared/native-membership.ts";
import type { NativeMembershipRecord, NativeReplicaReply, NativeReplicaRequest } from "../shared/native-replica.d.ts";
import type { createNativeReplicaFiles, NativeReplicaFileSystem } from "./native-replica-files.ts";

const { randomBytes }: typeof NodeCrypto = require("node:crypto");
const filesModule: {
  createNativeReplicaFiles: typeof createNativeReplicaFiles;
  MAX_REPLICA_UPDATE_BYTES: number;
  MAX_REPLICA_JOURNAL_BYTES: number;
} = require("./native-replica-files.ts");

const SCRIPT_ID = /^[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_-]{1,64})?(?![\s\S])/;
const LEASE_ID = /^[a-f0-9]{32}(?![\s\S])/;
const LOCKED = { kind: "failed", reason: "locked" } as const;
const CLOSED = { kind: "failed", reason: "closed" } as const;
const STORED = { kind: "stored" } as const;
const MEMBERSHIP_PREFIX = "\0";

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
  forgotten?: boolean;
  managing?: boolean;
  close?: Promise<void>;
  detach?: () => void;
}

function generation(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isPayload(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength > 0 && value.buffer instanceof ArrayBuffer;
}

function isRequest(value: unknown, readNativeMembership: typeof ReadNativeMembership): value is NativeReplicaRequest {
  if (!Array.isArray(value)) return false;
  const [op, name, lease, through, checkpoint, bytes, journal]: unknown[] = value;
  if (typeof name !== "string" || !SCRIPT_ID.test(name)) return false;
  if (op === "open" || op === "delete") return value.length === 2;
  if (typeof lease !== "string" || !LEASE_ID.test(lease)) return false;
  if (op === "join") return value.length === 4 && readNativeMembership(through) !== null;
  if (op === "membership" || op === "forget" || op === "close" || op === "read-journal") return value.length === 3;
  if (op === "write-journal") return value.length === 4 && isPayload(through);
  if (op === "read") return value.length === 4 && (through === null || generation(through, 0));
  return op === "write" && (value.length === 6 || value.length === 7) && generation(through, 1)
    && typeof checkpoint === "boolean" && isPayload(bytes) && (value.length === 6 || isPayload(journal));
}

function failure(error: unknown): NativeReplicaReply {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return { kind: "failed", reason: code === "ENOSPC" || code === "EDQUOT" ? "quota" : "io" };
}

interface CredentialCipher {
  readonly encrypt: (token: string) => Buffer;
  readonly decrypt: (bytes: Buffer) => string;
}

function createNativeReplicaIpc(userData: string, readNativeMembership: typeof ReadNativeMembership,
  disk?: NativeReplicaFileSystem, cipher?: CredentialCipher) {
  const files = filesModule.createNativeReplicaFiles(userData, disk);
  const leases = new Map<string, Lease | null>();

  function decodeMembership(value: string) {
    return readNativeMembership(value.startsWith(MEMBERSHIP_PREFIX) ? JSON.parse(value.slice(1)) : value);
  }

  function release(name: string, lease: Lease): Promise<void> {
    lease.close ??= lease.done.then(() => {
      lease.detach?.();
      leases.delete(name);
    });
    return lease.close;
  }

  async function open(name: string, owner: Renderer): Promise<NativeReplicaReply> {
    if (leases.has(name)) return LOCKED;
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

  function enqueue<T>(lease: Lease, work: (replica: Replica) => Promise<T>): Promise<T> {
    const operation = lease.done.then(() => lease.replica).then(work);
    lease.done = operation.catch(() => {});
    return operation;
  }

  async function manageMembership(lease: Lease,
    manage: (record: NativeMembershipRecord) => Promise<NativeMembershipRecord>): Promise<NativeReplicaReply> {
    if (!cipher) return CLOSED;
    if (lease.managing) return LOCKED;
    lease.managing = true;
    try {
      const before = await enqueue(lease, replica => lease.forgotten ? Promise.resolve(null) : replica.readMembership());
      if (!before || lease.close) return CLOSED;
      const record = decodeMembership(cipher.decrypt(before));
      if (!record) return CLOSED;
      const updated = await manage(record);
      if (lease.close) return CLOSED;
      return await enqueue(lease, async replica => {
        if (lease.forgotten || lease.close) return CLOSED;
        const current = await replica.readMembership();
        if (lease.close || !current?.equals(before)) return CLOSED;
        if (updated !== record) await replica.writeMembership(cipher.encrypt(MEMBERSHIP_PREFIX + JSON.stringify(updated)));
        return { kind: "membership", record: updated };
      });
    } catch (error) { return failure(error); }
    finally { lease.managing = false; }
  }

  async function handle(owner: Renderer, request: unknown,
    manage?: (record: NativeMembershipRecord) => Promise<NativeMembershipRecord>): Promise<NativeReplicaReply> {
    if (!isRequest(request, readNativeMembership)) throw new TypeError("Invalid native replica request");
    if (request[0] === "write") {
      if (request[5].buffer.byteLength > filesModule.MAX_REPLICA_UPDATE_BYTES) {
        if (request[4]) return { kind: "failed", reason: "quota" };
        throw new TypeError("Invalid native replica request");
      }
      if (request.length === 7) {
        if (request[6].byteLength > filesModule.MAX_REPLICA_JOURNAL_BYTES) return { kind: "failed", reason: "quota" };
        if (request[6].buffer.byteLength > filesModule.MAX_REPLICA_JOURNAL_BYTES) throw new TypeError("Invalid native replica request");
      }
    }
    if (request[0] === "write-journal") {
      if (request[3].byteLength > filesModule.MAX_REPLICA_JOURNAL_BYTES) return { kind: "failed", reason: "quota" };
      if (request[3].buffer.byteLength > filesModule.MAX_REPLICA_JOURNAL_BYTES) throw new TypeError("Invalid native replica request");
    }
    const [op, name, id] = request;
    if (op === "open") return open(name, owner);
    if (op === "delete") {
      if (leases.has(name)) return LOCKED;
      if (owner.isDestroyed()) return CLOSED;
      leases.set(name, null);
      try { await files.remove(name); return STORED; }
      catch (error) { return failure(error); }
      finally { leases.delete(name); }
    }
    const lease = leases.get(name);
    if (!lease || lease.close || lease.owner !== owner || lease.id !== id) return CLOSED;
    if (op === "close") { await release(name, lease); return STORED; }
    if (op === "membership" && manage) return manageMembership(lease, manage);
    return enqueue(lease, async (replica): Promise<NativeReplicaReply> => {
      if (request[0] === "read") return { kind: "read", entries: replica.read(request[3]) };
      if (lease.forgotten) return CLOSED;
      if (request[0] === "read-journal") return { kind: "journal", bytes: replica.readJournal() };
      if (request[0] === "write-journal") {
        await replica.writeJournal(request[3]);
        return STORED;
      }
      if (request[0] === "forget") {
        await files.remove(name);
        lease.forgotten = true;
        return STORED;
      }
      if (request[0] === "membership") {
        const bytes = await replica.readMembership();
        if (bytes && !cipher) return { kind: "failed", reason: "io" };
        return { kind: "membership", record: bytes && cipher ? decodeMembership(cipher.decrypt(bytes)) : null };
      }
      if (request[0] === "join") {
        if (!cipher) return { kind: "failed", reason: "io" };
        await replica.writeMembership(cipher.encrypt(MEMBERSHIP_PREFIX + JSON.stringify(readNativeMembership(request[3]))));
        return STORED;
      }
      if (request[0] !== "write") return CLOSED;
      const [, , , generation, checkpoint, bytes, journal] = request;
      await replica.write({ generation, checkpoint, bytes, ...(journal && { journal }) });
      return STORED;
    }).catch(failure);
  }

  return handle;
}

export type { createNativeReplicaIpc };
module.exports = { createNativeReplicaIpc };
