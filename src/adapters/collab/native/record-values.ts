import type * as Y from "yjs";
import { cleanId } from "../../../core/document/text-policy.ts";
import type { NativeScript } from "./script.ts";
import { nativeAvailability } from "./text-commands.ts";
import type { NativeRefusal } from "./text-commands.ts";
import { decodeNativeValue, encodeNativeValue, nativeWellFormed } from "./values.ts";

type RecordRefusal = NativeRefusal | "value" | "taken" | "author" | "stored";

export type NativeRecordOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: RecordRefusal };

export const RECORD_WRITTEN: NativeRecordOutcome = Object.freeze({ kind: "written" });
export const RECORD_UNCHANGED: NativeRecordOutcome = Object.freeze({ kind: "unchanged" });

export function refuseRecord(reason: RecordRefusal): Extract<NativeRecordOutcome, { kind: "refused" }> {
  return Object.freeze({ kind: "refused", reason });
}

export function copyArgument<T>(read: () => T): { value: T } | null {
  try { return { value: read() }; } catch { return null; }
}

export function transactRecord<T, R extends NativeRecordOutcome>(script: NativeScript, copy: () => { value: T } | null, write: (input: T) => R): R | Extract<NativeRecordOutcome, { kind: "refused" }> {
  const input = copy(), unavailable = nativeAvailability(script);
  if (unavailable) return refuseRecord(unavailable);
  if (!input) return refuseRecord("value");
  return script.doc.transact(() => {
    if (script.closed() || script.reader.isClosed()) return refuseRecord("closed");
    return write(input.value);
  }, script.origin);
}

export function recordBag(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function plainRecordArgument(value: unknown): boolean {
  if (!recordBag(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function nativeRecordId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && cleanId(value) === value;
}

// why: known file records are shallow; leave room for unknown fields while bounding validation and JSON encoding
const MAX_DEPTH = 64;
const MAX_UNITS = 15_000_000;

export function copyRecordValue(value: unknown): unknown {
  const copiedObjects = new WeakMap<object, unknown>();
  let remaining = MAX_UNITS;
  function charge(units: number): void {
    remaining -= units;
    if (remaining < 0) throw new RangeError("File value is too large");
  }
  function copy(item: unknown, depth: number): unknown {
    charge(typeof item === "string" ? item.length + 1 : 1);
    if (depth > MAX_DEPTH) throw new RangeError("File value is too deeply nested");
    if (item === null || typeof item !== "object") return item;
    if (copiedObjects.has(item)) return copiedObjects.get(item);
    copiedObjects.set(item, undefined);
    let result: unknown;
    if (Array.isArray(item)) {
      const list: readonly unknown[] = item, length = list.length, items: unknown[] = [];
      if (!Number.isSafeInteger(length) || length < 0 || length > remaining) throw new RangeError("Invalid file array size");
      for (let index = 0; index < length; index++) items.push(copy(list[index], depth + 1));
      result = items;
    } else {
      if (!plainRecordArgument(item)) throw new TypeError("Expected a plain file record");
      const source = item as Record<string, unknown>;
      result = Object.fromEntries(Object.keys(source).map(key => {
        charge(key.length);
        return [key, copy(source[key], depth + 1)];
      }));
    }
    copiedObjects.set(item, result);
    return result;
  }

  const copied = copy(value, 0);
  remaining = MAX_UNITS;
  function check(item: unknown, depth: number): void {
    charge(typeof item === "string" ? item.length + 1 : 1);
    if (depth > MAX_DEPTH) throw new RangeError("File value is too deeply nested");
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item) || nativeWellFormed(item)) return;
    if (Array.isArray(item)) {
      for (const child of item as unknown[]) check(child, depth + 1);
    } else if (recordBag(item)) {
      for (const [key, child] of Object.entries(item)) {
        charge(key.length);
        if (!nativeWellFormed(key)) throw new TypeError("Malformed field name");
        check(child, depth + 1);
      }
    } else throw new TypeError("Expected a plain file value");
  }
  check(copied, 0);
  return copied;
}

export function sameNativeValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => sameNativeValue(item, right[index]));
  if (!recordBag(left) || !recordBag(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameNativeValue(left[key], right[key]));
}

export function writeRecordFields(record: Y.Map<unknown>, fields: Readonly<Record<string, unknown>>): NativeRecordOutcome {
  const changes = Object.entries(fields).flatMap(([key, value]) => {
    const stored = decodeNativeValue(record.get(key));
    return stored && sameNativeValue(stored.value, value) ? [] : [[key, encodeNativeValue(value)] as const];
  });
  for (const [key, value] of changes) record.set(key, value);
  return changes.length ? RECORD_WRITTEN : RECORD_UNCHANGED;
}
