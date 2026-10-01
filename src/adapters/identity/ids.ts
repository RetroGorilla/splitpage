import type { Clock, IdSource } from "../../core/document/ports.ts";

interface LegacyCryptoWindow {
  msCrypto?: Crypto;
}

export function makeId(prefix?: string): string {
  return (prefix || "r") + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export function randomHexBytes(n: number): string {
  const bytes = new Uint8Array(n);
  const c: Crypto | undefined = window.crypto || (window as Window & LegacyCryptoWindow).msCrypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = "";
  for (const byte of bytes) hex += (byte < 16 ? "0" : "") + byte.toString(16);
  return hex;
}

export function mintDocId(): string {
  return "d" + randomHexBytes(16);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export const randomIds: IdSource = { id: makeId, docId: mintDocId };

export const systemClock: Clock = { nowIso: nowIso };
