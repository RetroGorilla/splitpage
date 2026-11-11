import * as Y from "yjs";
import { createEncoder, toUint8Array, writeAny } from "lib0/encoding";
import { createDecoder, readAny } from "lib0/decoding";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, SharedExecutionWriteError } from "./state.ts";
import { sharedJson } from "./snapshot.ts";

export type SharedPreparedWrite = {
  readonly path: readonly string[];
  readonly kind: "set" | "delete" | "map" | "text" | "array";
  readonly value?: unknown;
};
export interface SharedPreparationView {
  readonly writer: string;
  readonly get: (path: readonly string[]) => unknown;
  readonly kind: (path: readonly string[]) => "map" | "text" | "array" | "value" | "missing";
  readonly keys: (path: readonly string[]) => readonly string[];
}
export type SharedPreparationResult = { readonly ok: false; readonly reason: string } | {
  readonly ok: true; readonly writes: readonly SharedPreparedWrite[]; readonly apply: (handle: SharedDocumentHandle) => void;
};

function freeze(value: unknown): unknown {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
function wireValue(raw: unknown): unknown {
  try {
    if (raw instanceof Y.AbstractType || raw instanceof Y.Doc) return undefined;
    const encoder = createEncoder(); writeAny(encoder, raw as Parameters<typeof writeAny>[1]);
    return freeze(sharedJson(readAny(createDecoder(toUint8Array(encoder)))));
  } catch { return undefined; }
}
function liveValue(handle: SharedDocumentHandle, path: readonly string[]): unknown {
  const roots = collabState(handle).roots;
  let value: unknown = roots[path[0] as keyof typeof roots];
  for (const key of path.slice(1)) value = value instanceof Y.Map ? value.get(key) : undefined;
  return value;
}

export function createSharedPreparation(handle: SharedDocumentHandle) {
  const overlay = new Map<string, SharedPreparedWrite>();
  const lookup = (path: readonly string[]): { kind: ReturnType<SharedPreparationView["kind"]>; value: unknown } => {
    const exact = overlay.get(JSON.stringify(path));
    if (exact) return { kind: exact.kind === "delete" ? "missing" : exact.kind === "set" ? "value" : exact.kind, value: exact.value };
    for (let length = path.length - 1; length > 0; length--) {
      if (overlay.has(JSON.stringify(path.slice(0, length)))) return { kind: "missing", value: undefined };
    }
    const value = liveValue(handle, path);
    return { kind: value instanceof Y.Map ? "map" : value instanceof Y.Text ? "text" : value instanceof Y.Array ? "array" : value === undefined ? "missing" : "value", value };
  };
  const view: SharedPreparationView = Object.freeze({
    writer: String(collabState(handle).doc.clientID),
    get: (path: readonly string[]): unknown => {
      const item = lookup(path);
      return item.kind === "map" ? undefined : item.value instanceof Y.Text ? wireValue(item.value.toDelta())
        : item.value instanceof Y.Array ? wireValue(item.value.toArray()) : wireValue(item.value);
    },
    kind: (path: readonly string[]) => lookup(path).kind,
    keys: (path: readonly string[]): readonly string[] => {
      const item = lookup(path);
      if (item.kind !== "map") return Object.freeze([]);
      const keys = new Set(item.value instanceof Y.Map ? item.value.keys() : []);
      for (const write of overlay.values()) {
        if (write.path.length === path.length + 1 && path.every((key, index) => write.path[index] === key)) {
          const key = write.path.at(-1);
          if (key !== undefined) { if (write.kind === "delete") keys.delete(key); else keys.add(key); }
        }
      }
      return Object.freeze([...keys].sort());
    }
  });
  return { view, include: (writes: readonly SharedPreparedWrite[]): void => {
    for (const write of writes) if (write.kind === "set" && write.value === undefined) throw new Error("Prepared set writes cannot contain undefined");
    for (const write of writes) {
      for (const [key, previous] of overlay) {
        if (previous.path.length > write.path.length && write.path.every((part, index) => previous.path[index] === part)) overlay.delete(key);
      }
      overlay.set(JSON.stringify(write.path), { path: [...write.path], kind: write.kind, value: wireValue(write.value) });
    }
  } };
}

export function applySharedMapWrites(handle: SharedDocumentHandle, writes: readonly SharedPreparedWrite[]): void {
  if (!collabState(handle).execution?.applying) throw new SharedExecutionWriteError();
  for (const write of writes) {
    const parent = liveValue(handle, write.path.slice(0, -1)) as Y.Map<unknown>, key = write.path.at(-1) as string;
    if (write.kind === "delete") parent.delete(key);
    else parent.set(key, write.kind === "map" ? new Y.Map<unknown>() : write.value);
  }
}
