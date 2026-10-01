import { test } from "node:test";
import assert from "node:assert/strict";
import { applySteps, invertSteps, touchedCells } from "../../../src/core/text/steps.ts";
import type { Step, StepRow, StepState } from "../../../src/core/text/steps.ts";
import { addComment, deleteRange, insertText, setMark } from "../../../src/core/text/edits.ts";
import { cellLength, normalizeCell } from "../../../src/core/text/runs.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { randomCell, rng } from "./cells.ts";

type Doc = { state: StepState; cells: Map<string, Run[]> };

function doc(r: () => number): Doc {
  const rows: StepRow[] = [];
  const cells = new Map<string, Run[]>();
  const n = 1 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const visual = normalizeCell(randomCell(r)), audio = normalizeCell(randomCell(r));
    cells.set("r" + i + " visualText", visual);
    cells.set("r" + i + " audioText", audio);
    rows.push({ id: "r" + i, status: "todo", visualText: toHtml(visual), audioText: toHtml(audio) });
  }
  return { state: { title: "T", rows: rows, people: ["Ada"] }, cells: cells };
}

function pick<T>(r: () => number, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)] as T;
}

function editCell(r: () => number, cell: Run[]): Run[] {
  const n = cellLength(cell);
  const p = Math.floor(r() * (n + 1)), q = Math.floor(r() * (n + 1));
  const kind = Math.floor(r() * 4);
  if (kind === 0) return insertText(cell, p, pick(r, ["x", " new ", "\u{1F600}", "\n"]));
  if (kind === 1) return deleteRange(cell, p, q);
  if (kind === 2) return setMark(cell, p, q, pick(r, ["b", "i", "hl"] as const), r() < 0.5);
  return addComment(cell, p, q, "c" + Math.floor(r() * 3));
}

function randomSteps(r: () => number, start: Doc, count: number): Step[] {
  const steps: Step[] = [];
  let state = start.state;
  let fresh = 0;
  for (let k = 0; k < count; k++) {
    const rows = (state.rows || []) as StepRow[];
    const kind = rows.length ? Math.floor(r() * 6) : 3;
    let step: Step;
    if (kind === 0 || kind === 1) {
      const row = pick(r, rows);
      const key = pick(r, ["visualText", "audioText", "status", "note"]);
      const before = row[key];
      let after: unknown;
      if (key === "visualText" || key === "audioText") {
        const cell = start.cells.get(row.id + " " + key) || [];
        assert.equal(toHtml(cell), before);
        const next = editCell(r, cell);
        start.cells.set(row.id + " " + key, next);
        after = toHtml(next);
      } else {
        after = pick(r, ["todo", "shot", "cut", { nested: [1, 2] }]);
      }
      step = { op: "rowField", rowId: row.id as string, key: key, before: before, after: after };
    } else if (kind === 2) {
      const key = pick(r, ["title", "people", "extra"]);
      step = { op: "docField", key: key, before: state[key], after: r() < 0.2 ? undefined : pick(r, ["New", ["Ada", "Bo"], { a: 1 }]) };
    } else if (kind === 3) {
      step = { op: "insertRow", index: Math.floor(r() * (rows.length + 1)), row: { id: "n" + fresh++, status: "todo", visualText: "", audioText: "" } };
    } else if (kind === 4) {
      const index = Math.floor(r() * rows.length);
      step = { op: "deleteRow", index: index, row: rows[index] as StepRow };
    } else {
      step = { op: "moveRow", from: Math.floor(r() * rows.length), to: Math.floor(r() * rows.length) };
    }
    steps.push(step);
    state = applySteps(state, [step]);
  }
  return steps;
}

test("apply, then apply the inverse, is the identity over seeded random edits", () => {
  const r = rng(2024);
  for (let n = 0; n < 200; n++) {
    const start = doc(r);
    const before = start.state;
    const frozen = JSON.stringify(before);
    const steps = randomSteps(r, start, 1 + Math.floor(r() * 8));
    const after = applySteps(before, steps);
    assert.equal(JSON.stringify(before), frozen, "the state handed in is not touched");
    const back = applySteps(after, invertSteps(steps));
    assert.deepEqual(back, before);
    assert.deepEqual(invertSteps(invertSteps(steps)), steps);
  }
});

test("each step's inverse undoes it alone, in reverse order", () => {
  const r = rng(77);
  for (let n = 0; n < 50; n++) {
    const start = doc(r);
    const before = start.state;
    const steps = randomSteps(r, start, 4);
    const states: StepState[] = [before];
    for (const s of steps) states.push(applySteps(states[states.length - 1] as StepState, [s]));
    const inverse = invertSteps(steps);
    let state = states[states.length - 1] as StepState;
    inverse.forEach((s, i) => {
      state = applySteps(state, [s]);
      assert.deepEqual(state, states[states.length - 2 - i]);
    });
  }
});

test("the inverse of each kind of step", () => {
  const row = { id: "r9", visualText: "", audioText: "" };
  assert.deepEqual(invertSteps([
    { op: "rowField", rowId: "r1", key: "audioText", before: "a", after: "b" },
    { op: "docField", key: "title", before: "T" },
    { op: "insertRow", index: 2, row: row },
    { op: "deleteRow", index: 0, row: row },
    { op: "moveRow", from: 1, to: 3 }
  ]), [
    { op: "moveRow", from: 3, to: 1 },
    { op: "insertRow", index: 0, row: row },
    { op: "deleteRow", index: 2, row: row },
    { op: "docField", key: "title", before: undefined, after: "T" },
    { op: "rowField", rowId: "r1", key: "audioText", before: "b", after: "a" }
  ]);
  assert.deepEqual(Object.keys(invertSteps([{ op: "rowField", rowId: "r1", key: "k", before: 1, after: 2 }])[0] || {}), ["op", "rowId", "key", "before", "after"]);
  assert.deepEqual(invertSteps(null), []);
  assert.deepEqual(applySteps({ rows: [] }, undefined), { rows: [] });
});

test("a step that no longer applies is refused, and an unknown one too", () => {
  const state: StepState = { title: "T", rows: [{ id: "r1", text: "a" }, { id: "r2", text: "b" }] };
  const refused = (steps: unknown[], why: RegExp) =>
    assert.throws(() => applySteps(state, steps as Step[]), (e: Error & { code?: string }) => e.code === "STEP_REFUSED" && why.test(e.message));
  refused([{ op: "rowField", rowId: "gone", key: "text", before: "a", after: "x" }], /no row gone/);
  refused([{ op: "rowField", rowId: "r1", key: "text", before: "z", after: "x" }], /text has changed/);
  refused([{ op: "docField", key: "title", before: "Old", after: "x" }], /title has changed/);
  refused([{ op: "insertRow", index: 3, row: { id: "r3" } }], /index 3/);
  refused([{ op: "insertRow", index: -1, row: { id: "r3" } }], /index -1/);
  refused([{ op: "insertRow", index: 0, row: { id: "r2" } }], /row exists/);
  refused([{ op: "deleteRow", index: 0, row: { id: "r1", text: "changed" } }], /row has changed/);
  refused([{ op: "deleteRow", index: 5, row: { id: "r1" } }], /row has changed/);
  refused([{ op: "moveRow", from: 0, to: 2 }], /index/);
  refused([{ op: "moveRow", from: 4, to: 0 }], /index/);
  refused([{ op: "splitRow" }], /step does not apply: splitRow \(unknown op\)/);
  assert.throws(() => invertSteps([{ op: "splitRow" }] as unknown as Step[]), (e: Error & { code?: string }) => e.code === "STEP_REFUSED");
});

test("a field set to undefined is removed, and the inverse puts it back", () => {
  const state: StepState = { title: "T", rows: [{ id: "r1", note: "n", text: "a" }] };
  const steps: Step[] = [{ op: "rowField", rowId: "r1", key: "note", before: "n" }, { op: "docField", key: "title", before: "T" }];
  const after = applySteps(state, steps);
  assert.deepEqual(after, { rows: [{ id: "r1", text: "a" }] });
  assert.deepEqual(applySteps(after, invertSteps(steps)), state);
});

test("the cells a list of steps touches, once each, in order", () => {
  assert.deepEqual(touchedCells([
    { op: "rowField", rowId: "r1", key: "audioText", before: "a", after: "b" },
    { op: "rowField", rowId: "r1", key: "status", before: "a", after: "b" },
    { op: "insertRow", index: 0, row: { id: "r9" } },
    { op: "rowField", rowId: "r1", key: "audioText", before: "b", after: "c" },
    { op: "deleteRow", index: 0, row: { id: "r9" } },
    { op: "docField", key: "title", before: "a", after: "b" },
    { op: "moveRow", from: 0, to: 1 }
  ]), ["r1\u{0}audioText", "r9\u{0}visualText", "r9\u{0}audioText"]);
  assert.deepEqual(touchedCells(undefined), []);
});
