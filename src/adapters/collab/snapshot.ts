import * as Y from "yjs";
import { CollabDocumentState, collabState } from "./state.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { countSharedRead } from "./read-counts.ts";

export function withSharedSnapshot<T>(handle: SharedDocumentHandle, read: (copy: CollabDocumentState) => T): T {
  const copy = new CollabDocumentState();
  countSharedRead("snapshots");
  try {
    // why: Public wire decoding normalizes malformed strings and colliding map keys exactly as a late join does.
    Y.applyUpdate(copy.doc, Y.encodeStateAsUpdate(collabState(handle).doc));
    return read(copy);
  } finally { copy.doc.destroy(); }
}

export function sharedJson(raw: unknown): unknown {
  if (raw === null || typeof raw === "boolean" || typeof raw === "string") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (Array.isArray(raw)) {
    const values: unknown[] = [];
    for (let index = 0; index < raw.length; index++) {
      const value = sharedJson(raw[index]);
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  }
  if (!raw || typeof raw !== "object" || Object.getPrototypeOf(raw) !== Object.prototype) return undefined;
  const fields: [string, unknown][] = [];
  for (const key of Object.keys(raw).sort()) {
    const value = sharedJson((raw as Record<string, unknown>)[key]);
    if (value === undefined) return undefined;
    fields.push([key, value]);
  }
  return Object.fromEntries(fields);
}
