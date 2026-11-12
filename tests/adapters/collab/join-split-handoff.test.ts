import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { startBeat, beatPos } from "../../../src/core/flow/flow.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { applyFlowOperations } from "../../core/flow/operation-applier.ts";

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const concurrent of [false, true]) test(`joined split handoff distinguishes a seen join from a concurrent join: ${copies}/${order}/${concurrent}`, () => {
  const set = replicas(copies, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  const runtime = createFlowLoadRuntime(), handles = [set.a, set.b, set.c].slice(0, copies);
  const declaredLimits = concurrent ? [] : ["Enter after a visible join is refused with invalid-reference; extending joined-row routing requires the split/projection rule."];
  const violations: string[] = [];
  try {
    handles.forEach(handle => { registerSharedJoinHandlers(handle); registerSharedSplitHandlers(handle, runtime); });
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Alice", from: "R2", into: "R1", glue: " " })]), { ok: true });
    if (!concurrent) set.queue.flush(order);
    else if (copies === 3) assert.deepEqual(executeSharedOperations(set.c, [operation({ kind: "join", id: "join", by: "Cara", from: "R2", into: "R1", glue: " " })]), { ok: true });
    const current = projectSharedDocument(set.b), doc = { rows: current.rows, sections: current.sections, comments: [] };
    const split = startBeat(doc, beatPos("R1", 1), { ...runtime.ports, newId: () => "fresh", operations: { id: "enter", by: "Bob" } });
    assert.ok(split && "rows" in split && split.ops);
    const independent = applyFlowOperations(doc, split.ops, runtime.cells);
    assert.deepEqual(independent.rows, split.rows); assert.deepEqual(independent.sections, split.sections);
    assert.deepEqual(split.rows.map(row => row.audioText), concurrent ? ["a", "b", "cd"] : ["a", "b cd"]);
    const bytes = encodeSharedState(set.b), vector = encodeSharedStateVector(set.b), revision = readSharedRevision(set.b);
    const result = executeSharedOperations(set.b, split.ops, { base: revision });
    if (concurrent) assert.deepEqual(result, { ok: true });
    else {
      assert.ok(!result.ok); assert.equal(result.reason, "invalid-reference");
      assert.deepEqual(encodeSharedState(set.b), bytes); assert.deepEqual(encodeSharedStateVector(set.b), vector); assert.equal(readSharedRevision(set.b), revision);
      violations.push("Enter after a visible join is refused with invalid-reference; extending joined-row routing requires the split/projection rule.");
    }
    set.queue.flush(order);
    agree("joined split handoff", order, handles, handle => projectSharedDocument(handle).rows.map(row => row.audioText), concurrent ? ["a cd", "b"] : ["ab cd"]);
    assert.deepEqual(violations, declaredLimits);
  } finally { set.close(); }
});
