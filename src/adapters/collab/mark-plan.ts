import type { SharedContentRef, SharedMarkValue } from "../../core/collab/operations.ts";
import { readMarkChange, readSharedContentRef } from "../../core/collab/read-operation.ts";
import type { SharedMarkBirth, SharedMarkWriter } from "./mark-record.ts";
import { readSharedMarkBirth, readSharedMarkRecordIdentity, sharedMarkRecordKey, stableSharedMark } from "./mark-record.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";

export type SharedMarkWriteChangeInput = { readonly type: "add"; readonly mark: unknown; readonly born?: unknown }
  | { readonly type: "remove" | "birth"; readonly observed: readonly string[]; readonly born?: unknown };
interface MarkWriteCoordinates {
  readonly identity: SharedContentRef;
  readonly operation: SharedContentRef;
  readonly writer: SharedMarkWriter;
  readonly from: number;
  readonly to: number;
}
export type SharedMarkWritePlan = MarkWriteCoordinates & (
  { readonly kind: "inserted"; readonly change: { readonly type: "add"; readonly mark: SharedMarkValue; readonly born: "inserted" } | { readonly type: "birth"; readonly observed: readonly SharedContentRef[]; readonly born: "inserted" } }
  | { readonly kind: "record"; readonly change: { readonly type: "add"; readonly mark: SharedMarkValue; readonly born: SharedMarkBirth | null } | { readonly type: "remove"; readonly observed: readonly SharedContentRef[] } | { readonly type: "birth"; readonly observed: readonly SharedContentRef[]; readonly born: SharedMarkBirth } }
);

export function prepareSharedMarkWrite(text: { readonly length: number; readonly recordKeys: readonly string[] }, writer: SharedMarkWriter,
  operation: string, from: number, to: number, raw: SharedMarkWriteChangeInput): SharedMarkWritePlan | null {
  const id = readSharedContentRef(operation), key = id && sharedMarkRecordKey(id, writer), identity = readSharedMarkRecordIdentity(key);
  if (!id || !identity || text.recordKeys.includes(identity) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > text.length) return null;
  const born = raw.born === "inserted" ? "inserted" : raw.born === undefined || raw.born === null ? null : readSharedMarkBirth(raw.born);
  if (raw.born !== undefined && raw.born !== null && born === null) return null;
  if (raw.type === "add") {
    const mark = readMarkChange({ kind: "mark", id: "validate", by: "", target: { owner: "validate", segment: "validate", field: "audioText" }, observed: [], mark: raw.mark })?.mark;
    if (!mark || !stableSharedMark(mark) || mark.value === null) return null;
    return born === "inserted" ? freezeSharedPreparedValue({ kind: "inserted", identity, operation: id, writer, from, to, change: { type: "add", mark, born } })
      : freezeSharedPreparedValue({ kind: "record", identity, operation: id, writer, from, to, change: { type: "add", mark, born } });
  }
  const observed: SharedContentRef[] = [];
  for (let index = 0; index < raw.observed.length; index++) {
    const reference = readSharedMarkRecordIdentity(raw.observed[index]);
    if (!reference) return null;
    observed.push(reference);
  }
  const ids = [...new Set(observed)].sort();
  if (raw.type === "remove") return freezeSharedPreparedValue({ kind: "record", identity, operation: id, writer, from, to, change: { type: "remove", observed: ids } });
  return born === "inserted" ? freezeSharedPreparedValue({ kind: "inserted", identity, operation: id, writer, from, to, change: { type: "birth", observed: ids, born } })
    : born ? freezeSharedPreparedValue({ kind: "record", identity, operation: id, writer, from, to, change: { type: "birth", observed: ids, born } }) : null;
}
