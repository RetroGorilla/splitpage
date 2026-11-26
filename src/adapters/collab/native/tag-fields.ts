import { TAG_STATUS_IDS, unmergedTagEdits } from "../../../core/document/tags.ts";
import type { UnmergedTagEdit } from "../../../core/document/validated.ts";
import type * as Y from "yjs";
import { decodeNativeValue, nativeFieldKey } from "./values.ts";

export const NATIVE_TAG_FIELDS = { notes: "", owner: "", status: TAG_STATUS_IDS[0] } as const;

type NativeTagField = keyof typeof NATIVE_TAG_FIELDS;

export const nativeTagFields = ["notes", "owner", "status"] as const;

export function nativeTagCounterKey(field: NativeTagField): string {
  return "tag-counter:" + field;
}

export function nativeTagCounter(record: Y.Map<unknown> | undefined, field: NativeTagField): number {
  const value = record?.get(nativeTagCounterKey(field));
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function nativeTagAlternativesKey(field: NativeTagField): string {
  return "tag-alternatives:" + field;
}

export function readNativeTagAlternatives(record: Y.Map<unknown>, legacy: unknown): UnmergedTagEdit[] {
  const edits = unmergedTagEdits(legacy);
  const out: UnmergedTagEdit[] = [];
  for (const field of nativeTagFields) {
    const key = nativeTagAlternativesKey(field);
    const values = record.get(key);
    if (Array.isArray(values)) out.push(...unmergedTagEdits(values.map(value => ({ field, value }))));
    else if (edits.length && !record.has(key)) out.push(...edits.filter(edit => edit.field === field));
  }
  return out;
}

export function storedNativeTagAlternatives(record: Y.Map<unknown>): UnmergedTagEdit[] {
  return readNativeTagAlternatives(record, decodeNativeValue(record.get(nativeFieldKey("unmergedEdits")))?.value);
}
