import { b, base, h } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import type { Cmd, Step } from "../native-chosen/play.ts";
import type { RegisterStep } from "./model.ts";

export const act = (by: number, cmd: Cmd): Step => ({ by, cmd });
export const sync = (writers: number): Step[] => [
  ...Array.from({ length: writers - 1 }, (_, at) => ({ from: at + 1, to: 0 })), ...Array.from({ length: writers - 1 }, (_, at) => ({ from: 0, to: at + 1 }))
];
export const remove = (by: number, ...rows: string[]): Step => act(by, { op: "delete", rows });
export const rowAfter = (by: number, first: string, target: string): Step => act(by, { op: "move", drop: { unit: "row", first, target, after: true } });
export const rowBefore = (by: number, first: string, target: string): Step => act(by, { op: "move", drop: { unit: "row", first, target, after: false } });
export const intoScene = (by: number, first: string, scene: string): Step => act(by, { op: "move", drop: { unit: "row", first, target: null, after: true, intoScene: scene } });
export const sceneAfter = (by: number, first: string, target: string): Step => act(by, { op: "move", drop: { unit: "scene", first, target, after: true } });
export const undo = (by: number): Step => act(by, { op: "undo" });
export const redo = (by: number): Step => act(by, { op: "redo" });
export const split = (by: number, id: string, at: number, created: string): Step => act(by, { op: "split", id, at, created });
export const setField = (by: number, id: string, key: string, value: string): Step => act(by, { op: "field", id, key, value });

export const twoBeats = (): Spec => ({
  order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "b", h("H"), "h"] } },
  beats: { A: {}, B: {} }, visuals: { A: "", B: "" }, headings: { H: {} }
});

export const fourBeats = (): Spec => ({
  order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "b", b("C"), "c", b("D"), "d"] } },
  beats: { A: {}, B: {}, C: {}, D: {} }, visuals: { A: "", B: "", C: "", D: "" }, headings: {}
});

// why: the review's five steps; Alice is copy 0 (client 1) and Bob copy 1 (client 2), so Bob's write wins
const RACE: Step[] = [intoScene(0, "A", "H"), { from: 0, to: 1 }, rowAfter(0, "B", "A"), intoScene(1, "B", "H"), ...sync(2)];

export interface Named { label: string; spec: Spec; writers: number; steps: Step[]; checkpoints: number[]; register: RegisterStep[]; rows: Record<string, string[]>[] }

const named = (label: string, spec: Spec, writers: number, parts: Step[][], register: RegisterStep[], rows: Record<string, string[]>[]): Named => {
  const steps: Step[] = [], checkpoints: number[] = [];
  for (const part of parts) { steps.push(...part); checkpoints.push(steps.length); }
  return { label, spec, writers, steps, checkpoints, register, rows };
};

const w = (by: number, label: string): RegisterStep => ({ op: "write", by, label });
const other = (by: number, label: string): RegisterStep => ({ op: "other", by, label });
const press = (op: "undo" | "redo", by: number): RegisterStep => ({ op, by });
const SYNC_MARK: RegisterStep[] = [{ op: "sync" }, { op: "mark" }];
const rows = (text: string): string[] => text.split(", ").map(part => part.startsWith("#") ? part : `${part}: ${part.toLowerCase()} / `);
const full = (text: string): string[] => text.split(", ").map(part => part.startsWith("#") ? `${part} ${BASE_NAMES[part]}` : BASE_ROWS[part] ?? part);
const BASE_NAMES: Record<string, string> = { "#H": "mno", "#I": "stu" };
const BASE_ROWS: Record<string, string> = { A: "A: abc / 1", B: "B: def / 2", C: "C: ghi / 3", D: "D: jkl / 4", E: "E: pqr / 5", F: "F: vwx / 6" };
const two = (text: string): string[] => rows(text).map(row => row === "#H" ? "#H h" : row);

const RACE_REGISTER: RegisterStep[] = [other(0, "A into H"), { op: "sync" }, w(0, "alice"), w(1, "bob"), ...SYNC_MARK];
const RACE_ROWS = { bob: two("#H, B, A") };

// why: each history is cut into parts, and the rows are read after each part once everything is delivered; the rows
// are listed for each write the register model can leave standing at that point
export const NAMED: Named[] = [
  named("winner undoes, then the loser deletes A", twoBeats(), 2, [RACE, [undo(1), ...sync(2)], [remove(0, "A"), ...sync(2)]],
    [...RACE_REGISTER, press("undo", 1), ...SYNC_MARK, other(0, "delete A"), ...SYNC_MARK],
    [RACE_ROWS, { none: two("#H, A, B"), start: two("B, #H, A"), alice: two("#H, A, B") }, { none: two("B, #H"), start: two("B, #H"), alice: two("#H, B") }]),
  named("loser undoes, then the loser deletes A", twoBeats(), 2, [RACE, [undo(0), ...sync(2)], [remove(0, "A"), ...sync(2)]],
    [...RACE_REGISTER, press("undo", 0), ...SYNC_MARK, other(0, "delete A"), ...SYNC_MARK],
    [RACE_ROWS, { "bob / undone A into H": two("A, #H, B"), start: two("B, #H, A"), bob: two("#H, B, A") },
      { "bob / undone A into H": two("#H, B"), start: two("B, #H"), bob: two("#H, B") }]),
  named("winner undoes, then redoes", twoBeats(), 2, [RACE, [undo(1), ...sync(2)], [redo(1), ...sync(2)]],
    [...RACE_REGISTER, press("undo", 1), ...SYNC_MARK, press("redo", 1), ...SYNC_MARK],
    [RACE_ROWS, { none: two("#H, A, B"), start: two("B, #H, A"), alice: two("#H, A, B") }, { bob: two("#H, B, A") }]),
  named("three people move one beat at once, each undoes in turn", fourBeats(), 3,
    [[rowAfter(0, "B", "C"), rowAfter(1, "B", "D"), rowBefore(2, "B", "A"), ...sync(3)], [undo(2), ...sync(3)], [undo(1), ...sync(3)], [undo(0), ...sync(3)]],
    [w(0, "alice"), w(1, "bob"), w(2, "carol"), ...SYNC_MARK, press("undo", 2), ...SYNC_MARK, press("undo", 1), ...SYNC_MARK, press("undo", 0), ...SYNC_MARK],
    [{ carol: rows("B, A, C, D") }, { none: rows("A, B, C, D"), start: rows("A, B, C, D"), bob: rows("A, C, D, B") },
      { none: rows("A, B, C, D"), start: rows("A, B, C, D"), alice: rows("A, C, B, D") }, { none: rows("A, B, C, D"), start: rows("A, B, C, D") }]),
  named("E11's six-step deletion history", twoBeats(), 2,
    [[intoScene(0, "A", "H"), remove(0, "B"), intoScene(1, "B", "H"), ...sync(2)], [undo(0), ...sync(2)], [remove(0, "A"), ...sync(2)]],
    [other(0, "A into H"), { op: "drop", by: 0 }, w(1, "bob"), ...SYNC_MARK, press("undo", 0), ...SYNC_MARK, other(0, "delete A"), ...SYNC_MARK],
    [{ deleted: two("#H, A") }, { none: two("#H, A, B"), start: two("B, #H, A") }, { none: two("B, #H"), start: two("B, #H") }]),
  named("a move, someone else's seen move of the same beat, the first person's undo", fourBeats(), 2,
    [[rowAfter(0, "B", "C"), ...sync(2)], [rowAfter(1, "B", "D"), ...sync(2)], [undo(0), ...sync(2)]],
    [w(0, "alice"), ...SYNC_MARK, w(1, "bob"), ...SYNC_MARK, press("undo", 0), ...SYNC_MARK],
    [{ alice: rows("A, C, B, D") }, { bob: rows("A, C, D, B") }, { bob: rows("A, C, D, B"), start: rows("A, B, C, D") }]),
  named("a move while someone else splits the beat unseen, then the mover undoes", fourBeats(), 2,
    [[rowAfter(0, "B", "D"), split(1, "B", 0, "N"), ...sync(2)], [undo(0), ...sync(2)]],
    [w(0, "alice"), other(1, "split"), ...SYNC_MARK, press("undo", 0), ...SYNC_MARK],
    [{ alice: ["A: a / ", "N: b / ", "C: c / ", "D: d / ", "B:  / "] }, { start: ["A: a / ", "B:  / ", "N: b / ", "C: c / ", "D: d / "] }]),
  named("a heading move against a beat move into that scene, then each undoes", base(), 2,
    [[sceneAfter(0, "H", "I"), intoScene(1, "B", "H"), ...sync(2)], [undo(1), ...sync(2)], [undo(0), ...sync(2)]],
    [other(0, "scene H"), w(1, "bob"), ...SYNC_MARK, press("undo", 1), ...SYNC_MARK, press("undo", 0), ...SYNC_MARK],
    [{ bob: full("A, C, D, B, #I, F, #H, E") }, { start: full("A, B, C, D, #I, F, #H, E") }, { "start / undone scene H": full("A, B, C, D, #H, E, #I, F") }])
];
