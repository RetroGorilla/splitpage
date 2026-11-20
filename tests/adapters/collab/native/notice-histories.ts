import type { NoticeHistoryEffect } from "./notice-history-model.ts";

export interface NoticeFixtureMarker { kind: "b" | "h"; id: string }
type Unit = string | NoticeFixtureMarker;
export interface NoticeFixtureSegmentReading { head: NoticeFixtureMarker | null; units: Unit[] }
export interface NoticeFixtureStoredReading {
  order: string[];
  segments: Record<string, NoticeFixtureSegmentReading>;
  beats: Record<string, { status?: string; joined?: { into: string; glue: string } }>;
  visuals: Record<string, string>;
  headings: Record<string, { removed?: boolean }>;
}

export const beat = (id: string): NoticeFixtureMarker => ({ kind: "b", id });
export const heading = (id: string): NoticeFixtureMarker => ({ kind: "h", id });

export const base: NoticeFixtureStoredReading = {
  order: ["S", "T", "U", "V"],
  segments: {
    S: { head: beat("A"), units: [..."abc", beat("B"), ..."def", beat("C"), ..."ghi"] },
    T: { head: beat("D"), units: [..."jkl", heading("H"), ..."mno", beat("E"), ..."pqr"] },
    U: { head: heading("I"), units: [..."stu"] },
    V: { head: beat("F"), units: [..."vwx"] }
  },
  beats: { A: {}, B: { status: "todo" }, C: {}, D: {}, E: {}, F: {} },
  visuals: { A: "1", B: "2", C: "3", D: "4", E: "5", F: "6" },
  headings: { H: {}, I: {} }
};

export const sole: NoticeFixtureStoredReading = {
  order: ["S"], segments: { S: { head: beat("A"), units: [..."abc"] } },
  beats: { A: {} }, visuals: { A: "1" }, headings: {}
};

type Cell = "audio" | "visual" | "name";
export type NoticeFixtureDeleteCommand =
  | { op: "rows"; ids: string[] }
  | { op: "scene"; id: string }
  | { op: "heading"; id: string; removal: "flag" | "delete" }
  | { op: "type"; id: string; field: Cell; at: number; value: string }
  | { op: "erase"; id: string; field: Cell; from: number; to: number }
  | { op: "mark"; id: string; field: "audio" | "visual"; from: number; to: number; key: string }
  | { op: "field"; id: string; value: string }
  | { op: "split"; id: string; at: number; created: string }
  | { op: "insert"; before: string; created: string; value: string }
  | { op: "join"; id: string }
  | { op: "unjoin"; id: string }
  | { op: "create"; above: string; id: string; value: string };

export interface NoticeFixtureExpectedBlock extends NoticeFixtureMarker { segment: string; from: number; to: number; text: string }
export function need<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Missing ${description}`);
  return value;
}

export function blocks(stored: NoticeFixtureStoredReading): NoticeFixtureExpectedBlock[] {
  const result: NoticeFixtureExpectedBlock[] = [];
  for (const segment of stored.order) {
    const { head, units } = need(stored.segments[segment], segment);
    let open: NoticeFixtureExpectedBlock | undefined;
    const begin = (marker: NoticeFixtureMarker, index: number): void => {
      if (open) open.to = index - 1;
      open = { ...marker, segment, from: index, to: units.length, text: "" };
      result.push(open);
    };
    if (head) begin(head, 0);
    for (const [index, unit] of units.entries()) {
      if (typeof unit !== "string") begin(unit, index + 1);
      else if (open) open.text += unit;
    }
  }
  return result;
}

interface DeleteHistory {
  name: string;
  initial: NoticeFixtureStoredReading;
  forks: NoticeFixtureDeleteCommand[][];
}

const rows = (...ids: string[]): NoticeFixtureDeleteCommand => ({ op: "rows", ids });
const typing = (id: string, field: "audio" | "visual" | "name", at: number, value = "Ω"): NoticeFixtureDeleteCommand =>
  ({ op: "type", id, field, at, value });

function histories(seed: number): DeleteHistory[] {
  const at = seed % 4, inside = 1 + seed % 2;
  const make = (name: string, a: NoticeFixtureDeleteCommand, b: NoticeFixtureDeleteCommand[], initial = base): DeleteHistory =>
    ({ name, initial, forks: [[a], b] });
  const joined = structuredClone(base);
  joined.beats.C = { joined: { into: "B", glue: " " } };
  const across = structuredClone(joined);
  across.beats.D = { joined: { into: "C", glue: " " } };
  return [
    make("inline narration", rows("B"), [typing("B", "audio", at)]),
    make("head narration", rows("A"), [typing("A", "audio", at)]),
    make("tail narration", rows("C"), [typing("C", "audio", at)]),
    make("sole segment narration", rows("F"), [typing("F", "audio", at)]),
    make("only beat narration", rows("A"), [typing("A", "audio", at)], sole),
    make("visual typing", rows("B"), [typing("B", "visual", seed % 2)]),
    make("text erase", rows("B"), [{ op: "erase", id: "B", field: seed % 2 ? "visual" : "audio", from: 0, to: 1 }]),
    make("format audio", rows("B"), [{ op: "mark", id: "B", field: "audio", from: 0, to: inside, key: "b" }]),
    make("tag audio", rows("B"), [{ op: "mark", id: "B", field: "audio", from: 1, to: 3, key: "t:T" }]),
    make("tag visual", rows("B"), [{ op: "mark", id: "B", field: "visual", from: 0, to: 1, key: "t:T" }]),
    make("field", rows("B"), [{ op: "field", id: "B", value: "ready" }]),
    make("inline split", rows("B"), [{ op: "split", id: "B", at: inside, created: "N" }, typing("N", "visual", 0)]),
    make("head split", rows("A"), [{ op: "split", id: "A", at: inside, created: "N" }, typing("N", "visual", 0)]),
    make("only beat split", rows("A"), [{ op: "split", id: "A", at: inside, created: "N" }, typing("N", "visual", 0)], sole),
    make("only beat split then narration", rows("A"), [{ op: "split", id: "A", at: inside, created: "N" }, typing("N", "audio", 1)], sole),
    make("join deleted up", rows("B"), [{ op: "join", id: "B" }]),
    make("join below to deleted", rows("B"), [{ op: "join", id: "C" }, typing("C", "audio", 1)]),
    make("unjoin selected member", rows("B"), [{ op: "unjoin", id: "C" }], joined),
    make("inline heading create", rows("B"), [{ op: "create", above: "B", id: "J", value: "Ω" }]),
    make("segment heading create", rows("A"), [{ op: "create", above: "A", id: "J", value: "Ω" }]),
    make("heading name insert", rows("E"), [typing("H", "name", seed % 4)]),
    make("heading name erase", rows("E"), [{ op: "erase", id: "H", field: "name", from: inside - 1, to: inside }]),
    make("heading above flag", rows("E"), [{ op: "heading", id: "H", removal: "flag" }]),
    make("heading above delete", rows("E"), [{ op: "heading", id: "H", removal: "delete" }]),
    make("embedded heading flag versus rename", { op: "heading", id: "H", removal: "flag" }, [typing("H", "name", at)]),
    make("embedded heading delete versus rename", { op: "heading", id: "H", removal: "delete" }, [typing("H", "name", at)]),
    make("head heading flag versus rename", { op: "heading", id: "I", removal: "flag" }, [typing("I", "name", at)]),
    make("head heading delete versus rename", { op: "heading", id: "I", removal: "delete" }, [typing("I", "name", at)]),
    make("same row", rows("B"), [rows("B")]),
    make("neighbor left", rows("B"), [rows("A")]),
    make("neighbor right", rows("B"), [rows("C")]),
    make("cross segment joined", rows("B"), [typing("D", "audio", at)], across),
    make("run of rows", rows("B", "C", "D"), [typing(seed % 2 ? "C" : "D", "audio", at)]),
    make("scene name", { op: "scene", id: "H" }, [typing("H", "name", at)]),
    make("scene beat", { op: "scene", id: "H" }, [typing("E", "audio", at)]),
    make("scene head", { op: "scene", id: "I" }, [typing("F", "audio", at)]),
    make("insert neighbor", rows("B"), [{ op: "insert", before: "D", created: "N", value: "Ω" }, typing("N", "visual", 0, "Ψ")])
  ];
}

export const tagSweepRemovals = ["cut", "same", "all", "first"] as const;
const audioRanges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]] as const;
export const tagSweepCases = [...audioRanges.map(range => ({ field: "audio" as const, range })),
  { field: "visual" as const, range: [0, 1] as const }];

export type NoticeHistoryCommand = NoticeFixtureDeleteCommand | { op: "undo" | "redo" } | { op: "move"; id: string; after: string } |
  { op: "detail"; id: string; key: string; value: unknown };
export type NoticeFixtureStep =
  | { person: number; command: NoticeHistoryCommand; effect: NoticeHistoryEffect }
  | { from: number; to: number; ack?: true };

export interface NoticeHistory {
  name: string;
  initial: NoticeFixtureStoredReading;
  copies: number;
  stretches: { offline: readonly number[]; steps: NoticeFixtureStep[]; order?: number[] }[];
}

const other: NoticeHistoryEffect = { action: "other" };
const remove = (...ids: string[]): NoticeHistoryEffect => ({ action: "delete", ids });
type NoticeEdit = Extract<NoticeHistoryEffect, { action: "edit" }>;
const edit = (id: string, kind: NoticeEdit["kind"], details: Partial<NoticeEdit> = {}): NoticeHistoryEffect =>
  ({ action: "edit", id, kind, ...details });
const step = (person: number, command: NoticeHistoryCommand, effect: NoticeHistoryEffect): NoticeFixtureStep => ({ person, command, effect });
const cut = (person: number, id: string, above?: string): NoticeFixtureStep =>
  step(person, { op: "rows", ids: [id] }, { action: "delete", ids: [id], ...(above ? { above } : {}) });
const undo = (person: number): NoticeFixtureStep => step(person, { op: "undo" }, { action: "undo" });
const type = (person: number, id: string, field: "audio" | "visual", value: string, at = 1): NoticeFixtureStep =>
  step(person, { op: "type", id, field, at, value }, edit(id, field === "audio" ? "narration" : "visual", { token: value }));
const mark = (person: number, id: string, field: "audio" | "visual", key: string, from = 0, to = from + 1): NoticeFixtureStep =>
  step(person, { op: "mark", id, field, from, to, key },
    edit(id, "marks", { mark: key, from, column: field === "audio" ? "narration" : "visual" }));
const status = (person: number, id: string, value: string): NoticeFixtureStep =>
  step(person, { op: "field", id, value }, edit(id, "record", { field: "status" }));
const note = (person: number, id: string): NoticeFixtureStep =>
  step(person, { op: "detail", id, key: "notes", value: "changed" }, edit(id, "record", { field: "notes" }));
const split = (person: number, id: string, created: string, at = 1): NoticeFixtureStep =>
  step(person, { op: "split", id, at, created }, { action: "create", id: created, from: id });
const insert = (person: number, before: string, created: string): NoticeFixtureStep =>
  step(person, { op: "insert", before, created, value: "new" }, { action: "create", id: created });

export function namedHistories(): NoticeHistory[] {
  return histories(1).flatMap(({ name, initial, forks }) => {
    const steps = forks.flatMap((commands, person) => commands.map(command => {
      let effect = other;
      switch (command.op) {
        case "rows": effect = remove(...command.ids, ...name === "cross segment joined" ? ["C", "D"] :
          name === "unjoin selected member" ? ["C"] : []); break;
        case "scene": effect = remove(command.id, command.id === "H" ? "E" : "F"); break;
        case "heading": if (command.removal === "delete") effect = remove(command.id); break;
        case "type":
          effect = edit(command.id, command.field === "visual" ? "visual" : "narration", { token: command.value });
          break;
        case "mark": effect = edit(command.id, "marks", { mark: command.key, from: command.from,
          column: command.field === "audio" ? "narration" : "visual" }); break;
        case "field": effect = edit(command.id, "record", { field: "status" }); break;
        case "join": effect = edit(command.id, "join", { into: command.id === "C" ? "B" : "A" }); break;
        case "unjoin": effect = edit(command.id, "join"); break;
        case "split": effect = { action: "create", id: command.created, from: command.id }; break;
        case "insert": effect = { action: "create", id: command.created }; break;
      }
      if (effect.action === "delete") {
        const ordered = blocks(initial);
        const at = ordered.findIndex(block => effect.action === "delete" && effect.ids.includes(block.id));
        const above = ordered.slice(0, Math.max(0, at)).findLast(block => block.kind === "b")?.id;
        if (above) effect.above = above;
        if (name === "run of rows") effect.landing = "A";
        if (name === "scene name" || name === "scene beat" || name === "embedded heading delete versus rename") effect.landing = "D";
      }
      return step(person, command, effect);
    }));
    return [0, 1].map(person => ({ name: `${name} / offline ${person}`, initial, copies: 2, stretches: [{ offline: [person], steps }] }));
  }).concat([
    { name: "double delete and undo", initial: base, copies: 2, stretches: [{ offline: [0, 1], steps: [cut(0, "B"), undo(0), cut(1, "B"), undo(1)] }] },
    ...(["insert", "split"] as const).flatMap(creation => [0, 1].map(person => ({
      name: `undo ${creation} / offline ${person}`, initial: base, copies: 2, stretches: [{
        offline: [person], steps: [creation === "insert" ? insert(0, "D", "N") : split(0, "B", "N"),
          { from: 0, to: 1 }, type(1, "N", "audio", "⟡"), type(1, "N", "visual", "♠", 0),
          status(1, "N", "filmed"), undo(0)]
      }]
    }))),
    ...([
      type(0, "B", "visual", "Ω"), status(0, "B", "ready"), note(0, "B"),
      mark(0, "B", "visual", "t:TAG"), mark(0, "B", "audio", "t:TAG", 1),
      step(0, { op: "erase", id: "B", field: "visual", from: 0, to: 1 }, edit("B", "visual", { token: "2", erased: true }))
    ] as const).map((change, index) => ({ name: `unseen edit then cut and undo ${index}`, initial: base,
      copies: 2, stretches: [{ offline: [0, 1], steps: [change, cut(1, "B", "A"), undo(1)] }] }))
  ]);
}

function generatedBase(): NoticeFixtureStoredReading {
  const initial = structuredClone(base);
  for (const suffix of ["0", "1"]) {
    const ids = ["A" + suffix, "B" + suffix, "C" + suffix] as const;
    initial.order.push("work" + suffix);
    initial.segments["work" + suffix] = {
      head: { kind: "b", id: ids[0] },
      units: [..."abc", { kind: "b", id: ids[1] }, ..."def", { kind: "b", id: ids[2] }, ..."ghi"]
    };
    ids.forEach(id => { initial.beats[id] = { status: "todo" }; initial.visuals[id] = "x"; });
  }
  return initial;
}

export function generatedHistory(seed: number, copies: number): NoticeHistory {
  let state = seed + 1;
  function next(max: number): number {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  }
  const stretches = [0, 1].map(stretch => {
    const a = "A" + stretch, b = "B" + stretch, c = "C" + stretch, n = "N" + stretch;
    const writer = next(copies);
    const deleter = (writer + 1 + next(copies - 1)) % copies;
    const role = (Math.floor(seed / 12) + stretch) % 4;
    const mode = seed < 72 ? (seed + 5 * stretch) % 12 : 12 + (seed - 72 + 5 * stretch) % 12;
    const idle = copies === 3 ? 3 - writer - deleter : deleter;
    const offline = mode === 22 ? [idle] : role === 0 ? [writer, deleter] : [role < 2 ? writer : deleter];
    const token = String.fromCodePoint(0xe000 + stretch * 256 + seed);
    const commands: NoticeFixtureStep[] = [];
    const move = (person: number) => step(person, { op: "move", id: b, after: c }, { action: "move", id: b, after: c });
    const removeBeat = () => cut(deleter, b, a);
    const seen = { from: writer, to: deleter };
    switch (mode) {
      case 0: commands.push(type(writer, b, "audio", token, next(4)), removeBeat()); break;
      case 1: commands.push(type(writer, b, "visual", token, next(2)), removeBeat()); break;
      case 2: commands.push(mark(writer, b, next(2) ? "audio" : "visual", seed % 3 === 0 ? "b" : "t:TAG"), removeBeat()); break;
      case 3: commands.push(status(writer, b, "ready"), removeBeat()); break;
      case 4: commands.push(step(writer, { op: "join", id: c }, edit(c, "join", { into: b })), removeBeat()); break;
      case 5: commands.push(split(writer, b, n, 1 + next(2)), removeBeat()); break;
      case 6: commands.push(split(writer, b, n, 1 + next(2)), move(deleter)); break;
      case 7: commands.push(cut(writer, b, a), undo(writer), removeBeat(), undo(deleter)); break;
      case 8: commands.push(type(writer, b, "visual", token), seen, removeBeat()); break;
      case 9: commands.push(type(writer, b, "audio", token), undo(writer), removeBeat()); break;
      case 10: commands.push(type(writer, a, "audio", token), removeBeat()); break;
      case 11: commands.push(insert(deleter, c, n), { from: deleter, to: writer }, type(writer, n, "visual", token, 0),
        note(writer, n), undo(deleter)); break;
      case 12: commands.push(type(writer, b, "visual", token), removeBeat(), undo(deleter)); break;
      case 13: commands.push(status(writer, b, "ready"), removeBeat(), undo(deleter)); break;
      case 14: commands.push(mark(writer, b, "visual", "t:TAG"), removeBeat(), undo(deleter)); break;
      case 15: commands.push(mark(writer, b, "audio", "t:TAG", 1), removeBeat(), undo(deleter)); break;
      case 16:
        commands.push(note(writer, b), removeBeat());
        if (stretch === 0) commands.push(undo(deleter));
        break;
      case 17: commands.push(mark(writer, b, role % 2 === 0 ? "visual" : "audio", "t:TAG"), seen, removeBeat()); break;
      case 18: commands.push(status(writer, b, "ready"), seen, removeBeat()); break;
      case 19: commands.push(type(writer, b, "audio", token), seen, removeBeat()); break;
      case 20: commands.push(split(writer, b, n), seen, move(deleter)); break;
      case 21:
        commands.push(type(writer, b, "audio", token),
          step(writer, { op: "erase", id: b, field: "audio", from: 1, to: 2 }, { action: "revert", id: b, kind: "narration", token }),
          status(writer, b, "ready"), step(writer, { op: "field", id: b, value: "todo" }, { action: "revert", id: b, kind: "record" }),
          removeBeat());
        break;
      case 22:
        commands.push(stretch === 0
          ? step(writer, { op: "erase", id: b, field: "audio", from: 0, to: 3 }, other)
          : type(writer, b, "audio", "def", 3));
        break;
      case 23: commands.push(split(writer, b, n), { ...seen, ack: true }, move(deleter)); break;
    }
    for (let index = 0; index < 24; index++) {
      const selected = next(copies), person = mode === 22 && selected === idle ? writer : selected;
      const id = ["A", "C", "D", "F"][next(4)] ?? "F";
      if (index % 5 === 0) {
        commands.unshift(step(person, { op: "create", above: id, id: `heading-${stretch}-${index}`, value: "Scene" }, other));
      } else if (index % 5 === 1) {
        commands.unshift(step(person, { op: "field", id, value: "ready" }, edit(id, "record")));
      } else {
        commands.unshift(type(person, id, next(2) ? "audio" : "visual", "x", 0));
      }
    }
    if (copies === 3 && (mode === 0 || mode === 1)) {
      const third = 3 - writer - deleter;
      commands.push(type(third, b, mode === 0 ? "audio" : "visual", String.fromCodePoint(0xe300 + stretch * 256 + seed), 0));
    }
    const first = next(copies);
    return { offline, steps: commands, order: Array.from({ length: copies }, (_, index) => (first + index) % copies) };
  });
  return { name: `generated ${copies}×${seed}`, initial: generatedBase(), copies, stretches };
}
