import type { ChangeSet } from "../../../src/application/session/change-set.ts";

type Bag = Record<string, unknown>;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function rowsOf(doc: Bag): Map<string, Bag> {
  return new Map((doc.rows as Bag[]).map(row => [String(row.id), row]));
}

export function namesUnchanged(before: Bag, after: Bag, changes: ChangeSet): string[] {
  const was = rowsOf(before), now = rowsOf(after), out: string[] = [];
  for (const cell of changes.cells) {
    const old = was.get(String(cell.rowId)), next = now.get(String(cell.rowId));
    if (!old || !next || same(old[String(cell.field)], next[String(cell.field)])) out.push(`cell ${cell.rowId}.${cell.field}`);
  }
  for (const id of changes.rowsInserted) if (was.has(id) || !now.has(id)) out.push(`inserted ${id}`);
  for (const id of changes.rowsRemoved) if (!was.has(id) || now.has(id)) out.push(`removed ${id}`);
  for (const key of changes.docFields) if (key === "rows" || same(before[key], after[key])) out.push(`field ${key}`);
  const kept = (doc: Bag): string[] => (doc.rows as Bag[]).map(row => String(row.id)).filter(id => was.has(id) && now.has(id));
  if (changes.rowsMoved && same(kept(before), kept(after))) out.push("rows order");
  if (changes.whole || changes.runsMoved) out.push("a flag no comparison sets");
  return out;
}
