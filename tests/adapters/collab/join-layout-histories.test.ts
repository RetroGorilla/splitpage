import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";

for (const order of ["D1", "rev", "dup"] as const) for (const kind of ["source-prefix", "cycle", "parallel-sources"] as const) test(`native join layout keeps reading order: ${kind}/${order}`, () => {
  const set = replicas(3, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }] });
  const handles = [set.a, set.b, set.c], runtime = createFlowLoadRuntime(), incremental = handles.map(handle => captureIncrementalReplica(handle));
  try {
    handles.forEach(handle => { registerSharedJoinHandlers(handle); registerSharedSplitHandlers(handle, runtime); });
    const join = (from: string, into: string, id: string) => operation({ kind: "join", id, by: "Writer", from, into, glue: " " });
    assert.deepEqual(executeSharedOperations(set.a, [join("R2", "R1", "first")]), { ok: true });
    if (kind === "cycle") assert.deepEqual(executeSharedOperations(set.b, [join("R1", "R2", "second")]), { ok: true });
    if (kind === "parallel-sources") assert.deepEqual(executeSharedOperations(set.b, [join("R3", "R1", "second")]), { ok: true });
    const owner = kind === "cycle" ? "R1" : "R2";
    assert.deepEqual(executeSharedOperations(set.c, [operation({ kind: kind === "source-prefix" ? "split-before" : "split", id: "split", by: "Writer",
      target: { owner, segment: owner, field: "audioText" }, at: { left: null, right: flowBaseReference(owner, "audioText", 1), affinity: "before" },
      observed: [], beat: "fresh", boundary: "fresh", fields: {} })], { base: readSharedRevision(set.c) }), { ok: true });
    set.queue.flush(order);
    const expected = kind === "source-prefix" ? ["ab c", "d", "ef"] : kind === "cycle" ? ["a", "b cd", "ef"] : ["ab c", "d ef"];
    agree("split native source interval", order, handles, handle => {
      const result = projectSharedDocumentWithRecovery(handle); assert.deepEqual(result.recovery, []); return result.document.rows.map(row => row.audioText);
    }, expected);
    handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); });
  } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
});
