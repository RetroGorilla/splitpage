"use strict";

import type * as NodeFs from "node:fs";
import type * as NodePath from "node:path";
import type { RelayConnectionCheck, RelaySetupSave } from "../shared/desktop-contract.d.ts";

const fs: typeof NodeFs = require("node:fs");
const { join }: typeof NodePath = require("node:path");

function relayOrigin(address: string): string | null {
  if (address.length > 2048 || !/^https?:\/\/[^/?#\\]+\/?$/i.test(address) || address.includes("@")) return null;
  try {
    const url = new URL(address);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.protocol === "https:" || loopback ? url.origin : null;
  } catch {
    return null;
  }
}

function validSecret(secret: string): boolean {
  return /^[\x20-\x7e]{1,4096}$/.test(secret) && secret.trim() === secret;
}

function createRelayOwner(userData: string, keyStore: {
  encryptString: (text: string) => Buffer;
  decryptString: (data: Buffer) => string;
  isEncryptionAvailable: () => boolean;
  getSelectedStorageBackend?: () => string;
}, request: typeof fetch = fetch) {
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
      if (relayOrigin(record.address) !== record.address || !validSecret(record.secret)) return null;
      return { address: record.address, secret: record.secret };
    } catch {
      return null;
    }
  }

  function save(address: string, secret: string): RelaySetupSave {
    const origin = relayOrigin(address.trim());
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

  async function ownerRequest(pathname: string, options: { method: string; body?: BodyInit; contentType?: string }) {
    const record = read();
    if (!record) return { kind: "not-configured" as const };
    try {
      const url = new URL(pathname, record.address);
      if (url.origin !== record.address || !url.pathname.startsWith("/api/") || url.username || url.password || url.hash) {
        return { kind: "unreachable" as const };
      }
      const headers = new Headers({ Authorization: "Bearer " + record.secret });
      if (options.contentType) headers.set("Content-Type", options.contentType);
      const response = await request(url, {
        method: options.method, body: options.body ?? null, headers,
        credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5000)
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

  return { save, clear, status: () => ({ address: read()?.address ?? null }), testConnection, ownerRequest };
}

export type { createRelayOwner };
module.exports = { createRelayOwner };
