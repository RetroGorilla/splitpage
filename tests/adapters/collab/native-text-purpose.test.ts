import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation, ref } from "./executor-support.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision, transactSharedDocument, destroySharedDocument, observeSharedUpdates } from "../../../src/adapters/collab/document.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord, readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { createSharedAnchor, resolveSharedAnchor, resolveSharedTextAnchor } from "../../../src/adapters/collab/anchors.ts";
import { collabPurposeTextTarget, collabTextTarget, createCollabText } from "../../../src/adapters/collab/text-target.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import type { SharedTextAddress } from "../../../src/core/collab/operations.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const narration: SharedTextAddress = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" };
const visual: SharedTextAddress = { owner: ref("R1"), segment: ref("R1"), field: "visualText" };
const change = { type: "add", mark: { kind: "b", value: true } } as const;

function unchanged<T>(handle: SharedDocumentHandle, read: () => T): T {
  const bytes = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle); let updates = 0;
  const stop = observeSharedUpdates(handle, () => { updates++; });
  try {
    const result = read(); assert.deepEqual(encodeSharedState(handle), bytes); assert.deepEqual(encodeSharedStateVector(handle), vector);
    assert.equal(readSharedRevision(handle), revision); assert.equal(updates, 0); return result;
  } finally { stop(); }
}
function recordMap(handle: SharedDocumentHandle, id = "R1"): Y.Map<unknown> {
  const record = collabState(handle).roots.beats.get(id); assert.ok(record instanceof Y.Map); return record;
}
function earlier(handle: SharedDocumentHandle, id: string, text: string): void {
  const roots = collabState(handle).roots, segment = new Y.Map<unknown>(), beat = new Y.Map<unknown>();
  segment.set("head", { b: id }); segment.set("text", new Y.Text(text)); segment.set("markRecords", new Y.Map<unknown>());
  beat.set("id", id); beat.set("segment", "earlier"); roots.segments.set("earlier", segment); roots.beats.set(id, beat); roots.order.insert(0, ["earlier"]);
}

for (const form of ["removed-order", "hidden-visual", "invalid-beat", "invalid-visual", "recovered-beat", "rule21-later", "rule21-visual"] as const)
  for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const)
    test(`native writes refuse a nonprojected target without a physical fallback: ${form}/${copies}/${order}`, () => {
      const run = replicas(copies, { rows: [{ id: "R1", audioText: "abcd", visualText: "abcd" }] }), handles = [run.a, run.b, run.c].slice(0, copies);
      const target = form.endsWith("visual") ? visual : narration;
      try {
        const held = prepareSharedMarkRecord(run.a, target, "blocked", 0, 1, change); assert.ok(held);
        const anchor = createSharedAnchor(run.a, target, 0, "after"); assert.ok(anchor);
        transactSharedDocument(run.a, "local-command", () => {
          const roots = collabState(run.a).roots;
          if (form === "removed-order" || form === "hidden-visual") roots.order.delete(0, roots.order.length);
          if (form === "invalid-beat" || form === "invalid-visual") recordMap(run.a).set("id", false);
          if (form === "recovered-beat") { roots.beats.delete("R1"); earlier(run.a, "R1", "Other"); }
          if (form === "rule21-later" || form === "rule21-visual") earlier(run.a, "[R1]", "Reserved");
        }); run.queue.flush(order);
        agree("native refusal " + form, order, handles, handle => unchanged(handle, () => {
          const raw = { ...held, writer: collabState(handle).doc.clientID };
          assert.equal(collabPurposeTextTarget(handle, target, "hydration-write"), null);
          assert.equal(collabPurposeTextTarget(handle, target, "opaque-title-label"), null);
          if (target.field === "audioText") assert.equal(createSharedAnchor(handle, "b:R1", 0, "after"), null);
          assert.deepEqual(resolveSharedAnchor(handle, anchor), { segment: target.segment, offset: 0 });
          assert.equal(resolveSharedTextAnchor(handle, anchor, target), 0);
          return { preparation: prepareSharedMarkRecord(handle, target, "blocked", 0, 1, change),
            write: writeSharedMarkRecord(handle, target, "blocked", raw), anchor: createSharedAnchor(handle, target, 0, "after") };
        }), { preparation: null, write: { ok: false, reason: "missing-text" }, anchor: null });
      } finally { run.close(); }
    });

test("stored anchor reading remains physical after its beat becomes a recovered duplicate", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] });
  try {
    const anchor = createSharedAnchor(run.a, narration, 2, "after"); assert.ok(anchor);
    transactSharedDocument(run.a, "local-command", () => earlier(run.a, "[R1]", "Reserved")); run.queue.flush("dup");
    agree("stored physical anchor", "dup", [run.a, run.b], handle => unchanged(handle, () => resolveSharedAnchor(handle, anchor)), { segment: "b:R1", offset: 2 });
  } finally { run.close(); }
});

test("hydration-origin writes can address unprojected text while later hydration labels keep the native writer", () => {
  const handle = createMonitoredSharedDocument(), state = collabState(handle);
  try {
    state.doc.clientID = 101;
    transactSharedDocument(handle, "hydration", () => {
      const segment = new Y.Map<unknown>(); state.roots.segments.set("b:R1", segment); createCollabText(handle, segment).insert(0, "a");
      const record = prepareSharedMarkRecord(handle, narration, "first", 0, 1, change); assert.ok(record); assert.equal(record.writer, "hydration");
      assert.deepEqual(writeSharedMarkRecord(handle, narration, "first", record), { ok: true }); assert.ok(createSharedAnchor(handle, narration, 0, "after"));
    });
    transactSharedDocument(handle, "hydration", () => {
      const record = prepareSharedMarkRecord(handle, narration, "second", 0, 1, change); assert.ok(record); assert.equal(record.writer, 101);
      assert.deepEqual(writeSharedMarkRecord(handle, narration, "second", record), { ok: true });
    });
    unchanged(handle, () => { assert.equal(prepareSharedMarkRecord(handle, narration, "outside", 0, 1, change), null); assert.equal(createSharedAnchor(handle, narration, 0, "after"), null); });
    transactSharedDocument(handle, "local-command", () => transactSharedDocument(handle, "hydration", () => {
      assert.equal(prepareSharedMarkRecord(handle, narration, "false-label", 0, 1, change), null);
    }));
  } finally { destroySharedDocument(handle); }
});

test("opaque title labels explicitly address the title without granting another field physical access", () => {
  const run = replicas(2, { title: "abcd", rows: [{ id: "R1", audioText: "abcd" }] });
  try {
    const target: SharedTextAddress = { owner: ref("opaque"), segment: ref("opaque"), field: "title" };
    const record = prepareSharedMarkRecord(run.a, target, "title", 0, 1, change); assert.ok(record);
    assert.deepEqual(writeSharedMarkRecord(run.a, target, "title", record), { ok: true });
    const anchor = createSharedAnchor(run.a, target, 0, "after"); assert.ok(anchor);
    assert.equal(resolveSharedTextAnchor(run.a, anchor, target), 0);
    assert.equal(collabPurposeTextTarget(run.a, narration, "opaque-title-label"), null);
    assert.equal(collabTextTarget(run.a, target)?.text.toString(), "abcd");
  } finally { run.close(); }
});

test("text staged earlier in the same operation list accepts its prepared mark inside the one transaction", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "a" }] });
  try {
    registerSharedSplitHandlers(run.a, { cells: createFlowLoadRuntime().cells }); registerSharedTextOperationHandlers(run.a);
    const result = executeSharedOperations(run.a, [operation({ kind: "segment-create", id: "stage", by: "Writer", segment: "new", beat: "new",
      at: { left: "R1", right: null, affinity: "after" }, fields: { audioText: "x" } }),
    operation({ kind: "mark", id: "bold", by: "Writer", target: { owner: "new", segment: "new", field: "audioText" },
      observed: [flowBaseReference("new", "audioText", 0, 1)], mark: { kind: "b", value: true } })], { base: readSharedRevision(run.a) });
    assert.deepEqual(result, { ok: true }); run.queue.flush("dup");
    agree("staged text marked", "dup", [run.a, run.b], handle => readSharedMarkCharacters(handle, {
      owner: ref("structure_1_00730074006100670065_beat_0"), segment: ref("structure_1_00730074006100670065_segment_0"), field: "audioText"
    })?.map(char => ({ value: char.value, marks: char.marks.map(mark => mark.kind) })), [{ value: "x", marks: ["b"] }]);
  } finally { run.close(); }
});

test("a projected beat cannot use native positions inside another inline beat or duplicate fragment", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] });
  try {
    const held = prepareSharedMarkRecord(run.a, narration, "range", 2, 3, change); assert.ok(held);
    transactSharedDocument(run.a, "local-command", () => {
      const text = (collabState(run.a).roots.segments.get("b:R1") as Y.Map<unknown>).get("text") as Y.Text;
      text.insertEmbed(2, { b: "R1" });
    });
    unchanged(run.a, () => {
      assert.ok(createSharedAnchor(run.a, narration, 1, "after")); assert.equal(createSharedAnchor(run.a, narration, 3, "after"), null);
      assert.equal(prepareSharedMarkRecord(run.a, narration, "range", 3, 4, change), null);
      assert.deepEqual(writeSharedMarkRecord(run.a, narration, "range", held), { ok: false, reason: "invalid-record" });
    });
  } finally { run.close(); }
});
