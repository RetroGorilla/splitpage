import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { printCell, readCell } from "../../src/format-keys/model.ts";
import { World, deltaOf, measureUndo } from "../../src/format-keys/world.ts";
import { NativeReplica } from "../../src/native/variant.ts";
import type { NativeScheme } from "../../src/native/variant.ts";

type Span = readonly [number, number];
type Scenario = {
  name: string; a: Span; b: Span; other: "bold" | "unbold" | "none";
  typing: "none" | "unseen" | "seen"; typeAt: number; olderTyping?: boolean; otherSawA?: boolean;
};
type StackItem = Y.UndoManager["undoStack"][number];

const beat = "one", field = "audioText", original = "abcdefgh";
const ranges: [string, Span][] = [
  ["Separated", [0, 1]], ["Touching", [0, 2]], ["Overlapping", [4, 7]], ["Nested", [3, 5]], ["Identical", [2, 6]]
];
const scenarios = ranges.flatMap(([name, b]): Scenario[] => (["bold", "unbold"] as const).flatMap(other =>
  (["none", "unseen", "seen"] as const).map(typing => ({ name, a: [2, 6], b, other, typing, typeAt: 4 }))));
scenarios.push(
  { name: "Bold bc, then type X", a: [1, 3], b: [0, 0], other: "none", typing: "seen", typeAt: 2 },
  { name: "Bold bc, then type X (no older step)", a: [1, 3], b: [0, 0], other: "none", typing: "seen", typeAt: 2, olderTyping: false },
  { name: "Bold bc, then unbold bc", a: [1, 3], b: [1, 3], other: "unbold", typing: "none", typeAt: 0, otherSawA: true }
);

function letters([from, to]: Span): string[] { return [...original.slice(from, to)]; }

function measure(scheme: NativeScheme, scenario: Scenario, aHasLowerId: boolean) {
  const world = new World({ rows: [{ id: beat, audioText: original, visualText: "" }] }, scheme, 2);
  const [a, b] = (aHasLowerId ? world.writers : [...world.writers].reverse()) as [NativeReplica, NativeReplica];
  const { other, typing, typeAt, otherSawA } = scenario, aLetters = letters(scenario.a), bLetters = letters(scenario.b);
  const missing: number[] = [], leftover: number[] = [], steps: string[] = [], updates: number[] = [];
  let disagreement = 0;
  const format = (copy: NativeReplica, [from, to]: Span, value: true | null): void => {
    copy.format(beat, field, from, to, { b: value });
    copy.changes();
  };
  const type = (copy: NativeReplica, at: number, char: string): void => {
    copy.splice(beat, field, at, at, [{ text: char, marks: {} }]);
    copy.changes();
  };
  const snapshot = (copy: NativeReplica) => readCell(deltaOf(copy, beat, field));
  let aOn = false, bOn = false;
  const expected = () => new Set([
    ...(aOn ? aLetters.filter(char => !otherSawA || !bOn || !bLetters.includes(char)) : []),
    ...(!otherSawA && bOn === (other === "bold") ? bLetters : [])
  ]);
  const record = (takenBack?: string[]): void => {
    world.pullAll();
    const actual = snapshot(a), want = expected();
    const visible = new Set(actual.filter(char => char.names.includes("b")).map(char => char.ch));
    missing.push([...want].filter(char => !visible.has(char)).length);
    if (takenBack) leftover.push(takenBack.filter(char => visible.has(char)).length);
    if (JSON.stringify(actual) !== JSON.stringify(snapshot(b))) disagreement++;
    for (const copy of [a, b]) {
      const late = new NativeReplica(901, 0, scheme);
      try {
        Y.applyUpdate(late.doc, copy.encode(), "remote");
        late.changes();
        if (JSON.stringify(actual) !== JSON.stringify(snapshot(late))) disagreement++;
      } finally { late.destroy(); }
    }
  };
  const undo = (copy: NativeReplica, target: StackItem | null): void => {
    const { item, updates: sent } = measureUndo(copy);
    steps.push(item === null ? "empty" : item === target ? "right" : "wrong");
    updates.push(sent);
  };
  const last = (copy: NativeReplica) => copy.undo.undoStack.at(-1) ?? null;
  const newStep = (copy: NativeReplica, edit: () => void): StackItem | null => {
    const before = last(copy);
    edit();
    const after = last(copy);
    return before === after ? null : after;
  };
  const redo = (copy: NativeReplica): void => { copy.undo.redo(); copy.changes(); };
  try {
    if (other === "unbold" && !otherSawA) {
      const fixture = new NativeReplica(902, 0, scheme);
      try {
        Y.applyUpdate(fixture.doc, Y.encodeStateAsUpdate(world.server), "remote");
        fixture.changes();
        format(fixture, scenario.b, true);
        Y.applyUpdate(world.server, fixture.encode(), "remote");
      } finally { fixture.destroy(); }
      world.pullAll();
    }
    if (scenario.olderTyping !== false) {
      type(a, original.length, "Q");
      world.pullAll();
      type(b, original.length + 1, "R");
      world.pullAll();
    }

    const aTarget = newStep(a, () => format(a, scenario.a, true));
    aOn = true;
    let bTarget: StackItem | null = null;
    if (other !== "none") {
      if (otherSawA) world.pullAll();
      bTarget = newStep(b, () => format(b, scenario.b, other === "bold" ? true : null));
      bOn = true;
    }
    const insert = () => { bTarget = newStep(b, () => type(b, typeAt, "X")); };
    if (typing === "unseen") insert();
    record();
    if (typing === "seen") {
      insert();
      record();
    }
    const xBold = typing !== "none" && snapshot(a).some(char => char.ch === "X" && char.names.includes("b"));

    let before = [...expected()];
    undo(a, aTarget);
    aOn = false;
    record(before.filter(char => !expected().has(char)));
    const afterAUndo = printCell(snapshot(a));
    before = [...expected()];
    undo(b, bTarget);
    if (typing === "none") bOn = false;
    const after = expected();
    record(before.filter(char => !after.has(char)));

    redo(a);
    aOn = true;
    record();
    redo(b);
    if (typing === "none") bOn = true;
    record();
    return { missing, leftover, steps, updates, disagreement, xBold, afterAUndo };
  } finally { world.destroy(); }
}

type Measurement = ReturnType<typeof measure>;

function totals(first: number[], second: number[]): string {
  return first.map((count, index) => {
    const other = second[index];
    assert.ok(other !== undefined);
    return count + other;
  }).join("/");
}

function cell([low, high]: [Measurement, Measurement]): string {
  const presses = low.updates.map((count, index) => `${count},${high.updates[index]}`).join("/");
  const order = low.steps.map((step, index) => `${step[0]},${high.steps[index]?.[0]}`).join("/");
  return [totals(low.missing, high.missing), totals(low.leftover, high.leftover), order, presses,
    String(Number(low.xBold) + Number(high.xBold)), String(low.disagreement + high.disagreement)].join(" · ");
}

test("same-kind unseen edits, undo and redo under both key schemes and both client orders", t => {
  const lines: string[] = [];
  for (const scenario of scenarios) {
    const pair = (scheme: NativeScheme): [Measurement, Measurement] => [measure(scheme, scenario, true), measure(scheme, scenario, false)];
    const name = pair("name"), act = pair("act");
    for (const result of [...name, ...act]) assert.equal(result.disagreement, 0, scenario.name);
    lines.push(`| ${scenario.name} | ${scenario.other} | ${scenario.typing} | ${cell(name)} | ${cell(act)} |`);
    if (scenario.other === "none") {
      const older = scenario.olderTyping !== false;
      for (const result of name) assert.equal(result.afterAUndo, older ? "abX[cdefghQR|b]" : "abX[cdefgh|b]");
      for (const result of act) assert.equal(result.afterAUndo, older ? "abX[c|b]defghQR" : "abX[c|b]defgh");
    }
    if (scenario.other === "unbold" && scenario.typing === "none" && scenario.name === "Overlapping") {
      for (const result of name) assert.deepEqual(result.updates, [1, 2]);
      for (const result of act) assert.deepEqual(result.updates, [1, 1]);
    }
    if (scenario.other === "unbold" && scenario.name === "Identical") {
      for (const result of name) assert.equal(result.steps[0], "wrong");
      for (const result of act) assert.equal(result.steps[0], "right");
    }
    if (scenario.otherSawA) for (const result of [...name, ...act]) {
      assert.equal(result.steps[0], "wrong");
      assert.equal(result.afterAUndo, "abcdefghR");
    }
  }
  if (process.env.E4_TABLE === "1") t.diagnostic(lines.join("\n"));
});
