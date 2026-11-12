import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { replicas, execute, ref } from "./executor-support.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import { applySharedUpdate, encodeSharedState, observeSharedTransactions, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { assertIncremental, nativeMap, nativeText } from "./incremental-support.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { SHARED_MARK_PROVENANCE_MARKER } from "../../../src/adapters/collab/mark-provenance.ts";

test("incremental join refreshes its partner after text and status changes", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "one" }, { id: "R2", audioText: "two" }, { id: "R3", audioText: "three" }] });
  const projector = createSharedIncrementalProjector(run.a), stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    const untouched = projector.read().document.rows[2];
    transactSharedDocument(run.a, "local-command", () => {
      const joins = nativeMap(run.a, "beats", "R2").get("joins"); assert.ok(joins instanceof Y.Map);
      joins.set("join", { into: "R1", glue: " " });
    });
    assert.deepEqual(projector.read().document.rows.map(row => [row.id, row.audioText, row.status]), [["R1", "one two", "todo"], ["R3", "three", "todo"]]);
    transactSharedDocument(run.b, "local-command", () => nativeText(run.b, "b:R2").insert(3, "!"));
    run.queue.flush("dup");
    assert.deepEqual(projector.read().document.rows.map(row => row.audioText), ["one two!", "three"]);
    execute(run.a, { kind: "status", id: "ready", by: "Writer", target: { scope: "beat", record: "R2" }, value: "ready", parents: [] });
    assert.deepEqual(projector.read().document.rows.map(row => row.status), ["ready", "todo"]);
    assert.equal(projector.read().document.rows[1], untouched);
    assertIncremental(run.a, projector);
  } finally { stop(); projector.dispose(); run.close(); }
});

test("incremental mark-only arrival and an opaque undo marker invalidate the cached text", () => {
  const run = replicas(), work: string[] = [], projector = createSharedIncrementalProjector(run.a, (kind, key) => work.push(kind + ":" + key));
  const stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
    const mark = prepareSharedMarkRecord(run.b, target, "bold", 0, 2, { type: "add", mark: { kind: "b", value: true } }); assert.ok(mark);
    assert.deepEqual(writeSharedMarkRecord(run.b, target, "bold", mark), { ok: true });
    run.queue.flush("rev");
    assert.equal(projector.read().document.rows[0]?.audioText, "<strong>ab</strong>Z");
    work.length = 0;
    transactSharedDocument(run.a, "local-undo", () => {
      const store = nativeMap(run.a, "segments", "b:R1").get("markRecords"); assert.ok(store instanceof Y.Map); store.set("opaque-undo-marker", 1);
    });
    assert.deepEqual(work.filter(value => value.startsWith("segment:")), ["segment:b:R1"]);
    assert.equal(projector.read().document.rows[0]?.audioText, "<strong>ab</strong>Z");
    registerSharedUndoOperationHandlers(run.b);
    const preparation = createSharedPreparation(run.b);
    const occurrences = preparation.view.text(["segments", "b:R1", "text"])?.records.filter(item => item.record.type === "add").map(item => item.identity);
    preparation.close(); assert.ok(occurrences); assert.equal(occurrences.length, 1);
    execute(run.b, { kind: "mark-retract", id: "retract-bold", by: "Writer", target, occurrences });
    run.queue.flush("dup");
    const store = nativeMap(run.a, "segments", "b:R1").get("markRecords"); assert.ok(store instanceof Y.Map);
    assert.equal(store.get(SHARED_MARK_PROVENANCE_MARKER), true);
    assert.equal(projector.read().document.rows[0]?.audioText, "abZ");
    assertIncremental(run.a, projector);
  } finally { stop(); projector.dispose(); run.close(); }
});

test("incremental publishes each drained revision and retains a coherent previous pair before its update callback", () => {
  const run = replicas(), early: number[] = [], published: [number, string][] = [];
  let read = () => -1;
  const before = observeSharedTransactions(run.a, () => early.push(read()));
  const projector = createSharedIncrementalProjector(run.a); read = () => projector.read().revision;
  try {
    const base = readSharedRevision(run.a);
    transactSharedDocument(run.b, "local-command", () => nativeText(run.b, "b:R1").insert(0, "x"));
    const update = encodeSharedState(run.b);
    projector.observe(value => {
      assertIncremental(run.a, projector);
      published.push([value.revision, value.document.rows[0]?.audioText ?? ""]);
      if (published.length === 1) {
        assert.deepEqual(applySharedUpdate(run.a, update), { ok: true });
        assert.equal(projector.read(), value);
      }
    });
    transactSharedDocument(run.a, "local-command", () => collabState(run.a).roots.meta.set("wordsPerMinute", 140));
    assert.deepEqual(early, [base, base + 1]);
    assert.deepEqual(published, [[base + 1, "abZ"], [base + 2, "xabZ"]]);
    assert.ok(Object.isFrozen(projector.read().document.rows[0]));
    projector.dispose(); projector.dispose();
    assert.throws(() => projector.observe(() => {}), /has ended/);
  } finally { before(); projector.dispose(); run.close(); }
});

test("incremental split, ownership, duplicate cleaned ids and wrong shapes retain full recovery", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "two" }] });
  const projector = createSharedIncrementalProjector(run.a), stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    transactSharedDocument(run.a, "local-command", () => {
      const text = nativeText(run.a, "b:R1"); text.insertEmbed(2, { b: "R2" });
      nativeMap(run.a, "beats", "R2").set("segment", "b:R1");
    });
    assert.deepEqual(projector.read().document.rows.map(row => [row.id, row.audioText]), [["R1", "ab"], ["R2", "cd"]]);
    assert.deepEqual(projector.read().recovery.map(entry => entry.kind), ["unprojectable-fragment"]);
    transactSharedDocument(run.a, "local-command", () => nativeMap(run.a, "beats", "R2").set("id", null));
    assert.deepEqual(projector.read().document.rows.map(row => row.id), ["R1"]);
    assert.deepEqual(projector.read().recovery.map(entry => entry.kind), ["unprojectable-fragment", "unprojectable-fragment"]);
    transactSharedDocument(run.a, "local-command", () => {
      nativeText(run.a, "b:R1").insertEmbed(0, { b: "R1", before: "R1" });
      collabState(run.a).roots.beats.set("bad", false);
      collabState(run.a).roots.segments.set("dangling", new Y.Map());
      collabState(run.a).roots.people.set("P1", { id: "P1", name: "invalid-native-shape" });
    });
    assertIncremental(run.a, projector);
  } finally { stop(); projector.dispose(); run.close(); }
});

test("incremental status replacement, retargeting, retirement and deletion refresh exactly the affected values", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "one" }, { id: "R2", audioText: "two" }] });
  const projector = createSharedIncrementalProjector(run.a), stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    const roots = collabState(run.a).roots;
    transactSharedDocument(run.a, "remote", () => roots.statusEvents.set("event", { kind: "status", id: "event", by: "Writer", target: { scope: "beat", record: "R1" }, value: "ready", parents: [] }));
    assert.deepEqual(projector.read().document.rows.map(row => row.status), ["ready", "todo"]);
    transactSharedDocument(run.a, "remote", () => roots.statusEvents.set("event", { kind: "status", id: "event", by: "Writer", target: { scope: "beat", record: "R2" }, value: "shot", parents: [] }));
    assert.deepEqual(projector.read().document.rows.map(row => row.status), ["todo", "shot"]);
    transactSharedDocument(run.a, "remote", () => roots.retiredStatus.set("event", true));
    assert.deepEqual(projector.read().document.rows.map(row => row.status), ["todo", "todo"]);
    transactSharedDocument(run.a, "remote", () => roots.retiredStatus.delete("event"));
    assert.deepEqual(projector.read().document.rows.map(row => row.status), ["todo", "shot"]);
    transactSharedDocument(run.a, "remote", () => roots.statusEvents.delete("event"));
    assert.deepEqual(projector.read().document.rows.map(row => row.status), ["todo", "todo"]);
  } finally { stop(); projector.dispose(); run.close(); }
});

test("incremental surrogate fragments normalize exactly like a fresh wire snapshot after native item merges", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "" }] }), projector = createSharedIncrementalProjector(run.a);
  const stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R1").insert(0, "\ud800"));
    assert.equal(projector.read().document.rows[0]?.audioText, "\ufffd");
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R1").insert(1, "\udc00"));
    assert.equal(projector.read().document.rows[0]?.audioText, "\ud800\udc00");
    assertIncremental(run.a, projector);
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R1").delete(0, 1));
    assert.equal(projector.read().document.rows[0]?.audioText, "\ufffd");
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R1").insert(1, "x"));
    assert.equal(projector.read().document.rows[0]?.audioText, "\ufffdx");
    assertIncremental(run.a, projector);
  } finally { stop(); projector.dispose(); run.close(); }
});

test("incremental normalized inputs retain untouched groups and stay fresh after mark-only and unrelated updates", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "" }, { id: "R2", audioText: "other" }] });
  const work: string[] = [], projector = createSharedIncrementalProjector(run.a, (kind, key) => work.push(kind + ":" + key));
  const stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    const untouched = projector.read().document.rows[1];
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R1").insert(0, "\ud800"));
    work.length = 0;
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R1").insert(1, "\udc00"));
    assert.equal(projector.read().document.rows[0]?.audioText, "\ud800\udc00");
    assert.equal(projector.read().document.rows[1], untouched);
    assert.deepEqual(work, ["snapshot:normalized-input", "segment:b:R1", "group:R1", "broll-scan:[\"R1\",\"audioText\"]", "cell:[\"R1\",\"audioText\"]", "compare-row:R1", "compare-field:comments"]);
    const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
    const mark = prepareSharedMarkRecord(run.a, target, "unicode-bold", 0, 2, { type: "add", mark: { kind: "b", value: true } }); assert.ok(mark);
    work.length = 0;
    assert.deepEqual(writeSharedMarkRecord(run.a, target, "unicode-bold", mark), { ok: true });
    assert.equal(projector.read().document.rows[0]?.audioText, "<strong>\ud800\udc00</strong>");
    assert.deepEqual(work, ["snapshot:normalized-input", "segment:b:R1", "group:R1", "broll-scan:[\"R1\",\"audioText\"]", "cell:[\"R1\",\"audioText\"]", "compare-row:R1", "compare-field:comments"]);
    const marked = projector.read().document.rows[0]; work.length = 0;
    execute(run.a, { kind: "scalar", id: "other-length", by: "Writer", target: { scope: "beat", record: "R2" }, field: "lengthSeconds", value: 12 });
    assert.equal(projector.read().document.rows[0], marked);
    assert.deepEqual(work, ["snapshot:normalized-input", "fields:R2", "group:R2", "compare-row:R2", "compare-field:comments"]);
  } finally { stop(); projector.dispose(); run.close(); }
});
