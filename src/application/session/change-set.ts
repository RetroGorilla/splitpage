import { commentIds } from "../../core/text/runs.ts";
import type { CellInput } from "../../core/text/runs.ts";

export type TransactionKind = "edit" | "server" | "reload" | "recovery" | "adopt";

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
  derive: Object.freeze([])
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
    derive: Object.freeze((parts.derive ?? []).slice())
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

export function isEmpty(changes: ChangeSet): boolean {
  return !changes.whole && !changes.cells.length && !changes.rowsInserted.length && !changes.rowsRemoved.length &&
    !changes.rowsMoved && !changes.runsMoved && !changes.docFields.length;
}

export function needsReconciliation(changes: ChangeSet): boolean {
  return changes.runsMoved || changes.rowsMoved || changes.rowsInserted.length > 0 || changes.rowsRemoved.length > 0;
}
