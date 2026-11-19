// why: the evidence for the named histories; it imports nothing. A register model follows one stored value under each
// option's written rules, and the hand-written rows below say what a person sees for each value it can leave standing
export type Storage = "A" | "B" | "C" | "D" | "E";
export type RegisterStep =
  | { op: "write"; by: number; label: string }
  | { op: "other"; by: number; label: string }
  | { op: "drop"; by: number }
  | { op: "delete"; by: number }
  | { op: "sync" }
  | { op: "deliver"; from: number; to: number }
  | { op: "undo" | "redo"; by: number }
  | { op: "mark" };
export interface Snapshot { rank: string | null; undone: string[] }
export type Register = "rank" | "record";

interface Gone { by: number; id: number }
interface Item { id: number; by: number; value: string; key: string; stamp: number; origin: Item | null; gone: Gone[]; redone: Set<number> }
interface Entry { other?: string; ins: Item[]; del: Item[]; drop?: boolean }

// why: a record is a plain map entry in every option, so only B (its undo setting) and E (its fixed place) differ there
export const storageOf = (option: Storage, register: Register): Storage => register === "rank" || option === "B" || option === "E" ? option : "A";

// why: each option's written rule: one map key (A, E; B always brings it back), a key per write read by stamp (C), a
// list read by its last live element, where a redo goes back before its original (D)
export function standings(storage: Storage, steps: readonly RegisterStep[]): Snapshot[] {
  const keyed = storage === "A" || storage === "B" || storage === "E";
  const list: Item[] = [];
  let clock = 0, dropped = false;
  const known = new Map<number, Set<number>>(), seeded = 1;
  const knows = (by: number, id: number): boolean => id < seeded || by === -1 || (known.get(by)?.has(id) ?? false);
  const learn = (by: number, id: number): void => { const set = known.get(by) ?? new Set<number>(); set.add(id); known.set(by, set); };
  const make = (by: number, value: string, key: string, stamp: number, origin: Item | null): Item => {
    const item: Item = { id: clock++, by, value, key, stamp, origin, gone: [], redone: new Set() };
    learn(by, item.id);
    return item;
  };
  list.push(make(-1, "start", "k-start", 1, null));
  const exists = (by: number, item: Item): boolean => knows(by, item.id);
  const deletedFor = (by: number, item: Item): boolean => item.gone.some(gone => knows(by, gone.id));
  const lastExisting = (by: number): Item | null => list.filter(item => exists(by, item)).at(-1) ?? null;
  // why: a map key shows only its last item; an earlier one is deleted when the later one arrives
  const alive = (by: number, item: Item): boolean => exists(by, item) && !deletedFor(by, item) && (!keyed || lastExisting(by) === item);
  const remove = (item: Item, by: number): void => { const gone = { by, id: clock++ }; item.gone.push(gone); if (by >= 0) learn(by, gone.id); };
  const undos = new Map<number, Entry[]>(), redos = new Map<number, Entry[]>(), undone = new Set<string>();
  const stack = (map: Map<number, Entry[]>, by: number): Entry[] => { const found = map.get(by) ?? []; map.set(by, found); return found; };
  // why: items made at once after the same item are ordered by writer, lower first, as the library orders siblings
  const place = (item: Item, before: Item | null = null): void => {
    let at = item.origin ? list.indexOf(item.origin) + 1 : 0;
    while (at < list.length && list[at] !== before && list[at]?.origin === item.origin && (list[at]?.by ?? 0) < item.by) at++;
    list.splice(at, 0, item);
  };
  const write = (by: number, value: string): Entry => {
    const seen = list.filter(item => alive(by, item)), last = lastExisting(by);
    const stamp = 1 + Math.max(0, ...seen.map(item => item.stamp));
    const item = make(by, value, keyed ? "k-start" : `k${clock}`, stamp, keyed || storage === "D" ? last : null);
    if (storage === "C") list.push(item); else place(item);
    for (const old of seen) remove(old, by);
    if (dropped) remove(item, -2);
    return { ins: [item], del: seen };
  };
  const restore = (by: number, entry: Entry): Item[] => {
    const back: Item[] = [];
    for (const item of entry.del) {
      if (item.redone.has(by)) continue;
      const own = new Set([...entry.ins, ...stack(undos, by).flatMap(other => other.del), ...stack(redos, by).flatMap(other => other.del)]);
      const after = list.slice(list.indexOf(item) + 1).filter(other => other.key === item.key && exists(by, other));
      if (storage !== "B" && storage !== "D" && after.some(other => !own.has(other) && !other.redone.has(by))) continue;
      const left = list.slice(0, list.indexOf(item)).filter(other => exists(by, other)).at(-1) ?? null;
      const copy = make(by, item.value, item.key, item.stamp, keyed ? lastExisting(by) : storage === "D" ? left : item.origin);
      item.redone.add(by);
      if (keyed) place(copy); else if (storage === "D") place(copy, item); else list.push(copy);
      back.push(copy);
    }
    return back;
  };
  const press = (by: number, from: Map<number, Entry[]>, to: Map<number, Entry[]>): void => {
    for (let entry = stack(from, by).pop(); entry; entry = stack(from, by).pop()) {
      if (entry.other !== undefined) {
        if (undone.has(entry.other)) undone.delete(entry.other); else undone.add(entry.other);
        stack(to, by).push(entry);
        return;
      }
      if (entry.drop) dropped = !dropped;
      const gone = entry.ins.filter(item => alive(by, item));
      for (const item of gone) remove(item, by);
      const back = restore(by, entry);
      if (!entry.drop && !gone.length && !back.length && !entry.del.some(item => item.redone.has(by))) continue;
      stack(to, by).push({ ins: back, del: gone, ...entry.drop ? { drop: true } : {} });
      return;
    }
  };
  const read = (): string | null => {
    if (dropped) return "deleted";
    const live = list.filter(item => !item.gone.length);
    if (keyed) { const last = list.at(-1); return last && !last.gone.length ? last.value : storage === "E" ? "fixed" : null; }
    if (storage === "D") return live.at(-1)?.value ?? null;
    return live.toSorted((a, b) => b.stamp - a.stamp || b.by - a.by)[0]?.value ?? null;
  };
  const everyone = steps.flatMap(step => "by" in step ? [step.by] : "from" in step ? [step.from, step.to] : []);
  const writers = (): number[] => [...new Set([...everyone, ...known.keys(), ...list.map(item => item.by)])].filter(by => by >= 0);
  const snapshots: Snapshot[] = [];
  let settled = true;
  for (const step of steps) {
    if (step.op === "write") { stack(undos, step.by).push(write(step.by, step.label)); stack(redos, step.by).length = 0; settled = false; }
    else if (step.op === "other") { stack(undos, step.by).push({ other: step.label, ins: [], del: [] }); stack(redos, step.by).length = 0; }
    else if (step.op === "drop" || step.op === "delete") {
      const seen = list.filter(item => alive(step.by, item));
      for (const item of seen) remove(item, step.by);
      if (step.op === "drop") dropped = true;
      stack(undos, step.by).push({ ins: [], del: seen, ...step.op === "drop" ? { drop: true } : {} }); stack(redos, step.by).length = 0;
      settled = false;
    } else if (step.op === "sync") {
      const all = [...list.map(item => item.id), ...list.flatMap(item => item.gone.map(gone => gone.id))];
      for (const by of writers()) for (const id of all) learn(by, id);
      settled = true;
    } else if (step.op === "deliver") { for (const id of known.get(step.from) ?? []) learn(step.to, id); }
    else if (step.op === "undo") { press(step.by, undos, redos); settled = false; }
    else if (step.op === "redo") { press(step.by, redos, undos); settled = false; }
    else {
      if (!settled) throw new Error("The model reads only once every copy has every update");
      snapshots.push({ rank: read(), undone: [...undone].sort() });
    }
  }
  return snapshots;
}

export const snapshotKey = (snapshot: Snapshot): string => `${snapshot.rank ?? "none"}${snapshot.undone.length ? ` / undone ${snapshot.undone.join(", ")}` : ""}`;

// why: a row is `id: narration / visual`, a heading `#id name`. Short forms: a bare id is a row whose narration is its
// id in lower case and whose visual cell is empty; `#H` is a heading whose name is `h`
// why: `N=b` is a row N whose narration is `b`, for rows a split gave new narration
const short = (text: string): string[] => text.split(", ").map(part => part.startsWith("#") ? `${part} ${part.slice(1).toLowerCase()}`
  : part.includes("=") ? `${part.split("=")[0]}: ${part.split("=")[1]} / ` : `${part}: ${part.toLowerCase()} / `);
const BASE_NAMES: Record<string, string> = { "#H": "mno", "#I": "stu" };
const BASE_ROWS: Record<string, string> = { A: "A: abc / 1", B: "B: def / 2", C: "C: ghi / 3", D: "D: jkl / 4", E: "E: pqr / 5", F: "F: vwx / 6" };
const full = (text: string): string[] => text.split(", ").map(part => part.startsWith("#") ? `${part} ${BASE_NAMES[part]}` : BASE_ROWS[part] ?? part);
const RACE = { bob: short("#H, B, A") };
const DRIFT = "beats B changed scene with one person working";
const EMPTY_REDO = "redo popped an item but changed nothing stored";
const SPLIT_RANKLESS = "split-off N has no rank";
const OPTION_LETTERS = ["A", "B", "C", "D", "E"] as const;
type Listed = Partial<Record<Storage, { at: number; problem: string }[]>>;
const lostOf = (id: string): string[] => [`beat ${id} has no record`, `beat ${id} has no visual cell`];
const lostAt = (at: number, extra: { at: number; problem: string }[] = [], id = "B", extraIn: readonly Storage[] = ["A", "B", "C", "D"]): Listed =>
  Object.fromEntries(OPTION_LETTERS.map(option => [option, [...lostOf(id).map(problem => ({ at, problem })), ...extraIn.includes(option) ? extra : []]]));
const every = (at: number, problem: string): Listed => Object.fromEntries(OPTION_LETTERS.map(option => [option, [{ at, problem }]]));

// why: rows per part by the model's reading, or by option (`all`: every option); never, local and threw by part;
// seenLater and moved: options whose press moves a later seen placement, or rows the pressed command did not place
export interface Expected {
  rows: Record<string, string[]>[]; never?: Listed; local?: Listed; threw?: Listed; seenLater?: Storage[]; moved?: Storage[]; blockedRedo?: Storage[];
}

export const EXPECTED: Record<string, Expected> = {
  "winner undoes, then the loser deletes A": {
    rows: [RACE, { none: short("#H, A, B"), start: short("B, #H, A"), alice: short("#H, A, B"), fixed: short("B, #H, A") },
      { none: short("B, #H"), start: short("B, #H"), alice: short("#H, B"), fixed: short("B, #H") }],
    never: { A: [{ at: 2, problem: DRIFT }] }
  },
  "loser undoes, then the loser deletes A": {
    rows: [RACE, { "bob / undone A into H": short("A, #H, B"), start: short("B, #H, A"), bob: short("#H, B, A") },
      { "bob / undone A into H": short("#H, B"), start: short("B, #H"), bob: short("#H, B") }],
    seenLater: ["B"]
  },
  "winner undoes, then redoes": {
    rows: [RACE, { none: short("#H, A, B"), start: short("B, #H, A"), alice: short("#H, A, B"), fixed: short("B, #H, A") }, { bob: short("#H, B, A") }]
  },
  "three people move one beat at once, each undoes in turn": {
    rows: [{ carol: short("B, A, C, D") }, { none: short("A, B, C, D"), start: short("A, B, C, D"), fixed: short("A, B, C, D"), bob: short("A, C, D, B") },
      { none: short("A, B, C, D"), start: short("A, B, C, D"), fixed: short("A, B, C, D"), alice: short("A, C, B, D") },
      { none: short("A, B, C, D"), start: short("A, B, C, D"), fixed: short("A, B, C, D") }]
  },
  "E11's six-step deletion history": {
    rows: [{ deleted: short("#H, A") }, { none: short("#H, A, B"), start: short("B, #H, A"), fixed: short("B, #H, A") },
      { none: short("B, #H"), start: short("B, #H"), fixed: short("B, #H") }],
    never: { A: [{ at: 2, problem: DRIFT }] }
  },
  "a move, someone else's seen move of the same beat, the first person's undo": {
    rows: [{ alice: short("A, C, B, D") }, { bob: short("A, C, D, B") }, { bob: short("A, C, D, B"), start: short("A, B, C, D") }],
    seenLater: ["B"]
  },
  "a move while someone else splits the beat unseen, then the mover undoes": {
    rows: [{ alice: ["A: a / ", "N: b / ", "C: c / ", "D: d / ", "B:  / "] }, { start: ["A: a / ", "B:  / ", "N: b / ", "C: c / ", "D: d / "] }]
  },
  "a heading move against a beat move into that scene, then each undoes": {
    rows: [{ bob: full("A, C, D, B, #I, F, #H, E") }, { start: full("A, B, C, D, #I, F, #H, E") }, { "start / undone scene H": full("A, B, C, D, #H, E, #I, F") }]
  },
  "an older redo of a heading move against a later move the presser had seen": {
    rows: [{ start: short("A, #H, #I") }, { alice: short("#H, A, #I") }, { alice: short("#H, A, #I"), bob: short("A, #I, #H") }],
    local: { A: [{ at: 2, problem: EMPTY_REDO }], E: [{ at: 2, problem: EMPTY_REDO }] },
    seenLater: ["B", "C"], blockedRedo: ["A", "E"]
  },
  "three people: a redo and an undo of heading moves around a later move": {
    rows: [{ top: short("#H, A, #I"), carol: short("A, #I, #H"), start: short("A, #H, #I") }],
    local: { A: [{ at: 0, problem: EMPTY_REDO }], E: [{ at: 0, problem: EMPTY_REDO }] },
    seenLater: ["B", "C", "D"], blockedRedo: ["A", "E"]
  },
  "a row moved earlier, then two moves at once and the winner's undo": {
    rows: [{ earlier: short("A, C, D, B") }, { bob: short("B, A, C, D") },
      { none: short("A, B, C, D"), earlier: short("A, C, D, B"), alice: short("A, C, B, D"), fixed: short("A, B, C, D") }]
  },
  "both delete a row offline and undo, one redoes: the row loses its record": {
    rows: [{ none: short("A, B"), fixed: short("A, B") }],
    never: lostAt(0)
  },
  "a row that lost its record under a moved neighbour, then the neighbour is deleted": {
    rows: [{ start: short("B, #H, A") }, { none: short("#H, A, B"), fixed: short("B, #H, A") }, { none: short("B, #H"), fixed: short("B, #H") }],
    never: lostAt(1, [{ at: 2, problem: DRIFT }])
  },
  "a new row inserted before a row that lost its record": {
    rows: [{ none: short("A, B"), fixed: short("A, B") }, { none: short("N, A, B"), fixed: short("A, N, B") }],
    never: lostAt(0)
  },
  "a rankless row split, a move into the gap, a heading above the split-off, the mover's undo": {
    rows: [
      { A: short("A, B, C, D"), B: short("A, B, C, D"), C: short("A, C, B, D"), D: short("A, C, B, D"), E: short("A, B, C, D") },
      { A: short("A, B=, N=b, C, D"), B: short("A, B=, N=b, C, D"), C: short("A, C, B=, N=b, D"), D: short("A, C, B=, N=b, D"), E: short("A, B=, N=b, C, D") },
      { A: short("A, B=, D, N=b, C"), B: short("A, B=, D, N=b, C"), C: short("A, C, B=, D, N=b"), D: short("A, C, B=, D, N=b"), E: short("A, B=, D, N=b, C") },
      { A: short("A, B=, D, #H, N=b, C"), B: short("A, B=, D, #H, N=b, C"), C: short("A, C, B=, D, #H, N=b"), D: short("A, C, B=, D, #H, N=b"), E: short("A, B=, D, #H, N=b, C") },
      { A: short("A, B=, #H, N=b, C, D"), B: short("A, B=, N=b, #H, C, D"), C: short("A, C, B=, N=b, D, #H"), D: short("A, C, B=, N=b, D, #H"), E: short("A, B=, N=b, #H, C, D") }
    ],
    local: { A: [{ at: 1, problem: SPLIT_RANKLESS }], E: [{ at: 1, problem: SPLIT_RANKLESS }] },
    moved: ["B", "C", "D", "E"]
  },
  "a rankless row split, a move into the gap, another row moved into it, the mover's undo": {
    rows: [
      { A: short("A, B, C, D, X"), B: short("A, B, C, D, X"), C: short("A, C, B, D, X"), D: short("A, C, B, D, X"), E: short("A, B, C, D, X") },
      { A: short("A, B=, N=b, C, D, X"), B: short("A, B=, N=b, C, D, X"), C: short("A, C, B=, N=b, D, X"), D: short("A, C, B=, N=b, D, X"), E: short("A, B=, N=b, C, D, X") },
      { A: short("A, B=, D, N=b, C, X"), B: short("A, B=, D, N=b, C, X"), C: short("A, C, B=, D, N=b, X"), D: short("A, C, B=, D, N=b, X"), E: short("A, B=, D, N=b, C, X") },
      { A: short("A, B=, D, X, N=b, C"), B: short("A, B=, D, X, N=b, C"), C: short("A, C, B=, D, X, N=b"), D: short("A, C, B=, D, X, N=b"), E: short("A, B=, D, X, N=b, C") },
      { A: short("A, B=, X, N=b, C, D"), B: short("A, B=, N=b, X, C, D"), C: short("A, C, B=, N=b, X, D"), D: short("A, C, B=, N=b, X, D"), E: short("A, B=, N=b, X, C, D") }
    ],
    local: { A: [{ at: 1, problem: SPLIT_RANKLESS }], E: [{ at: 1, problem: SPLIT_RANKLESS }] },
    moved: ["B", "C", "D", "E"]
  },
  "a healthy row moved to the top after another lost its record": {
    rows: [{ all: short("A, B, C") }, { all: short("C, A, B") }],
    never: lostAt(0), threw: every(1, "move: Missing record b:B")
  },
  "a heading created above a row that lost its record": {
    rows: [{ all: short("A, B") }, { all: short("A, #H, B") }],
    never: lostAt(0), threw: every(1, "heading: Missing record b:B")
  },
  "a document where one row's boundary has no fixed place: B rankless, C without a record, A deleted": {
    rows: [
      { all: short("B, #H, A, C") },
      { A: short("#H, A, B, C"), B: short("B, #H, A, C"), C: short("#H, A, B, C"), D: short("#H, A, B, C"), E: short("B, #H, A, C") },
      { A: short("#H, C, A, B"), B: short("B, #H, C, A"), C: short("#H, C, A, B"), D: short("#H, C, A, B"), E: short("#H, C, A, B") },
      { A: short("B, #H, C"), B: short("B, #H, C"), C: short("#H, C, B"), D: short("#H, C, B"), E: short("B, #H, C") }
    ],
    never: lostAt(2, [{ at: 3, problem: DRIFT }], "C", ["A", "E"])
  },
  "history 1 on a document whose boundaries have no fixed place": {
    rows: [{ all: short("#H, B, A") }, { A: short("#H, A, B"), B: short("B, #H, A"), C: short("#H, A, B"), D: short("#H, A, B"), E: short("#H, A, B") },
      { A: short("B, #H"), B: short("B, #H"), C: short("#H, B"), D: short("#H, B"), E: short("B, #H") }],
    never: { A: [{ at: 2, problem: DRIFT }], E: [{ at: 2, problem: DRIFT }] }
  },
  "a move, someone else's seen range move that carries the beat, the first person's undo": {
    rows: [{ all: short("A, C, B, D") }, { all: short("A, D, C, B") }, { A: short("A, D, C, B"), B: short("A, B, D, C"), C: short("A, D, C, B"), D: short("A, D, C, B"), E: short("A, D, C, B") }],
    seenLater: ["B"]
  }
};
