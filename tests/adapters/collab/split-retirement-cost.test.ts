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
    assert.deepEqual(visits, { typed: 0, fresh: { 1: 9, 100: 207 }[marks] });
  } finally { projector.dispose(); set.close(); }
});
