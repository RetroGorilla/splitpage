import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { replicas, execute } from "./executor-support.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import type { SharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { projectSharedDocumentStep, projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { assertIncremental, captureIncrementalReplica, incrementalReports, nativeMap, nativeText } from "./incremental-support.ts";

const NOTHING = { whole: false, added: [], removed: [], moved: [], changed: [], fields: [] };
const WHOLE = { ...NOTHING, whole: true };
const FOUR = { title: "Script", rows: [{ id: "R1", audioText: "one" }, { id: "R2", audioText: "two" }, { id: "R3", audioText: "three" }, { id: "R4", audioText: "four" }] };

function watched(handle: SharedDocumentHandle, projector: SharedIncrementalProjector) {
  const reports: unknown[] = [];
  assertIncremental(handle, projector);
  const stop = projector.observe(step => { assertIncremental(handle, projector); reports.push(step.changes); });
  return { reports, stop, last: () => { assert.equal(reports.length, 1); return reports.pop(); } };
}

test("the first projection reports the whole document; typing, a status and a document number each name exactly their own place", () => {
  const run = replicas(2, FOUR), projector = createSharedIncrementalProjector(run.a), watch = watched(run.a, projector);
  const checked = incrementalReports.compared;
  try {
    assert.deepEqual(projector.read().changes, WHOLE);
    assert.ok(Object.isFrozen(projector.read().changes) && Object.isFrozen(projector.read().changes.changed));
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R2").insert(3, "!"));
    assert.deepEqual(watch.last(), { ...NOTHING, changed: [{ id: "R2", fields: ["audioText"] }] });
    execute(run.a, { kind: "status", id: "ready", by: "Writer", target: { scope: "beat", record: "R3" }, value: "ready", parents: [] });
    assert.deepEqual(watch.last(), { ...NOTHING, changed: [{ id: "R3", fields: ["status"] }] });
    transactSharedDocument(run.a, "local-command", () => collabState(run.a).roots.meta.set("wordsPerMinute", 140));
    assert.deepEqual(watch.last(), { ...NOTHING, fields: ["wordsPerMinute"] });
    transactSharedDocument(run.a, "local-command", () => { const title: unknown = collabState(run.a).roots.meta.get("title"); assert.ok(title instanceof Y.Text); title.insert(0, "New "); });
    assert.deepEqual(watch.last(), { ...NOTHING, fields: ["title"] });
    transactSharedDocument(run.a, "local-command", () => {
      const person = new Y.Map<unknown>(); person.set("id", "P1"); person.set("name", "Ada"); collabState(run.a).roots.people.set("P1", person);
    });
    assert.deepEqual(watch.last(), { ...NOTHING, fields: ["people"] });
    transactSharedDocument(run.a, "local-command", () => collabState(run.a).roots.meta.set("not-a-document-field", { wrong: true }));
    assert.deepEqual(watch.last(), NOTHING);
    assert.equal(incrementalReports.compared - checked, 6);
  } finally { watch.stop(); projector.dispose(); run.close(); }
});

test("a join removes the joined row and changes its target; removal, restore, a new beat and a reorder name rows and no cell", () => {
  const run = replicas(2, FOUR), projector = createSharedIncrementalProjector(run.a), watch = watched(run.a, projector);
  try {
    const roots = collabState(run.a).roots;
    transactSharedDocument(run.a, "local-command", () => {
      const joins = nativeMap(run.a, "beats", "R2").get("joins"); assert.ok(joins instanceof Y.Map); joins.set("join", { into: "R1", glue: " " });
    });
    assert.deepEqual(projector.read().document.rows.map(row => [row.id, row.audioText]), [["R1", "one two"], ["R3", "three"], ["R4", "four"]]);
    assert.deepEqual(watch.last(), { ...NOTHING, removed: ["R2"], changed: [{ id: "R1", fields: ["audioText"] }] });
    transactSharedDocument(run.a, "local-command", () => {
      const removals = nativeMap(run.a, "beats", "R4").get("removals"); assert.ok(removals instanceof Y.Map); removals.set("gone", true);
    });
    assert.deepEqual(watch.last(), { ...NOTHING, removed: ["R4"] });
    transactSharedDocument(run.a, "local-command", () => {
      const removals = nativeMap(run.a, "beats", "R4").get("removals"); assert.ok(removals instanceof Y.Map); removals.delete("gone");
    });
    assert.deepEqual(watch.last(), { ...NOTHING, added: ["R4"] });
    transactSharedDocument(run.a, "local-command", () => {
      const beat = new Y.Map<unknown>(), segment = new Y.Map<unknown>();
      beat.set("id", "N1"); beat.set("segment", "s:N1"); segment.set("head", { b: "N1" }); segment.set("text", new Y.Text("new"));
      roots.beats.set("N1", beat); roots.segments.set("s:N1", segment); roots.order.insert(1, ["s:N1"]);
    });
    assert.deepEqual(projector.read().document.rows.map(row => row.id), ["R1", "N1", "R3", "R4"]);
    assert.deepEqual(watch.last(), { ...NOTHING, added: ["N1"] });
    transactSharedDocument(run.a, "local-command", () => { roots.order.delete(0, roots.order.length); roots.order.push(["b:R4", "b:R1", "b:R2", "s:N1", "b:R3"]); });
    assert.deepEqual(projector.read().document.rows.map(row => row.id), ["R4", "R1", "N1", "R3"]);
    assert.deepEqual(watch.last(), { ...NOTHING, moved: ["R4"] });
    transactSharedDocument(run.a, "local-command", () => { roots.order.delete(0, roots.order.length); roots.order.push(["b:R3", "s:N1", "b:R4", "b:R1", "b:R2"]); });
    assert.deepEqual(projector.read().document.rows.map(row => row.id), ["R3", "N1", "R4", "R1"]);
    assert.deepEqual(watch.last(), { ...NOTHING, moved: ["R3", "N1"] });
  } finally { watch.stop(); projector.dispose(); run.close(); }
});

test("a wrong-shape beat leaves the report as its row leaves the document, and unprojectable content changes no row", () => {
  const run = replicas(2, FOUR), projector = createSharedIncrementalProjector(run.a), watch = watched(run.a, projector);
  try {
    const roots = collabState(run.a).roots;
    transactSharedDocument(run.a, "local-command", () => {
      roots.beats.set("bad", false); roots.segments.set("dangling", new Y.Map()); roots.people.set("P1", { id: "P1", name: "invalid-native-shape" });
    });
    assert.deepEqual(watch.last(), NOTHING);
    transactSharedDocument(run.a, "local-command", () => nativeMap(run.a, "beats", "R2").set("id", null));
    assert.deepEqual(projector.read().recovery.map(entry => entry.kind), ["unprojectable-fragment"]);
    assert.deepEqual(watch.last(), { ...NOTHING, removed: ["R2"] });
    transactSharedDocument(run.a, "local-command", () => nativeMap(run.a, "beats", "R2").set("id", "R2"));
    assert.deepEqual(watch.last(), { ...NOTHING, added: ["R2"] });
    transactSharedDocument(run.a, "local-command", () => nativeMap(run.a, "beats", "R3").set("lengthSeconds", "wrong"));
    assert.deepEqual(watch.last(), NOTHING);
  } finally { watch.stop(); projector.dispose(); run.close(); }
});

test("a received change gives the report a local one gives, once under duplicated delivery, and a late joiner's first report adds every row", () => {
  const run = replicas(2, FOUR), projector = createSharedIncrementalProjector(run.a), watch = watched(run.a, projector);
  const late = createMonitoredSharedDocument(), lateProjector = createSharedIncrementalProjector(late), lateWatch = watched(late, lateProjector);
  try {
    const base = projectSharedDocumentWithRecovery(run.a).document;
    transactSharedDocument(run.b, "local-command", () => {
      nativeText(run.b, "b:R3").insert(0, ">");
      const order = collabState(run.b).roots.order; order.delete(0, order.length); order.push(["b:R2", "b:R1", "b:R3", "b:R4"]);
    });
    run.queue.flush("dup");
    const expected = { ...NOTHING, moved: ["R1"], changed: [{ id: "R3", fields: ["audioText"] }] };
    assert.deepEqual(watch.last(), expected);
    assert.deepEqual(applySharedUpdate(late, encodeSharedState(run.a)), { ok: true });
    assert.deepEqual(lateWatch.last(), { ...NOTHING, added: ["R2", "R1", "R3", "R4"], fields: ["title", "docId", "wordsPerMinute"] });
    assertReplicasAgree("report between the same two documents on every copy", [
      { order: "D2", replica: "A", output: expected },
      { order: "dup", replica: "A", output: projectSharedDocumentStep(run.a, base).changes },
      { order: "dup", replica: "B", output: projectSharedDocumentStep(run.b, base).changes },
      { order: "late-C", replica: "C", output: projectSharedDocumentStep(late, base).changes }
    ]);
  } finally { lateWatch.stop(); lateProjector.dispose(); destroySharedDocument(late); watch.stop(); projector.dispose(); run.close(); }
});

test("a throwing subscriber leaves the next report relative to the last published projection", () => {
  const run = replicas(2, FOUR), projector = createSharedIncrementalProjector(run.a), reports: unknown[] = [];
  const stop = projector.observe(step => { reports.push(step.changes); if (reports.length === 1) throw new Error("subscriber failed"); });
  try {
    assert.throws(() => transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R1").insert(0, "a")), /subscriber failed/);
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R4").insert(0, "b"));
    assert.deepEqual(reports, [{ ...NOTHING, changed: [{ id: "R1", fields: ["audioText"] }] }, { ...NOTHING, changed: [{ id: "R4", fields: ["audioText"] }] }]);
  } finally { stop(); projector.dispose(); run.close(); }
});

test("one typed character compares one row by value among 300; a reorder compares the 300 rows the assembly rebuilt and names one", () => {
  const rows = Array.from({ length: 300 }, (_unused, index) => ({ id: "R" + String(index), audioText: "text " + String(index) }));
  const run = replicas(2, { title: "Script", rows }), work: string[] = [];
  const { projector } = captureIncrementalReplica(run.a, (kind, key) => { if (kind.startsWith("compare")) work.push(kind + ":" + key); });
  try {
    assertIncremental(run.a, projector);
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R150").insert(0, "x"));
    assert.deepEqual(projector.read().changes, { ...NOTHING, changed: [{ id: "R150", fields: ["audioText"] }] });
    assert.deepEqual(work, ["compare-row:R150", "compare-field:comments"]);
    assertIncremental(run.a, projector); work.length = 0;
    transactSharedDocument(run.a, "local-command", () => {
      const order = collabState(run.a).roots.order; order.delete(299, 1); order.insert(0, ["b:R299"]);
    });
    assert.deepEqual(projector.read().changes, { ...NOTHING, moved: ["R299"] });
    assert.deepEqual(work.filter(entry => !entry.startsWith("compare-row:")), ["compare-field:comments"]);
    assert.equal(work.filter(entry => entry.startsWith("compare-row:")).length, 300);
    assertIncremental(run.a, projector);
  } finally { projector.dispose(); run.close(); }
});
