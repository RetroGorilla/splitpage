import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation, ref } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedJoinEndpointField, readSharedJoinEndpoint } from "../../../src/adapters/collab/join-endpoint.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";

test("seeded damaged join bindings agree with native painting, incremental projection and encoded state", t => {
  let seed = 0x5c3602, checkpoints = 0;
  const choose = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % n; };
  const declaredLimits: readonly string[] = [], violations: string[] = [];
  for (const order of ["D1", "rev", "dup"] as const) {
    const set = replicas(3, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
    const handles = [set.a, set.b, set.c], incremental = handles.map(handle => captureIncrementalReplica(handle));
    try {
      registerSharedJoinHandlers(set.a);
      assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " })]), { ok: true }); set.queue.flush(order);
      const field = sharedJoinEndpointField("structure_1_006a006f0069006e_join_0"), binding = readSharedJoinEndpoint(collabState(set.a).roots.meta.get(field)); assert.ok(binding);
      for (let sample = 0; sample < 64; sample++) {
        const writer = handles[choose(3)]; assert.ok(writer);
        const values: readonly { raw: unknown; rows: readonly string[] }[] = [
          { raw: binding, rows: ["ab cd"] }, { raw: null, rows: ["ab", "cd"] }, { raw: choose(100), rows: ["ab", "cd"] },
          { raw: [undefined, null, "bad"], rows: ["ab", "cd"] }, { raw: { ...binding, extra: true }, rows: ["ab", "cd"] },
          { raw: { ...binding, start: { ...binding.start, assoc: 0 } }, rows: ["ab", "cd"] },
          { raw: { ...binding, end: { ...binding.end, type: [7777, choose(100)] } }, rows: ["ab", "cd"] },
          { raw: { ...binding, stop: { ...binding.stop, item: [-1, choose(100)] } }, rows: ["ab", "cd"] },
          { raw: { ...binding, end: { ...binding.end, segment: "missing" } }, rows: ["ab", "cd"] }
        ];
        const value = values[choose(values.length)]; assert.ok(value);
        transactSharedDocument(writer, "local-command", () => collabState(writer).roots.meta.set(field, value.raw)); set.queue.flush(order);
        agree("damaged endpoint " + sample, order, handles, handle => {
          const result = projectSharedDocumentWithRecovery(handle), rows = result.document.rows.map(row => row.audioText);
          if (JSON.stringify(rows) !== JSON.stringify(value.rows) || result.recovery.length) violations.push("binding-projection");
          for (const row of result.document.rows) if (readSharedPaintedText(handle, { owner: ref(row.id), segment: ref(row.id), field: "audioText" })?.text !== row.audioText) violations.push("binding-paint");
          return result;
        });
        handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); }); checkpoints++;
      }
    } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
  }
  assert.deepEqual(violations, declaredLimits); assert.equal(checkpoints, 192);
  t.diagnostic(JSON.stringify({ seed: 0x5c3602, checkpoints, declaredLimits }));
});

test("incremental joined partner mark-only arrival changes its row without changing fragment lengths", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] }), incremental = captureIncrementalReplica(set.a);
  try {
    registerSharedJoinHandlers(set.a);
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " })]), { ok: true });
    assert.equal(incremental.projector.read().document.rows[0]?.audioText, "ab cd");
    const target = { owner: ref("R2"), segment: ref("b:R2"), field: "audioText" as const };
    const mark = prepareSharedMarkRecord(set.b, target, "source-bold", 0, 2, { type: "add", mark: { kind: "b", value: true } }); assert.ok(mark);
    assert.deepEqual(writeSharedMarkRecord(set.b, target, "source-bold", mark), { ok: true }); set.queue.flush("dup");
    assert.equal(incremental.projector.read().document.rows[0]?.audioText, "ab <strong>cd</strong>");
    assertIncremental(set.a, incremental.projector);
  } finally { incremental.projector.dispose(); set.close(); }
});
