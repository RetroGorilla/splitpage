import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { saveChanges } from "../bootstrap/wiring/save-owners.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { BEATS_MIME, buildBeatPayload } = await import("../features/clipboard/beat-clip.ts");
const { deleteSelectedBeats, newScriptFromSelection, pasteBeatsAt } = await import("../features/clipboard/beat-select.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const undo = () => undoOwner().undo();
const undoSizes = () => undoOwner().sizes();
const flushEdits = () => undoOwner().flush();
const { currentDocument, liveSession } = await import("../bootstrap/wiring/session-owner.ts");
const writer = await import("../features/writer/writer.ts");
const { viewFlags } = await import("../bootstrap/wiring/preferences-owner.ts");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");

after(closeApp);

const realNow = Date.now;
let clock = 9_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const cmt = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;

function fixture(blankLast) {
  return {
    schema: 2,
    title: "Scene clipboard",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Every " + cmt("c1", "morning") + ".", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Mara mends nets.", status: "ready" },
      blankLast ? { id: "r3", visualText: "", audioText: "", status: "todo" } : { id: "r3", visualText: "End", audioText: "Bye.", status: "todo" }
    ],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", anchorId: "c1", quotedText: "morning", author: "Ann", body: "Warmer?" }]
  };
}

let opened = 0;
async function open(blankLast) {
  if (viewFlags().writerOpen()) writer.closeWriter();
  window.__sceneSelectTest.clear();
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(fixture(blankLast))))], "scene-clip-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file: file, handle: null, options: { skipSnapshot: true } });
  flushEdits();
}

const settle = () => new Promise((r) => setImmediate(r));
const ids = () => currentDocument().rows.map((r) => r.id);
const cellOf = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');

function clipboardWith(data) {
  const store = Object.assign({}, data);
  return {
    getData: (t) => store[t] || "",
    setData: (t, v) => { store[t] = v; },
    store: store
  };
}

function copiedBeats(rowIds) {
  const out = buildBeatPayload(currentDocument(), rowIds);
  return clipboardWith({ [BEATS_MIME]: out.json, "text/html": out.html, "text/plain": out.text });
}

function watch() {
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c));
  return { seen, stop };
}

function counters() {
  return { generation: liveSession().generation(), seq: saveChanges(), sizes: undoSizes() };
}

function cutEvent(clipboardData) {
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const e = new window.Event("cut", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: clipboardData });
  document.body.dispatchEvent(e);
  return e;
}

beforeEach(() => { clock += 10_000; });

test("pasting copied scenes is one paste-scenes transaction: one generation, one edit, one undo entry, and the scenes and their comments in its change set", async () => {
  await open();
  const cd = copiedBeats(["r1"]);
  const was = counters();
  const w = watch();
  try {
    assert.equal(pasteBeatsAt(cd, cellOf("r3", "audioText")), true);
  } finally {
    w.stop();
  }
  await settle();
  assert.equal(currentDocument().rows.length, 4);
  const pasted = ids()[3];
  assert.notEqual(pasted, "r1");
  assert.equal(currentDocument().comments.length, 2, "the comment came with its scene");
  assert.equal(liveSession().generation(), was.generation + 1);
  assert.equal(saveChanges(), was.seq + 1);
  assert.deepEqual(undoSizes(), { undo: was.sizes.undo + 1, redo: 0 });
  assert.equal(w.seen.length, 1);
  const change = w.seen[0];
  assert.equal(change.kind, "edit");
  assert.equal(change.changes.whole, false);
  assert.deepEqual(change.changes.rowsInserted, [pasted]);
  assert.deepEqual(change.changes.rowsRemoved, []);
  assert.deepEqual(change.changes.docFields.slice(0, 4), ["comments", "people", "productionTags", "brollShots"]);
  assert.equal(change.changes.saveNow, true);
  undo();
  assert.deepEqual(ids(), ["r1", "r2", "r3"]);
  assert.equal(currentDocument().comments.length, 1);
});

test("pasting onto a blank scene replaces it inside the same transaction", async () => {
  await open(true);
  const cd = copiedBeats(["r2"]);
  const w = watch();
  try {
    pasteBeatsAt(cd, cellOf("r3", "audioText"));
  } finally {
    w.stop();
  }
  assert.equal(currentDocument().rows.length, 3);
  assert.equal(ids().indexOf("r3"), -1);
  assert.equal(w.seen.length, 1);
  assert.deepEqual(w.seen[0].changes.rowsRemoved, ["r3"]);
  assert.deepEqual(w.seen[0].changes.rowsInserted, [ids()[2]]);
});

test("cutting selected scenes is one remove-scenes transaction with one undo entry, and the paste afterwards is the move", async () => {
  await open();
  window.__sceneSelectTest.select("r2", "r3");
  const cd = clipboardWith({});
  const was = counters();
  const w = watch();
  try {
    assert.equal(cutEvent(cd).defaultPrevented, true);
  } finally {
    w.stop();
  }
  assert.deepEqual(ids(), ["r1"]);
  assert.equal(w.seen.length, 1);
  assert.equal(w.seen[0].kind, "edit");
  assert.equal(w.seen[0].changes.whole, false);
  assert.deepEqual(w.seen[0].changes.rowsRemoved, ["r2", "r3"]);
  assert.equal(w.seen[0].changes.saveNow, true);
  assert.equal(liveSession().generation(), was.generation + 1);
  assert.deepEqual(undoSizes(), { undo: was.sizes.undo + 1, redo: 0 });
  assert.ok(cd.store[BEATS_MIME], "the scenes are on the clipboard");

  pasteBeatsAt(cd, cellOf("r1", "audioText"));
  assert.deepEqual(ids(), ["r1", "r2", "r3"], "a cut then its paste keeps the scene ids");
  undo();
  assert.deepEqual(ids(), ["r1"]);
  undo();
  assert.deepEqual(ids(), ["r1", "r2", "r3"]);
});

test("deleting selected scenes is one transaction, and its undo brings the scenes and the comment's place back", async () => {
  await open();
  window.__sceneSelectTest.select("r1", "r2");
  const w = watch();
  try {
    deleteSelectedBeats();
  } finally {
    w.stop();
  }
  assert.deepEqual(ids(), ["r3"]);
  assert.equal(w.seen.length, 1);
  assert.deepEqual(w.seen[0].changes.rowsRemoved, ["r1", "r2"]);
  undo();
  assert.deepEqual(ids(), ["r1", "r2", "r3"]);
  assert.equal(currentDocument().comments[0].rowId, "r1");
});

test("a new script from selected scenes takes its title in the same transaction as the scenes", async () => {
  await open();
  window.__sceneSelectTest.select("r2", "r2");
  newScriptFromSelection();
  await settle();
  assert.equal(currentDocument().rows.length, 1);
  assert.equal(currentDocument().rows[0].audioText, "Mara mends nets.");
  assert.equal(currentDocument().title, "Scene clipboard — 1 beat");
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 }, "the scenes and the title are one step");
  undo();
  assert.equal(currentDocument().title, "Untitled Script", "undo takes the title back with the scenes");
  assert.equal(currentDocument().rows.length, 1);
  assert.equal(currentDocument().rows[0].audioText, "");
});

test("a scene paste that fails part way is thrown and leaves the document, the edit count and undo as they were", async () => {
  await open();
  const cd = copiedBeats(["r1", "r2"]);
  await settle();
  const before = JSON.stringify(currentDocument());
  const was = counters();
  const w = watch();
  const real = Date.prototype.toISOString;
  Date.prototype.toISOString = function () { throw new Error("no clock"); };
  try {
    assert.throws(() => pasteBeatsAt(cd, cellOf("r3", "audioText")), /no clock/);
  } finally {
    Date.prototype.toISOString = real;
    w.stop();
  }
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.equal(liveSession().generation(), was.generation);
  assert.equal(saveChanges(), was.seq);
  assert.deepEqual(undoSizes(), was.sizes);
  assert.deepEqual(w.seen, []);
});
