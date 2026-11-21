import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dom } from "../../../../src/test/_dom.mjs";
import type { NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import { RaceWorld, countUpdates, deltaOf, formatRange, printCell, readCell, typeAt } from "./format-harness.ts";
import type { RaceStackItem, RaceWriter } from "./format-harness.ts";

after(() => { dom.window.close(); });

type Span = readonly [number, number];
interface Scenario {
  readonly name: string; readonly a: Span; readonly b: Span; readonly other: "bold" | "unbold" | "none";
  readonly typing: "none" | "unseen" | "seen"; readonly typeAt: number; readonly olderTyping?: boolean; readonly otherSawA?: boolean;
}

const CELL: NativeTextTarget = { beat: "one", cell: "narration" }, ORIGINAL = "abcdefgh";
const RANGES: [string, Span][] = [["Separated", [0, 1]], ["Touching", [0, 2]], ["Overlapping", [4, 7]], ["Nested", [3, 5]], ["Identical", [2, 6]]];
const SCENARIOS: Scenario[] = [
  ...RANGES.flatMap(([name, b]): Scenario[] => (["bold", "unbold"] as const).flatMap(other =>
    (["none", "unseen", "seen"] as const).map(typing => ({ name, a: [2, 6] as const, b, other, typing, typeAt: 4 })))),
  { name: "Bold bc, then type X", a: [1, 3], b: [0, 0], other: "none", typing: "seen", typeAt: 2 },
  { name: "Bold bc, then type X (no older step)", a: [1, 3], b: [0, 0], other: "none", typing: "seen", typeAt: 2, olderTyping: false },
  { name: "Bold bc, then unbold bc", a: [1, 3], b: [1, 3], other: "unbold", typing: "none", typeAt: 0, otherSawA: true }
];

// why: the kind-key column of prototypes/collab/src/format-keys/RESULT.md (removed; see commit 5b9b2b141)
// supplies the evidence for design decision 3's plain keys
const E4_KIND_KEYS: readonly string[] = [
  "0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0", "0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0", "0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0",
  "0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0", "0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0", "0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0",
  "4/0/0/4/4 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0", "4/0/0/4/4 · 0/0 · r,r/r,r · 1,1/1,1 · 1 · 0", "4/4/0/0/4/4 · 2/0 · r,r/r,r · 1,1/1,1 · 0 · 0",
  "8/0/0/8/8 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0", "8/0/0/8/8 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0", "8/8/0/0/8/8 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0",
  "2/6/0/0/2 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0", "2/6/6/2/2 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0", "2/2/0/6/2/2 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0",
  "0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/2,2 · 0 · 0", "0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 2 · 0", "0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0",
  "2/4/0/0/2 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0", "2/2/4/2/2 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0", "2/2/2/4/2/2 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0",
  "0/0/0/2/0 · 4/0 · r,r/r,r · 1,1/2,2 · 0 · 0", "0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 2 · 0", "0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0",
  "0/4/0/4/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0", "0/2/4/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0", "0/0/2/4/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0",
  "8/0/0/0/8 · 0/0 · w,w/r,r · 1,1/1,1 · 0 · 0", "8/0/0/8/8 · 0/0 · w,w/r,r · 1,1/1,1 · 0 · 0", "8/8/0/0/8/8 · 0/0 · w,w/r,r · 1,1/1,1 · 0 · 0",
  "0/0/0/0/0/0 · 2/0 · r,r/r,r · 1,1/1,1 · 0 · 0", "0/0/0/0/0/0 · 2/0 · r,r/r,r · 1,1/1,1 · 0 · 0", "0/0/0/0/0 · 0/0 · w,w/r,r · 1,1/1,1 · 0 · 0"
];

function letters([from, to]: Span): string[] { return [...ORIGINAL.slice(from, to)]; }

interface Measurement { missing: number[]; leftover: number[]; steps: string[]; updates: number[]; disagreement: number; xBold: boolean; afterAUndo: string }

// why: after prototypes/collab/test/format-keys/schemes.test.ts (removed; see commit 5b9b2b141).
// The expected bold comes from the commands issued alone.
function measure(scenario: Scenario, aHasLowerId: boolean): Measurement {
  const { other, typing, otherSawA } = scenario, aLetters = letters(scenario.a), bLetters = letters(scenario.b);
  const seedBold = other === "unbold" && !otherSawA;
  const world = new RaceWorld({ one: { audioText: ORIGINAL, visualText: "" } }, aHasLowerId ? [1, 2] : [2, 1], 900, seedBold
    ? fixture => { assert.equal(formatRange(fixture, CELL, scenario.b[0], scenario.b[1], { kind: "plain", mark: "b", on: true }), "written"); }
    : undefined);
  const [a, b] = world.writers as [RaceWriter, RaceWriter];
  const missing: number[] = [], leftover: number[] = [], steps: string[] = [], updates: number[] = [];
  let disagreement = 0, aOn = false, bOn = false;
  const snapshot = (writer: RaceWriter) => readCell(deltaOf(writer.script, CELL));
  const expected = (): Set<string> => new Set([
    ...(aOn ? aLetters.filter(char => !otherSawA || !bOn || !bLetters.includes(char)) : []),
    ...(!otherSawA && bOn === (other === "bold") ? bLetters : [])
  ]);
  const record = (takenBack?: string[]): void => {
    world.pullAll();
    const actual = snapshot(a), want = expected(), visible = new Set(actual.filter(char => char.names.includes("b")).map(char => char.ch));
    missing.push([...want].filter(char => !visible.has(char)).length);
    if (takenBack) leftover.push(takenBack.filter(char => visible.has(char)).length);
    if (JSON.stringify(actual) !== JSON.stringify(snapshot(b))) disagreement++;
    for (const writer of [a, b]) if (!world.lateAgrees(writer, [CELL])) disagreement++;
  };
  const last = (writer: RaceWriter): RaceStackItem | null => writer.undo.undoStack.at(-1) ?? null;
  const newStep = (writer: RaceWriter, edit: () => void): RaceStackItem | null => {
    const before = last(writer);
    edit();
    writer.script.reader.refresh();
    const after = last(writer);
    return before === after ? null : after;
  };
  const undo = (writer: RaceWriter, target: RaceStackItem | null): void => {
    let item: RaceStackItem | null = null;
    updates.push(countUpdates(writer, () => { item = writer.undo.undo(); }));
    steps.push(item === null ? "empty" : item === target ? "right" : "wrong");
  };
  const redo = (writer: RaceWriter): void => { writer.undo.redo(); writer.script.reader.refresh(); };
  try {
    if (scenario.olderTyping !== false) {
      typeAt(a, CELL, ORIGINAL.length, "Q");
      world.pullAll();
      typeAt(b, CELL, ORIGINAL.length + 1, "R");
      world.pullAll();
    }
    const aTarget = newStep(a, () => { formatRange(a, CELL, scenario.a[0], scenario.a[1], { kind: "plain", mark: "b", on: true }); });
    aOn = true;
    let bTarget: RaceStackItem | null = null;
    if (other !== "none") {
      if (otherSawA) world.pullAll();
      bTarget = newStep(b, () => { formatRange(b, CELL, scenario.b[0], scenario.b[1], { kind: "plain", mark: "b", on: other === "bold" }); });
      bOn = true;
    }
    const insert = (): void => { bTarget = newStep(b, () => { typeAt(b, CELL, scenario.typeAt, "X"); }); };
    if (typing === "unseen") insert();
    record();
    if (typing === "seen") { insert(); record(); }
    const xBold = typing !== "none" && snapshot(a).some(char => char.ch === "X" && char.names.includes("b"));
    let before = [...expected()];
    undo(a, aTarget);
    aOn = false;
    record(before.filter(char => !expected().has(char)));
    const afterAUndo = printCell(snapshot(a));
    before = [...expected()];
    undo(b, bTarget);
    if (typing === "none") bOn = false;
    const afterB = expected();
    record(before.filter(char => !afterB.has(char)));
    redo(a);
    aOn = true;
    record();
    redo(b);
    if (typing === "none") bOn = true;
    record();
    return { missing, leftover, steps, updates, disagreement, xBold, afterAUndo };
  } finally { world.close(); }
}

function cell(low: Measurement, high: Measurement): string {
  const sums = (first: number[], second: number[]): string => first.map((count, index) => count + (second[index] ?? NaN)).join("/");
  const presses = low.updates.map((count, index) => `${count},${high.updates[index]}`).join("/");
  const order = low.steps.map((step, index) => `${step[0]},${high.steps[index]?.[0]}`).join("/");
  return [sums(low.missing, high.missing), sums(low.leftover, high.leftover), order, presses, String(Number(low.xBold) + Number(high.xBold)), String(low.disagreement + high.disagreement)].join(" · ");
}

test("E4 on the adapter: plain bold under same-moment edits, undo and redo, both client orders, equals E4's kind-key table", t => {
  const measured = SCENARIOS.map(scenario => {
    const low = measure(scenario, true), high = measure(scenario, false);
    return { scenario, low, high, line: cell(low, high) };
  });
  t.diagnostic(measured.map(({ scenario, line }) => `| ${scenario.name} | ${scenario.other} | ${scenario.typing} | ${line} |`).join("\n"));
  const paired = measured.slice(0, 30), merge = paired.reduce((sum, { low, high }) => sum + (low.missing[0] ?? 0) + (high.missing[0] ?? 0), 0);
  const left = paired.reduce((sum, { low, high }) => sum + [...low.leftover, ...high.leftover].reduce((a, b) => a + b, 0), 0);
  const wrong = paired.reduce((sum, { low, high }) => sum + [...low.steps, ...high.steps].filter(step => step === "wrong").length, 0);
  const xBold = paired.filter(({ scenario }) => scenario.typing === "unseen").reduce((sum, { low, high }) => sum + Number(low.xBold) + Number(high.xBold), 0);
  t.diagnostic(`missing at merge ${merge}; left bold after undo ${left}; wrong undo steps ${wrong} of 120; bold on unseen X ${xBold} of 20`);
  assert.deepEqual(measured.map(({ line }) => line), E4_KIND_KEYS);
  assert.deepEqual([merge, left, wrong, xBold], [72, 34, 6, 11]);
  const cleanup = measured.flatMap(({ low, high }) => [low, high]).flatMap(result =>
    result.updates.flatMap((count, at) => count === 2 ? [result.steps[at]] : []));
  assert.deepEqual(cleanup, ["right", "right", "right", "right"]);
  for (const { scenario, low, high } of measured) if (scenario.other === "none") {
    for (const result of [low, high]) assert.equal(result.afterAUndo, scenario.olderTyping !== false ? "abX[cdefghQR|b]" : "abX[cdefgh|b]");
  }
});
