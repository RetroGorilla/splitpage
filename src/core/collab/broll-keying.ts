import type { SharedContentRef, SharedJsonFields, SharedOperation, SharedRecordCreate } from "./operations.ts";
import { sharedCellTextOperations } from "./cell-text-operations.ts";
import type { SharedCellSplice } from "./cell-text-operations.ts";
import { brollAnchorTodo, brollMarkerLines, planBrollAnchorsInState, planBrollRecordsInState } from "../production/broll.ts";
import { BROLL_MARKER_RE } from "../document/broll.ts";
import type { BrollState } from "../production/broll.ts";
import type { FieldText, ProductionReaders } from "../production/ports.ts";
import { explode, implode } from "../text/edits.ts";
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

function applySplices(cell: readonly Run[], splices: readonly SharedCellSplice[]): readonly Run[] {
  const units = explode(cell);
  for (const change of [...splices].sort((a, b) => b.from - a.from)) units.splice(change.from, change.to - change.from, ...explode(change.insert));
  return implode(units);
}

// why: rule 196 on #1414: a new key takes its id from the line's first character, so copies keying one line at once
// mint one id and one shot record; an id already held by an unclaimed shot of that name is reused, as standalone does.
export function sharedBrollKeying(left: SharedBrollLeftCell, readers: ProductionReaders, plainTextOf: FieldText, lineKey: SharedBrollLineKey,
  author: { readonly id: string; readonly by: string }, shotRemoved: (id: string) => boolean = () => false): SharedBrollKeying | null {
  let drawn = 0;
  const plan = planBrollAnchorsInState(left.state, readers, { id: () => undrawn(drawn++), docId: () => "" });
  const found = readers.brollInField(toHtml(left.cell)), lines = brollMarkerLines(left.cell);
  const named = new Set(lines.filter((_, index) => !!found[index]?.name).map(item => item.line.start));
  const todo = brollAnchorTodo(left.cell, left.rowId, plan).flatMap(item => {
    if (item.found.marker.key || !named.has(item.found.line.start)) return [];
    const id = isUndrawn(item.id) ? lineKey(item.found.line.start) : item.id;
    return id ? [{ ...item, id }] : [];
  });
  const splices: SharedCellSplice[] = [], keys: string[] = [];
  for (const item of todo) {
    const match = BROLL_MARKER_RE.exec(item.found.line.items.map(unit => unit.text).join(""));
    if (!match) continue;
    let remaining = match[0].trimEnd().length, first = true;
    for (const unit of item.found.line.items) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, unit.text.length);
      if (!take) continue;
      splices.push({ from: unit.pos, to: unit.pos + take, insert: first
        ? [{ atom: "broll", id: item.id, text: (match[1] ?? "") + (match[2] ?? ""), marks: {} },
          ...match[0].length === match[0].trimEnd().length ? [{ text: " ", marks: {} }] : []] : [] });
      first = false; remaining -= take;
    }
    keys.push(item.id);
  }
  const cell = applySplices(left.cell, splices);
  const text = sharedCellTextOperations({ owner: left.rowId, field: "visualText", before: left.cell, after: cell }, splices);
  if (!text) return null;
  const html = toHtml(cell), eligible = new Set([...keys, ...found.filter(item => item.name && item.id).map(item => item.id)]);
  const state: BrollState = { ...left.state, rows: left.state.rows.map(row => row.id === left.rowId ? { ...row, visualText: html } : row) };
  const shots = planBrollRecordsInState(state, readers, { id: () => undrawn(drawn++), docId: () => "" }, plainTextOf, rowId => rowId === left.rowId).create
    .filter(shot => eligible.has(shot.id) && !shotRemoved(shot.id));
  const operations: SharedOperation[] = text.map((operation, index) => ({ ...operation, id: (author.id + ":" + index) as SharedContentRef, by: author.by }));
  shots.forEach(({ id, ...fields }, index) => {
    const created: SharedRecordCreate = { kind: "record-create", id: (author.id + ":shot:" + index) as SharedContentRef, by: author.by,
      target: { collection: "shots", record: id as SharedContentRef }, fields: JSON.parse(JSON.stringify(fields)) as SharedJsonFields };
    operations.push(created);
  });
  return operations.length ? { operations, keys, shots: shots.map(shot => shot.id) } : null;
}

// why: rule 196 on #1414: a key right after another is dropped whatever its id, so copies cleaning at once agree; its
// shot goes only if no key holds it and nobody changed it since it was made, so no one's edit is taken away.
export function sharedBrollRepeats(left: Pick<SharedBrollLeftCell, "rowId" | "cell">, shotIds: readonly string[], author: { readonly id: string; readonly by: string },
  otherCells: readonly (readonly Run[])[], untouched: (id: string) => boolean): readonly SharedOperation[] | null {
  const units = explode(left.cell), shots = new Set(shotIds), splices: SharedCellSplice[] = [];
  for (let at = 1; at < units.length; at++) {
    const key = units[at - 1]?.atom, repeat = units[at]?.atom;
    if (key?.atom !== "broll" || repeat?.atom !== "broll") continue;
    splices.push({ from: at, to: at + 1, insert: [] });
  }
  if (!splices.length) return null;
  const text = sharedCellTextOperations({ owner: left.rowId, field: "visualText", before: left.cell, after: (() => {
    const removed = new Set(splices.map(item => item.from));
    return implode(units.filter((_, index) => !removed.has(index)));
  })() }, splices);
  if (!text) return null;
  const operations: SharedOperation[] = text.map((operation, index) => ({ ...operation, id: (author.id + ":repeat:" + index) as SharedContentRef, by: author.by }));
  const removed = new Set(splices.map(item => item.from));
  const kept = units.filter((_, index) => !removed.has(index));
  const held = new Set([...kept, ...otherCells.flatMap(cell => explode(cell))].flatMap(unit => unit.atom?.atom === "broll" ? [unit.atom.id] : []));
  const dropped = new Set(splices.flatMap(item => { const atom = units[item.from]?.atom; return atom?.atom === "broll" ? [atom.id] : []; }));
  for (const id of dropped) if (shots.has(id) && !held.has(id) && untouched(id)) operations.push({ kind: "record-delete", id: (author.id + ":drop-shot:" + operations.length) as SharedContentRef,
    by: author.by, target: { collection: "shots", record: id as SharedContentRef } });
  return operations;
}
