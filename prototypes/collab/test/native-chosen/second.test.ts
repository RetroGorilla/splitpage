import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { ALL_RULES } from "../../src/native/variant.ts";
import type { ChosenNames, ChosenReplica } from "../../src/native-chosen/replica.ts";
import { MODES } from "./engine.ts";
import { b, base, h, load, seed } from "./kit.ts";
import type { Spec } from "./kit.ts";
import { settle } from "./ledger.ts";
import type { LedgerEvent } from "./ledger.ts";
import { perform, play } from "./play.ts";
import type { Cmd, PlayResult, Step } from "./play.ts";

const act = (by: number, cmd: Cmd): Step => ({ by, cmd });
const SYNC: Step[] = [{ from: 0, to: 1 }, { from: 1, to: 0 }];
const TO_FIRST: Step = { from: 1, to: 0 };
const remove = (by: number, ...rows: string[]): Step => act(by, { op: "delete", rows });
const typeIn = (by: number, id: string, at: number, text: string, field: "audio" | "name" = "audio"): Step => act(by, { op: "type", id, field, at, text });
const rowAfter = (by: number, first: string, target: string): Step => act(by, { op: "move", drop: { unit: "row", first, target, after: true } });
const intoScene = (by: number, first: string, scene: string): Step => act(by, { op: "move", drop: { unit: "row", first, target: null, after: true, intoScene: scene } });
const sceneBefore = (by: number, first: string, target: string): Step => act(by, { op: "move", drop: { unit: "scene", first, target, after: false } });
const undo = (by: number): Step => act(by, { op: "undo" });
const redo = (by: number): Step => act(by, { op: "redo" });
const run = (spec: Spec, steps: readonly Step[], mode: (typeof MODES)[number] = "forward", names: ChosenNames = "inline"): PlayResult =>
  play({ spec, steps, writers: 2, mode, seed: 1, names });

// why: two copies that exchange whole states, so the stored records can be read after each step
function stored(spec: Spec, steps: readonly Step[], names: ChosenNames = "inline"): { copy: ChosenReplica; close: () => void } {
  const copies = [load(seed(spec, ALL_RULES, names), 1, ALL_RULES, names), load(seed(spec, ALL_RULES, names), 2, ALL_RULES, names)];
  for (const step of steps) {
    if ("by" in step) perform(copies[step.by] as ChosenReplica, step.cmd);
    else if ("to" in step) {
      const from = copies[step.from] as ChosenReplica, to = copies[step.to] as ChosenReplica;
      Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote");
      to.changes();
    }
  }
  return { copy: copies[0] as ChosenReplica, close: () => { for (const copy of copies) copy.destroy(); } };
}

const twoBeats = (): Spec => ({
  order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "b", h("H"), "h"] } },
  beats: { A: {}, B: {} }, visuals: { A: "", B: "" }, headings: { H: {} }
});

// why: the review's history; B has no rank after Alice's undo, so Alice's own later deletion of A moves B out of H
const DRIFT: Step[] = [intoScene(0, "A", "H"), remove(0, "B"), intoScene(1, "B", "H"), TO_FIRST, undo(0)];

test("E11 second review: a beat read by rule (e) can change place and scene on a later command that did not touch it", () => {
  for (const mode of MODES) {
    const shownToAlice = run(twoBeats(), DRIFT, mode);
    assert.deepEqual([shownToAlice.never, shownToAlice.local, shownToAlice.lines], [[], [], ["#H h", "A: a / ", "B: b / "]], mode);
    const after = run(twoBeats(), [...DRIFT, remove(0, "A")], mode);
    assert.deepEqual(after.lines, ["B: b / ", "#H h"], mode);
    assert.deepEqual(after.never, ["step 5 delete: beats B changed scene with one person working"], mode);
    assert.deepEqual(after.drift, { place: 1, scene: 1 }, mode);
  }
  const { copy, close } = stored(twoBeats(), DRIFT);
  try { assert.equal(copy.beats.get("B")?.has("e10Rank"), false); } finally { close(); }
});

const RANKLESS_F: Step[] = [remove(0, "F"), rowAfter(1, "F", "A"), TO_FIRST, undo(0)];

test("E11 second review: splitting a beat read by rule (e) makes a new beat without a rank", () => {
  for (const mode of MODES) {
    const result = run(base(), [...RANKLESS_F, act(0, { op: "split", id: "F", at: 1, created: "N" })], mode);
    assert.deepEqual(result.lines.slice(-3), ["#I stu", "F: v / 6", "N: wx / "], mode);
    assert.deepEqual([result.never, result.local], [[], ["step 4 split: split-off N has no rank"]], mode);
  }
  const { copy, close } = stored(base(), [...RANKLESS_F, act(0, { op: "split", id: "F", at: 1, created: "N" })]);
  // why: the split copies the old beat's rank entry, which F lacks, so N stores the key with no value
  try { assert.deepEqual([copy.beats.get("F")?.has("e10Rank"), copy.beats.get("N")?.has("e10Rank"), copy.beats.get("N")?.get("e10Rank")], [false, true, undefined]); } finally { close(); }
});

const RANKLESS_J: Step[] = [act(0, { op: "heading", above: "C", id: "J", text: "Q" }), { from: 0, to: 1 }, sceneBefore(1, "J", "I"), undo(0), TO_FIRST, redo(0)];

test("E11 second review: a heading created again by a redo after an unseen scene move has no rank, reads, and its name stays editable", () => {
  const rows = ["A: abc / 1", "B: def / 2", "#J QX", "#H mno", "E: pqr / 5", "C: ghi / 3", "D: jkl / 4", "#I stu", "F: vwx / 6"];
  for (const mode of MODES) {
    const result = run(base(), [...RANKLESS_J, typeIn(0, "J", 1, "X", "name")], mode, "cells");
    assert.deepEqual([result.never, result.local, result.lines], [[], [], rows], mode);
  }
  const { copy, close } = stored(base(), RANKLESS_J, "cells");
  try {
    assert.equal(copy.headings.get("J")?.has("e10Rank"), false);
    assert.equal(copy.names.get("J")?.toString(), "Q");
  } finally { close(); }
});

const oneBeat = (): Spec => ({ order: ["S"], segments: { S: { head: b("A"), units: ["x"] } }, beats: { A: {} }, visuals: { A: "" }, headings: {} });

test("E11 second review: two people each delete one beat and undo their own deletion; the owner's accepted doubling", () => {
  const histories: Step[][] = [
    [remove(0, "A"), remove(1, "A"), undo(0), undo(1)],
    [remove(0, "A"), remove(1, "A"), ...SYNC, undo(0), undo(1)]
  ];
  for (const steps of histories) for (const mode of MODES) {
    const result = run(oneBeat(), steps, mode);
    assert.deepEqual([result.never, result.local, result.lines], [[], [], ["A: xx / "]], mode);
    assert.equal(result.kinds["a double delete then a double undo doubles the narration"], 1, mode);
  }
});

const leading = (): Spec => ({ order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "b"] } }, beats: { A: {}, B: {} }, visuals: { A: "", B: "" }, headings: {} });
const trailing = (): Spec => ({
  order: ["S", "T"], segments: { S: { head: b("B"), units: ["b"] }, T: { head: b("A"), units: ["a"] } },
  beats: { A: {}, B: {} }, visuals: { A: "", B: "" }, headings: {}
});

test("E11 second review: a split inside recovered text goes to the nearest point, which can be the whole recovered text away", () => {
  for (const size of [1, 100]) for (const mode of MODES) {
    const text = "X".repeat(size), recovered: Step[] = [remove(0, "A"), typeIn(1, "A", 1, text), ...SYNC];
    const before = run(leading(), recovered, mode);
    assert.deepEqual(before.lines, [`B: ${text}b / `], `${size} ${mode}`);
    const front = run(leading(), [...recovered, act(0, { op: "split", id: "B", at: 0, created: "N" })], mode);
    assert.deepEqual(front.lines, [`B: ${text} / `, "N: b / "], `caret before the recovered text, ${size} ${mode}`);
    assert.equal(front.kinds["a split inside rule-read text was placed at the beat's own text"], 1);
    const end = run(trailing(), [...recovered, act(0, { op: "split", id: "B", at: size + 1, created: "N" })], mode);
    assert.deepEqual(end.lines, ["B: b / ", `N: ${text} / `], `caret at the end of the row, ${size} ${mode}`);
    assert.deepEqual([front.never, front.local, end.never, end.local], [[], [], [], []]);
  }
});

const event = (index: number, by: number, extra: Partial<LedgerEvent>, seen = index): LedgerEvent => ({
  index, by, op: "x", seen: new Set(Array.from({ length: seen }, (_, at) => at)), typed: [], erased: [], deletedBeats: [], seenVisual: [],
  createdBeats: [], createdSegment: false, createdHeading: null, fieldSet: null, reverts: null, redoes: null, skipped: [], ...extra
});

test("E11 second review: the ledger judges a new beat through split, undo, redo and undo on one copy", () => {
  const events = [event(0, 0, { createdBeats: ["N"] }), event(1, 0, { reverts: 0 }), event(2, 0, { redoes: 1 }), event(3, 0, { reverts: 2 })];
  const judged = [1, 2, 3, 4].map(count => { const result = settle(events.slice(0, count), [], ["A"]); return [[...result.beatsAlive], [...result.beatsDead], [...result.beatsUncertain]]; });
  assert.deepEqual(judged, [[["A", "N"], [], []], [["A"], ["N"], []], [["A", "N"], [], []], [["A"], ["N"], []]]);
  // why: control: a command from another copy the redoer had not seen still leaves the redone beat open
  const unseen = [events[0], events[1], event(2, 1, {}, 0), event(3, 0, { redoes: 1 }, 2)].filter((item): item is LedgerEvent => item !== undefined);
  assert.deepEqual([...settle(unseen, [], ["A"]).beatsUncertain], ["N"]);
  const played = run(base(), [act(0, { op: "split", id: "B", at: 1, created: "N" }), undo(0), redo(0), undo(0)]);
  assert.deepEqual([played.never, played.local, played.kinds], [[], [], {}]);
});

const twoHeadings = (): Spec => ({
  order: ["S"], segments: { S: { head: h("H"), units: ["h", b("A"), "a", h("I"), "i", b("B"), "b"] } },
  beats: { A: {}, B: {} }, visuals: { A: "", B: "" }, headings: { H: {}, I: {} }
});

test("E11 second review: rule (f) can show recovered narration under another scene, and it follows that beat", () => {
  for (const mode of MODES) {
    const recovered = run(twoHeadings(), [remove(0, "A"), typeIn(1, "A", 1, "X")], mode, "cells");
    assert.deepEqual([recovered.never, recovered.local, recovered.lines], [[], [], ["#H h", "#I i", "B: Xb / "]], mode);
    const moved = run(twoHeadings(), [remove(0, "A"), sceneBefore(0, "I", "H"), typeIn(1, "A", 1, "X")], mode, "cells");
    assert.deepEqual([moved.never, moved.local, moved.lines], [[], [], ["#I i", "B: Xb / ", "#H h"]], mode);
    const edited = run(twoHeadings(), [remove(0, "A"), typeIn(1, "A", 1, "X"), ...SYNC, sceneBefore(0, "I", "H"), typeIn(0, "B", 1, "Y")], mode, "cells");
    assert.deepEqual([edited.never, edited.local, edited.lines], [[], [], ["#I i", "B: XYb / ", "#H h"]], mode);
  }
});
