export type ModelOption = "K" | "R" | "U";
export type ModelStep =
  | { by: number; op: "split"; at: "start" | "end" }
  | { by: number; op: "cut"; rows: string[] }
  | { by: number; op: "undo" | "redo" }
  | { from: number; to: number };

export interface ModelView { rows: string[]; boundaries: number; record: boolean; cell: boolean; rank: boolean; missing: string[] }
export interface ModelRun { views: ModelView[][]; settled: ModelView }

interface Instance { n: number; key: string; by: number; parent: number | null }
interface Entry { inserted: number[]; deleted: number[] }
interface Copy { known: Set<number>; undo: Entry[]; redo: Entry[]; redone: Map<number, number> }

const HYDRATION = -1;
const STRAY = "~stray";

// why: the document is `A: a`, `B: b` in one segment, A at its head. Every instance of a key sits in that key's slot,
// so a boundary brought back by an undo or redo sits where the original was
function slots(split: "start" | "end"): string[] {
  return split === "start" ? ["head:A", "chr:a", "bnd:B", "bnd:N", "chr:b"] : ["head:A", "chr:a", "bnd:B", "chr:b", "bnd:N"];
}

const beatOf = (key: string): string | null => /^(head|bnd):/.test(key) ? key.slice(key.indexOf(":") + 1) : null;
const isMapEntry = (key: string): boolean => /^(head|rec|cell):/.test(key);

// why: the rules of the library's undo, written out: an undo deletes what its entry inserted (following this copy's
// redone links) unless the option's filter keeps it, and brings back each thing its entry deleted as a new instance
export function runModel(option: ModelOption, steps: readonly ModelStep[], writers: number): ModelRun {
  const instances: Instance[] = [], deletions = new Map<number, Set<number>>();
  const split = steps.find((step): step is Extract<ModelStep, { op: "split" }> => "op" in step && step.op === "split")?.at ?? "start";
  const order = slots(split);
  const create = (key: string, by: number, parent: number | null = null): number => { instances.push({ n: instances.length, key, by, parent }); return instances.length - 1; };
  for (const key of ["head:A", "chr:a", "bnd:B", "chr:b", "rec:A", "cell:A", "rec:B", "cell:B"]) create(key, HYDRATION);
  const copies: Copy[] = Array.from({ length: writers }, () => ({ known: new Set([HYDRATION]), undo: [], redo: [], redone: new Map() }));
  const alive = (copy: Copy, n: number): boolean => {
    const instance = instances[n];
    if (!instance || !copy.known.has(instance.by) || [...deletions.get(n) ?? []].some(event => copy.known.has(event))) return false;
    return instance.parent === null || alive(copy, instance.parent);
  };
  const children = (n: number): number[] => instances.filter(instance => instance.parent === n).map(instance => instance.n);
  // why: deleting a record deletes what it holds in the same change, so an undo of that deletion brings both back
  const remove = (n: number, by: number, copy?: Copy): number[] => {
    const inside = copy ? children(n).filter(child => alive(copy, child)) : [];
    const set = deletions.get(n) ?? new Set(); set.add(by); deletions.set(n, set);
    return [n, ...inside.flatMap(child => remove(child, by, copy))];
  };
  const live = (copy: Copy, key: string): number[] => instances.filter(instance => instance.key === key && alive(copy, instance.n)).map(instance => instance.n);
  const whole = (copy: Copy, beat: string): boolean => live(copy, `rec:${beat}`).length > 0 && live(copy, `cell:${beat}`).length > 0;

  const read = (copy: Copy): { view: ModelView; cover: Map<string, number[]> } => {
    const rows: { id: string; text: string; cover: number[] }[] = [], leadingCover: number[] = [];
    let current: { id: string; text: string; cover: number[] } | null = null, leading = "";
    for (const key of order) {
      const here = live(copy, key), beat = beatOf(key);
      if (!here.length) continue;
      if (beat !== null) {
        if (option === "R" && !whole(copy, beat)) {
          if (current) current.cover.push(...here); else leadingCover.push(...here);
          continue;
        }
        current = { id: beat, text: "", cover: [...here] };
        rows.push(current);
        continue;
      }
      const letters = key.slice(4).repeat(here.length);
      if (current) { current.text += letters; current.cover.push(...here); } else { leading += letters; leadingCover.push(...here); }
    }
    const first = rows[0];
    if (first) { first.text = leading + first.text; first.cover.unshift(...leadingCover); }
    else if (leading) rows.push({ id: STRAY, text: leading, cover: leadingCover });
    const n = live(copy, "bnd:N").length;
    return {
      view: {
        rows: rows.map(row => `${row.id}: ${row.text} / `), boundaries: n, record: live(copy, "rec:N").length > 0, cell: live(copy, "cell:N").length > 0,
        rank: live(copy, "rank:N").length > 0,
        missing: rows.filter(row => row.id !== STRAY && !whole(copy, row.id)).map(row => row.id)
      },
      cover: new Map(rows.map(row => [row.id, row.cover]))
    };
  };

  const kept = (key: string): boolean => option === "U" && /^(rec|cell):/.test(key);
  const follow = (copy: Copy, n: number): number => { let at = n; while (copy.redone.has(at)) at = copy.redone.get(at) as number; return at; };
  const press = (copy: Copy, from: Entry[], to: Entry[], event: number): boolean => {
    while (from.length) {
      const entry = from.pop() as Entry, inserted: number[] = [], deleted: number[] = [];
      let changed = false;
      // why: an entry inside a deleted record comes back only into that record's own replacement
      const redo = (original: number): number | null => {
        const done = copy.redone.get(original);
        if (done !== undefined) return done;
        const { key, parent } = instances[original] as Instance;
        let home: number | null = null;
        if (parent !== null) {
          home = alive(copy, parent) ? parent : entry.deleted.includes(parent) ? redo(parent) : null;
          if (home === null) return null;
        }
        if (isMapEntry(key) && instances.some(other => other.key === key && other.n > original && copy.known.has(other.by))) {
          throw new Error(`model does not cover a redo of ${key} after a later entry`);
        }
        const fresh = create(key, event, home);
        copy.redone.set(original, fresh);
        inserted.push(fresh);
        return fresh;
      };
      for (const original of entry.deleted) if (!entry.inserted.includes(original) && redo(original) !== null) changed = true;
      for (const original of entry.inserted) {
        const target = follow(copy, original);
        if (!alive(copy, target) || kept((instances[target] as Instance).key)) continue;
        deleted.push(...remove(target, event, copy));
        changed = true;
      }
      if (changed) { copy.known.add(event); to.push({ inserted, deleted }); return true; }
    }
    return false;
  };

  const views: ModelView[][] = [];
  for (const [event, step] of steps.entries()) {
    if ("from" in step) {
      const from = copies[step.from] as Copy, to = copies[step.to] as Copy;
      for (const known of from.known) to.known.add(known);
    } else {
      const copy = copies[step.by] as Copy;
      if (step.op === "split") {
        const record = create("rec:N", event), made = [create("bnd:N", event), record, create("rank:N", event, record), create("cell:N", event)];
        copy.known.add(event);
        copy.undo.push({ inserted: made, deleted: [] });
        copy.redo = [];
      } else if (step.op === "cut") {
        const { cover } = read(copy), deleted: number[] = [];
        const targets = new Set(step.rows.flatMap(id => cover.has(id) ? [id] : []));
        for (const id of targets) for (const n of cover.get(id) ?? []) { remove(n, event); deleted.push(n); }
        if (deleted.length) { copy.known.add(event); copy.undo.push({ inserted: [], deleted }); copy.redo = []; }
      } else if (step.op === "undo") press(copy, copy.undo, copy.redo, event);
      else press(copy, copy.redo, copy.undo, event);
    }
    views.push(copies.map(copy => read(copy).view));
  }
  const all: Copy = { known: new Set(copies.flatMap(copy => [...copy.known])), undo: [], redo: [], redone: new Map() };
  return { views, settled: read(all).view };
}
