import test from "node:test";
import assert from "node:assert/strict";
import type { SharedUndoSelection } from "../../../src/core/collab/undo-record.ts";
import { bufferOracles } from "../oracles/buffer-oracles.ts";
import { replacementIntentFixtures } from "../oracles/buffer-replacements.ts";
import { caretAfter } from "./model-world.ts";
import { UndoScenario } from "./scenario.ts";

const TRACES = ["T04", "T01", "T01 composition", "T02", "T02 boundary", "T03", "T03 replace"] as const;
const RUNS: Record<typeof TRACES[number], number> = { T04: 3, T01: 5, "T01 composition": 5, T02: 3, "T02 boundary": 1, T03: 2, "T03 replace": 3 };

for (const trace of TRACES) test(`Stage 1 ${trace}: the undo half on the shared owner matches its copied literal`, () => {
  const fixture = bufferOracles[trace];
  for (const order of fixture.orders) {
    const s = new UndoScenario(fixture.seed, order);
    const at = s.a.observe(fixture.beat, fixture.from, fixture.to), gap = s.a.observe(fixture.beat, fixture.from, fixture.from);
    const backspaced = trace === "T03" ? s.a.observe("R1", 3, 7) : undefined;
    const remoteAt = trace === "T04" || trace === "T02" ? 0 : trace === "T03 replace" ? 7 : 2;
    const remote = s.b.observe("R1", remoteAt, remoteAt), remoteRange = trace === "T04" ? s.b.observe("R1", 3, 4) : s.b.observe("R1", 0, 3);
    let caret: SharedUndoSelection = gap.selection;
    const writeA = (): void => {
      const text = trace === "T04" ? "xy" : trace === "T01 composition" ? "β" : trace === "T02" ? "c" : trace === "T02 boundary" ? "Z" : trace === "T03 replace" ? "a" : "";
      const created = s.a.edit({ at, text, ...(backspaced ? { remove: backspaced } : {}) });
      s.world.name(created, created.map((_, index) => "a" + (index + 1)));
      const last = created.at(-1);
      if (last !== undefined) caret = caretAfter(last);
    };
    const writeB = (): void => {
      if (trace === "T03") { s.b.mark(remoteRange, { kind: "b", value: true }); return; }
      const text = trace === "T04" ? "Z" : trace === "T02 boundary" ? "Y" : trace === "T03 replace" ? "n" : "X";
      s.world.name(s.b.edit({ at: remote, text, ...(trace === "T04" ? { remove: remoteRange } : {}) }), ["b1"]);
    };
    if (order === "D3") { writeB(); s.world.queue.deliverFrom("B", order); writeA(); }
    else { writeA(); if (order === "D2" || order === "late-C") s.deliver(); writeB(); }
    s.check(`${trace} ${order}`, fixture.expected, { carets: { A: caret } });
    const restored = s.effective(s.a.undo.undo());
    assert.ok(restored);
    s.check(`${trace} ${order} undone`, fixture.undo, { carets: { A: restored } });
    assert.deepEqual(s.a.undo.sizes(), { undo: 0, redo: 1, dropped: 0 });
    assert.deepEqual(s.b.undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
    assert.equal(s.checks, 2);
  }
  assert.equal(fixture.orders.length, RUNS[trace]);
});

for (const fixture of replacementIntentFixtures) test(`Stage 1 replacement, ${fixture.name}: the undo half matches its copied literal`, () => {
  for (const order of fixture.orders) {
    const s = new UndoScenario([{ id: "R1", text: "the the" }], order);
    const at = s.a.observe("R1", 4, 7), remote = s.b.observe("R1", fixture.remote ?? 7, fixture.remote ?? 7);
    let caret: SharedUndoSelection | null = null;
    const writeA = (): void => {
      const created = s.a.edit({ at, text: fixture.data });
      s.world.name(created, fixture.names);
      caret = caretAfter(created.at(-1) ?? "");
    };
    const writeB = (): void => { if (fixture.remote !== null) s.world.name(s.b.edit({ at: remote, text: "n" }), ["b1"]); };
    if (order === "D3") { writeB(); s.world.queue.deliverFrom("B", order); writeA(); }
    else { writeA(); if (order === "D2" || order === "late-C") s.deliver(); writeB(); }
    assert.ok(caret);
    s.check(`${fixture.name} ${order}`, fixture.expected, { carets: { A: caret } });
    const restored = s.effective(s.a.undo.undo());
    assert.ok(restored);
    s.check(`${fixture.name} ${order} undone`, fixture.undo, { carets: { A: restored } });
  }
  assert.equal(fixture.orders.length, fixture.remote === null ? 1 : 3);
});
