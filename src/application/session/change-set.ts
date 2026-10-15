import { commentIds } from "../../core/text/runs.ts";
import type { CellInput } from "../../core/text/runs.ts";

export type TransactionKind = "edit" | "replay" | "server" | "reload" | "recovery" | "adopt";

export interface CellChange {
  readonly rowId: string;
  readonly field: string;
}

export interface ChangeSet {
  readonly whole: boolean;
  readonly cells: readonly CellChange[];
  readonly rowsInserted: readonly string[];
  readonly rowsRemoved: readonly string[];
  readonly rowsMoved: boolean;
  readonly runsMoved: boolean;
  readonly docFields: readonly string[];
  readonly derive: readonly string[];
  readonly saveNow: boolean;
}

export interface SessionChange {
  readonly kind: TransactionKind;
  readonly epoch: number;
  readonly generation: number;
  readonly changes: ChangeSet;
}

export const NO_CHANGES: ChangeSet = Object.freeze({
  whole: false,
  cells: Object.freeze([]),
  rowsInserted: Object.freeze([]),
  rowsRemoved: Object.freeze([]),
  rowsMoved: false,
  runsMoved: false,
  docFields: Object.freeze([]),
  derive: Object.freeze([]),
  saveNow: false
});

export const WHOLE_DOCUMENT: ChangeSet = Object.freeze({ ...NO_CHANGES, whole: true });

export function changeSet(parts: Partial<ChangeSet>): ChangeSet {
  return Object.freeze({
    whole: parts.whole ?? false,
    cells: Object.freeze((parts.cells ?? []).map(function (c) { return Object.freeze({ rowId: c.rowId, field: c.field }); })),
    rowsInserted: Object.freeze((parts.rowsInserted ?? []).slice()),
    rowsRemoved: Object.freeze((parts.rowsRemoved ?? []).slice()),
    rowsMoved: parts.rowsMoved ?? false,
    runsMoved: parts.runsMoved ?? false,
    docFields: Object.freeze((parts.docFields ?? []).slice()),
    derive: Object.freeze((parts.derive ?? []).slice()),
    saveNow: parts.saveNow ?? false
  });
}

export function cellEdit(rowId: string, field: string, derive: readonly string[] = []): ChangeSet {
  return changeSet({ cells: [{ rowId: rowId, field: field }], derive: derive });
}

export function cellTextEdit(rowId: string, field: string, before: CellInput, after: CellInput, derive: readonly string[] = []): ChangeSet {
  const was = commentIds(before), now = commentIds(after);
  const same = was.length === now.length && was.every(function (id, i) { return id === now[i]; });
  return changeSet({ cells: [{ rowId: rowId, field: field }], runsMoved: !same, derive: derive });
}

function joined<T>(first: readonly T[], second: readonly T[], same: (a: T, b: T) => boolean): T[] {
  return first.concat(second.filter(function (item, at) {
    return !first.some(function (had) { return same(had, item); }) &&
      second.findIndex(function (other) { return same(other, item); }) === at;
  }));
}

function equal<T>(a: T, b: T): boolean {
  return a === b;
}

export function combined(first: ChangeSet, second: ChangeSet): ChangeSet {
  return changeSet({
    whole: first.whole || second.whole,
    cells: joined(first.cells, second.cells, function (a, b) { return a.rowId === b.rowId && a.field === b.field; }),
    rowsInserted: joined(first.rowsInserted, second.rowsInserted, equal),
    rowsRemoved: joined(first.rowsRemoved, second.rowsRemoved, equal),
    rowsMoved: first.rowsMoved || second.rowsMoved,
    runsMoved: first.runsMoved || second.runsMoved,
    docFields: joined(first.docFields, second.docFields, equal),
    derive: joined(first.derive, second.derive, equal),
    saveNow: first.saveNow || second.saveNow
  });
}

export function isEmpty(changes: ChangeSet): boolean {
  return !changes.whole && !changes.cells.length && !changes.rowsInserted.length && !changes.rowsRemoved.length &&
    !changes.rowsMoved && !changes.runsMoved && !changes.docFields.length;
}

export function needsReconciliation(changes: ChangeSet): boolean {
  return changes.runsMoved || changes.rowsMoved || changes.rowsInserted.length > 0 || changes.rowsRemoved.length > 0;
}
