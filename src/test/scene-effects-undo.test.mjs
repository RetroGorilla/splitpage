import "./_dom.mjs";
import "./_preferences-started.mjs";
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { migrateRows } from "../js/02-state.js";
import { lastUndoEntry, redo, resetUndo, undo, undoSizes } from "../js/12a-undo.js";

register("./_fanout-hooks.mjs", import.meta.url);

const stubs = await import("./_fanout-stubs.mjs");
const { cycleRowStatus } = await import("../js/01-scene-status.js");
const { setSceneLength } = await import("../js/05r-read-time.js");
const { loadTestDocument } = await import("./_document.mjs");

stubs.wireSession();

function fresh() {
  stubs.resetFanout({ noteEdit: true });
  loadTestDocument(migrateRows({
    title: "Undo groups",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ]
  }));
  resetUndo();
  return currentDocument();
}

const settle = () => new Promise((r) => setImmediate(r));
const row = (id) => currentDocument().rows.find((r) => r.id === id);

test("one status click is one undo entry holding only the status", async () => {
  fresh();
  cycleRowStatus("r1");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  assert.deepEqual(lastUndoEntry().steps, [{ op: "rowField", rowId: "r1", key: "status", before: "todo", after: "ready" }]);
});

test("two status clicks on one scene at once are two entries, undone one at a time", async () => {
  fresh();
  cycleRowStatus("r1");
  await settle();
  cycleRowStatus("r1");
  await settle();
  assert.equal(row("r1").status, "shot");
  assert.deepEqual(undoSizes(), { undo: 2, redo: 0 });
  assert.equal(undo().ok, true);
  assert.equal(row("r1").status, "ready");
  assert.equal(undo().ok, true);
  assert.equal(row("r1").status, "todo");
  assert.deepEqual(undoSizes(), { undo: 0, redo: 2 });
  assert.equal(redo().ok, true);
  assert.equal(row("r1").status, "ready");
});

test("two status clicks inside one microtask are one entry", async () => {
  fresh();
  cycleRowStatus("r1");
  cycleRowStatus("r1");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  assert.deepEqual(lastUndoEntry().steps, [{ op: "rowField", rowId: "r1", key: "status", before: "todo", after: "shot" }]);
});

test("a status click and a length on the same scene are two entries", async () => {
  fresh();
  cycleRowStatus("r2");
  await settle();
  assert.equal(setSceneLength("r2", 90), true);
  await settle();
  assert.deepEqual(undoSizes(), { undo: 2, redo: 0 });
  assert.deepEqual(lastUndoEntry().steps, [{ op: "rowField", rowId: "r2", key: "lengthSeconds", before: undefined, after: 90 }]);
  assert.equal(undo().ok, true);
  assert.ok(!("lengthSeconds" in row("r2")));
  assert.equal(row("r2").status, "ready", "the status entry is still there");
  assert.equal(undo().ok, true);
  assert.equal(row("r2").status, "todo");
});

test("a scene length is one entry; clearing it is another", async () => {
  fresh();
  setSceneLength("r1", 90);
  await settle();
  setSceneLength("r1", null);
  await settle();
  assert.deepEqual(undoSizes(), { undo: 2, redo: 0 });
  assert.deepEqual(lastUndoEntry().steps, [{ op: "rowField", rowId: "r1", key: "lengthSeconds", before: 90, after: undefined }]);
});

test("a length that changes nothing records nothing", async () => {
  fresh();
  setSceneLength("r1", 90);
  await settle();
  assert.equal(setSceneLength("r1", 90), false);
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
});

test("a new edit after an undo drops the redo", async () => {
  fresh();
  cycleRowStatus("r1");
  await settle();
  undo();
  assert.deepEqual(undoSizes(), { undo: 0, redo: 1 });
  cycleRowStatus("r2");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
});
