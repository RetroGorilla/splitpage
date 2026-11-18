import type { NativeField, NativeReplica, NativeRow } from "./variant.ts";

export interface NativeSpot { beat: string; offset: number; seam: string | null }
export type NativeSplitOutcome = "split" | "unjoined";

function partsOf(row: NativeRow, field: NativeField): { beat: string; start: number; end: number }[] {
  const result: { beat: string; start: number; end: number }[] = [];
  let at = 0;
  for (const part of field === "visualText" ? row.parts.visual : row.parts.audio) {
    if (part.beat !== null) result.push({ beat: part.beat, start: at, end: at + part.length });
    at += part.length;
  }
  return result;
}

// why: design section 7: a place between two joined beats, glue included, is the seam; typing there goes to the end
// of the earlier beat
export function rowSpot(row: NativeRow, field: NativeField, at: number): NativeSpot {
  const parts = partsOf(row, field);
  for (let index = 1; index < parts.length; index++) {
    const before = parts[index - 1], after = parts[index];
    if (before && after && before.end <= at && at <= after.start) return { beat: before.beat, offset: before.end - before.start, seam: after.beat };
  }
  const inside = parts.find(part => part.start <= at && at <= part.end) ?? parts.at(-1);
  if (!inside) throw new Error(`Row ${row.id} has no beat`);
  return { beat: inside.beat, offset: Math.min(Math.max(at - inside.start, 0), inside.end - inside.start), seam: null };
}

function rowOf(replica: NativeReplica, id: string): NativeRow {
  const row = replica.rows().find(candidate => candidate.id === id);
  if (!row) throw new Error(`No row ${id}`);
  return row;
}

export function typeAt(replica: NativeReplica, rowId: string, field: NativeField, at: number, text: string): void {
  const spot = rowSpot(rowOf(replica, rowId), field, at);
  replica.splice(spot.beat, field, spot.offset, spot.offset, [{ text, marks: {} }]);
  replica.changes();
}

// why: a selection over a seam deletes in each beat it covers and keeps the flag
export function deleteIn(replica: NativeReplica, rowId: string, field: NativeField, from: number, to: number): void {
  const parts = partsOf(rowOf(replica, rowId), field);
  replica.transact(() => {
    for (const part of [...parts].reverse()) {
      const start = Math.max(from, part.start), end = Math.min(to, part.end);
      if (end > start) replica.splice(part.beat, field, start - part.start, end - part.start, []);
    }
  });
  replica.changes();
}

// why: a later beat of the row stays joined to the part of the row after the split, so the beats it named before the
// split point are renamed to the beat the split begins
function repoint(replica: NativeReplica, row: NativeRow, from: number, begins: string): void {
  if (replica.reading === "contiguous") return;
  const earlier = new Set(row.members.slice(0, from));
  for (const member of row.members.slice(from)) {
    const join = replica.joined(member);
    if (member !== begins && join && earlier.has(join.into)) replica.join(member, begins, join.glue);
  }
}

export function splitAt(replica: NativeReplica, rowId: string, at: number, created: string): NativeSplitOutcome {
  const row = rowOf(replica, rowId), spot = rowSpot(row, "audioText", at);
  let outcome: NativeSplitOutcome = "split";
  replica.transact(() => {
    if (spot.seam !== null) {
      replica.unjoin(spot.seam);
      repoint(replica, row, row.members.indexOf(spot.seam), spot.seam);
      outcome = "unjoined";
      return;
    }
    replica.split(spot.beat, spot.offset, created);
    repoint(replica, row, row.members.indexOf(spot.beat) + 1, created);
  });
  replica.changes();
  return outcome;
}

export function joinUp(replica: NativeReplica, rowId: string, glue = " "): boolean {
  const rows = replica.rows(), index = rows.findIndex(row => row.id === rowId), above = rows[index - 1];
  const into = above?.members.at(-1);
  if (index <= 0 || into === undefined) return false;
  replica.join(rowId, into, glue);
  replica.changes();
  return true;
}

// why: under the contiguous reading a joined beat left visible would join the row above the removed one, so a
// removal flags every beat of the row and a restore clears every beat of the entry
export function removeRow(replica: NativeReplica, rowId: string, by: string): void {
  const members = replica.reading === "contiguous" ? rowOf(replica, rowId).members : [rowId];
  replica.transact(() => { for (const member of members) replica.remove(member, by); });
  replica.changes();
}

export function restoreRow(replica: NativeReplica, head: string): void {
  const entry = replica.recovery().find(item => item.reason === "removed" && item.beat === head);
  const members = replica.reading === "contiguous" ? entry?.members ?? [head] : [head];
  replica.transact(() => { for (const member of members) replica.restore(member); });
  replica.changes();
}
