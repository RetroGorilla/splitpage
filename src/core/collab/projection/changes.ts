type Bag = Readonly<Record<string, unknown>>;
type Row = Bag & { readonly id: string };

export interface SharedProjectionRowChange {
  readonly id: string;
  readonly fields: readonly string[];
}

export interface SharedProjectionChanges {
  readonly whole: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly moved: readonly string[];
  readonly changed: readonly SharedProjectionRowChange[];
  readonly fields: readonly string[];
}

export type SharedProjectionComparison = "row" | "field";

function wholeProjection(): SharedProjectionChanges {
  return { whole: true, added: [], removed: [], moved: [], changed: [], fields: [] };
}

function structured(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!structured(a) || !structured(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
  const left = Object.keys(a), right = Object.keys(b);
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const key = left[index];
    if (key === undefined || key !== right[index] || !same((a as Bag)[key], (b as Bag)[key])) return false;
  }
  return true;
}

function differing(before: Bag, after: Bag, skip: string | null, compared?: (key: string) => void): string[] {
  const keys = Object.keys(after), found: string[] = [];
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) keys.push(key);
  for (const key of keys) {
    if (key === skip) continue;
    const present = Object.hasOwn(before, key) && Object.hasOwn(after, key);
    if (present && Object.is(before[key], after[key])) continue;
    if (present && structured(before[key]) && structured(after[key])) compared?.(key);
    if (!present || !same(before[key], after[key])) found.push(key);
  }
  return found;
}

function indexed(rows: unknown): Map<string, number> | null {
  if (!Array.isArray(rows)) return null;
  const found = new Map<string, number>();
  for (let index = 0; index < rows.length; index++) {
    const row: unknown = rows[index];
    const id = row !== null && typeof row === "object" ? (row as Bag).id : undefined;
    if (typeof id !== "string" || found.has(id)) return null;
    found.set(id, index);
  }
  return found;
}

function inPlace(previous: readonly number[]): boolean[] {
  const runs: number[] = [], tails: number[] = [];
  for (let at = previous.length - 1; at >= 0; at--) {
    const value = previous[at] ?? 0;
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((tails[middle] ?? 0) > value) low = middle + 1; else high = middle;
    }
    tails[low] = value; runs[at] = low + 1;
  }
  let need = tails.length, last = -1;
  return previous.map((value, at) => {
    if (value <= last || runs[at] !== need) return false;
    need--; last = value;
    return true;
  });
}

export function compareSharedProjections(previous: Bag | null, next: Bag,
  compared?: (kind: SharedProjectionComparison, key: string) => void): SharedProjectionChanges {
  if (!previous) return wholeProjection();
  const was = indexed(previous.rows), now = indexed(next.rows);
  // why: A repeated or missing row id leaves no one row to compare, so only the whole document is a true extent.
  if (!was || !now) return wholeProjection();
  const before = previous.rows as readonly Row[], after = next.rows as readonly Row[];
  const added: string[] = [], changed: SharedProjectionRowChange[] = [], kept: string[] = [], places: number[] = [];
  let ordered = true;
  for (const row of after) {
    const at = was.get(row.id), old = at === undefined ? undefined : before[at];
    if (at === undefined || !old) { added.push(row.id); continue; }
    if (at < (places.at(-1) ?? -1)) ordered = false;
    kept.push(row.id); places.push(at);
    if (old === row) continue;
    compared?.("row", row.id);
    const fields = differing(old, row, null);
    if (fields.length) changed.push({ id: row.id, fields });
  }
  const removed: string[] = [];
  for (const row of before) if (!now.has(row.id)) removed.push(row.id);
  const stays = ordered ? null : inPlace(places);
  return {
    whole: false, added, removed,
    moved: stays ? kept.filter((_id, at) => !stays[at]) : [],
    changed,
    fields: differing(previous, next, "rows", compared && (key => compared("field", key)))
  };
}
