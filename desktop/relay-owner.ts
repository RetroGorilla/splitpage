"use strict";

import type { NativeMembershipRecord } from "../shared/native-replica.d.ts";
import type * as NodeFs from "node:fs";
import type * as NodePath from "node:path";
import type * as NodeChildProcess from "node:child_process";
import type * as NodeCrypto from "node:crypto";
import type { RelayConnectionCheck, RelaySetupSave, ShareScriptCreation } from "../shared/desktop-contract.d.ts";

const { execFile }: typeof NodeChildProcess = require("node:child_process");
const fs: typeof NodeFs = require("node:fs");
const { join }: typeof NodePath = require("node:path");
const { createHash, randomUUID }: typeof NodeCrypto = require("node:crypto");
const ID = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;
const HASH = /^[a-f0-9]{64}(?![\s\S])/;
const REPLICA = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}(?![\s\S])/;
const TOKEN = /^[A-Za-z0-9_-]{43}(?![\s\S])/;
const MAX_SNAPSHOT_BYTES = 15_000_000;

type PendingShare = { creationId: string; contentHash: string; relay: string; replica?: string };
type ShareJournal = { pending: PendingShare[]; abandon: Record<string, string[]> };

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeCreation(data: unknown, address: string, deployment: string | null): ShareScriptCreation {
  if (!data || typeof data !== "object" || !deployment || !ID.test(deployment)) return { kind: "failed" };
  const { scriptId, owner, guest } = data as { scriptId?: string; owner?: { token?: string }; guest?: { token?: string } };
  if (typeof scriptId !== "string" || !ID.test(scriptId)) return { kind: "failed" };
  if (owner === undefined && guest === undefined) return { kind: "already-used" };
  if (typeof owner?.token !== "string" || !TOKEN.test(owner.token) ||
      typeof guest?.token !== "string" || !TOKEN.test(guest.token)) return { kind: "failed" };
  return { kind: "created", address, deployment, scriptId, owner: owner.token, guest: guest.token };
}

async function invitationToken(response: Response): Promise<string> {
  const data = await response.json() as { token?: unknown } | null;
  if (typeof data?.token !== "string" || !TOKEN.test(data.token)) throw new Error("Invalid relay invitation.");
  return data.token;
}

function relayOrigin(address: string, testBuild: boolean): string | null {
  if (address.length > 2048 || !/^https?:\/\/[^/?#\\]+\/?$/i.test(address) || address.includes("@")) return null;
  try {
    const url = new URL(address);
    if (url.protocol === "https:") return url.origin;
    if (testBuild && /^http:\/\/127\.0\.0\.1:[0-9]+\/?$/i.test(address)) {
      return url.port ? url.origin : url.origin + ":80";
    }
    return null;
  } catch {
    return null;
  }
}

function validSecret(secret: string): boolean {
  return /^[\x20-\x7e]{1,4096}$/.test(secret) && secret.trim() === secret;
}

function windowsReplicaCipher(decryptLegacy: (bytes: Buffer) => string) {
  if (process.platform !== "win32") return undefined;
  const prefix = Buffer.from("DPAPI\0");
  const system = process.env.SystemRoot || process.env.windir;
  const powershell = system && join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

  // why: a fresh Electron profile can lose its pending key-store preferences if it stops before Chromium writes them
  function protect(operation: "Protect" | "Unprotect", bytes: Buffer): Promise<Buffer> {
    if (!powershell) return Promise.reject(new Error("The Windows credential store is unavailable."));
    const command = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
      "$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); " +
      `$result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,'CurrentUser'); ` +
      "[Console]::Out.Write([Convert]::ToBase64String($result))";
    return new Promise((resolve, reject) => {
      const child = execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true, timeout: 10_000, maxBuffer: 64_000 }, (error, stdout) => {
          const encoded = stdout.trim();
          if (error || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) reject(new Error("Could not use the Windows credential store."));
          else resolve(Buffer.from(encoded, "base64"));
        });
      child.stdin?.on("error", () => {});
      child.stdin?.end(bytes.toString("base64"));
    });
  }

  return {
    async encrypt(value: string) { return Buffer.concat([prefix, await protect("Protect", Buffer.from(value, "utf8"))]); },
    async decrypt(bytes: Buffer) {
      if (!bytes.subarray(0, prefix.length).equals(prefix)) return decryptLegacy(bytes);
      return (await protect("Unprotect", bytes.subarray(prefix.length))).toString("utf8");
    }
  };
}

function createRelayOwner(userData: string, keyStore: {
  encryptString: (text: string) => Buffer;
  decryptString: (data: Buffer) => string;
  isEncryptionAvailable: () => boolean;
  getSelectedStorageBackend?: () => string;
}, request: typeof fetch = fetch, testBuild = false) {
  const file = join(userData, "relay-owner.enc");
  const pending = file + ".new";

  function keyStoreAvailable(): boolean {
    return keyStore.isEncryptionAvailable() && keyStore.getSelectedStorageBackend?.() !== "basic_text";
  }

  function read() {
    try {
      const bytes = fs.readFileSync(file);
      if (!keyStoreAvailable()) return null;
      const record = JSON.parse(keyStore.decryptString(bytes)) as { address?: unknown; secret?: unknown } | null;
      if (typeof record?.address !== "string" || typeof record.secret !== "string") return null;
      if (relayOrigin(record.address, testBuild) !== record.address || !validSecret(record.secret)) return null;
      return { address: record.address, secret: record.secret };
    } catch {
      return null;
    }
  }

  function save(address: string, secret: string): RelaySetupSave {
    const origin = relayOrigin(address.trim(), testBuild);
    if (!origin) return "invalid-address";
    if (!validSecret(secret)) return "invalid-secret";
    try {
      if (!keyStoreAvailable()) return "key-store-unavailable";
      const encrypted = keyStore.encryptString(JSON.stringify({ address: origin, secret }));
      fs.writeFileSync(pending, encrypted, { mode: 0o600, flush: true });
      fs.renameSync(pending, file);
      return "saved";
    } catch {
      try { fs.rmSync(pending, { force: true }); } catch { }
      return "save-failed";
    }
  }

  function clear(): boolean {
    try {
      fs.rmSync(pending, { force: true });
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async function ownerRequest(pathname: string, options: {
    method: string; body?: BodyInit; headers?: Record<string, string>; timeout?: number; address?: string
  }) {
    const record = read();
    if (!record || (options.address && record.address !== options.address)) return { kind: "not-configured" as const };
    try {
      const url = new URL(pathname, record.address);
      if (url.origin !== new URL(record.address).origin || !url.pathname.startsWith("/api/") || url.username || url.password || url.hash) {
        return { kind: "unreachable" as const };
      }
      const headers = new Headers(options.headers);
      headers.set("Authorization", "Bearer " + record.secret);
      const response = await request(url, {
        method: options.method, body: options.body ?? null, headers,
        credentials: "omit", redirect: "error", signal: AbortSignal.timeout(options.timeout ?? 5000)
      });
      return { kind: "response" as const, response };
    } catch {
      return { kind: "unreachable" as const };
    }
  }

  async function testConnection(): Promise<RelayConnectionCheck> {
    const result = await ownerRequest("/api/status", { method: "GET" });
    if (result.kind !== "response") return result.kind;
    const { response } = result;
    try { await response.body?.cancel(); } catch { }
    if (response.status === 401) return "wrong-secret";
    return response.ok ? "connected" : "unreachable";
  }

  async function manageSharing(operation: string, name: string, address: string, membership: NativeMembershipRecord) {
    const origin = relayOrigin(address, testBuild);
    const [deployment, script] = name.split("/");
    if (!origin || !script || !ID.test(script)) throw new Error("Invalid shared script relay.");
    const path = `/api/scripts/${script}`;
    const send = (method: string, suffix: string, token: string) => request(new URL(path + suffix, origin), {
      method, headers: { Authorization: "Bearer " + token }, credentials: "omit", redirect: "error",
      signal: AbortSignal.timeout(5000)
    });
    if (operation === "promote" && membership.role === "guest") {
      if (read()?.address !== origin) throw new Error("No management credential for this relay.");
      const access = await send("HEAD", "/link", membership.token);
      if (!access.ok || access.headers.get("Splitpage-Deployment") !== deployment) {
        throw new Error("The guest invitation is no longer active for this relay.");
      }
      const result = await ownerRequest(path + "/invitations", {
        address: origin, method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "owner", label: "Splitpage desktop" })
      });
      if (result.kind !== "response" || result.response.status !== 201) throw new Error("Could not issue owner invitation.");
      return { ...membership, role: "owner" as const, token: await invitationToken(result.response) };
    }
    if (membership.role !== "owner") throw new Error("Owner membership required.");
    if (operation === "reset") {
      const response = await send("POST", "/reset", membership.token);
      if (!response.ok) throw new Error("Could not reset guest invitation.");
      return { ...membership, guestLinkToken: await invitationToken(response) };
    }
    if (operation === "stop") {
      if ((await send("DELETE", "", membership.token)).status !== 204) throw new Error("Could not delete shared script.");
      return membership;
    }
    if (operation === "check-link") {
      if (!membership.guestLinkToken) return membership;
      const response = await send("HEAD", "/link", membership.guestLinkToken);
      if (response.headers.get("Splitpage-Deployment") === deployment && response.status === 403) {
        return { role: membership.role, token: membership.token };
      }
      if (!response.ok) throw new Error("Could not check guest invitation.");
      return membership;
    }
    throw new Error("Invalid sharing operation.");
  }

  return { manageSharing, save, clear, status: () => ({ address: read()?.address ?? null }), testConnection, ownerRequest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isShareJournal(value: unknown): value is ShareJournal {
  return isRecord(value) && Array.isArray(value.pending) && isRecord(value.abandon)
    && value.pending.every((entry: unknown) => isRecord(entry)
      && typeof entry.creationId === "string" && ID.test(entry.creationId)
      && typeof entry.contentHash === "string" && HASH.test(entry.contentHash)
      && typeof entry.relay === "string" && HASH.test(entry.relay)
      && (entry.replica === undefined || (typeof entry.replica === "string" && REPLICA.test(entry.replica))))
    && Object.entries(value.abandon).every(([relay, ids]) => HASH.test(relay) && Array.isArray(ids)
      && ids.every((id: unknown) => typeof id === "string" && ID.test(id)));
}

function createShareCreations(userData: string, owner: ReturnType<typeof createRelayOwner>, eraseReplica: (name: string) => Promise<void>) {
  const file = join(userData, "relay-owner-shares.json");
  const tabs = new Map<string, string>();
  let tail = Promise.resolve<unknown>(undefined);
  function ordered<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run);
    tail = result.catch(() => {});
    return result;
  }

  function readJournal(): ShareJournal {
    let json: string;
    try { json = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { pending: [], abandon: {} };
    }
    let journal: unknown;
    try { journal = JSON.parse(json); } catch { }
    if (isShareJournal(journal)) return journal;
    fs.renameSync(file, file + ".corrupt-" + randomUUID());
    return { pending: [], abandon: {} };
  }

  function writeJournal(journal: ShareJournal): void {
    const temporary = file + ".new";
    fs.writeFileSync(temporary, JSON.stringify(journal), { mode: 0o600, flush: true });
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") {
      const directory = fs.openSync(userData, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  }

  function queueAbandon(journal: ShareJournal, pending: PendingShare): void {
    journal.pending = journal.pending.filter(entry => entry !== pending);
    const ids = journal.abandon[pending.relay] ??= [];
    if (!ids.includes(pending.creationId)) ids.push(pending.creationId);
    writeJournal(journal);
  }

  async function sendAbandon(journal: ShareJournal, relay: string, id: string): Promise<boolean> {
    const address = owner.status().address;
    if (!address || sha256(address) !== relay || !ID.test(id)) return false;
    const result = await owner.ownerRequest("/api/creations/" + id, { method: "DELETE", address });
    if (result.kind !== "response") return false;
    await result.response.body?.cancel().catch(() => {});
    if (![204, 404, 409].includes(result.response.status)) return false;
    const remaining = (journal.abandon[relay] ?? []).filter(value => value !== id);
    if (remaining.length) journal.abandon[relay] = remaining;
    else Reflect.deleteProperty(journal.abandon, relay);
    writeJournal(journal);
    return true;
  }

  async function create(tab: string, creationId: string, contentHash: string, bytes: Uint8Array, expectedAddress: string): Promise<ShareScriptCreation> {
    return ordered(async (): Promise<ShareScriptCreation> => {
      if (!ID.test(creationId) || !HASH.test(contentHash) || !(bytes instanceof Uint8Array) ||
          !(bytes.buffer instanceof ArrayBuffer) || !bytes.byteLength) return { kind: "failed" };
      if (bytes.byteLength > MAX_SNAPSHOT_BYTES || bytes.buffer.byteLength > MAX_SNAPSHOT_BYTES) return { kind: "too-large" };
      if (sha256(bytes) !== contentHash) return { kind: "failed" };
      const address = owner.status().address;
      if (!address || address !== expectedAddress) return { kind: "not-configured" };
      const relay = sha256(address);
      const journal = readJournal();
      let entry = journal.pending.find(value => value.creationId === creationId);
      if (entry) {
        if (tabs.get(creationId) !== tab || entry.contentHash !== contentHash || entry.relay !== relay) return { kind: "failed" };
      } else {
        if (Object.values(journal.abandon).some(ids => ids.includes(creationId))) return { kind: "failed" };
        entry = { creationId, contentHash, relay };
        journal.pending.push(entry);
        writeJournal(journal);
        tabs.set(creationId, tab);
      }
      const result = await owner.ownerRequest("/api/scripts", {
        method: "POST", address, body: Buffer.from(bytes), timeout: 30_000,
        headers: { "Content-Type": "application/octet-stream", "Idempotency-Key": creationId, "Splitpage-Content-SHA256": contentHash }
      });
      if (result.kind !== "response") return { kind: result.kind };
      const { response } = result;
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { kind: response.status === 413 ? "too-large" : "failed" };
      }
      let created: ShareScriptCreation;
      try { created = decodeCreation(await response.json(), address, response.headers.get("Splitpage-Deployment")); }
      catch { return { kind: "unreachable" }; }
      if (created.kind === "created") {
        entry.replica = created.deployment + "/" + created.scriptId;
        writeJournal(journal);
      }
      return created;
    }).catch(() => ({ kind: "failed" }));
  }

  function abandon(tab: string, creationId: string): Promise<boolean> {
    return ordered(async () => {
      const journal = readJournal();
      const entry = journal.pending.find(value => value.creationId === creationId);
      if (!entry) return true;
      if (tabs.get(creationId) !== tab) return false;
      if (entry.replica) await eraseReplica(entry.replica);
      queueAbandon(journal, entry);
      tabs.delete(creationId);
      await sendAbandon(journal, entry.relay, creationId);
      return true;
    }).catch(() => false);
  }

  function complete(tab: string, creationId: string): Promise<boolean> {
    return ordered(async () => {
      if (tabs.get(creationId) !== tab) return false;
      const journal = readJournal();
      const entry = journal.pending.find(value => value.creationId === creationId);
      if (!entry?.replica) return false;
      journal.pending = journal.pending.filter(value => value !== entry);
      writeJournal(journal);
      tabs.delete(creationId);
      return true;
    }).catch(() => false);
  }

  function recover(): Promise<void> {
    return ordered(async () => {
      const journal = readJournal();
      for (const entry of journal.pending) {
        if (tabs.has(entry.creationId)) continue;
        try { if (entry.replica) await eraseReplica(entry.replica); }
        catch { continue; }
        queueAbandon(journal, entry);
      }
    });
  }

  function retryAbandons(): Promise<void> {
    return ordered(async () => {
      const address = owner.status().address;
      if (!address) return;
      const relay = sha256(address);
      const journal = readJournal();
      for (const id of journal.abandon[relay] ?? []) {
        if (!await sendAbandon(journal, relay, id)) break;
      }
    }).catch(() => {});
  }
  return { create, abandon, complete, recover, retryAbandons };
}

export type { createRelayOwner, createShareCreations, windowsReplicaCipher };
module.exports = { createRelayOwner, createShareCreations, windowsReplicaCipher };
