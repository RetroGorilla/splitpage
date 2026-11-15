import { flowBaseReference } from "./base-reference.ts";
import type { SharedIdentityGap, SharedInsertionChunk, SharedTextAddress, SharedTextDelete, SharedTextInsert } from "./operations.ts";
import { FlowOperationTrace } from "../flow/operations.ts";
import { explode } from "../text/edits.ts";
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

export function sharedCellUnitKey(unit: Char): string {
  return unit.atom ? JSON.stringify(["atom", sorted(unit.atom)]) : JSON.stringify([unit.ch, sorted(unit.marks)]);
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
  if (splice.from < length) return { left: null, right: flowBaseReference(target.owner, target.field, splice.from), affinity: "before" };
  return { left: flowBaseReference(target.owner, target.field, length - 1), right: null, affinity: "after" };
}

export function sharedCellTextOperations(cell: SharedCellText, splices: readonly SharedCellSplice[]): readonly SharedCellTextOperation[] | null {
  const was = explode(cell.before), parts = merged(splices, was.length);
  if (!parts || (!was.length && parts.length)) return null;
  const result: Char[] = [];
  let kept = 0;
  for (const splice of parts) {
    for (let index = kept; index < splice.from; index++) result.push(was[index] as Char);
    for (const unit of explode(splice.insert)) result.push(unit);
    kept = splice.to;
  }
  for (let index = kept; index < was.length; index++) result.push(was[index] as Char);
  const now = explode(cell.after);
  if (result.length !== now.length || result.some((unit, index) => sharedCellUnitKey(unit) !== sharedCellUnitKey(now[index] as Char))) return null;
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
