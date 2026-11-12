import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";

const joinId = "structure_1_006a006f0069006e_join_0", fresh = "structure_2_00730070006c00690074_beat_0";
const join = () => operation({ kind: "join", id: "join", by: "Alice", from: "R2", into: "R1", glue: " " });
const split = (owner: string, offset: number, length: number, prefix = false, id = "split") => operation({ kind: prefix ? "split-before" : "split", id, by: "Bob",
  target: { owner, segment: owner, field: "audioText" }, at: { left: null, right: flowBaseReference(owner, "audioText", offset), affinity: "before" },
  observed: [flowBaseReference(owner, "audioText", 0, length)], boundary: id + "_beat", beat: id + "_beat", fields: {} });
const source = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] };
const samples = [
  { name: "end", seen: false, offset: 2, rows: [["R1", "ab"], [fresh, " cd"]], recovery: [] },
  { name: "end", seen: true, offset: 2, rows: [["R1", "ab"], [fresh, " cd"]], recovery: [] },
  { name: "prefix", seen: false, offset: 1, rows: [[fresh, "a"], ["R1", "b cd"]], recovery: [] },
  { name: "prefix", seen: true, offset: 1, rows: [[fresh, "a"], ["R1", "b cd"]], recovery: [] },
  { name: "source", seen: true, offset: 4, rows: [["R1", "ab c"], [fresh, "d"]], recovery: [] },
  { name: "retired", seen: false, offset: 1, rows: [["R1", "a"], [fresh, "b"], ["R2", "cd"]], recovery: [] },
  { name: "retired", seen: true, offset: 1, rows: [["R1", "a"], [fresh, "b"], ["R2", "cd"]], recovery: [] },
  { name: "removed", seen: false, offset: 1, rows: [[fresh, "b cd"]], recovery: [["R1", "a", ["R1"]]] },
  { name: "removed", seen: true, offset: 1, rows: [[fresh, "b cd"]], recovery: [["R1", "a", ["R1"]]] }
];
for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const sample of samples) test(`native join end: ${sample.name}/${sample.seen}/${copies}/${order}`, () => {
  const set = replicas(copies, source), handles = [set.a, set.b, set.c].slice(0, copies), runtime = createFlowLoadRuntime();
  const incremental = handles.map(handle => captureIncrementalReplica(handle));
  const checkpoint = () => handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); });
  try {
    handles.forEach(handle => { registerSharedJoinHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle); registerSharedRemovalHandlers(handle); });
    assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true });
    if (copies === 3) assert.deepEqual(executeSharedOperations(set.c, [join()]), { ok: true });
    if (sample.seen) set.queue.flush(order); checkpoint();
    if (sample.name === "retired") assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join-retire", id: "retire", by: "Alice", joins: [joinId] })]), { ok: true });
    if (sample.name === "removed") assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "remove", id: "remove", by: "Alice", removalKind: "beat", targets: ["R1"],
      observed: [], boundaries: ["R1"], components: [], gallery: [], comments: [], at: 1 })]), { ok: true });
    assert.deepEqual(executeSharedOperations(set.b, [split("R1", sample.offset, sample.seen ? 5 : 2, sample.name === "prefix")], { base: readSharedRevision(set.b) }), { ok: true });
    checkpoint(); set.queue.flush(order); checkpoint();
    agree("native endpoint literal", order, handles, handle => {
      const result = projectSharedDocumentWithRecovery(handle);
      const rows = result.document.rows.map(row => [row.id, row.audioText]);
      for (const row of result.document.rows) assert.equal(readSharedPaintedText(handle, { owner: row.id, segment: row.id, field: "audioText" } as Parameters<typeof readSharedPaintedText>[1])?.text, row.audioText);
      return { rows, recovery: result.recovery.map(entry => { assert.equal(entry.kind, "removed-beat"); return entry.kind === "removed-beat" ? [entry.row.id, entry.row.audioText, entry.members] : null; }) };
    }, { rows: sample.rows, recovery: sample.recovery });
    const beat = collabState(set.a).roots.beats.get("R2"); assert.ok(beat instanceof Y.Map);
    const issued = beat.get("joins"); assert.ok(issued instanceof Y.Map);
    assert.deepEqual(issued.get(joinId), { into: "R1", glue: " ", by: "Alice", operation: "join", generation: 0 });
  } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) for (const deleted of [{ from: 1, rows: ["a", " cd"] }, { from: 0, rows: ["", " cd"] }]) test(`native endpoint survives last-character deletion apart from join and split: ${order}/${deleted.from}`, () => {
  const set = replicas(3, source), handles = [set.a, set.b, set.c], runtime = createFlowLoadRuntime(), incremental = handles.map(handle => captureIncrementalReplica(handle));
  try {
    handles.forEach(handle => { registerSharedJoinHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle); });
    assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true });
    assert.deepEqual(executeSharedOperations(set.b, [split("R1", 1, 2)], { base: readSharedRevision(set.b) }), { ok: true });
    assert.deepEqual(executeSharedOperations(set.c, [operation({ kind: "text-delete", id: "delete", by: "Cara", target: { owner: "R1", segment: "R1", field: "audioText" },
      observed: [flowBaseReference("R1", "audioText", deleted.from, 2)] })], { base: readSharedRevision(set.c) }), { ok: true });
    set.queue.flush(order); agree("deleted endpoint", order, handles, handle => projectSharedDocumentWithRecovery(handle).document.rows.map(row => row.audioText), deleted.rows);
    handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); });
  } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
});
