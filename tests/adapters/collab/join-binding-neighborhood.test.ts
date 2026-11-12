import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation, ref } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedJoinEndpointField, readSharedJoinEndpoint } from "../../../src/adapters/collab/join-endpoint.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { observeSharedStructureIndex } from "../../../src/adapters/collab/structure-index.ts";

for (const order of ["D1", "rev", "dup"] as const) test("native binding neighborhood survives a deleted intervening join and patches retargeting: " + order, () => {
  const set = replicas(3, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }] });
  const handles = [set.a, set.b, set.c], incremental = handles.map(handle => captureIncrementalReplica(handle));
  const first = "structure_1_00660069007200730074_join_0", second = "structure_1_007300650063006f006e0064_join_0";
  const check = (expected: string[]) => {
    set.queue.flush(order);
    agree("native endpoint neighborhood", order, handles, handle => {
      const result = projectSharedDocumentWithRecovery(handle); assert.deepEqual(result.recovery, []);
      for (const row of result.document.rows) assert.equal(readSharedPaintedText(handle, { owner: ref(row.id), segment: ref(row.id), field: "audioText" })?.text, row.audioText);
      return result.document.rows.map(row => row.audioText);
    }, expected);
    agree("live binding index equals encoded fresh index", order, handles, handle => {
      const index = observeSharedStructureIndex(handle);
      return { forward: [index.joinSegments(first), index.joinSegments(second)], reverse: ["b:R1", "b:R2", "b:R3"].map(segment => index.segmentJoins(segment)) };
    });
    handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); });
  };
  try {
    handles.forEach(handle => { registerSharedJoinHandlers(handle); registerSharedTextOperationHandlers(handle); });
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "first", by: "Writer", from: "R2", into: "R1", glue: " " }),
      operation({ kind: "join", id: "second", by: "Writer", from: "R3", into: "R1", glue: " " })]), { ok: true }); check(["ab cd ef"]);
    const roots = collabState(set.a).roots, firstBinding = readSharedJoinEndpoint(roots.meta.get(sharedJoinEndpointField(first))), secondBinding = readSharedJoinEndpoint(roots.meta.get(sharedJoinEndpointField(second)));
    assert.ok(firstBinding && secondBinding);
    transactSharedDocument(set.a, "local-command", () => {
      const beat = roots.beats.get("R2"); assert.ok(beat instanceof Y.Map); const joins = beat.get("joins"); assert.ok(joins instanceof Y.Map); joins.delete(first);
    }); check(["ab", "cd ef"]);
    assert.deepEqual(executeSharedOperations(set.b, [operation({ kind: "text-insert", id: "typed", by: "Writer", target: { owner: "R2", segment: "R2", field: "audioText" },
      at: { left: null, right: flowBaseReference("R2", "audioText", 4), affinity: "before" }, content: [{ value: "X", marks: [] }] })], { base: readSharedRevision(set.b) }), { ok: true }); check(["ab", "cd eXf"]);
    transactSharedDocument(set.a, "local-command", () => roots.meta.set(sharedJoinEndpointField(second), { ...secondBinding, end: firstBinding.end })); check(["ab eXf", "cd"]);
    transactSharedDocument(set.a, "local-command", () => roots.meta.set(sharedJoinEndpointField(second), secondBinding)); check(["ab", "cd eXf"]);
  } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
});
