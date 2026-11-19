import { randomFor } from "../native/e5-histories.ts";

export type E10Field = "audioText" | "visualText";
export type E10Drop = { unit: "row" | "rows" | "scene"; first: string; last?: string; target: string | null; after: boolean; intoScene?: string };
export type E10Command =
  | { op: "move"; drop: E10Drop }
  | { op: "type"; id: string; field: E10Field; at: number; text: string }
  | { op: "format" | "tag"; id: string; from: number; to: number; key: string }
  | { op: "field"; id: string; key: string; value: string }
  | { op: "split"; id: string; at: number; newId: string }
  | { op: "join" | "unjoin" | "delete" | "removeHeading"; id: string }
  | { op: "heading"; id: string; newId: string; text: string }
  | { op: "rename"; id: string; at: number; text: string }
  | { op: "undo" | "redo"; contested?: boolean };
export type E10Step = { by: number; command: E10Command } | { from: number; to: number };
export type E10Kind = "join moving" | "join next" | "split landing" | "heading at source" | "scene overlap"
  | "split moving" | "same beat" | "opposing moves" | "same run cut" | "delete moving" | "delete landing"
  | "delete run start" | "heading at destination" | "rename moved heading" | "remove moved heading" | "undo remote move"
  | "undo remote edit" | "undo ranked split" | "late joiner" | "delete while editing" | "undo real deletion"
  | "two splits" | "move after seen split" | "split housekeeping vs move" | "heading above segment head" | "delete segment head"
  | "delete head while typing" | "drop between tied halves" | "drop onto heading";

export interface E10History { label: string; kind: E10Kind; steps: E10Step[]; expectation: string; preferred: (view: E10View) => boolean }
export interface E10View {
  order: string[];
  rows: { id: string; scene: string | null; start: boolean; members: string[] }[];
  cells: Record<string, string>;
}
interface DraftBlock { audioText: string; visualText: string; fields: Record<string, string | boolean>; joined: boolean; hidden: boolean }
interface Draft { order: string[]; blocks: Record<string, DraftBlock>; marks: Record<string, string[]> }
export type E10Facts = Record<string, unknown>;
export interface E10Event {
  step: number;
  by: number;
  command: E10Command;
  prior: E10Facts;
  effect: E10Facts;
  view: E10View | undefined;
  expected: E10Facts;
}

const entry = (audioText: string, visualText = "", fields: DraftBlock["fields"] = {}): DraftBlock =>
  ({ audioText, visualText, fields, joined: false, hidden: false });

export const seedBlocks = {
  "#P": entry("x"), A: entry("ab", "A", { note: "one" }), B: entry("cd", "B", { note: "two" }),
  C: entry("ef", "C", { paragraphStart: true }), D: entry("gh", "D"),
  "#Q": entry("y"), E: entry("ij", "E"), F: entry("kl", "F"), G: entry("mn", "G"), H: entry("op", "H")
};

export const initial = (): Draft => ({ order: Object.keys(seedBlocks), blocks: structuredClone(seedBlocks), marks: {} });
const chars = (text: string): string[] => text.split("");
const isHeading = (id: string): boolean => id.startsWith("#");
const need = <T>(x: T | undefined, label: string): T => {
  if (x === undefined) throw new Error(`Model could not find ${label}`);
  return x;
};

export function viewOf(draft: Draft): E10View {
  const rows: E10View["rows"] = [], order: string[] = [], cells: E10View["cells"] = {};
  let scene: string | null = null, row: E10View["rows"][number] | undefined;
  for (const id of draft.order) {
    const block = need(draft.blocks[id], id);
    cells[id] = block.audioText;
    if (isHeading(id)) {
      if (block.hidden) continue;
      scene = id;
      row = undefined;
    } else if (block.joined && row) row.members.push(id);
    else {
      row = { id, scene, start: !row || block.fields.paragraphStart === true, members: [id] };
      rows.push(row);
    }
    order.push(id);
  }
  return { order, rows, cells };
}

function facts(draft: Draft): E10Facts {
  const result: E10Facts = {};
  for (const [id, block] of Object.entries(draft.blocks)) {
    result[`id/${id}`] = true;
    if (block.joined) result[`join/${id}`] = true;
    if (block.hidden) result[`hide/${id}`] = true;
    for (const [key, value] of Object.entries(block.fields)) result[`field/${id}/${key}`] = value;
    for (const [field, text] of [["narration", block.audioText], ["visual", block.visualText]] as const) {
      for (const char of chars(text)) {
        result[`letter/${char}`] = field;
        for (const mark of draft.marks[char] ?? []) result[`mark/${char}/${mark}`] = true;
      }
    }
  }
  return result;
}

const difference = (before: E10Facts, after: E10Facts): E10Facts =>
  Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => before[key] !== after[key])
    .map(key => [key, after[key] ?? null]));
const apply = (state: E10Facts, patch: E10Facts): void => {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) Reflect.deleteProperty(state, key);
    else state[key] = value;
  }
};

function move(draft: Draft, drop: E10Drop): void {
  const { order } = draft, view = viewOf(draft);
  const bounds = (id: string): [number, number] => {
    if (drop.unit === "scene") {
      const from = order.indexOf(id), rest = order.slice(from + 1), end = rest.findIndex(next => isHeading(next) && !draft.blocks[next]?.hidden);
      if (from < 0) throw new Error(`Model missing scene ${id}`);
      return [from, end < 0 ? order.length - 1 : from + end];
    }
    const row = need(view.rows.find(item => item.id === id), id);
    return [order.indexOf(need(row.members[0], "first row member")), order.indexOf(need(row.members.at(-1), "last row member"))];
  };
  const [start, end] = bounds(drop.first), last = drop.last === undefined ? end : bounds(drop.last)[1];
  const [targetStart, targetEnd] = drop.target === null ? [-1, -1] : bounds(drop.target);
  const above = drop.intoScene ? "#" + drop.intoScene : order[drop.after ? targetEnd : targetStart - 1] ?? null;
  const selection = order.slice(start, last + 1);
  if (above !== null && selection.includes(above)) {
    if (above === selection.at(-1)) return;
    throw new Error("Model drop inside selection");
  }
  const remaining = order.filter(id => !selection.includes(id));
  remaining.splice(above === null ? 0 : remaining.indexOf(above) + 1, 0, ...selection);
  draft.order = remaining;
}

function edit(draft: Draft, command: Exclude<E10Command, { op: "undo" | "redo" }>): void {
  if (command.op === "move") { move(draft, command.drop); return; }
  const id = command.id, block = need(draft.blocks[id], id), index = draft.order.indexOf(id);
  if (command.op === "type" || command.op === "rename") {
    const field = command.op === "type" ? command.field : "audioText";
    const text = block[field];
    block[field] = text.slice(0, command.at) + command.text + text.slice(command.at);
  } else if (command.op === "format" || command.op === "tag") {
    for (const char of chars(block.audioText.slice(command.from, command.to))) (draft.marks[char] ??= []).push(command.key);
  } else if (command.op === "field") block.fields[command.key] = command.value;
  else if (command.op === "split") {
    draft.order.splice(index + 1, 0, command.newId);
    draft.blocks[command.newId] = entry(block.audioText.slice(command.at));
    block.audioText = block.audioText.slice(0, command.at);
  } else if (command.op === "join") block.joined = true;
  else if (command.op === "unjoin") block.joined = false;
  else if (command.op === "delete") {
    draft.order.splice(index, 1);
    Reflect.deleteProperty(draft.blocks, id);
  } else if (command.op === "heading") {
    draft.order.splice(index, 0, command.newId);
    draft.blocks[command.newId] = entry(command.text);
  } else if (command.op === "removeHeading") block.hidden = true;
}

export function compile(steps: E10Step[], writers: number): { events: E10Event[]; final: E10Facts } {
  const events: E10Event[] = [];
  const locals = Array.from({ length: writers }, () => ({
    draft: initial(), seen: new Set<E10Event>(), undo: [] as [Draft, Draft][], redo: [] as [Draft, Draft][], mixed: false
  }));
  const seed = facts(initial());
  const ledger = (seen: Set<E10Event>): E10Facts => {
    const result = { ...seed };
    for (const event of events) if (seen.has(event)) apply(result, event.effect);
    return result;
  };
  steps.forEach((step, index) => {
    if ("from" in step) {
      const source = need(locals[step.from], "sending writer"), target = need(locals[step.to], "receiving writer");
      const unseen = [...source.seen].filter(event => !target.seen.has(event));
      if (unseen.length && !target.seen.size) {
        target.draft = structuredClone(source.draft);
        target.mixed = source.mixed;
      } else if (unseen.length) target.mixed = true;
      for (const event of unseen) target.seen.add(event);
      return;
    }
    const { by, command } = step, local = need(locals[by], "editing writer"), before = structuredClone(local.draft), prior = ledger(local.seen);
    if (command.op === "undo" || command.op === "redo") {
      if (!command.contested) {
        const item = local[command.op].pop();
        if (!item) throw new Error("Model undo/redo has no command");
        local[command.op === "undo" ? "redo" : "undo"].push(item);
        local.draft = structuredClone(item[command.op === "undo" ? 0 : 1]);
      }
    } else {
      edit(local.draft, command as Exclude<E10Command, { op: "undo" | "redo" }>);
      if (JSON.stringify(before) !== JSON.stringify(local.draft)) {
        local.undo.push([before, structuredClone(local.draft)]);
        local.redo.length = 0;
      }
    }
    const effect = difference(facts(before), facts(local.draft));
    const event = { step: index, by, command, prior, effect, view: local.mixed || ("contested" in command && command.contested) ? undefined : viewOf(local.draft),
      expected: { ...prior } };
    apply(event.expected, effect);
    events.push(event);
    local.seen.add(event);
  });
  const final = { ...seed };
  for (const event of events) apply(final, event.effect);
  for (const key of Object.keys(final)) {
    const [part, id] = key.split("/");
    if (part === "join" && !final[`id/${id}`]) Reflect.deleteProperty(final, key);
    if (part === "mark" && !final[`letter/${id}`]) Reflect.deleteProperty(final, key);
  }
  return { events, final };
}

const write = (by: number, command: E10Command): E10Step => ({ by, command });
const a = (command: E10Command): E10Step => write(0, command);
const b = (command: E10Command): E10Step => write(1, command);
const ab: E10Step = { from: 0, to: 1 }, ba: E10Step = { from: 1, to: 0 };
const drop = (first: string, target: string | null, after = true, unit: E10Drop["unit"] = "row", last?: string): Extract<E10Command, { op: "move" }> =>
  ({ op: "move", drop: { unit, first, target, after, ...(last === undefined ? {} : { last }) } });
const split = (id: string, newId = "X", at = 1): E10Command => ({ op: "split", id, at, newId });
const join = (id: string): E10Command => ({ op: "join", id });
const remove = (id: string): E10Command => ({ op: "delete", id });
const heading = (id: string): E10Command => ({ op: "heading", id, newId: "#R", text: "z" });
const type = (id: string, field: E10Field, at: number, text: string): E10Command => ({ op: "type", id, field, at, text });
const A_MOVES = a(drop("B", "F"));
const run = a(drop("B", "F", true, "rows", "C"));
const scene = a(drop("#Q", "#P", false, "scene"));
const WHOLE = "#P A C D #Q E F B G H";
const START = "#P A B C D #Q E F G H";
const EXACT = (words: string) => (view: E10View): boolean => view.order.join(" ") === words;
const rowHas = (row: string, member: string) => (view: E10View): boolean => view.rows.some(item => item.id === row && item.members.includes(member));
const named = (kind: E10Kind, steps: E10Step[], expectation: string, preferred: E10History["preferred"]): E10History =>
  ({ kind, label: kind, steps, expectation, preferred });

export const namedHistories: E10History[] = [
  named("join moving", [A_MOVES, b(join("B"))], "B joins F at the destination", view => EXACT(WHOLE)(view) && rowHas("F", "B")(view)),
  named("join next", [a(drop("E", "H")), b(join("F"))], "F stays the first row under Q", view => EXACT("#P A B C D #Q F G H E")(view) && rowHas("F", "F")(view)),
  named("split landing", [A_MOVES, b(split("F"))], "B appears between the halves of F or after both", view =>
    EXACT("#P A C D #Q E F B X G H")(view) || EXACT("#P A C D #Q E F X B G H")(view)),
  named("heading at source", [A_MOVES, b(heading("B"))], "R stays where it was made before C", EXACT("#P A #R C D #Q E F B G H")),
  named("scene overlap", [scene, b(drop("F", "A"))], "Either requested neighbour holds, or there is another editable order", () => true),
  named("split moving", [A_MOVES, b(split("B"))], "B and X travel together below F, with c then d", view =>
    EXACT("#P A C D #Q E F B X G H")(view) && view.cells.B === "c" && view.cells.X === "d"),
  named("same beat", [A_MOVES, b(drop("B", "H"))], "B appears once at either destination", view =>
    EXACT(WHOLE)(view) || EXACT("#P A C D #Q E F G H B")(view)),
  named("opposing moves", [A_MOVES, b(drop("F", "B"))], "B follows F at the destination, or F follows B at the source", view =>
    EXACT(WHOLE)(view) || EXACT("#P A B F C D #Q E G H")(view)),
  named("same run cut", [a(drop("B", "F")), b(drop("B", "H", true, "rows", "C"))], "B and C are at A's and B's drops, or both at B's drop", view =>
    EXACT("#P A D #Q E F B G H C")(view) || EXACT("#P A D #Q E F G H B C")(view)),
  named("delete moving", [A_MOVES, b(remove("B"))], "B is gone and all other beats stay put", EXACT("#P A C D #Q E F G H")),
  named("delete landing", [A_MOVES, b(remove("F"))], "B stays where F was", EXACT("#P A C D #Q E B G H")),
  named("delete run start", [run, b(remove("B"))], "C still travels below F", EXACT("#P A D #Q E F C G H")),
  named("heading at destination", [A_MOVES, b(heading("G"))], "R stays between B and G", EXACT("#P A C D #Q E F B #R G H")),
  named("rename moved heading", [scene, b({ op: "rename", id: "#Q", at: 1, text: "w" })], "Q has its new name at the top", view =>
    EXACT("#Q E F G H #P A B C D")(view) && view.cells["#Q"] === "yw"),
  named("remove moved heading", [scene, b({ op: "removeHeading", id: "#Q" })], "The heading is hidden and its beats stay at the top",
    EXACT("E F G H #P A B C D")),
  named("undo remote move", [A_MOVES, ab, b(drop("B", "H")), ba, a({ op: "undo", contested: true }), a({ op: "redo", contested: true })],
    "B stays after H through undo and redo", EXACT("#P A C D #Q E F G H B")),
  named("undo remote edit", [A_MOVES, b(type("B", "audioText", 1, "q")), ba, a({ op: "undo", contested: true }), a({ op: "redo", contested: true })],
    "Undo takes B home and redo puts it back after F, both with cqd", view => EXACT(WHOLE)(view) && view.cells.B === "cqd"),
  named("undo ranked split", [a(split("B")), ab, b(drop("X", "F")), a({ op: "undo" })],
    "B becomes cd at the source and the undone split-off's old rank does not move C", view => EXACT(START)(view) && view.cells.B === "cd"),
  named("late joiner", [A_MOVES, b(type("B", "visualText", 1, "W"))], "A new copy opens with B below F, including the other person's visual edit", EXACT(WHOLE)),
  named("delete while editing", [a(remove("B")), b(type("B", "visualText", 1, "W")), b({ op: "field", id: "B", key: "remote", value: "kept" })],
    "Only the observed text and fields are deleted. The unseen edit stays reachable", () => true),
  named("undo real deletion", [A_MOVES, ab, b(remove("B")), b({ op: "undo" }), b({ op: "redo" })],
    "Undo restores the whole beat at its new place and redo removes it again", EXACT("#P A C D #Q E F G H")),
  named("two splits", [a(split("B", "X", 0)), b(split("B", "Y", 1))],
    "The split-off rows stay in the order of the typed text", view => EXACT("#P A B X Y C D #Q E F G H")(view) && view.cells.X === "c" && view.cells.Y === "d"),
  named("move after seen split", [b(split("B")), ba, A_MOVES],
    "Only B travels. X stays where the split was made", EXACT("#P A X C D #Q E F B G H")),
  named("split housekeeping vs move", [b(drop("B", "F")), ba, b(split("F")), a(drop("B", "H"))],
    "B's deliberate second move wins and lands after H", EXACT("#P A C D #Q E F X G H B")),
  named("heading above segment head", [a(drop("D", "F")), b(heading("D"))],
    "R remains empty at the source", EXACT("#P A B C #R #Q E F D G H")),
  named("delete segment head", [a(drop("D", "F")), b(remove("D"))],
    "D and its visual are gone, with all other beats in place", EXACT("#P A B C #Q E F G H")),
  named("delete head while typing", [a(drop("D", "F")), b(remove("D")), a(type("D", "audioText", 1, "q"))],
    "The unseen q remains reachable", () => true),
  named("drop between tied halves", [b(split("B")), ba, a(drop("D", "B"))],
    "D fits between the two halves that initially share a flat rank", EXACT("#P A B D X C #Q E F G H")),
  named("drop onto heading", [a({ op: "move", drop: { unit: "row", first: "B", target: null, after: false, intoScene: "Q" } })],
    "B becomes the first beat of Q and starts a paragraph", view =>
      EXACT("#P A C D #Q B E F G H")(view) && view.rows.some(row => row.id === "B" && row.scene === "#Q" && row.start))
];

export function generate(seed: number): E10History {
  const random = randomFor(seed * 7919), pick = <T>(items: T[]): T => need(items[Math.floor(random() * items.length)], "generated choice");
  const motifs = namedHistories;
  const motif = need(motifs[(seed - 1) % motifs.length], "generated history");
  const steps = [...motif.steps];
  const key = (offset: number): string => String.fromCharCode(0x100 + offset);
  const surprise = seed % 4 === 0;
  const third: E10Command[] = [
    type("H", "visualText", 0, key(1)),
    { op: "field", id: "D", key: "lens", value: "wide" },
    { op: "tag", id: "A", from: 0, to: 1, key: "t:prop" },
    { op: "format", id: "D", from: 1, to: 2, key: "b" },
    { op: "rename", id: "#P", at: 1, text: key(2) },
    split("D", "Z"),
    join("Z"), { op: "unjoin", id: "Z" },
    { op: "undo" }, { op: "redo" },
    { op: "heading", id: "E", newId: "#T", text: key(3) },
    { op: "removeHeading", id: "#T" }
  ];
  for (let index = 0; index < (seed % 5 === 0 ? 40 : 4); index++) {
    third.push(type(pick(["A", "C", "G"]), pick(["audioText", "visualText"]), 1, key(index + 4)));
    if (index % 3 === 2) {
      third.push({ op: "undo" }, { op: "redo" });
    }
  }
  if (surprise) {
    const draft = initial();
    for (const command of third) if (command.op !== "undo" && command.op !== "redo") {
      edit(draft, command as Exclude<E10Command, { op: "undo" | "redo" }>);
    }
    for (let i = 0; i < 3 + Math.floor(random() * 5); i++) {
      const rows = viewOf(draft).rows, from = pick(rows), other = pick(rows.filter(row => row !== from));
      const command = drop(from.id, other.id, random() < 0.5);
      move(draft, command.drop);
      third.push(command);
    }
  }
  steps.push(...third.map(command => write(2, command)));
  if (seed % 3 === 0) {
    steps.push({ from: 0, to: 2 }, write(2, type("H", "visualText", 0, key(60))),
      { from: 2, to: 1 }, b(type("E", "visualText", 0, key(61))));
  }
  return { ...motif, label: `generated ${seed}, ${motif.kind}`, steps,
    preferred: view => {
      const filtered: E10View = { ...view, order: view.order.filter(id => id !== "Z" && id !== "#T"),
        cells: Object.fromEntries(Object.entries(view.cells).map(([id, text]) => [id, text.replace(/[\u0100-\u01ff]/g, "")])) };
      if (motif.kind === "join next") return filtered.rows.some(row => row.id === "F" && row.scene === "#Q");
      return motif.preferred(filtered);
    }
  };
}
