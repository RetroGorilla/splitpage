import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyScriptCommand } from "../../../src/application/commands/empty-script.ts";
import { readSharedContentRef } from "../../../src/core/collab/read-operation.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { sharedUndoOwner } from "../../../src/bootstrap/wiring/ports/shared-undo.ts";
import { encodeSharedState, applySharedUpdate, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { replicas } from "../../adapters/collab/executor-support.ts";
import { adapterReplica, sharedHarness } from "../session/shared-session-support.ts";
import { createMonitoredSharedDocument } from "../../adapters/collab/helpers.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { bufferStamps } from "../../collab/buffer-readers.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";

function ref(value: string) { const result = readSharedContentRef(value); assert.ok(result); return result; }

for (const order of ["dup", "rev"] as const) test("empty shared script first input is one literal creation command; its existing undo refusal stays named/" + order, () => {
  const h = replicas(2, { rows: [] }), late = createMonitoredSharedDocument();
  for (const handle of [h.a, h.b]) registerSharedOperationFamilies(handle, createFlowLoadRuntime());
  const undo = sharedUndoOwner(h.a, () => ({ id: "undo", by: "Alice" }), () => 0, error => { throw error; });
  const a = sharedHarness(adapterReplica(h.a, undo));
  const ports = { ...bufferStamps("Alice"), author: { id: ref("start"), by: "Alice" },
    gap: { left: null, right: null, affinity: "before" as const }, created: ref("structure_1_00730074006100720074_beat_0") };
  try {
    assert.equal(a.session.run(emptyScriptCommand("A<&\nB", ports)).kind, "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), [[{ kind: "segment-create", id: "start", by: "Alice",
      segment: "structure_1_00730074006100720074_beat_0", beat: "structure_1_00730074006100720074_beat_0", at: { left: null, right: null, affinity: "before" },
      fields: { status: "todo", visualText: "", audioText: "A&lt;&amp;<br>B", imageRef: null, updatedAt: "2026-11-12T10:00:00.000Z", updatedBy: "Alice" } }]]);
    assert.deepEqual(undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
    const before = encodeSharedState(h.a);
    assert.deepEqual(undo.undo(), { ok: false, reason: "undo-unsupported:segment-create" });
    assert.deepEqual(encodeSharedState(h.a), before);
    h.queue.flush(order); assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
    const readings = [h.a, h.b, late].map(handle => projectSharedDocumentWithRecovery(handle));
    for (const output of readings) assert.deepEqual(output, { document: { schema: 2, title: "", docId: "d00000000000000000000000000000000", rows: [
      { id: "structure_1_00730074006100720074_beat_0", status: "todo", visualText: "", audioText: "A&lt;&amp;<br>B", imageRef: null, updatedAt: "2026-11-12T10:00:00.000Z", updatedBy: "Alice" }
    ], comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 }, recovery: [] });
    assertReplicasAgree("empty-script first command", readings.map((output, index) => ({ replica: index === 0 ? "A" : index === 1 ? "B" : "C", order: index === 2 ? "late-C" : order === "rev" ? "D2" : "D1", output })));
    assert.equal(a.session.run(emptyScriptCommand("", { ...ports, clock: { ...ports.clock, nowIso: () => { assert.fail("Empty input read the clock"); } } })).kind, "noop");
    assert.equal(a.executed.length, 1); assert.deepEqual(undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
  } finally { a.session.dispose(); destroySharedDocument(late); h.close(); }
});
