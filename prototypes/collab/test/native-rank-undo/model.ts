// why: the evidence model for the named histories; it imports neither Yjs nor the code under test. It follows one
// beat's rank under each storage's written rules and says which write stands
export type Storage = "A" | "B" | "C" | "D";
export type RegisterStep =
  | { op: "write"; by: number; label: string }
  | { op: "other"; by: number; label: string }
  | { op: "drop"; by: number }
  | { op: "sync" }
  | { op: "undo" | "redo"; by: number }
  | { op: "mark" };
export interface Snapshot { rank: string | null; undone: string[] }

interface Item { id: number; by: number; value: string; key: string; stamp: number; origin: Item | null; gone: { by: number; at: number } | null; redone: Set<number> }
interface Entry { other?: string; ins: Item[]; del: Item[]; drop?: boolean }

// why: each option's written rule, applied once every copy has every update; the four rules are listed in
// RESULT.md under "What each option changes elsewhere"
export function standings(storage: Storage, steps: readonly RegisterStep[]): Snapshot[] {
  const keyed = storage === "A" || storage === "B";
  let clock = 0, base = 0, list: Item[] = [], dropped = false;
  const make = (by: number, value: string, key: string, stamp: number, origin: Item | null): Item =>
    ({ id: clock++, by, value, key, stamp, origin, gone: null, redone: new Set() });
  list.push(make(-1, "start", "k-start", 1, null));
  base = clock;
  const undos = new Map<number, Entry[]>(), redos = new Map<number, Entry[]>(), undone = new Set<string>();
  const stack = (map: Map<number, Entry[]>, by: number): Entry[] => { const found = map.get(by) ?? []; map.set(by, found); return found; };
  const exists = (by: number, item: Item): boolean => item.id < base || item.by === by;
  const alive = (by: number, item: Item): boolean => exists(by, item) && (item.gone === null || (item.gone.at >= base && item.gone.by !== by));
  const remove = (item: Item, by: number): void => { item.gone ??= { by, at: clock++ }; };
  // why: items made at once after the same item are ordered by writer, lower first, as the library orders siblings
  const place = (item: Item): void => {
    let at = item.origin ? list.indexOf(item.origin) + 1 : 0;
    while (at < list.length && list[at]?.origin === item.origin && (list[at]?.by ?? 0) < item.by) at++;
    list.splice(at, 0, item);
  };
  const write = (by: number, value: string): Entry => {
    const seen = list.filter(item => alive(by, item)), last = list.filter(item => exists(by, item)).at(-1) ?? null;
    const stamp = 1 + Math.max(0, ...seen.map(item => item.stamp));
    const item = make(by, value, keyed ? "k-start" : `k${clock}`, stamp, keyed || storage === "D" ? last : null);
    if (storage === "C") list.push(item); else place(item);
    for (const old of seen) remove(old, by);
    if (dropped) remove(item, -2);
    return { ins: [item], del: seen };
  };
  const restore = (by: number, entry: Entry, before: readonly Item[]): Item[] => {
    const back: Item[] = [];
    for (const item of entry.del) {
      if (item.redone.has(by)) continue;
      const own = new Set([...entry.ins, ...stack(undos, by).flatMap(other => other.del), ...stack(redos, by).flatMap(other => other.del)]);
      const after = before.slice(before.indexOf(item) + 1).filter(other => other.key === item.key);
      if ((storage === "A" || storage === "C") && after.some(other => !own.has(other) && !other.redone.has(by))) continue;
      const copy = make(by, item.value, item.key, item.stamp, keyed ? list.at(-1) ?? null : item.origin);
      item.redone.add(by);
      if (storage === "D") list.splice(Math.max(0, list.indexOf(item)), 0, copy); else list.push(copy);
      if (keyed) for (const other of list) if (other !== copy) remove(other, by);
      back.push(copy);
    }
    return back;
  };
  const press = (by: number, from: Map<number, Entry[]>, to: Map<number, Entry[]>): void => {
    if (base !== clock) throw new Error("The model presses undo only on settled copies");
    for (let entry = stack(from, by).pop(); entry; entry = stack(from, by).pop()) {
      if (entry.other !== undefined) {
        if (undone.has(entry.other)) undone.delete(entry.other); else undone.add(entry.other);
        stack(to, by).push(entry);
        return;
      }
      const before = list;
      if (entry.drop) { dropped = !dropped; if (!dropped) list = []; }
      const gone = entry.ins.filter(item => item.gone === null);
      for (const item of gone) remove(item, by);
      const back = restore(by, entry, before);
      if (!entry.drop && !gone.length && !back.length && !entry.del.some(item => item.redone.has(by))) continue;
      stack(to, by).push({ ins: back, del: gone, ...entry.drop ? { drop: true } : {} });
      return;
    }
  };
  const read = (): string | null => {
    if (dropped) return "deleted";
    const live = list.filter(item => item.gone === null);
    if (keyed) { const last = list.at(-1); return last && last.gone === null ? last.value : null; }
    if (storage === "D") return live.at(-1)?.value ?? null;
    return live.toSorted((a, b) => b.stamp - a.stamp || b.by - a.by)[0]?.value ?? null;
  };
  const snapshots: Snapshot[] = [];
  for (const step of steps) {
    if (step.op === "write") { stack(undos, step.by).push(write(step.by, step.label)); stack(redos, step.by).length = 0; }
    else if (step.op === "other") { stack(undos, step.by).push({ other: step.label, ins: [], del: [] }); stack(redos, step.by).length = 0; }
    else if (step.op === "drop") {
      const seen = list.filter(item => alive(step.by, item));
      for (const item of seen) remove(item, step.by);
      dropped = true;
      stack(undos, step.by).push({ ins: [], del: seen, drop: true }); stack(redos, step.by).length = 0;
    } else if (step.op === "sync") {
      // why: once delivered, a map key keeps only its last item, as the library deletes the rest on arrival
      if (keyed) for (const item of list.slice(0, -1)) remove(item, -2);
      base = clock;
    } else if (step.op === "undo") press(step.by, undos, redos);
    else if (step.op === "redo") press(step.by, redos, undos);
    else snapshots.push({ rank: read(), undone: [...undone].sort() });
  }
  return snapshots;
}

export const snapshotKey = (snapshot: Snapshot): string => `${snapshot.rank ?? "none"}${snapshot.undone.length ? ` / undone ${snapshot.undone.join(", ")}` : ""}`;
