import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { observeSharedTransactions, observeSharedUpdates, readSharedRevision, encodeSharedState, encodeSharedStateVector } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedRemovalCommand } from "../../../src/adapters/collab/removal-record.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";

const BEAT = "structure_1_007200310037_beat_0", VISUAL = "structure_1_007200310037_visual_0";
const REMOVE = "structure_1_007200310037005f00720065006d006f00760065_removal_0";
const recoveryList = [
  { kind: "segment-create", id: "r17", by: "Alice", segment: "draft_segment_17", beat: "draft_17",
    at: { left: "b:R1", right: null, affinity: "after" }, fields: { audioText: "aZd", bufferSourceOwner: "R1", bufferPaintedBase: 7 } },
  { kind: "remove", id: "r17_remove", by: "Alice", removalKind: "beat", targets: ["draft_17"], observed: ['["flow-base","draft_17","audioText",0,3]'],
    boundaries: ["draft_17"], components: [VISUAL], gallery: [], comments: [], at: 2 }
].map(operation);

function read(handle: SharedDocumentHandle, value = projectSharedDocumentWithRecovery(handle)) {
  for (const row of value.document.rows) {
    assert.equal(Object.hasOwn(row, "bufferSourceOwner"), false); assert.equal(Object.hasOwn(row, "bufferPaintedBase"), false);
  }
  return { rows: value.document.rows.map(row => ({ id: row.id, text: row.audioText })), recovery: value.recovery.map(entry => {
    assert.equal(entry.kind, "removed-beat"); if (entry.kind !== "removed-beat") throw new Error("Unexpected recovery entry");
    assert.equal(Object.hasOwn(entry.row, "bufferSourceOwner"), false); assert.equal(Object.hasOwn(entry.row, "bufferPaintedBase"), false);
    return { id: entry.row.id, text: entry.row.audioText, members: entry.members, buffer: entry.buffer };
  }) };
}

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const)
  test(`rule 29 literal: create and remove a staged alias in one command: ${copies}/${order}`, () => {
    const run = replicas(copies, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
    const handles = [run.a, run.b, run.c].slice(0, copies), runtime = createFlowLoadRuntime();
    const projectors = handles.map(handle => createSharedIncrementalProjector(handle));
    const compare = () => handles.forEach((handle, index) => { const projector = projectors[index]; assert.ok(projector); assert.deepEqual(read(handle, projector.read()), read(handle)); });
    const undo = handles.map(() => createSharedUndo({ now: () => 0, supports: () => false, reverse: () => { throw new Error("Recovery must not create an undo entry"); } }));
    try {
      registerSharedSplitHandlers(run.a, runtime); registerSharedRemovalHandlers(run.a);
      let transactions = 0, updates = 0;
      const stop = observeSharedTransactions(run.a, () => { transactions++; }), detach = observeSharedUpdates(run.a, () => { updates++; });
      try {
        undo[0]?.perform(() => { assert.deepEqual(executeSharedOperations(run.a, recoveryList, { base: readSharedRevision(run.a) }), { ok: true }); return null; });
        assert.deepEqual([transactions, updates], [1, 1]);
      } finally { stop(); detach(); }
      run.queue.flush(order);
      agree("buffer recovery literal", order, handles, read, { rows: [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }], recovery: [{
        id: BEAT, text: "aZd", members: [BEAT], buffer: [{ beat: BEAT, metadata: { bufferSourceOwner: "R1", bufferPaintedBase: 7 } }]
      }] });
      compare();
      for (const owner of undo) assert.deepEqual(owner.sizes(), { undo: 0, redo: 0, dropped: 0 });
      const record = readSharedRemovalCommand(REMOVE, collabState(run.a).roots.removalRecords.get(REMOVE));
      assert.ok(record?.kind === "remove"); assert.deepEqual(record.boundaries, [BEAT]); assert.deepEqual(record.components, [VISUAL]);
      assert.deepEqual(record.references, ['["flow-base","draft_17","audioText",0,3]']);
      assert.deepEqual(record.observed.map(value => ({ field: value.target.field, units: value.identities.length })), [{ field: "audioText", units: 3 }, { field: "visualText", units: 0 }]);
      assert.deepEqual(executeSharedOperations(run.a, [operation({ kind: "restore", id: "back", by: "Alice", removals: [REMOVE] })], { base: readSharedRevision(run.a) }), { ok: true });
      run.queue.flush(order);
      agree("restored recovery has no exported bookkeeping", order, handles, read, { rows: [{ id: "R1", text: "ab" }, { id: BEAT, text: "aZd" }, { id: "R2", text: "cd" }], recovery: [] });
      compare();
      const loaded = runtime.load(projectSharedDocumentWithRecovery(run.a).document);
      assert.equal(loaded.rows[1]?.id, BEAT); assert.equal(loaded.rows[1]?.audioText, "aZd");
      assert.equal(Object.hasOwn(loaded.rows[1] ?? {}, "bufferSourceOwner"), false);
    } finally { for (const projector of projectors) projector.dispose(); run.close(); }
  });

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const)
  test(`identical removals have one effect; an older restore cannot consume a fresh removal: ${copies}/${order}`, () => {
    const run = replicas(copies, { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }] });
    const handles = [run.a, run.b, run.c].slice(0, copies), fresh = copies === 2 ? run.a : run.c;
    const A = "structure_1_0061_removal_0", B = "structure_2_0062_removal_0", C = copies === 2 ? "structure_1_0063_removal_0" : "structure_3_0063_removal_0";
    const send = (handle: SharedDocumentHandle, value: unknown) => assert.deepEqual(executeSharedOperations(handle, [operation(value)], { base: readSharedRevision(handle) }), { ok: true });
    const remove = (handle: SharedDocumentHandle, id: string, by: string) => send(handle, { kind: "remove", id, by, removalKind: "beat", targets: ["R1"],
      observed: [flowBaseReference("R1", "audioText", 0, 4)], boundaries: ["R1"], components: ["R1:visual"], gallery: ["R1:gallery"], at: 0 });
    const visible = (handle: SharedDocumentHandle) => { const value = projectSharedDocumentWithRecovery(handle); return {
      rows: value.document.rows.map(row => ({ id: row.id, text: row.audioText })),
      recovery: value.recovery.map(entry => entry.kind === "removed-beat" ? { id: entry.row.id, text: entry.row.audioText } : entry)
    }; };
    try {
      for (const handle of handles) registerSharedRemovalHandlers(handle);
      remove(run.a, "a", "Alice"); remove(run.b, "b", "Bob"); run.queue.flush(order);
      agree("one removal effect", order, handles, visible, { rows: [{ id: "R2", text: "ef" }], recovery: [{ id: "R1", text: "abcd" }] });
      send(run.b, { kind: "restore", id: "undoB", by: "Bob", removals: [B] });
      for (const message of [...run.queue.pending].filter(value => value.from === "B" && value.to === (copies === 2 ? "A" : "C"))) run.queue.deliver(message.id, order === "dup" ? 2 : 1);
      remove(fresh, "c", "Fresh");
      send(run.a, { kind: "restore", id: "undoA", by: "Alice", removals: [A] }); run.queue.flush(order);
      agree("old restore keeps the fresh removal", order, handles, visible, { rows: [{ id: "R2", text: "ef" }], recovery: [{ id: "R1", text: "abcd" }] });
      for (const [key, generation] of [[A, 0], [B, 0], [C, 1]] as const) assert.equal(readSharedRemovalCommand(key, collabState(run.a).roots.removalRecords.get(key))?.targets[0]?.generation, generation);
      send(fresh, { kind: "restore", id: "undoC", by: "Fresh", removals: [C] }); run.queue.flush(order);
      agree("fresh removal restored", order, handles, visible, { rows: [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }], recovery: [] });
      const bytes = encodeSharedState(run.b), vector = encodeSharedStateVector(run.b), revision = readSharedRevision(run.b);
      send(run.b, { kind: "restore", id: "used", by: "Bob", removals: [B] });
      assert.deepEqual(encodeSharedState(run.b), bytes); assert.deepEqual(encodeSharedStateVector(run.b), vector); assert.equal(readSharedRevision(run.b), revision);
      assert.equal(collabState(run.b).roots.removalRecords.size, copies === 2 ? 5 : 6); assert.equal(run.queue.pending.length, 0);
    } finally { run.close(); }
  });
