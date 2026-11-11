import { readMarkChange, readSharedContentRef } from "../../core/collab/read-operation.ts";
import type { SharedContentRef, SharedMarkValue } from "../../core/collab/operations.ts";
import { readSharedAnchor } from "./anchors.ts";

export interface SharedTextIdentity { readonly client: number; readonly clock: number }
export interface SharedMarkBirth { readonly client: number; readonly clock: number; readonly length: number }
export type SharedMarkWriter = number | "hydration";
interface MarkRecordRange { readonly operation: SharedContentRef; readonly writer: SharedMarkWriter; readonly start: SharedContentRef; readonly end: SharedContentRef }
export type SharedMarkRecord = MarkRecordRange & (
  | { readonly type: "add"; readonly mark: SharedMarkValue; readonly born: SharedMarkBirth | null }
  | { readonly type: "remove"; readonly observed: readonly SharedContentRef[] }
  | { readonly type: "birth"; readonly observed: readonly SharedContentRef[]; readonly born: SharedMarkBirth }
);
export interface SharedMarkGroup {
  readonly kind: SharedMarkValue["kind"];
  readonly id: SharedContentRef | null;
  readonly values: readonly (true | string)[];
  readonly additions: readonly { readonly record: SharedContentRef; readonly operation: SharedContentRef; readonly value: true | string }[];
}
export interface SharedMarkedCharacter {
  readonly offset: number;
  readonly identity: SharedTextIdentity;
  readonly value: string;
  readonly marks: readonly SharedMarkGroup[];
}

function bag(raw: unknown): raw is Record<string, unknown> { return raw !== null && typeof raw === "object" && !Array.isArray(raw); }
function shape(raw: Record<string, unknown>, fields: string): boolean { return Object.keys(raw).sort().join(",") === fields; }
function observed(raw: unknown): SharedContentRef[] | null {
  if (!Array.isArray(raw)) return null;
  const result: SharedContentRef[] = [];
  for (let index = 0; index < raw.length; index++) {
    const value = recordReference(raw[index]);
    if (!value) return null;
    result.push(value);
  }
  return [...new Set(result)].sort();
}
function birth(raw: unknown): SharedMarkBirth | null {
  if (!bag(raw) || !shape(raw, "client,clock,length")) return null;
  const { client, clock, length } = raw;
  if (typeof client !== "number" || !Number.isInteger(client) || client < 0 || client > 0xffffffff
    || typeof clock !== "number" || !Number.isSafeInteger(clock) || clock < 0
    || typeof length !== "number" || !Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(clock + length)) return null;
  return { client, clock, length };
}

function writer(raw: unknown): raw is SharedMarkWriter { return raw === "hydration" || typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 0xffffffff; }

export function sharedMarkRecordKey(operation: string, author: SharedMarkWriter): string | null {
  const id = readSharedContentRef(operation);
  return id && writer(author) ? JSON.stringify([author, id]).replace(/[^\x20-\x7e]/g, unit => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0")) : null;
}
function recordReference(raw: unknown): SharedContentRef | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.length === 2 && writer(value[0]) && typeof value[1] === "string" && sharedMarkRecordKey(value[1], value[0]) === raw ? readSharedContentRef(raw) : null;
  } catch { return null; }
}

export function readSharedMarkRecord(key: string, raw: unknown): SharedMarkRecord | null {
  if (!bag(raw)) return null;
  const operation = readSharedContentRef(raw.operation), start = readSharedAnchor(raw.start), end = readSharedAnchor(raw.end);
  if (!operation || !writer(raw.writer) || key !== sharedMarkRecordKey(operation, raw.writer) || !start || !end) return null;
  const author = raw.writer === 0 ? 0 : raw.writer;
  if (raw.type === "add" && shape(raw, "born,end,mark,operation,start,type,writer")) {
    const mark = readMarkChange({ kind: "mark", id: "validate", by: "", target: { owner: "validate", segment: "validate", field: "audioText" }, observed: [], mark: raw.mark })?.mark;
    const born = raw.born === null ? null : birth(raw.born);
    return mark && mark.value !== null && (raw.born === null || born) ? { type: "add", operation, writer: author, start, end, mark, born } : null;
  }
  const ids = observed(raw.observed);
  if (!ids) return null;
  if (raw.type === "remove" && shape(raw, "end,observed,operation,start,type,writer")) return { type: "remove", operation, writer: author, start, end, observed: ids };
  const born = birth(raw.born);
  return raw.type === "birth" && born && shape(raw, "born,end,observed,operation,start,type,writer") ? { type: "birth", operation, writer: author, start, end, observed: ids, born } : null;
}

export function sharedMarkContains(born: SharedMarkBirth | null, identity: SharedTextIdentity): boolean {
  return born === null || born.client === identity.client && born.clock <= identity.clock && identity.clock < born.clock + born.length;
}
