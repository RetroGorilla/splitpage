import assert from "node:assert/strict";
import type { SharedUndoSelection } from "../../../src/core/collab/undo-record.ts";
import type { DeliveryOrder } from "../delivery.ts";
import { bufferOracles } from "../oracles/buffer-oracles.ts";
import { MODEL_WORLD, UndoScenario } from "./scenario.ts";
import type { UndoWorldKind } from "./scenario.ts";

export const UNDO_BUFFER_TRACES = ["T04", "T01", "T01 composition", "T02", "T02 boundary", "T03", "T03 replace"] as const;
export type UndoBufferTrace = typeof UNDO_BUFFER_TRACES[number];

export function runBufferTrace(trace: UndoBufferTrace, order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const fixture = bufferOracles[trace];
  const s = new UndoScenario(fixture.seed, order, kind);
  const at = s.a.observe(fixture.beat, fixture.from, fixture.to), gap = s.a.observe(fixture.beat, fixture.from, fixture.from);
  const backspaced = trace === "T03" ? s.a.observe("R1", 3, 7) : undefined;
  const remoteAt = trace === "T04" || trace === "T02" ? 0 : trace === "T03 replace" ? 7 : 2;
  const remote = s.b.observe("R1", remoteAt, remoteAt);
  const remoteRange = trace === "T04" ? s.b.observe("R1", 3, 4) : trace === "T03" ? s.b.observe("R1", 0, 3) : undefined;
  let caret: SharedUndoSelection = gap.selection;
  const writeA = (): void => {
    const text = trace === "T04" ? "xy" : trace === "T01 composition" ? "β" : trace === "T02" ? "c" : trace === "T02 boundary" ? "Z" : trace === "T03 replace" ? "a" : "";
    const created = s.a.edit({ at, text, ...(backspaced ? { remove: backspaced } : {}) });
    s.world.name(created, created.map((_, index) => "a" + (index + 1)));
    const last = created.at(-1);
    if (last !== undefined) caret = s.a.caretAfter(last);
  };
  const writeB = (): void => {
    if (trace === "T03") { assert.ok(remoteRange); s.b.mark(remoteRange, { kind: "b", value: true }); return; }
    const text = trace === "T04" ? "Z" : trace === "T02 boundary" ? "Y" : trace === "T03 replace" ? "n" : "X";
    s.world.name(s.b.edit({ at: remote, text, ...(remoteRange ? { remove: remoteRange } : {}) }), ["b1"]);
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
  return s;
}
