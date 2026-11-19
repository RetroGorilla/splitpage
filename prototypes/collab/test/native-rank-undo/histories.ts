import { b, base, h } from "../native-chosen/kit.ts";
import type { MakeReplica, Spec } from "../native-chosen/kit.ts";
import type { Cmd, Step } from "../native-chosen/play.ts";
import type { RankOption } from "../../src/native-rank-undo/variants.ts";
import { snapshotKey, standings, storageOf } from "./model.ts";
import type { Expected, Register, RegisterStep } from "./model.ts";

export const act = (by: number, cmd: Cmd): Step => ({ by, cmd });
export const sync = (writers: number): Step[] => [
  ...Array.from({ length: writers - 1 }, (_, at) => ({ from: at + 1, to: 0 })), ...Array.from({ length: writers - 1 }, (_, at) => ({ from: 0, to: at + 1 }))
];
export const remove = (by: number, ...rows: string[]): Step => act(by, { op: "delete", rows });
export const rowAfter = (by: number, first: string, target: string): Step => act(by, { op: "move", drop: { unit: "row", first, target, after: true } });
export const rowBefore = (by: number, first: string, target: string): Step => act(by, { op: "move", drop: { unit: "row", first, target, after: false } });
export const intoScene = (by: number, first: string, scene: string): Step => act(by, { op: "move", drop: { unit: "row", first, target: null, after: true, intoScene: scene } });
export const sceneAfter = (by: number, first: string, target: string): Step => act(by, { op: "move", drop: { unit: "scene", first, target, after: true } });
export const sceneTop = (by: number, first: string): Step => act(by, { op: "move", drop: { unit: "scene", first, target: null, after: true } });
export const undo = (by: number): Step => act(by, { op: "undo" });
export const redo = (by: number): Step => act(by, { op: "redo" });
export const split = (by: number, id: string, at: number, created: string): Step => act(by, { op: "split", id, at, created });
export const setField = (by: number, id: string, key: string, value: string): Step => act(by, { op: "field", id, key, value });
export const insert = (by: number, before: string, id: string, text: string): Step => act(by, { op: "insert", before, id, text });
export const heading = (by: number, above: string, id: string, text: string): Step => act(by, { op: "heading", above, id, text });
export const rowTop = (by: number, first: string): Step => act(by, { op: "move", drop: { unit: "row", first, target: null, after: true } });

export const twoBeats = (): Spec => ({
  order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "b", h("H"), "h"] } },
  beats: { A: {}, B: {} }, visuals: { A: "", B: "" }, headings: { H: {} }
});

export const fourBeats = (): Spec => ({
  order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "b", b("C"), "c", b("D"), "d"] } },
  beats: { A: {}, B: {}, C: {}, D: {} }, visuals: { A: "", B: "", C: "", D: "" }, headings: {}
});

export const rowAndTwoHeadings = (): Spec => ({
  order: ["S"], segments: { S: { head: b("A"), units: ["a", h("H"), "h", h("I"), "i"] } },
  beats: { A: {} }, visuals: { A: "" }, headings: { H: {}, I: {} }
});

export const justTwo = (): Spec => ({
  order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "b"] } },
  beats: { A: {}, B: {} }, visuals: { A: "", B: "" }, headings: {}
});

export const justThree = (): Spec => ({
  order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "b", b("C"), "c"] } },
  beats: { A: {}, B: {}, C: {} }, visuals: { A: "", B: "", C: "" }, headings: {}
});

const fiveBeats = (): Spec => ({
  order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "b", b("C"), "c", b("D"), "d", b("X"), "x"] } },
  beats: { A: {}, B: {}, C: {}, D: {}, X: {} }, visuals: { A: "", B: "", C: "", D: "", X: "" }, headings: {}
});

const twoBeatsAndC = (): Spec => ({
  order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "b", h("H"), "h", b("C"), "c"] } },
  beats: { A: {}, B: {}, C: {} }, visuals: { A: "", B: "", C: "" }, headings: { H: {} }
});

// why: the review's five steps; Alice is copy 0 (client 1) and Bob copy 1 (client 2), so Bob's write wins
const RACE: Step[] = [intoScene(0, "A", "H"), { from: 0, to: 1 }, rowAfter(0, "B", "A"), intoScene(1, "B", "H"), ...sync(2)];
// why: offline, both delete a row and undo, then Bob (the higher client) redoes; both undos write its record entry
const recordLoss = (id: string): Step[] => [remove(0, id), remove(1, id), undo(0), undo(1), redo(1), ...sync(2)];
const RECORD_LOSS = recordLoss("B");
// why: B loses its rank in A and E: two moves at once, everything delivered, the winner (Bob) undoes
const RANK_LOSS: Step[] = [rowAfter(0, "B", "C"), rowAfter(1, "B", "D"), ...sync(2), undo(1), ...sync(2)];

// why: "rows" histories are judged by hand-written rows per option, as the register model follows one stored value
export interface Named { label: string; spec: Spec; writers: number; steps: Step[]; checkpoints: number[]; register: RegisterStep[]; target: Register | "rows"; plain: string[] }

const named = (label: string, spec: Spec, writers: number, parts: Step[][], register: RegisterStep[], target: Register | "rows" = "rank", plain: string[] = []): Named => {
  const steps: Step[] = [], checkpoints: number[] = [];
  for (const part of parts) { steps.push(...part); checkpoints.push(steps.length); }
  return { label, spec, writers, steps, checkpoints, register, target, plain };
};

export const keysOf = (option: RankOption, history: Named): string[] =>
  history.target === "rows" ? history.checkpoints.map(() => option) : standings(storageOf(option, history.target), history.register).map(snapshotKey);

export const rowsFor = (expected: Expected, at: number, key: string): string[] | undefined => expected.rows[at]?.[key] ?? expected.rows[at]?.all;

// why: a document written before option E: the listed blocks' hydrated boundaries carry no fixed place
export const plainMarkers = (make: MakeReplica, ids: readonly string[]): MakeReplica => !ids.length ? make : (client, rules, names) => {
  const replica = make(client, rules, names), hydrated = replica.hydratedBoundary.bind(replica);
  replica.hydratedBoundary = (index, kind, id) => ids.includes(id) ? { [kind]: id } : hydrated(index, kind, id);
  return replica;
};

const w = (by: number, label: string): RegisterStep => ({ op: "write", by, label });
const other = (by: number, label: string): RegisterStep => ({ op: "other", by, label });
const press = (op: "undo" | "redo", by: number): RegisterStep => ({ op, by });
const deliver = (from: number, to: number): RegisterStep => ({ op: "deliver", from, to });
const cut = (by: number): RegisterStep => ({ op: "delete", by });
const SYNC_MARK: RegisterStep[] = [{ op: "sync" }, { op: "mark" }];

const RACE_REGISTER: RegisterStep[] = [other(0, "A into H"), { op: "sync" }, w(0, "alice"), w(1, "bob"), ...SYNC_MARK];
const LOSS_REGISTER: RegisterStep[] = [cut(0), cut(1), press("undo", 0), press("undo", 1), press("redo", 1), ...SYNC_MARK];

// why: each history is cut into parts, and the rows are read after each part once everything is delivered; the model
// follows B's rank, H's rank, or B's record, and model.ts lists the rows for each value it can leave standing
export const NAMED: Named[] = [
  named("winner undoes, then the loser deletes A", twoBeats(), 2, [RACE, [undo(1), ...sync(2)], [remove(0, "A"), ...sync(2)]],
    [...RACE_REGISTER, press("undo", 1), ...SYNC_MARK, other(0, "delete A"), ...SYNC_MARK]),
  named("loser undoes, then the loser deletes A", twoBeats(), 2, [RACE, [undo(0), ...sync(2)], [remove(0, "A"), ...sync(2)]],
    [...RACE_REGISTER, press("undo", 0), ...SYNC_MARK, other(0, "delete A"), ...SYNC_MARK]),
  named("winner undoes, then redoes", twoBeats(), 2, [RACE, [undo(1), ...sync(2)], [redo(1), ...sync(2)]],
    [...RACE_REGISTER, press("undo", 1), ...SYNC_MARK, press("redo", 1), ...SYNC_MARK]),
  named("three people move one beat at once, each undoes in turn", fourBeats(), 3,
    [[rowAfter(0, "B", "C"), rowAfter(1, "B", "D"), rowBefore(2, "B", "A"), ...sync(3)], [undo(2), ...sync(3)], [undo(1), ...sync(3)], [undo(0), ...sync(3)]],
    [w(0, "alice"), w(1, "bob"), w(2, "carol"), ...SYNC_MARK, press("undo", 2), ...SYNC_MARK, press("undo", 1), ...SYNC_MARK, press("undo", 0), ...SYNC_MARK]),
  named("E11's six-step deletion history", twoBeats(), 2,
    [[intoScene(0, "A", "H"), remove(0, "B"), intoScene(1, "B", "H"), ...sync(2)], [undo(0), ...sync(2)], [remove(0, "A"), ...sync(2)]],
    [other(0, "A into H"), { op: "drop", by: 0 }, w(1, "bob"), ...SYNC_MARK, press("undo", 0), ...SYNC_MARK, other(0, "delete A"), ...SYNC_MARK]),
  named("a move, someone else's seen move of the same beat, the first person's undo", fourBeats(), 2,
    [[rowAfter(0, "B", "C"), ...sync(2)], [rowAfter(1, "B", "D"), ...sync(2)], [undo(0), ...sync(2)]],
    [w(0, "alice"), ...SYNC_MARK, w(1, "bob"), ...SYNC_MARK, press("undo", 0), ...SYNC_MARK]),
  named("a move while someone else splits the beat unseen, then the mover undoes", fourBeats(), 2,
    [[rowAfter(0, "B", "D"), split(1, "B", 0, "N"), ...sync(2)], [undo(0), ...sync(2)]],
    [w(0, "alice"), other(1, "split"), ...SYNC_MARK, press("undo", 0), ...SYNC_MARK]),
  named("a heading move against a beat move into that scene, then each undoes", base(), 2,
    [[sceneAfter(0, "H", "I"), intoScene(1, "B", "H"), ...sync(2)], [undo(1), ...sync(2)], [undo(0), ...sync(2)]],
    [other(0, "scene H"), w(1, "bob"), ...SYNC_MARK, press("undo", 1), ...SYNC_MARK, press("undo", 0), ...SYNC_MARK]),
  named("an older redo of a heading move against a later move the presser had seen", rowAndTwoHeadings(), 2,
    [[sceneAfter(1, "H", "I"), undo(1), ...sync(2)], [sceneTop(0, "H"), ...sync(2)], [redo(1), ...sync(2)]],
    [w(1, "bob"), press("undo", 1), ...SYNC_MARK, w(0, "alice"), ...SYNC_MARK, press("redo", 1), ...SYNC_MARK]),
  named("three people: a redo and an undo of heading moves around a later move", rowAndTwoHeadings(), 3,
    [[sceneTop(0, "H"), sceneTop(1, "H"), { from: 0, to: 1 }, undo(1), undo(0), { from: 0, to: 2 }, sceneAfter(2, "H", "I"), redo(1), undo(2), { from: 1, to: 2 }, redo(2), ...sync(3)]],
    [w(0, "top"), w(1, "top"), deliver(0, 1), press("undo", 1), press("undo", 0), deliver(0, 2), w(2, "carol"), press("redo", 1), press("undo", 2), deliver(1, 2), press("redo", 2), ...SYNC_MARK]),
  named("a row moved earlier, then two moves at once and the winner's undo", fourBeats(), 2,
    [[rowAfter(0, "B", "D"), ...sync(2)], [rowAfter(0, "B", "C"), rowBefore(1, "B", "A"), ...sync(2)], [undo(1), ...sync(2)]],
    [w(0, "earlier"), ...SYNC_MARK, w(0, "alice"), w(1, "bob"), ...SYNC_MARK, press("undo", 1), ...SYNC_MARK]),
  named("both delete a row offline and undo, one redoes: the row loses its record", justTwo(), 2, [RECORD_LOSS], LOSS_REGISTER, "record"),
  named("a row that lost its record under a moved neighbour, then the neighbour is deleted", twoBeats(), 2,
    [[intoScene(0, "A", "H"), ...sync(2)], RECORD_LOSS, [remove(0, "A"), ...sync(2)]],
    [other(0, "A into H"), ...SYNC_MARK, ...LOSS_REGISTER, other(0, "delete A"), ...SYNC_MARK], "record"),
  named("a new row inserted before a row that lost its record", justTwo(), 2, [RECORD_LOSS, [insert(0, "B", "N", "n"), ...sync(2)]],
    [...LOSS_REGISTER, other(0, "insert N"), ...SYNC_MARK], "record"),
  named("a rankless row split, a move into the gap, a heading above the split-off, the mover's undo", fourBeats(), 2,
    [RANK_LOSS, [split(0, "B", 0, "N"), ...sync(2)], [rowAfter(0, "D", "B"), ...sync(2)], [heading(1, "N", "H", "h"), ...sync(2)], [undo(0), ...sync(2)]], [], "rows"),
  named("a rankless row split, a move into the gap, another row moved into it, the mover's undo", fiveBeats(), 2,
    [RANK_LOSS, [split(0, "B", 0, "N"), ...sync(2)], [rowAfter(0, "D", "B"), ...sync(2)], [rowAfter(1, "X", "D"), ...sync(2)], [undo(0), ...sync(2)]], [], "rows"),
  named("a healthy row moved to the top after another lost its record", justThree(), 2, [RECORD_LOSS, [rowTop(0, "C"), ...sync(2)]], [], "rows"),
  named("a heading created above a row that lost its record", justTwo(), 2, [RECORD_LOSS, [heading(0, "B", "H", "h"), ...sync(2)]], [], "rows"),
  named("a document where one row's boundary has no fixed place: B rankless, C without a record, A deleted", twoBeatsAndC(), 2,
    [[intoScene(0, "A", "H"), ...sync(2)], [rowAfter(0, "B", "A"), intoScene(1, "B", "H"), ...sync(2), undo(1), ...sync(2)], recordLoss("C"), [remove(0, "A"), ...sync(2)]],
    [], "rows", ["C"]),
  named("history 1 on a document whose boundaries have no fixed place", twoBeats(), 2, [RACE, [undo(1), ...sync(2)], [remove(0, "A"), ...sync(2)]],
    [], "rows", ["A", "B", "H"]),
  named("a move, someone else's seen range move that carries the beat, the first person's undo", fourBeats(), 2,
    [[rowAfter(0, "B", "C"), ...sync(2)], [act(1, { op: "move", drop: { unit: "rows", first: "C", last: "B", target: "D", after: true } }), ...sync(2)], [undo(0), ...sync(2)]],
    [], "rows")
];
