import { flowBaseReference } from "./base-reference.ts";
import type { SharedIdentityGap, SharedInsertionChunk, SharedTextAddress, SharedTextDelete, SharedTextInsert } from "./operations.ts";
import { FlowOperationTrace } from "../flow/operations.ts";
import { explode, implode } from "../text/edits.ts";
import type { Char } from "../text/edits.ts";
import type { Run } from "../text/runs.ts";

export interface SharedCellSplice {
  readonly from: number;
  readonly to: number;
  readonly insert: readonly Run[];
}

export interface SharedCellText {
  readonly owner: string;
  readonly field: "audioText" | "visualText";
  readonly before: readonly Run[];
  readonly after: readonly Run[];
}

export type SharedCellTextOperation = Omit<SharedTextInsert, "id" | "by"> | Omit<SharedTextDelete, "id" | "by">;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]));
}

function unitKey(unit: Char): string {
  return unit.atom ? JSON.stringify(["atom", sorted(unit.atom)]) : JSON.stringify([unit.ch, sorted(unit.marks)]);
}

function splitsPair(units: readonly Char[], at: number): boolean {
  const high = units[at - 1], low = units[at];
  const before = high && !high.atom ? high.ch.charCodeAt(0) : 0, after = low && !low.atom ? low.ch.charCodeAt(0) : 0;
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function sharedCellSplice(before: readonly Run[], after: readonly Run[]): SharedCellSplice | null {
  const was = explode(before), now = explode(after);
  let start = 0;
  while (start < was.length && start < now.length && unitKey(was[start] as Char) === unitKey(now[start] as Char)) start++;
  if (start === was.length && start === now.length) return null;
  while (start > 0 && (splitsPair(was, start) || splitsPair(now, start))) start--;
  let end = 0;
  while (end < was.length - start && end < now.length - start
    && unitKey(was[was.length - 1 - end] as Char) === unitKey(now[now.length - 1 - end] as Char)) end++;
  while (end > 0 && (splitsPair(was, was.length - end) || splitsPair(now, now.length - end))) end--;
  return { from: start, to: was.length - end, insert: implode(now.slice(start, now.length - end)) };
}

function merged(splices: readonly SharedCellSplice[], length: number): SharedCellSplice[] | null {
  const out: SharedCellSplice[] = [];
  for (const splice of splices) {
    if (!Number.isSafeInteger(splice.from) || !Number.isSafeInteger(splice.to) || splice.from < 0 || splice.to < splice.from || splice.to > length) return null;
    const last = out.at(-1);
    if (last && splice.from < last.to) return null;
    if (last && splice.from === last.to) out[out.length - 1] = { from: last.from, to: splice.to, insert: [...last.insert, ...splice.insert] };
    else out.push(splice);
  }
  return out.filter(splice => splice.to > splice.from || explode(splice.insert).length > 0);
}

function chunks(owner: string, field: SharedCellText["field"], insert: readonly Run[]): readonly SharedInsertionChunk[] {
  const trace = new FlowOperationTrace({ rows: [] }, { cells: () => [] }, { id: "", by: "" });
  trace.insert(owner, [], 0, insert, field);
  const insertion = trace.ops[0];
  return insertion?.kind === "text-insert" ? insertion.content : [];
}

function gap(target: SharedTextAddress, splice: SharedCellSplice, length: number): SharedIdentityGap {
  if (splice.to < length) return { left: null, right: flowBaseReference(target.owner, target.field, splice.to), affinity: "before" };
  if (splice.from > 0) return { left: flowBaseReference(target.owner, target.field, splice.from - 1), right: null, affinity: "after" };
  return { left: null, right: flowBaseReference(target.owner, target.field, 0), affinity: "before" };
}

export function sharedCellTextOperations(cell: SharedCellText, splices: readonly SharedCellSplice[]): readonly SharedCellTextOperation[] | null {
  const was = explode(cell.before), parts = merged(splices, was.length);
  if (!parts) return null;
  const result: Char[] = [];
  let kept = 0;
  for (const splice of parts) {
    result.push(...was.slice(kept, splice.from), ...explode(splice.insert));
    kept = splice.to;
  }
  result.push(...was.slice(kept));
  const now = explode(cell.after);
  if (result.length !== now.length || result.some((unit, index) => unitKey(unit) !== unitKey(now[index] as Char))) return null;
  const target: SharedTextAddress = { owner: cell.owner as SharedTextAddress["owner"], segment: cell.owner as SharedTextAddress["segment"], field: cell.field };
  const operations: SharedCellTextOperation[] = [];
  for (const splice of parts) {
    const content = chunks(cell.owner, cell.field, splice.insert);
    // why: an insertion placed before its observed deletion keeps its gap when another copy's text lands beside it
    if (content.length) operations.push({ kind: "text-insert", target, at: gap(target, splice, was.length), content });
    if (splice.to > splice.from) operations.push({ kind: "text-delete", target, observed: [flowBaseReference(cell.owner, cell.field, splice.from, splice.to)] });
  }
  return operations;
}
