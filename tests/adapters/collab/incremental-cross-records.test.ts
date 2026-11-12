import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { replicas, execute, ref } from "./executor-support.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { assertIncremental, nativeMap, nativeText } from "./incremental-support.ts";
import { pictureA } from "./projection-record-support.ts";

const marker = '<span class="broll-key" data-broll-id="S1" contenteditable="false">B-roll:</span>';

test("incremental b-roll uses unchanged cells after shot reservation and document order changes", () => {
  const run = replicas(2, { rows: [{ id: "R1", visualText: marker }, { id: "R2", audioText: "" }] });
  const projector = createSharedIncrementalProjector(run.a), stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    transactSharedDocument(run.b, "local-command", () => nativeText(run.b, "b:R2").insertEmbed(0, { k: "S1", label: "B-roll:" }));
    run.queue.flush("dup");
    assert.equal(projector.read().document.rows[1]?.audioText, '<span class="broll-key" data-broll-id="broll_00530031_2_0" contenteditable="false">B-roll:</span>');
    registerSharedRecordHandlers(run.a);
    execute(run.a, { kind: "record-create", id: "reserve", by: "Writer", target: { collection: "shots", record: "broll_00530031_2_0" },
      fields: { id: "broll_00530031_2_0", name: "Reserved", status: "unshot", origin: "list" } });
    assert.equal(projector.read().document.rows[1]?.audioText, '<span class="broll-key" data-broll-id="broll_00530031_2_0_" contenteditable="false">B-roll:</span>');
    transactSharedDocument(run.a, "local-command", () => {
      const order = collabState(run.a).roots.order; order.delete(0, order.length); order.push(["b:R2", "b:R1"]);
    });
    assert.equal(projector.read().document.rows[0]?.audioText, marker);
    assert.notEqual(projector.read().document.rows[1]?.visualText, marker);
  } finally { stop(); projector.dispose(); run.close(); }
});

test("incremental joined gallery uses a changed partner record and folds the duplicate picture", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "one" }, { id: "R2", audioText: "two" }] });
  const projector = createSharedIncrementalProjector(run.a), stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    registerSharedRecordHandlers(run.a);
    execute(run.a, { kind: "record-create", id: "first", by: "Writer", target: { collection: "gallery", record: "G1" }, fields: { beat: "R1", rank: "0", picture: { imageRef: pictureA, name: "" }, links: [] } },
      { kind: "record-create", id: "second", by: "Writer", target: { collection: "gallery", record: "G2" }, fields: { beat: "R2", rank: "0", picture: { imageRef: pictureA, name: "First" }, links: [] } });
    transactSharedDocument(run.a, "local-command", () => { const joins = nativeMap(run.a, "beats", "R2").get("joins"); assert.ok(joins instanceof Y.Map); joins.set("join", { into: "R1", glue: " " }); });
    assert.equal(projector.read().document.rows[0]?.imageName, "First");
    assert.deepEqual(projector.read().document.rows[0]?.imageRef, pictureA);
    assert.equal(projector.read().document.rows[0]?.moreImages, undefined);
    execute(run.a, { kind: "record-set", id: "rename", by: "Writer", target: { collection: "gallery", record: "G2" }, field: "picture", value: { imageRef: pictureA, name: "Changed" } });
    assert.equal(projector.read().document.rows[0]?.imageName, "Changed");
    assert.deepEqual(projector.read().recovery, []);
  } finally { stop(); projector.dispose(); run.close(); }
});

test("incremental shared comment anchors move to the next unchanged row when the first occurrence disappears", () => {
  const anchor = '<span class="cmt-anchor" data-cmt="C1">word</span>';
  const run = replicas(2, { rows: [{ id: "R1", audioText: anchor }, { id: "R2", audioText: anchor }],
    comments: [{ id: "C1", anchorId: "C1", rowId: "R1", field: "audioText", quotedText: "word", author: "Ada", body: "Review" }] });
  const projector = createSharedIncrementalProjector(run.a), stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    assert.equal(projector.read().document.comments?.[0]?.rowId, "R1");
    transactSharedDocument(run.a, "local-command", () => { const text = nativeText(run.a, "b:R1"); text.delete(0, text.length); });
    assert.equal(projector.read().document.comments?.[0]?.rowId, "R2");
    assert.deepEqual(projector.read().document.rows.map(row => row.audioText), ["", anchor]);
  } finally { stop(); projector.dispose(); run.close(); }
});

for (const prefix of [false, true]) test(`incremental tag extent crosses a ${prefix ? "prefix" : "normal"} split through the same interpreter`, () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "old" }], productionTags: [{ id: "t_1", cat: "prop", name: "Cup" }] });
  const projector = createSharedIncrementalProjector(run.a), stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
    const record = prepareSharedMarkRecord(run.a, target, "tag", 0, 4, { type: "add", mark: { kind: "tag", id: "occurrence", value: "t_1" } }); assert.ok(record);
    assert.deepEqual(writeSharedMarkRecord(run.a, target, "tag", record), { ok: true });
    transactSharedDocument(run.a, "local-command", () => {
      nativeText(run.a, "b:R1").insertEmbed(2, prefix ? { b: "R2", before: "R1" } : { b: "R2" }); nativeMap(run.a, "beats", "R2").set("segment", "b:R1");
    });
    const open = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Cup" contenteditable="false">';
    assert.deepEqual(projector.read().document.rows.map(row => [row.id, row.audioText]), prefix
      ? [["R2", open + "ab</span>"], ["R1", open + "cd</span>"]] : [["R1", open + "ab</span>"], ["R2", open + "cd</span>"]]);
  } finally { stop(); projector.dispose(); run.close(); }
});

test("incremental cleaned-id conflicts, empty ids and dangling join cycles follow recovery after order changes", () => {
  const run = replicas(2, { rows: [] }), projector = createSharedIncrementalProjector(run.a);
  const stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    transactSharedDocument(run.a, "local-command", () => {
      const roots = collabState(run.a).roots;
      roots.order.delete(0, roots.order.length);
      for (const [id, text] of [["R!", "first"], ["R?", "second"], ["!!!", "empty"]]) {
        assert.ok(id && text); const beat = new Y.Map<unknown>(), segment = new Y.Map<unknown>();
        beat.set("id", id); beat.set("segment", "s:" + id); beat.set("joins", new Y.Map([["cycle", { into: "missing", glue: " " }]]));
        segment.set("head", { b: id }); segment.set("text", new Y.Text(text));
        roots.beats.set(id, beat); roots.segments.set("s:" + id, segment); roots.order.push(["s:" + id]);
      }
    });
    assert.deepEqual(projector.read().document.rows.map(row => [row.id, row.audioText]), [["R", "first"]]);
    assert.deepEqual(projector.read().recovery.map(entry => entry.kind === "unprojectable-fragment" ? entry.reason : entry.kind), ["duplicate-boundary", "invalid-beat-id"]);
    transactSharedDocument(run.a, "local-command", () => collabState(run.a).roots.order.delete(0, 1));
    assert.deepEqual(projector.read().document.rows.map(row => [row.id, row.audioText]), [["R", "second"]]);
    assert.deepEqual(projector.read().recovery.map(entry => entry.kind === "unprojectable-fragment" ? entry.reason : entry.kind), ["invalid-beat-id"]);
  } finally { stop(); projector.dispose(); run.close(); }
});
