import type { SharedContentRef, SharedJsonFields, SharedOperation, SharedRecordCreate } from "./operations.ts";
import { sharedCellTextOperations, sharedCellUnitKey } from "./cell-text-operations.ts";
import type { SharedCellSplice } from "./cell-text-operations.ts";
import { isSharedBrollRepeatOf } from "./projection/broll.ts";
import { anchorBrollCell, brollAnchorTodo, brollMarkerLines, planBrollAnchorsInState, planBrollRecordsInState } from "../production/broll.ts";
import type { BrollState } from "../production/broll.ts";
import type { FieldText, ProductionReaders } from "../production/ports.ts";
import { explode, implode } from "../text/edits.ts";
import type { Char } from "../text/edits.ts";
import { toHtml } from "../text/html.ts";
import type { Run } from "../text/runs.ts";

export interface SharedBrollLeftCell {
  readonly rowId: string;
  readonly cell: readonly Run[];
  readonly state: BrollState;
}

export interface SharedBrollKeying {
  readonly operations: readonly SharedOperation[];
  readonly keys: readonly string[];
  readonly shots: readonly string[];
}

export type SharedBrollLineKey = (at: number) => string | null;

function undrawn(serial: number): string {
  return "\u0000" + serial;
}

function isUndrawn(id: string): boolean {
  return id.startsWith("\u0000");
}

function splice(before: readonly Run[], after: readonly Run[]): SharedCellSplice | null {
  const was = explode(before), now = explode(after), same = (a: Char | undefined, b: Char | undefined) => !!a && !!b && sharedCellUnitKey(a) === sharedCellUnitKey(b);
  let start = 0, wasEnd = was.length, nowEnd = now.length;
  while (start < wasEnd && start < nowEnd && same(was[start], now[start])) start++;
  while (wasEnd > start && nowEnd > start && same(was[wasEnd - 1], now[nowEnd - 1])) { wasEnd--; nowEnd--; }
  return start === wasEnd && start === nowEnd ? null : { from: start, to: wasEnd, insert: implode(now.slice(start, nowEnd)) };
}

// why: rule 196 on #1414: a new key takes its id from the line's first character, so copies keying one line at once
// mint one id and one shot record; an id already held by an unclaimed shot of that name is reused, as standalone does.
export function sharedBrollKeying(left: SharedBrollLeftCell, readers: ProductionReaders, plainTextOf: FieldText, lineKey: SharedBrollLineKey,
  author: { readonly id: string; readonly by: string }): SharedBrollKeying | null {
  let drawn = 0;
  const plan = planBrollAnchorsInState(left.state, readers, { id: () => undrawn(drawn++), docId: () => "" });
  const todo = brollAnchorTodo(left.cell, left.rowId, plan).flatMap(item => {
    if (item.found.marker.key) return [];
    const id = isUndrawn(item.id) ? lineKey(item.found.line.start) : item.id;
    return id ? [{ ...item, id }] : [];
  });
  let cell = left.cell;
  const splices: SharedCellSplice[] = [], keys: string[] = [];
  for (let index = todo.length - 1; index >= 0; index--) {
    const item = todo[index];
    if (!item) continue;
    const next = anchorBrollCell(cell, [item]).cell, change = splice(cell, next);
    if (!change) continue;
    splices.unshift(change); keys.unshift(item.id); cell = next;
  }
  if (!splices.length) return null;
  const text = sharedCellTextOperations({ owner: left.rowId, field: "visualText", before: left.cell, after: cell }, splices);
  if (!text) return null;
  const html = toHtml(cell), had = new Set(readers.brollInField(toHtml(left.cell)).map(found => found.id)), made = new Set(keys);
  const state: BrollState = { ...left.state, rows: left.state.rows.map(row => row.id === left.rowId ? { ...row, visualText: html } : row) };
  const shots = planBrollRecordsInState(state, readers, { id: () => undrawn(drawn++), docId: () => "" }, plainTextOf, rowId => rowId === left.rowId).create
    .filter(shot => made.has(shot.id) && !had.has(shot.id));
  const operations: SharedOperation[] = text.map((operation, index) => ({ ...operation, id: (author.id + ":" + index) as SharedContentRef, by: author.by }));
  shots.forEach(({ id, ...fields }, index) => {
    const created: SharedRecordCreate = { kind: "record-create", id: (author.id + ":shot:" + index) as SharedContentRef, by: author.by,
      target: { collection: "shots", record: id as SharedContentRef }, fields: JSON.parse(JSON.stringify(fields)) as SharedJsonFields };
    operations.push(created);
  });
  return { operations, keys, shots: shots.map(shot => shot.id) };
}

// why: rule 196 on #1414: of keys that copies put on one line at once, the projection keeps the first in the text;
// each later one, renamed by it and with no shot, is deleted, so copies cleaning at once delete the same keys.
export function sharedBrollRepeats(left: Pick<SharedBrollLeftCell, "rowId" | "cell">, shotIds: readonly string[], author: { readonly id: string; readonly by: string }): readonly SharedOperation[] | null {
  const units = explode(left.cell), shots = new Set(shotIds), splices: SharedCellSplice[] = [];
  for (const line of brollMarkerLines(left.cell)) {
    const key = line.marker.key?.atom;
    if (!key?.id) continue;
    for (let at = (line.marker.key?.pos ?? 0) + 1; at < units.length; at++) {
      const repeat = units[at]?.atom;
      if (repeat?.atom !== "broll" || !isSharedBrollRepeatOf(repeat.id, key.id) || shots.has(repeat.id)) break;
      splices.push({ from: at, to: at + 1, insert: [] });
    }
  }
  if (!splices.length) return null;
  const text = sharedCellTextOperations({ owner: left.rowId, field: "visualText", before: left.cell, after: (() => {
    const removed = new Set(splices.map(item => item.from));
    return implode(units.filter((_, index) => !removed.has(index)));
  })() }, splices);
  return text ? text.map((operation, index) => ({ ...operation, id: (author.id + ":repeat:" + index) as SharedContentRef, by: author.by })) : null;
}
