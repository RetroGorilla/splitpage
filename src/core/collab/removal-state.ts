import { readSharedContentRef } from "./read-operation.ts";

export interface SharedBufferRecoveryMetadata {
  readonly bufferSourceOwner: string;
  readonly bufferPaintedBase: number;
}

function record(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

function identity(raw: unknown): string | null {
  const value = readSharedContentRef(raw);
  return value && !value.includes("\ufffd") ? value : null;
}

export function readSharedBufferRecoveryMetadata(raw: unknown): SharedBufferRecoveryMetadata | null {
  const value = record(raw);
  if (!value) return null;
  const owner = identity(value.bufferSourceOwner), base = value.bufferPaintedBase;
  return owner && typeof base === "number" && Number.isSafeInteger(base) && base >= 0
    ? { bufferSourceOwner: owner, bufferPaintedBase: base } : null;
}

export function projectSharedRemovalState(entries: readonly unknown[]) {
  let generation: number | null = null, active = false, cancelled = false;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!Array.isArray(entry) || entry.length !== 2 || !identity(entry[0])) continue;
    const value = entry[1], flag = record(value), next = value === true ? 0 : flag?.generation;
    const removed = value === true ? true : flag?.removed;
    if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 0 || typeof removed !== "boolean") continue;
    if (generation === null || next > generation) { generation = next; active = false; cancelled = false; }
    if (next === generation) { active ||= removed; cancelled ||= !removed; }
  }
  return { generation, removed: active && !cancelled };
}
