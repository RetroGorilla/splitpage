import * as Y from "yjs";
import { createEncoder, toUint8Array, writeAny } from "lib0/encoding";
import { createDecoder, readAny } from "lib0/decoding";
import { sharedJson } from "./snapshot.ts";

export function freezeSharedPreparedValue<T>(value: T): T {
  if (value && (typeof value === "object" || typeof value === "function")) {
    for (const nested of Object.values(value)) freezeSharedPreparedValue(nested);
    Object.freeze(value);
  }
  return value;
}

export function sharedPreparedValue(raw: unknown): unknown {
  try {
    if (raw instanceof Y.AbstractType || raw instanceof Y.Doc) return undefined;
    const encoder = createEncoder(); writeAny(encoder, raw as Parameters<typeof writeAny>[1]);
    return freezeSharedPreparedValue(sharedJson(readAny(createDecoder(toUint8Array(encoder)))));
  } catch { return undefined; }
}

export function sharedPreparedTextInsert(raw: unknown): unknown {
  // why: V1 text embeds drop undefined fields through JSON; read that same form on live copies before normalization.
  try { return sharedPreparedValue(typeof raw === "string" ? raw : JSON.parse(JSON.stringify(raw)) as unknown); }
  catch { return undefined; }
}
