import { isDeepStrictEqual } from "node:util";

type Bag = Record<string, unknown>;

export interface ExpectedProjectionChanges {
  whole: boolean;
  added: string[];
  removed: string[];
  moved: string[];
  changed: { id: string; fields: string[] }[];
  fields: string[];
}

function equalValue(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b) && JSON.stringify(a) === JSON.stringify(b);
}

function unequalKeys(before: Bag, after: Bag): string[] {
  return [...new Set([...Object.keys(after), ...Object.keys(before)])].filter(key =>
    !(Object.hasOwn(before, key) && Object.hasOwn(after, key) && equalValue(before[key], after[key])));
}

function rowList(document: Bag): Bag[] | null {
  const rows = document.rows;
  if (!Array.isArray(rows)) return null;
  const list: Bag[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row: unknown = rows[index];
    if (row === null || typeof row !== "object" || typeof (row as Bag).id !== "string") return null;
    list.push(row as Bag);
  }
  const ids = list.map(row => row.id);
  return ids.some((id, index) => ids.indexOf(id) !== index) ? null : list;
}

function runsFrom(places: readonly number[]): number[] {
  const longest: number[] = [];
  for (let at = places.length - 1; at >= 0; at--) {
    let best = 0;
    for (let later = at + 1; later < places.length; later++) if ((places[later] ?? 0) > (places[at] ?? 0)) best = Math.max(best, longest[later] ?? 0);
    longest[at] = best + 1;
  }
  return longest;
}

export function longestKeptRun(places: readonly number[]): number {
  return Math.max(0, ...runsFrom(places));
}

function movedIds(kept: readonly string[], places: readonly number[]): string[] {
  const longest = runsFrom(places);
  let remaining = Math.max(0, ...longest), floor = -1;
  return kept.filter((_id, at) => {
    const place = places[at] ?? 0;
    if (place > floor && longest[at] === remaining) { remaining--; floor = place; return false; }
    return true;
  });
}

export function expectedProjectionChanges(previous: unknown, next: unknown): ExpectedProjectionChanges {
  const whole = { whole: true, added: [], removed: [], moved: [], changed: [], fields: [] };
  if (previous === null) return whole;
  const before = rowList(previous as Bag), after = rowList(next as Bag);
  if (!before || !after) return whole;
  const beforeIds = before.map(row => String(row.id)), afterIds = after.map(row => String(row.id));
  const kept = afterIds.filter(id => beforeIds.includes(id));
  const changed: ExpectedProjectionChanges["changed"] = [];
  for (const id of kept) {
    const old = before[beforeIds.indexOf(id)], row = after[afterIds.indexOf(id)];
    const fields = old && row ? unequalKeys(old, row) : [];
    if (fields.length) changed.push({ id, fields });
  }
  return {
    whole: false,
    added: afterIds.filter(id => !beforeIds.includes(id)),
    removed: beforeIds.filter(id => !afterIds.includes(id)),
    moved: movedIds(kept, kept.map(id => beforeIds.indexOf(id))),
    changed,
    fields: unequalKeys(previous as Bag, next as Bag).filter(key => key !== "rows")
  };
}
