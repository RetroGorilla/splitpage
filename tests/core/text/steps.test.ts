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
    let kind = rows.length ? Math.floor(r() * 6) : 3;
    if (kind === 5 && rows.length < 2) kind = 3;
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
      } else if (before !== undefined && r() < 0.6) {
        after = undefined;
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
      const from = Math.floor(r() * rows.length);
      step = { op: "moveRow", from: from, to: (from + 1 + Math.floor(r() * (rows.length - 1))) % rows.length };
    }
    steps.push(step);
    state = applySteps(state, [step]);
  }
  return steps;
}

test("apply, then apply the inverse, is the identity over seeded random edits, fields removed from any row included", () => {
  const r = rng(2024);
  const seen = { removals: 0, moves: 0, stillMoves: 0 };
  for (let n = 0; n < 200; n++) {
    const start = doc(r);
    const before = start.state;
    const frozen = JSON.stringify(before);
    const steps = randomSteps(r, start, 1 + Math.floor(r() * 8));
    for (const s of steps) {
      if (s.op === "rowField" && s.before !== undefined && s.after === undefined) seen.removals++;
      if (s.op === "moveRow") { seen.moves++; if (s.from === s.to) seen.stillMoves++; }
    }
    const after = applySteps(before, steps);
    assert.equal(JSON.stringify(before), frozen, "the state handed in is not touched");
    const back = applySteps(after, invertSteps(steps));
    assert.deepEqual(back, before);
    assert.deepEqual(invertSteps(invertSteps(steps)), steps);
  }
  assert.ok(seen.removals >= 20, JSON.stringify(seen));
  assert.ok(seen.moves >= 50, JSON.stringify(seen));
  assert.equal(seen.stillMoves, 0);
});

test("the inverse of an insertRow applies once a field removed from that row has been put back, last (#323)", () => {
  const steps: Step[] = [
    { op: "insertRow", index: 0, row: { id: "r1", a: 1, b: 2 } },
    { op: "rowField", rowId: "r1", key: "a", before: 1 }
  ];
  const after = applySteps({ rows: [] }, steps);
  assert.deepEqual(after, { rows: [{ id: "r1", b: 2 }] });
  const inverse = invertSteps(steps);
  const restored = applySteps(after, inverse.slice(0, 1));
  assert.deepEqual(Object.keys((restored.rows || [])[0] || {}), ["id", "b", "a"]);
  assert.deepEqual(applySteps(after, inverse), { rows: [] });
});

test("a deleteRow compares the row's keys and values at every depth, not their order (#323)", () => {
  const state: StepState = { rows: [{ id: "r1", status: { label: "shot", list: [{ x: 1, y: 2 }] }, note: "n" }] };
  const applies = (row: StepRow) => assert.deepEqual(applySteps(state, [{ op: "deleteRow", index: 0, row: row }]), { rows: [] });
  const refused = (row: StepRow) => assert.throws(() => applySteps(state, [{ op: "deleteRow", index: 0, row: row }]),
    (e: Error & { code?: string }) => e.code === "STEP_REFUSED" && e.message === "step does not apply: deleteRow (row has changed)");
  applies({ note: "n", status: { list: [{ y: 2, x: 1 }], label: "shot" }, id: "r1" });
  applies({ id: "r1", note: "n", status: { label: "shot", list: [{ x: 1, y: 2 }] }, gone: undefined });
  refused({ note: "n", status: { list: [{ y: 2, x: 1 }], label: "cut" }, id: "r1" });
  refused({ note: "n", status: { list: [{ y: 2, x: 1 }, 3], label: "shot" }, id: "r1" });
  refused({ note: "n", status: { list: [{ y: 2 }], label: "shot" }, id: "r1" });
  refused({ id: "r1", status: { label: "shot", list: [{ x: 1, y: 2 }] } });
  refused({ id: "r1", status: { label: "shot", list: [{ x: 1, y: 2 }] }, note: "n", extra: 0 });
  refused({ id: "r1", status: { label: "shot", list: [{ x: 1, y: 2 }] }, note: ["n"] });
  refused({ id: "r1", status: { label: "shot", list: [{ x: 1, y: 2 }] }, note: { 0: "n" } });
  refused({ id: "r1", status: { list: { 0: { x: 1, y: 2 } }, label: "shot" }, note: "n" });
  refused({ id: "r1", status: { label: "shot", list: [{ x: 1, y: 2 }] }, Note: "n" });
  refused({ note: "n", status: { list: [{ X: 1, y: 2 }], label: "shot" }, id: "r1" });
  const boxed: StepState = { rows: [{ id: "r1", n: new Number(1), b: new Boolean(true), s: new String("a") }] };
  const boxedRefused = (row: StepRow) => assert.throws(() => applySteps(boxed, [{ op: "deleteRow", index: 0, row: row }]),
    (e: Error & { code?: string }) => e.code === "STEP_REFUSED" && e.message === "step does not apply: deleteRow (row has changed)");
  boxedRefused({ s: new String("a"), b: new Boolean(true), n: new Number(2), id: "r1" });
  boxedRefused({ s: new String("a"), b: new Boolean(false), n: new Number(1), id: "r1" });
  boxedRefused({ s: new String("b"), b: new Boolean(true), n: new Number(1), id: "r1" });
  assert.deepEqual(applySteps(boxed, [{ op: "deleteRow", index: 0, row: { s: "a", b: true, n: 1, id: "r1" } }]), { rows: [] });
  const parsed = JSON.parse("{\"rows\":[{\"id\":\"r1\",\"__proto__\":{\"a\":1},\"b\":2}]}") as StepState;
  assert.throws(() => applySteps(parsed, [{ op: "deleteRow", index: 0, row: JSON.parse("{\"b\":2,\"id\":\"r1\",\"__proto__\":{\"a\":2}}") as StepRow }]),
    (e: Error & { code?: string }) => e.code === "STEP_REFUSED");
  assert.deepEqual(applySteps(parsed, [{ op: "deleteRow", index: 0, row: JSON.parse("{\"b\":2,\"__proto__\":{\"a\":1},\"id\":\"r1\"}") as StepRow }]), { rows: [] });
});

test("a field's before value is compared by keys and values too, not their order", () => {
  const state: StepState = { meta: { a: 1, b: [{ c: 2, d: 3 }] }, rows: [{ id: "r1", status: { label: "shot", n: 1 } }] };
  assert.deepEqual(applySteps(state, [
    { op: "rowField", rowId: "r1", key: "status", before: { n: 1, label: "shot" }, after: "cut" },
    { op: "docField", key: "meta", before: { b: [{ d: 3, c: 2 }], a: 1 }, after: "m" }
  ]), { meta: "m", rows: [{ id: "r1", status: "cut" }] });
  assert.throws(() => applySteps(state, [{ op: "rowField", rowId: "r1", key: "status", before: { n: 2, label: "shot" }, after: "cut" }]),
    (e: Error & { code?: string }) => e.code === "STEP_REFUSED" && /status has changed/.test(e.message));
  assert.throws(() => applySteps(state, [{ op: "docField", key: "meta", before: { b: [{ c: 3, d: 2 }], a: 1 }, after: "m" }]),
    (e: Error & { code?: string }) => e.code === "STEP_REFUSED" && /meta has changed/.test(e.message));
});

function shuffled(r: () => number, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => shuffled(r, x));
  if (!v || typeof v !== "object") return v;
  const keys = Object.keys(v);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const k = keys[i] as string;
    keys[i] = keys[j] as string;
    keys[j] = k;
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = shuffled(r, (v as Record<string, unknown>)[k]);
  return out;
}

function sameOrder(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function randomValue(r: () => number): unknown {
  return pick(r, ["todo", "shot", 0, 7, null, true, ["Ada", "Bo"], { label: "x", list: [1, { p: 1, q: 2 }] }, { a: { b: "c", d: "e" }, f: 1 }]);
}

function randomRow(r: () => number, id: string): StepRow {
  const row: StepRow = { id: id };
  for (const k of ["status", "note", "lengthSeconds", "tags", "meta"]) if (r() < 0.7) row[k] = randomValue(r);
  return shuffled(r, row) as StepRow;
}

test("in any key order, apply then the inverse gives the original back, over seeded steps that remove and restore fields of any row (#323)", () => {
  const r = rng(323);
  const seen = { restoredThenDeleted: 0, deletedInOtherOrder: 0, steps: 0 };
  for (let n = 0; n < 400; n++) {
    const rows: StepRow[] = [];
    for (let i = 0, count = Math.floor(r() * 4); i < count; i++) rows.push(randomRow(r, "r" + i));
    const before = shuffled(r, { title: "T", people: ["Ada"], rows: rows }) as StepState;
    const frozen = JSON.stringify(before);
    const steps: Step[] = [];
    const removed: Record<string, boolean> = {};
    let state = before;
    let fresh = 0;
    for (let k = 0, count = 1 + Math.floor(r() * 8); k < count; k++) {
      const live = (state.rows || []) as StepRow[];
      let kind = live.length ? Math.floor(r() * 6) : 0;
      if (kind === 5 && live.length < 2) kind = 0;
      let step: Step;
      if (kind === 0) {
        step = { op: "insertRow", index: Math.floor(r() * (live.length + 1)), row: randomRow(r, "n" + fresh++) };
      } else if (kind === 1 || kind === 2) {
        const row = pick(r, live);
        const key = pick(r, ["status", "note", "lengthSeconds", "tags", "meta"]);
        const after = row[key] !== undefined && r() < 0.6 ? undefined : shuffled(r, randomValue(r));
        if (after === undefined) removed[row.id as string] = true;
        step = { op: "rowField", rowId: row.id as string, key: key, before: shuffled(r, row[key]), after: after };
      } else if (kind === 3) {
        const key = pick(r, ["title", "people", "extra"]);
        step = { op: "docField", key: key, before: shuffled(r, state[key]), after: r() < 0.3 ? undefined : shuffled(r, randomValue(r)) };
      } else if (kind === 4) {
        const index = Math.floor(r() * live.length);
        const row = shuffled(r, live[index]) as StepRow;
        if (!sameOrder(row, live[index])) seen.deletedInOtherOrder++;
        step = { op: "deleteRow", index: index, row: row };
      } else {
        const from = Math.floor(r() * live.length);
        step = { op: "moveRow", from: from, to: (from + 1 + Math.floor(r() * (live.length - 1))) % live.length };
      }
      steps.push(step);
      state = applySteps(state, [step]);
    }
    seen.steps += steps.length;
    for (const s of steps) if (s.op === "insertRow" && removed[s.row.id as string]) seen.restoredThenDeleted++;
    const back = applySteps(state, invertSteps(steps));
    assert.equal(JSON.stringify(before), frozen, "the state handed in is not touched");
    assert.deepEqual(back, before);
    assert.deepEqual(applySteps(back, steps), state);
  }
  assert.ok(seen.restoredThenDeleted >= 50, JSON.stringify(seen));
  assert.ok(seen.deletedInOtherOrder >= 50, JSON.stringify(seen));
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

test("applying a step copies its values in: changing the step or the state later never reaches the other", () => {
  const status = { label: "shot", list: [1] };
  const people = ["Ada"];
  const row = { id: "r2", tags: ["x"] };
  const steps: Step[] = [
    { op: "rowField", rowId: "r1", key: "status", before: "todo", after: status },
    { op: "docField", key: "people", after: people },
    { op: "insertRow", index: 1, row: row }
  ];
  const start: StepState = { rows: [{ id: "r1", status: "todo" }] };
  const state = applySteps(start, steps);
  const frozenState = JSON.stringify(state);
  const frozenSteps = JSON.stringify(steps);
  status.label = "changed";
  status.list.push(2);
  people.push("Bo");
  row.tags.push("y");
  row.id = "zz";
  assert.equal(JSON.stringify(state), frozenState);
  row.id = "r2";
  row.tags.pop();
  people.pop();
  status.list.pop();
  status.label = "shot";
  const rows = state.rows as StepRow[];
  ((rows[0] as StepRow).status as { list: number[] }).list.push(3);
  (state.people as string[]).push("Cy");
  ((rows[1] as StepRow).tags as string[]).push("z");
  assert.equal(JSON.stringify(steps), frozenSteps);
});

test("inverting copies the values too: the inverse and the steps share nothing", () => {
  const before = { a: [1] }, after = { a: [2] }, row = { id: "r1", list: [1] };
  const steps: Step[] = [
    { op: "rowField", rowId: "r1", key: "k", before: before, after: after },
    { op: "docField", key: "d", before: before, after: after },
    { op: "insertRow", index: 0, row: row },
    { op: "deleteRow", index: 0, row: row }
  ];
  const inverse = invertSteps(steps);
  const frozen = JSON.stringify(inverse);
  before.a.push(9);
  after.a.push(9);
  row.list.push(9);
  assert.equal(JSON.stringify(inverse), frozen);
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
