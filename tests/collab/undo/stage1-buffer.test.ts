import test from "node:test";
import assert from "node:assert/strict";
import type { SharedUndoSelection } from "../../../src/core/collab/undo-record.ts";
import { bufferOracles } from "../oracles/buffer-oracles.ts";
import { replacementIntentFixtures } from "../oracles/buffer-replacements.ts";
import { UNDO_BUFFER_TRACES, runBufferTrace } from "./buffer-cases.ts";
import type { UndoBufferTrace } from "./buffer-cases.ts";
import { ADAPTER_BUFFER_LIMIT_RUNS } from "./limits.ts";
import { ADAPTER_WORLD, MODEL_WORLD, UNDO_WORLDS, UndoScenario } from "./scenario.ts";

const RUNS: Record<UndoBufferTrace, number> = { T04: 3, T01: 5, "T01 composition": 5, T02: 3, "T02 boundary": 1, T03: 2, "T03 replace": 3 };
const ADAPTER_RUNS: Record<UndoBufferTrace, number> = { T04: 3, T01: 4, "T01 composition": 4, T02: 3, "T02 boundary": 1, T03: 2, "T03 replace": 3 };

for (const trace of UNDO_BUFFER_TRACES) test(`Stage 1 ${trace}: the undo half on the shared owner matches its copied literal`, () => {
  const orders = bufferOracles[trace].orders;
  let adapter = 0;
  for (const order of orders) {
    runBufferTrace(trace, order, MODEL_WORLD);
    if (ADAPTER_BUFFER_LIMIT_RUNS.some(run => run.trace === trace && run.order === order)) continue;
    runBufferTrace(trace, order, ADAPTER_WORLD);
    adapter++;
  }
  assert.equal(orders.length, RUNS[trace]);
  assert.equal(adapter, ADAPTER_RUNS[trace]);
});

for (const fixture of replacementIntentFixtures) test(`Stage 1 replacement, ${fixture.name}: the undo half matches its copied literal`, () => {
  for (const kind of UNDO_WORLDS) for (const order of fixture.orders) {
    const s = new UndoScenario([{ id: "R1", text: "the the" }], order, kind);
    const at = s.a.observe("R1", 4, 7), remote = s.b.observe("R1", fixture.remote ?? 7, fixture.remote ?? 7);
    let caret: SharedUndoSelection | null = null;
    const writeA = (): void => {
      const created = s.a.edit({ at, text: fixture.data });
      s.world.name(created, fixture.names);
      caret = s.a.caretAfter(created.at(-1) ?? "");
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
