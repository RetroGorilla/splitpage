import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation, ref } from "./executor-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument, encodeSharedState, encodeSharedStateVector, readSharedRevision, observeSharedUpdates } from "../../../src/adapters/collab/document.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { createSharedAnchor, resolveSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

function flag(handle: SharedDocumentHandle, id: string, generation: number, removed: boolean): void {
  transactSharedDocument(handle, "local-command", () => {
    const beat = collabState(handle).roots.beats.get("R1"); assert.ok(beat instanceof Y.Map);
    const flags = beat.get("removals"); assert.ok(flags instanceof Y.Map); flags.set(id, { generation, removed });
  });
}
function read(handle: SharedDocumentHandle) {
  const value = projectSharedDocumentWithRecovery(handle), prep = createSharedPreparation(handle);
  try {
    return { rows: value.document.rows.map(row => ({ id: row.id, text: row.audioText })),
      recovery: value.recovery.map(entry => entry.kind === "removed-beat" ? { id: entry.row.id, text: entry.row.audioText } : entry),
      owner: prep.view.resolveOwner("R1", "audioText") };
  } finally { prep.close(); }
}

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const)
  test(`removal state and write ownership agree on live and encoded copies: ${copies}/${order}`, () => {
    const run = replicas(copies, { rows: [{ id: "R1", audioText: "abcd", visualText: "abcd" }, { id: "R2", audioText: "ef" }] });
    const handles = [run.a, run.b, run.c].slice(0, copies);
    const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
    const held = new Map(handles.map(handle => [handle, prepareSharedMarkRecord(handle, target, "held", 0, 1, { type: "add", mark: { kind: "b", value: true } })]));
    const anchor = createSharedAnchor(run.a, target, 1, "after"); assert.ok(anchor);
    try {
      flag(run.a, "A", 0, true); flag(run.b, "B", 0, true); run.queue.flush(order);
      agree("removed group", order, handles, read, { rows: [{ id: "R2", text: "ef" }], recovery: [{ id: "R1", text: "abcd" }], owner: null });
      for (const handle of handles) {
        const bytes = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle);
        let updates = 0; const detach = observeSharedUpdates(handle, () => { updates++; });
        try {
          assert.equal(createSharedAnchor(handle, target, 1, "after"), null);
          assert.equal(prepareSharedMarkRecord(handle, target, "new", 0, 1, { type: "add", mark: { kind: "b", value: true } }), null);
          const record = held.get(handle); assert.ok(record);
          assert.deepEqual(writeSharedMarkRecord(handle, target, "held", record), { ok: false, reason: "missing-text" });
          const result = executeSharedOperations(handle, [operation({ kind: "scalar", id: "hidden", by: "Writer", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 9 })], { base: revision });
          assert.ok(!result.ok); assert.equal(result.reason, "missing-target");
          assert.deepEqual(resolveSharedAnchor(handle, anchor), { segment: "b:R1", offset: 1 });
          assert.deepEqual(encodeSharedState(handle), bytes); assert.deepEqual(encodeSharedStateVector(handle), vector);
          assert.equal(readSharedRevision(handle), revision); assert.equal(updates, 0);
        } finally { detach(); }
      }
      flag(run.b, "B", 0, false); run.queue.flush(order);
      agree("either identical removal restored", order, handles, read, { rows: [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }], recovery: [], owner: { owner: "R1", segment: "b:R1" } });
      flag(run.a, "C", 1, true); flag(run.b, "A", 0, false); run.queue.flush(order);
      agree("old restore does not consume fresh removal", order, handles, read, { rows: [{ id: "R2", text: "ef" }], recovery: [{ id: "R1", text: "abcd" }], owner: null });
      flag(run.a, "C", 1, false); run.queue.flush(order);
      agree("fresh removal restored", order, handles, read, { rows: [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }], recovery: [], owner: { owner: "R1", segment: "b:R1" } });
    } finally { run.close(); }
  });
