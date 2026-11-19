import assert from "node:assert/strict";
import test from "node:test";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { ALL_RULES } from "../../src/native/variant.ts";
import { neverAcceptable, reachability } from "./check.ts";
import { base, load, outline, seed, sync } from "./kit.ts";
import type { Spec } from "./kit.ts";
import { perform, play } from "./play.ts";
import type { Cmd, Step } from "./play.ts";

const BASE = ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pqr / 5", "#I stu", "F: vwx / 6"];

const start = (spec: Spec = base(), count = 3): ChosenReplica[] => {
  const bytes = seed(spec);
  return Array.from({ length: count }, (_, index) => load(bytes, index + 1));
};

const act = (replica: ChosenReplica, cmd: Cmd): void => { perform(replica, cmd); };
const type = (replica: ChosenReplica, id: string, at: number, text: string, field: "audio" | "visual" = "audio"): void => act(replica, { op: "type", id, field, at, text });
const erase = (replica: ChosenReplica, id: string, from: number, to: number): void => act(replica, { op: "erase", id, field: "audio", from, to });
const press = (replica: ChosenReplica, which: "undo" | "redo"): boolean => {
  const done = which === "undo" ? replica.undoPress() : replica.redoPress();
  replica.changes();
  return done;
};

// why: every check settles all copies, then demands one outline everywhere and nothing stored out of reach
function settle(copies: readonly ChosenReplica[], marks = false): string[] {
  sync(copies);
  for (const copy of copies) copy.changes();
  const [hub] = copies;
  assert.ok(hub);
  const first = outline(hub, marks);
  for (const copy of copies) {
    assert.deepEqual(outline(copy, marks), first, "copies agree");
    assert.deepEqual(neverAcceptable(reachability(copy)), [], "everything stored is shown once and editable");
  }
  return first;
}

const done = (copies: readonly ChosenReplica[]): void => { for (const copy of copies) copy.destroy(); };

test("E3 check: undo takes back only one's own typing with someone else's typing in between, and redo brings it back", () => {
  const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  type(a, "A", 3, "x"); settle(copies); type(b, "A", 0, "Q"); settle(copies); type(a, "A", 5, "y"); settle(copies); type(b, "A", 5, "W");
  assert.deepEqual(settle(copies)[0], "A: QabcxWy / 1");
  assert.equal(press(a, "undo"), true); assert.deepEqual(settle(copies)[0], "A: QabcxW / 1");
  assert.equal(press(a, "undo"), true); assert.deepEqual(settle(copies)[0], "A: QabcW / 1");
  assert.equal(press(a, "undo"), false);
  assert.equal(press(a, "redo"), true); assert.equal(press(a, "redo"), true);
  assert.deepEqual(settle(copies)[0], "A: QabcxWy / 1");
  done(copies);
});

test("E3 check: a new command clears redo, and another person's change leaves one's stacks alone", () => {
  const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  type(a, "A", 3, "x"); press(a, "undo"); type(a, "A", 3, "y");
  assert.equal(press(a, "redo"), false);
  type(a, "A", 4, "z"); press(a, "undo");
  const stacks = [a.undo.undoStack.length, a.undo.redoStack.length];
  type(b, "B", 0, "Q"); act(b, { op: "format", id: "B", field: "audio", from: 0, to: 2, key: "b", on: true }); settle(copies);
  assert.deepEqual([a.undo.undoStack.length, a.undo.redoStack.length], stacks);
  assert.equal(press(a, "redo"), true);
  assert.deepEqual(settle(copies, true).slice(0, 2), ["A: abcyz / 1", "B: [Qd|b]ef / 2"]);
  done(copies);
});

test("E3 check, issue 1612: bold undone and redone after someone else's unseen split, before and inside the word", () => {
  for (const [at, split, plain] of [
    [2, ["A: a  / 1", "N: [cup|b] of tea / "], ["A: a  / 1", "N: cup of tea / "]],
    [3, ["A: a [c|b] / 1", "N: [up|b] of tea / "], ["A: a c / 1", "N: up of tea / "]]
  ] as const) {
    const spec: Spec = { order: ["S"], segments: { S: { head: { b: "A" }, units: ["a cup of tea"] } }, beats: { A: {} }, visuals: { A: "1" }, headings: {} };
    const copies = start(spec, 2), [a, b] = copies as [ChosenReplica, ChosenReplica];
    act(a, { op: "format", id: "A", field: "audio", from: 2, to: 5, key: "b", on: true });
    act(b, { op: "split", id: "A", at, created: "N" });
    assert.deepEqual(settle(copies, true), split);
    assert.equal(press(a, "undo"), true); assert.deepEqual(settle(copies, true), plain);
    assert.equal(press(a, "redo"), true); assert.deepEqual(settle(copies, true), split);
    done(copies);
  }
});

test("E3 check, declared there: bold undone after someone typed plain text inside it comes back on everything after that text", () => {
  const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  act(a, { op: "format", id: "B", field: "audio", from: 0, to: 3, key: "b", on: true }); settle(copies);
  type(b, "B", 1, "X");
  assert.deepEqual(settle(copies, true)[1], "B: [d|b]X[ef|b] / 2");
  press(a, "undo");
  assert.deepEqual(settle(copies, true)[1], "B: dX[ef|b] / 2");
  done(copies);
});

test("E3 check: split undo and redo with someone else's typing on both sides (T12); the narration stays", () => {
  const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  act(a, { op: "split", id: "B", at: 1, created: "N" }); settle(copies);
  type(b, "B", 1, "Y"); type(b, "N", 0, "X");
  assert.deepEqual(settle(copies).slice(1, 3), ["B: dY / 2", "N: Xef / "]);
  assert.equal(press(a, "undo"), true); assert.deepEqual(settle(copies), [BASE[0], "B: dYXef / 2", ...BASE.slice(2)]);
  assert.equal(press(a, "redo"), true); assert.deepEqual(settle(copies).slice(1, 3), ["B: dY / 2", "N: Xef / "]);
  done(copies);
});

test("creation-undo loss: what someone typed in a new beat's visual cell goes when its creator undoes the split; redo brings it back only if seen", () => {
  for (const seen of [false, true]) {
    const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
    act(a, { op: "split", id: "B", at: 1, created: "N" }); settle(copies);
    type(b, "N", 0, "V", "visual"); type(b, "N", 0, "X");
    if (seen) settle(copies);
    assert.equal(press(a, "undo"), true);
    assert.deepEqual(settle(copies), [BASE[0], "B: dXef / 2", ...BASE.slice(2)], "the narration stays; the visual letter V is gone");
    assert.equal(press(a, "redo"), true);
    // why: the redo restores only what the undo itself deleted; a letter that arrived after the undo is not part of it
    assert.deepEqual(settle(copies).slice(1, 3), ["B: d / 2", seen ? "N: Xef / V" : "N: Xef / "], seen ? "seen: redo brings V back" : "unseen: V stays gone");
    done(copies);
  }
});

test("creation-undo loss counted by the letter ledger when the creator had not seen the typing", () => {
  const steps: Step[] = [
    { by: 0, cmd: { op: "split", id: "B", at: 1, created: "N" } }, { from: 0, to: 1 },
    { by: 1, cmd: { op: "type", id: "N", field: "visual", at: 0, text: "V" } },
    { by: 0, cmd: { op: "undo" } }
  ];
  const result = play({ spec: base(), steps, writers: 2, mode: "forward", seed: 1 });
  assert.deepEqual([result.never, result.local], [[], []]);
  assert.deepEqual(result.kinds, { "typing in a new beat lost when its creator undoes the creation unseen": 1 });
});

test("creation undo with core Yjs's default delete filter: seen and unseen visual letters and fields are counted apart, and a redo restores only the seen ones", () => {
  const split: Step = { by: 0, cmd: { op: "split", id: "B", at: 1, created: "N" } };
  const writes: Step[] = [{ by: 1, cmd: { op: "type", id: "N", field: "visual", at: 0, text: "V" } }, { by: 1, cmd: { op: "field", id: "N", key: "status", value: "shot" } }];
  const run = (seen: boolean, redo: boolean): Record<string, number> => {
    const undo: Step = { by: 0, cmd: { op: "undo" } }, again: Step = { by: 0, cmd: { op: "redo" } }, back: Step = { from: 1, to: 0 };
    const steps: Step[] = [split, { from: 0, to: 1 }, ...writes, ...seen ? [back] : [], undo, ...redo ? [again] : []];
    const result = play({ spec: base(), steps, writers: 2, mode: "forward", seed: 1 });
    assert.deepEqual([result.never, result.local], [[], []], `seen ${seen}, redo ${redo}: the ledger agrees with what is shown`);
    return result.kinds;
  };
  assert.deepEqual(run(true, false), { "typing removed by a creation undo the creator saw": 1, "record change removed by a creation undo the creator saw": 1 });
  assert.deepEqual(run(false, false), { "typing in a new beat lost when its creator undoes the creation unseen": 1, "record change in a new beat lost when its creator undoes the creation unseen": 1 });
  assert.deepEqual(run(true, true), {}, "the redo brings back V and the field");
  assert.deepEqual(run(false, true), { "typing in a new beat lost when its creator undoes the creation unseen": 1, "record change in a new beat lost when its creator undoes the creation unseen": 1 });
});

test("creation undo of a heading: a letter typed in its name after the unseen undo goes with the heading", () => {
  const steps: Step[] = [
    { by: 0, cmd: { op: "heading", above: "F", id: "J", text: "В" } }, { from: 0, to: 1 },
    { by: 0, cmd: { op: "undo" } },
    { by: 1, cmd: { op: "type", id: "J", field: "name", at: 1, text: "М" } }
  ];
  const result = play({ spec: base(), steps, writers: 2, mode: "forward", seed: 1 });
  assert.deepEqual([result.never, result.local, result.lines], [[], [], BASE]);
  assert.deepEqual(result.kinds, { "typing in a new heading lost when its creator undoes the creation unseen": 1 });
});

test("E3 check: join undo and redo with someone else's typing in the joined beat (T12 join)", () => {
  const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  act(a, { op: "join", id: "C" }); settle(copies);
  type(b, "C", 1, "Z");
  assert.deepEqual(settle(copies)[1], "B(B+C): def gZhi / 2\n3");
  assert.equal(press(a, "undo"), true); assert.deepEqual(settle(copies).slice(1, 3), ["B: def / 2", "C: gZhi / 3"]);
  assert.equal(press(a, "redo"), true); assert.deepEqual(settle(copies)[1], "B(B+C): def gZhi / 2\n3");
  done(copies);
});

test("E3 check: deleted text restored by undo keeps its place around what someone typed inside it (T01), and two restores", () => {
  const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  erase(a, "A", 1, 3); type(b, "A", 2, "X");
  assert.deepEqual(settle(copies)[0], "A: aX / 1");
  press(a, "undo"); assert.deepEqual(settle(copies)[0], "A: abXc / 1");
  press(a, "redo"); assert.deepEqual(settle(copies)[0], "A: aX / 1");
  done(copies);
  const second = start(), [c] = second as [ChosenReplica];
  erase(c, "B", 2, 3); erase(c, "B", 0, 2); press(c, "undo"); press(c, "undo");
  assert.deepEqual(settle(second)[1], "B: def / 2");
  done(second);
});

test("E3 check: main's declared limits of shared undo hold the same here", () => {
  let copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  erase(a, "A", 1, 3); erase(b, "A", 2, 3); settle(copies); press(a, "undo"); press(b, "undo");
  assert.deepEqual(settle(copies)[0], "A: abcc / 1", "double restore");
  done(copies);
  copies = start(); [a, b] = copies as [ChosenReplica, ChosenReplica];
  erase(a, "A", 1, 3); settle(copies); type(b, "A", 1, "X"); settle(copies); press(a, "undo");
  assert.deepEqual(settle(copies)[0], "A: abcX / 1", "insert after a deleted run");
  done(copies);
});

test("E3 check under the library's undo: a status that lost to someone else's passes over to the typing before it", () => {
  const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  type(a, "A", 3, "Z"); act(a, { op: "field", id: "A", key: "status", value: "ready" }); act(b, { op: "field", id: "A", key: "status", value: "shot" });
  settle(copies);
  assert.equal(a.beats.get("A")?.get("status"), "shot");
  assert.equal(press(a, "undo"), true);
  assert.deepEqual(settle(copies)[0], "A: abc / 1", "one press undid the typing, the item before the lost status");
  assert.equal(a.beats.get("A")?.get("status"), "shot");
  done(copies);
});

test("deletion undo and redo by one person: row, narration, visual cell and record come back, then go again", () => {
  const copies = start(), [a] = copies as [ChosenReplica];
  act(a, { op: "field", id: "B", key: "status", value: "ready" });
  act(a, { op: "delete", rows: ["B"] });
  assert.deepEqual(settle(copies), [BASE[0], ...BASE.slice(2)]);
  assert.equal(press(a, "undo"), true);
  assert.deepEqual(settle(copies), BASE);
  assert.equal(a.beats.get("B")?.get("status"), "ready");
  assert.equal(press(a, "redo"), true);
  assert.deepEqual(settle(copies), [BASE[0], ...BASE.slice(2)]);
  done(copies);
});

test("deletion with unseen typing, then undo: rule a shows the letter in the row above until the undo puts it back in its beat", () => {
  const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  act(a, { op: "delete", rows: ["B"] }); type(b, "B", 1, "X"); type(b, "B", 0, "V", "visual");
  assert.deepEqual(settle(copies), ["A: abcX / 1", ...BASE.slice(2)], "the narration is shown in A by rule a; the visual letter is gone");
  assert.equal(press(a, "undo"), true);
  assert.deepEqual(settle(copies), [BASE[0], "B: dXef / 2", ...BASE.slice(2)], "the undo restores B with the letter in place; V stays gone");
  assert.equal(press(a, "redo"), true);
  assert.deepEqual(settle(copies), ["A: abcX / 1", ...BASE.slice(2)]);
  done(copies);
});

test("deletion of a segment's first beat with unseen typing: rule a gives the text to the next beat, the undo gives it back", () => {
  const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  act(a, { op: "delete", rows: ["A"] }); type(b, "A", 1, "X");
  assert.deepEqual(settle(copies), ["B: Xdef / 2", ...BASE.slice(2)]);
  assert.equal(press(a, "undo"), true);
  assert.deepEqual(settle(copies), ["A: aXbc / 1", ...BASE.slice(1)]);
  done(copies);
});

test("rule c: both delete the same row, both undo, and the narration shows doubled in one row with one visual cell", () => {
  const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  act(a, { op: "delete", rows: ["B"] }); act(b, { op: "delete", rows: ["B"] });
  assert.deepEqual(settle(copies), [BASE[0], ...BASE.slice(2)]);
  press(a, "undo"); press(b, "undo");
  assert.deepEqual(settle(copies), [BASE[0], "B: defdef / 2", ...BASE.slice(2)]);
  assert.ok(a.ruleUse().repeat > 0, "the repeated boundary was read by rule c");
  done(copies);
});

test("move undo and redo by one person put the row back and move it again", () => {
  const copies = start(), [a] = copies as [ChosenReplica];
  act(a, { op: "move", drop: { unit: "row", first: "B", target: "D", after: true } });
  const moved = ["A: abc / 1", "C: ghi / 3", "D: jkl / 4", "B: def / 2", "#H mno", "E: pqr / 5", "#I stu", "F: vwx / 6"];
  assert.deepEqual(settle(copies), moved);
  assert.equal(press(a, "undo"), true); assert.deepEqual(settle(copies), BASE);
  assert.equal(press(a, "redo"), true); assert.deepEqual(settle(copies), moved);
  done(copies);
});

test("move undo after someone else moved the same row again does nothing visible, and the press passes over to the typing before it", () => {
  const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  type(a, "A", 3, "x"); act(a, { op: "move", drop: { unit: "row", first: "B", target: "D", after: true } }); settle(copies);
  act(b, { op: "move", drop: { unit: "row", first: "B", target: "F", after: true } });
  const twice = ["A: abcx / 1", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pqr / 5", "#I stu", "F: vwx / 6", "B: def / 2"];
  assert.deepEqual(settle(copies), twice);
  assert.equal(press(a, "undo"), true);
  assert.deepEqual(settle(copies), ["A: abc / 1", ...twice.slice(1)], "B stays where the other person put it; the typing x is undone");
  done(copies);
});

test("rule d changes what is shown between a move and its undo: a join stops counting after the move and counts again after the undo", () => {
  const copies = start(), [a, b] = copies as [ChosenReplica, ChosenReplica];
  act(a, { op: "join", id: "C" }); act(b, { op: "move", drop: { unit: "row", first: "C", target: "A", after: false } });
  assert.deepEqual(settle(copies).slice(0, 3), ["C: ghi / 3", "A: abc / 1", "B: def / 2"], "C's join target is not directly above it, so C is its own row");
  assert.equal(press(b, "undo"), true);
  assert.deepEqual(settle(copies).slice(0, 2), ["A: abc / 1", "B(B+C): def ghi / 2\n3"], "back below B, the join counts again");
  assert.equal(press(b, "redo"), true);
  assert.deepEqual(settle(copies).slice(0, 3), ["C: ghi / 3", "A: abc / 1", "B: def / 2"]);
  done(copies);
});

test("a move and a delete of the same row, then the delete undone: the restored record has no rank; rule (e) reads it", () => {
  const steps: Step[] = [
    { by: 0, cmd: { op: "delete", rows: ["F"] } },
    { by: 1, cmd: { op: "move", drop: { unit: "row", first: "F", target: "A", after: true } } },
    { from: 1, to: 0 },
    { by: 0, cmd: { op: "undo" } }
  ];
  // why: the first version's second never-acceptable kind; Yjs will not redo a map entry a newer entry overrode
  const off = play({ spec: base(), steps, writers: 2, mode: "forward", seed: 1, rules: { ...ALL_RULES, rank: false } });
  assert.deepEqual(off.never, ["step 3 threw: Missing rank for b:F"]);
  const on = play({ spec: base(), steps, writers: 2, mode: "forward", seed: 1 });
  assert.deepEqual([on.never, on.local, on.lines.at(-1)], [[], [], "F: vwx / 6"]);
});

test("a scene deleted while someone types in one of its beats: the letter ends up in the removed heading's name", () => {
  const steps: Step[] = [
    { by: 0, cmd: { op: "delete", rows: ["E"] } },
    { by: 0, cmd: { op: "removeHeading", id: "H" } },
    { by: 1, cmd: { op: "type", id: "E", field: "audio", at: 1, text: "Ω" } }
  ];
  const result = play({ spec: base(), steps, writers: 2, mode: "forward", seed: 1 });
  // why: the verdict's first never-acceptable kind
  assert.ok(result.never.some(problem => /narration Ω is shown only in a removed heading/.test(problem)), result.never.join("; "));
});
