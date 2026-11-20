import type * as Y from "yjs";
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

export function refuseRecord(reason: RecordRefusal): NativeRecordOutcome {
  return Object.freeze({ kind: "refused", reason });
}

export function transactRecord<T>(script: NativeScript, copy: () => T, write: (input: T) => NativeRecordOutcome): NativeRecordOutcome {
  let input: { value: T } | undefined;
  try { input = { value: copy() }; } catch { input = undefined; }
  const unavailable = nativeAvailability(script);
  if (unavailable) return refuseRecord(unavailable);
  if (!input) return refuseRecord("value");
  const { value } = input;
  return script.doc.transact(() => {
    if (script.closed() || script.reader.isClosed()) return refuseRecord("closed");
    return write(value);
  }, script.origin);
}

export function recordBag(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const INVALID = Symbol("Not a plain file value");

export function copyRecordValue(value: unknown): unknown {
  return copyFileValue(value, new WeakMap());
}

function copyFileValue(value: unknown, copiedObjects: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (copiedObjects.has(value)) return copiedObjects.get(value);
  copiedObjects.set(value, INVALID);
  let copied: unknown;
  if (Array.isArray(value)) {
    const list: readonly unknown[] = value, length = list.length, items: unknown[] = [];
    if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) return INVALID;
    for (let index = 0; index < length; index++) items.push(copyFileValue(list[index], copiedObjects));
    copied = items;
  } else {
    const prototype: unknown = Object.getPrototypeOf(value);
    const source = value as Record<string, unknown>;
    const entries = Object.keys(source).map(key => [key, copyFileValue(source[key], copiedObjects)] as const);
    copied = prototype === Object.prototype || prototype === null ? Object.fromEntries(entries) : INVALID;
  }
  copiedObjects.set(value, copied);
  return copied;
}

export function isFileValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || nativeWellFormed(value)) return true;
  if (Array.isArray(value)) return value.every(isFileValue);
  return recordBag(value) && Object.entries(value).every(([key, item]) => nativeWellFormed(key) && isFileValue(item));
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  if (!recordBag(left) || !recordBag(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

export function changedRecordFields(record: Y.Map<unknown>, fields: Readonly<Record<string, unknown>>): [string, string][] {
  return Object.entries(fields).flatMap(([key, value]) => {
    const stored = decodeNativeValue(record.get(key));
    return stored && sameValue(stored.value, value) ? [] : [[key, encodeNativeValue(value)]];
  });
}

export function writeRecordFields(record: Y.Map<unknown>, fields: Readonly<Record<string, unknown>>): NativeRecordOutcome {
  const changes = changedRecordFields(record, fields);
  for (const [key, value] of changes) record.set(key, value);
  return changes.length ? RECORD_WRITTEN : RECORD_UNCHANGED;
}
