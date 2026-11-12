import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { prepareSharedBeatJoin } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedRevision, encodeSharedState, encodeSharedStateVector } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { deliveryReplica } from "./helpers.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { applyFlowOperations } from "../../core/flow/operation-applier.ts";
import { joinWithPrevious } from "../../../src/core/flow/flow.ts";

const ids = ["structure_1_006a006f0069006e_join_0", "structure_2_006a006f0069006e_join_0", "structure_3_006a006f0069006e_join_0"];
const command = () => operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " });
const source = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] };
const read = (handle: Parameters<typeof collabState>[0]) => {
  const result = projectSharedDocumentWithRecovery(handle);
  return { rows: result.document.rows.map(row => ({ id: row.id, text: row.audioText })), recovery: result.recovery };
};

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup", "late-C"] as const)
  test(`same join by ${copies} writers is one effect with every issued entry retained: ${order}`, () => {
    const set = replicas(copies, source), handles = [set.a, set.b, set.c].slice(0, copies);
    try {
      for (const handle of handles) {
        registerSharedJoinHandlers(handle);
        assert.deepEqual(executeSharedOperations(handle, [command()], { base: readSharedRevision(handle) }), { ok: true });
      }
      set.queue.flush(order);
      agree("identical joins", order, handles, read, { rows: [{ id: "R1", text: "ab cd" }], recovery: [] });
      agree<unknown>("issued join entries", order, handles, handle => {
        const beat = collabState(handle).roots.beats.get("R2") as Y.Map<unknown>, entries = beat.get("joins") as Y.Map<unknown>;
        return [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      }, ids.slice(0, copies).map(id => [id, { into: "R1", glue: " ", by: "Writer", operation: "join", observed: [] }]));
    } finally { set.close(); }
  });

test("join freezes its fixed writes and emits one transaction/update without reading a text delta", () => {
  const set = replicas(2, source);
  try {
    let updates = 0, transactions = 0;
    const stop = deliveryReplica(set.a).onLocalUpdate(() => { updates++; });
    const state = collabState(set.a);
    const observe = () => { transactions++; }; state.doc.on("afterTransaction", observe);
    registerSharedOperationHandlers(set.a, { join: (op, view) => {
      const result = prepareSharedBeatJoin(op, { ...view, text: () => { throw new Error("Join read text"); } });
      if (result.ok) assert.ok(Object.isFrozen(result.writes) && Object.isFrozen(result.writes[0]?.value)); return result;
    } });
    assert.deepEqual(executeSharedOperations(set.a, [command()]), { ok: true });
    assert.deepEqual([updates, transactions], [1, 1]); state.doc.off("afterTransaction", observe); stop();
    const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
    const result = executeSharedOperations(set.a, [
      operation({ kind: "scalar", id: "before", by: "Writer", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 9 }),
      command()
    ]);
    assert.ok(!result.ok); assert.equal(result.reason, "existing-join"); assert.equal(result.index, 1);
    assert.deepEqual(encodeSharedState(set.a), bytes); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision);
  } finally { set.close(); }
});

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const)
  test(`join retains native content edited at the same time: ${copies} writers ${order}`, () => {
    const set = replicas(copies, source), handles = [set.a, set.b, set.c].slice(0, copies);
    try {
      for (const handle of handles) { registerSharedJoinHandlers(handle); registerSharedTextOperationHandlers(handle); }
      assert.deepEqual(executeSharedOperations(set.a, [command()]), { ok: true });
      assert.deepEqual(executeSharedOperations(set.b, [operation({ kind: "text-insert", id: "typed", by: "Writer",
        target: { owner: "R2", segment: "b:R2", field: "audioText" }, at: { left: null, right: flowBaseReference("R2", "audioText", 1), affinity: "before" }, content: [{ value: "X", marks: [] }] })],
      { base: readSharedRevision(set.b) }), { ok: true });
      if (copies === 3) assert.deepEqual(executeSharedOperations(set.c, [operation({ kind: "text-delete", id: "deleted", by: "Writer",
        target: { owner: "R1", segment: "b:R1", field: "audioText" }, observed: [flowBaseReference("R1", "audioText", 0, 1)] })],
      { base: readSharedRevision(set.c) }), { ok: true });
      set.queue.flush(order);
      agree("join and native text", order, handles, read, { rows: [{ id: "R1", text: copies === 3 ? "b cXd" : "ab cXd" }], recovery: [] });
    } finally { set.close(); }
  });

test("complete app join list agrees with the independent flow applier", () => {
  const runtime = createFlowLoadRuntime(), set = replicas(2, source);
  try {
    registerSharedJoinHandlers(set.a);
    const doc = { rows: source.rows, comments: [] }, result = joinWithPrevious(doc, "R2", { ...runtime.ports, operations: { id: "flow", by: "Writer" } });
    assert.ok(result && "rows" in result && result.ops);
    const expected = applyFlowOperations(doc, result.ops, runtime.cells); assert.deepEqual(expected.rows, result.rows);
    assert.deepEqual(executeSharedOperations(set.a, result.ops, { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(read(set.a), { rows: [{ id: "R1", text: "ab cd" }], recovery: [] });
  } finally { set.close(); }
});
