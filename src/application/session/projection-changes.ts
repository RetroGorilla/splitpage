import type { DocumentShape } from "../../core/document/validated.ts";
import { WHOLE_DOCUMENT, changeSet } from "./change-set.ts";
import type { CellChange, ChangeSet } from "./change-set.ts";

type Bag = Readonly<Record<string, unknown>>;
type Rows = readonly (Bag & { readonly id: string })[];

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function keysOf(before: Bag, after: Bag): string[] {
  return Object.keys(after).concat(Object.keys(before).filter(function (key) { return !Object.hasOwn(after, key); }));
}

function byId(rows: Rows): Map<string, Bag> | null {
  const found = new Map<string, Bag>();
  for (const row of rows) {
    if (found.has(row.id)) return null;
    found.set(row.id, row);
  }
  return found;
}

export function changesBetween(before: Readonly<DocumentShape>, after: Readonly<DocumentShape>): ChangeSet {
  const was = byId(before.rows), now = byId(after.rows);
  // why: A repeated beat id leaves no one row to compare, so only the whole document is a true extent.
  if (!was || !now) return WHOLE_DOCUMENT;
  const cells: CellChange[] = [];
  for (const row of after.rows) {
    const old = was.get(row.id);
    if (!old) continue;
    for (const field of keysOf(old, row)) if (!same(old[field], row[field])) cells.push({ rowId: row.id, field: field });
  }
  const kept = function (rows: Rows, other: Map<string, Bag>): string[] {
    return rows.filter(function (row) { return other.has(row.id); }).map(function (row) { return row.id; });
  };
  const oldOrder = kept(before.rows, now), newOrder = kept(after.rows, was);
  return changeSet({
    cells: cells,
    rowsInserted: after.rows.filter(function (row) { return !was.has(row.id); }).map(function (row) { return row.id; }),
    rowsRemoved: before.rows.filter(function (row) { return !now.has(row.id); }).map(function (row) { return row.id; }),
    rowsMoved: oldOrder.some(function (id, at) { return id !== newOrder[at]; }),
    docFields: keysOf(before, after).filter(function (key) { return key !== "rows" && !same(before[key], after[key]); })
  });
}
