import "../../../src/test/_dom.mjs";
import { inspectEmptyScriptViews, removedEmptyScript } from "./support.ts";
import { emptyScriptDocument, emptyScriptRecovery } from "./literals.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { replicas, operation } from "../../adapters/collab/executor-support.ts";
import { createMonitoredSharedDocument } from "../../adapters/collab/helpers.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { observeSharedStructureOrder } from "../../../src/adapters/collab/structure-order-index.ts";
import { replaceRange, beatPos } from "../../../src/core/flow/flow.ts";

function remove(id: string, beat: string, by: string) {
  return { kind: "remove", id, by, removalKind: "beat", targets: [beat], boundaries: [beat],
    observed: [flowBaseReference(beat, "audioText", 0, 2)], components: [], gallery: [], at: beat === "R1" ? 0 : 1 };
}

for (const order of ["dup", "rev"] as const) test("rule 91 feasibility: existing creation before the retained scene keeps concurrent starts and the heading in recovery/" + order, () => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "ab" }], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] });
  const late = createMonitoredSharedDocument();
  try {
    for (const handle of [h.a, h.b]) registerSharedOperationFamilies(handle, createFlowLoadRuntime());
    assert.deepEqual(executeSharedOperations(h.a, [operation(remove("cutA", "R1", "Alice"))], { base: readSharedRevision(h.a) }), { ok: true });
    h.queue.flush(order);
    for (const [handle, id, by, text] of [[h.a, "freshA", "Alice", "one"], [h.b, "freshB", "Bob", "two"]] as const) {
      const right = observeSharedStructureOrder(handle).at(0); assert.equal(right, "h:H1");
      assert.deepEqual(executeSharedOperations(handle, [operation({ kind: "segment-create", id, by, segment: id, beat: id,
        at: { left: null, right, affinity: "before" }, fields: { status: "todo", visualText: "", audioText: text, imageRef: null, updatedAt: "", updatedBy: null } })], { base: readSharedRevision(handle) }), { ok: true });
    }
    h.queue.flush(order); assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
    for (const handle of [h.a, h.b, late]) {
      const projected = projectSharedDocumentWithRecovery(handle);
      assert.deepEqual(projected.document, { schema: 2, title: "", docId: "d00000000000000000000000000000000", rows: [
        { id: "structure_1_006600720065007300680041_beat_0", status: "todo", visualText: "", audioText: "one", imageRef: null, updatedAt: "", updatedBy: null },
        { id: "structure_2_006600720065007300680042_beat_0", status: "todo", visualText: "", audioText: "two", imageRef: null, updatedAt: "", updatedBy: null }
      ], comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 });
      assert.deepEqual(projected.recovery.filter(entry => entry.kind === "scene-with-no-beats"), [{ kind: "scene-with-no-beats", heading: { id: "H1", name: "Scene" }, beforeRowId: null }]);
    }
  } finally { destroySharedDocument(late); h.close(); }
});

test("standalone full removal keeps the last beat empty through replaceRange", () => {
  const doc = { rows: [{ id: "R1", audioText: "ab" }], comments: [] };
  const result = replaceRange(doc, { anchor: beatPos("R1", 0), head: beatPos("R1", 2) }, [], { ...createFlowLoadRuntime().ports, newId: () => "blank" }, true);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows, [{ id: "R1", audioText: "" }]);
});

test("standalone whole-script cross-beat removal recreates one empty beat through replaceRange's repair", () => {
  const doc = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }], comments: [] };
  const result = replaceRange(doc, { anchor: beatPos("R1", 0), head: beatPos("R2", 2) }, [], { ...createFlowLoadRuntime().ports, newId: () => "blank" }, true);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows, [{ id: "blank", visualText: "", imageRef: null, audioText: "", status: "todo" }]);
});


for (const name of ["last beat", "two last beats", "removal and typing", "removal and split", "only scene"] as const) {
  for (const order of ["dup", "rev"] as const) test("rule 91 before: " + name + "/" + order, () => {
    const h = removedEmptyScript(name, order);
    const late = createMonitoredSharedDocument();
    try {
      h.queue.flush(order); assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
      const readings = [h.a, h.b, late].map(handle => ({ projected: projectSharedDocumentWithRecovery(handle), views: inspectEmptyScriptViews(handle) }));
      assertReplicasAgree(name, readings.map((output, index) => ({ order: index === 2 ? "late-C" : order === "rev" ? "D2" : "D1", replica: index === 0 ? "A" : index === 1 ? "B" : "C", output })));
      for (const reading of readings) assert.deepEqual(reading.projected, { document: emptyScriptDocument(), recovery: emptyScriptRecovery(name) });
      assert.deepEqual(readings[0]?.views, { writerBeats: 0, writerHeadings: 0, writerSelection: null, splitCells: 0, splitHeadings: 0, splitAdd: 1 });
    } finally { destroySharedDocument(late); h.close(); }
  });
}
