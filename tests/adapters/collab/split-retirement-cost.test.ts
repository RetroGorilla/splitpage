import { test } from "node:test";
import assert from "node:assert/strict";
import { replicas, operation } from "./executor-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

const runtime = createFlowLoadRuntime(), target = { owner: "R1", segment: "R1", field: "audioText" };

function undoneSplits(count: number) {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }] });
  registerSharedOperationFamilies(set.a, { cells: runtime.cells });
  for (let round = 0; round < count; round++) {
    const split = operation({ kind: "split", id: "cut" + String(round), by: "Writer", target, at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" },
      observed: [], boundary: "Rs", beat: "Rs", fields: {} });
    const execution = executeSharedCommand(set.a, [split], { label: "split", selection: null, typing: null }, { base: readSharedRevision(set.a) });
    assert.ok(execution.record);
    const done = reverseSharedUndoRecord(set.a, execution.record, { by: "Writer", nextId: () => "undo" + String(round) });
    assert.ok(done.ok); assert.equal(done.effective, true);
  }
  return set;
}

for (const marks of [1, 100]) test(`typing beside ${marks} undone split(s) of one beat reads no observation of an undone split again`, () => {
  const set = undoneSplits(marks), visits = { typed: 0, fresh: 0 };
  let counting = false;
  const { projector } = captureIncrementalReplica(set.a, (kind, _key, units) => { if (counting && kind === "split-observation") visits.typed += units ?? 0; });
  try {
    assert.deepEqual(projector.read().document.rows.map(row => row.audioText), ["abcd", "ef"]);
    counting = true;
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "text-insert", id: "typed", by: "Writer", target,
      at: { left: flowBaseReference("R1", "audioText", 3), right: null, affinity: "after" }, content: [{ value: "z", marks: [] }] })], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(projector.read().document.rows.map(row => row.audioText), ["abcdz", "ef"]);
    assertIncremental(set.a, projector);
    createSharedIncrementalProjector(set.a, (kind, _key, units) => { if (kind === "split-observation") visits.fresh += units ?? 0; }).dispose();
    assert.deepEqual(visits, { typed: 0, fresh: { 1: 11, 100: 308 }[marks] });
  } finally { projector.dispose(); set.close(); }
});

for (const [where, beat] of [["another segment", "R2"], ["the same segment", "R1"]] as const) test(`typing in ${where} beside an undone creation inside a segment reads its text only when typed in that segment`, () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }] });
  registerSharedOperationFamilies(set.a, { cells: runtime.cells });
  const command = (value: Record<string, unknown>) => {
    const execution = executeSharedCommand(set.a, [operation(value)], { label: "step", selection: null, typing: null }, { base: readSharedRevision(set.a) });
    assert.ok(execution.record); return execution.record;
  };
  command({ kind: "split", id: "cut", by: "Writer", target, at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" }, observed: [], boundary: "Rs", beat: "Rs", fields: {} });
  const created = command({ kind: "segment-create", id: "make", by: "Writer", segment: "Rn", beat: "Rn", at: { left: "R1", right: null, affinity: "after" }, fields: { status: "todo", visualText: "", audioText: "N" } });
  const done = reverseSharedUndoRecord(set.a, created, { by: "Writer", nextId: () => "undo" }); assert.ok(done.ok); assert.equal(done.effective, true);
  let counting = false, typed = 0;
  const { projector } = captureIncrementalReplica(set.a, (kind, _key, units) => { if (counting && kind === "split-observation") typed += units ?? 0; });
  try {
    assert.deepEqual(projector.read().document.rows.map(row => row.audioText), ["ab", "cd", "ef"]);
    counting = true;
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "text-insert", id: "typed", by: "Writer", target: { owner: beat, segment: beat, field: "audioText" },
      at: { left: flowBaseReference(beat, "audioText", 0), right: null, affinity: "after" }, content: [{ value: "z", marks: [] }] })], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(projector.read().document.rows.map(row => row.audioText), beat === "R1" ? ["azb", "cd", "ef"] : ["ab", "cd", "ezf"]);
    assertIncremental(set.a, projector);
    assert.equal(typed, beat === "R1" ? 5 : 0);
  } finally { projector.dispose(); set.close(); }
});
