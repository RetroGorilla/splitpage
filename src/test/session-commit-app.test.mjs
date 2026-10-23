import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { saveChanges, unsavedChanges } from "../legacy/save-bridge.ts";

await bootApp();

const { liveSession } = await import("../legacy/session-bridge.ts");
const { cycleRowStatus } = await import("../js/01-scene-status.js");
const { migrateRows } = await import("../js/02-state.js");
const { render } = await import("../js/05-render.js");
const { setSceneLength } = await import("../js/05r-read-time.js");
const { noteAbsorbedDirty, noteSessionEdit } = await import("../legacy/session-bridge.ts");
const { confirmSavedNow } = await import("../legacy/save-bridge.ts");
const { flushEdits, lastUndoEntry, undo, undoSizes } = await import("../js/12a-undo.js");
const { PERSON_COLORS } = await import("../core/document/person-colors.ts");
const { preferences } = await import("../legacy/preferences-bridge.ts");
const { saveAuthorName } = await import("../js/10-comments.js");
const NAME_KEY = "splitpage-comment-author";
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

const NAME = "Sam Ortega";
const COLOR = PERSON_COLORS[2];

function named() {
  saveAuthorName(NAME);
  preferences().setMyColor(COLOR);
}

function unnamed() {
  localStorage.removeItem(NAME_KEY);
  preferences().setMyColor(null);
}

let docs = 0;

function fresh() {
  docs++;
  loadTestDocument(migrateRows({
    schema: 5,
    title: "Colours " + docs,
    docId: "d" + String(docs).padStart(32, "7"),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ]
  }));
  render();
  flushEdits();
  confirmSavedNow();
  return currentDocument();
}

function colorOf(doc) {
  return doc.personColors ? doc.personColors[NAME] : undefined;
}

function published(run) {
  const changes = [];
  const off = liveSession().subscribe((c) => { changes.push(c); });
  try {
    run();
  } finally {
    off();
  }
  return changes;
}

function reportedDuring(run) {
  const reported = [];
  const consoleError = console.error;
  console.error = (error) => { reported.push(error); };
  try {
    run();
  } finally {
    console.error = consoleError;
  }
  return reported;
}

function liveToasts() {
  return Array.from(document.querySelectorAll("#toast-host .toast:not(.is-leaving)")).map((t) => t.textContent);
}

test("a command by a named editor writes the colour inside its transaction and publishes it in the change set", () => {
  named();
  const doc = fresh();
  assert.equal(colorOf(doc), undefined);
  const changes = published(() => cycleRowStatus("r1"));
  assert.equal(colorOf(currentDocument()), COLOR);
  assert.equal(changes.length, 1);
  assert.ok(changes[0].changes.docFields.includes("personColors"), "the published change set names personColors");
  assert.deepEqual(changes[0].changes.cells.map((c) => c.field), ["status", "updatedAt", "updatedBy"]);
});

test("the colour is no undo step: the first edit's entry holds only the edit, and undoing it keeps the colour", () => {
  named();
  fresh();
  cycleRowStatus("r1");
  const entry = lastUndoEntry();
  assert.deepEqual(entry.steps.map((s) => s.key), ["status"]);
  const states = [];
  const off = liveSession().subscribe(() => { states.push({ status: currentDocument().rows[0].status, color: colorOf(currentDocument()) }); });
  try {
    undo();
  } finally {
    off();
  }
  assert.deepEqual(states, [{ status: "todo", color: COLOR }]);
  assert.equal(colorOf(currentDocument()), COLOR);
  assert.deepEqual(undoSizes(), { undo: 0, redo: 1 });
});

test("a later command declares only its own change once the colour is recorded", () => {
  named();
  fresh();
  cycleRowStatus("r1");
  const changes = published(() => cycleRowStatus("r2"));
  assert.deepEqual(changes[0].changes.docFields, []);
});

test("without a saved name or colour a command writes and declares no colour", () => {
  unnamed();
  fresh();
  const changes = published(() => cycleRowStatus("r1"));
  assert.equal(currentDocument().personColors && Object.keys(currentDocument().personColors).length ? "has" : "none", "none");
  assert.deepEqual(changes[0].changes.docFields, []);
});

test("a legacy edit records the colour as it marks the document unsaved, and its undo entry holds only the edit", () => {
  named();
  fresh();
  currentDocument().title = "Renamed by hand";
  noteSessionEdit();
  assert.equal(colorOf(currentDocument()), COLOR);
  assert.equal(unsavedChanges(), true);
  assert.deepEqual(lastUndoEntry().steps.map((s) => s.key), ["title"]);
});

test("an absorbed change that marks the document unsaved records the colour as before", () => {
  named();
  fresh();
  noteAbsorbedDirty("server");
  assert.equal(colorOf(currentDocument()), COLOR);
  assert.equal(unsavedChanges(), true);
});

test("the dirty effect itself writes no document content, for a named editor too", () => {
  named();
  const doc = fresh();
  const before = JSON.stringify(doc);
  liveSession().settle("server");
  liveSession().noteEdit();
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.equal(unsavedChanges(), true);
});

test("a status click whose listener throws after the commit repaints the scene, keeps it unsaved, reports once and shows nothing new", () => {
  unnamed();
  fresh();
  const seq = saveChanges();
  const toasts = liveToasts();
  const off = liveSession().subscribe(() => { throw new Error("listener broke"); });
  let reported;
  try {
    reported = reportedDuring(() => cycleRowStatus("r2"));
  } finally {
    off();
  }
  assert.equal(currentDocument().rows[1].status, "ready");
  assert.equal(unsavedChanges(), true);
  assert.equal(saveChanges(), seq + 1);
  assert.deepEqual(reported.map((e) => e.message), ["listener broke"]);
  assert.deepEqual(liveToasts(), toasts, "no new toast");
  const lamp = document.querySelector('#rows .status-btn[data-id="r2"]');
  assert.ok(lamp && /Ready/.test(lamp.getAttribute("title")), "the scene's lamp shows the committed status: " + (lamp && lamp.getAttribute("title")));
});

test("a scene length whose effect throws after the commit still closes as applied and reports once", () => {
  unnamed();
  fresh();
  const start = globalThis.setTimeout;
  globalThis.setTimeout = function () {
    globalThis.setTimeout = start;
    throw new Error("effect broke");
  };
  let result;
  let reported;
  try {
    reported = reportedDuring(() => { result = setSceneLength("r1", 45); });
  } finally {
    globalThis.setTimeout = start;
  }
  assert.equal(result, true);
  assert.equal(currentDocument().rows[0].lengthSeconds, 45);
  assert.equal(unsavedChanges(), true);
  assert.deepEqual(reported.map((e) => e.message), ["effect broke"]);
});

test("in review mode neither a legacy edit nor an absorbed change records the colour", () => {
  named();
  fresh();
  window.__hostedTest.setSession({ role: "review", docId: "d" + "8".repeat(32) });
  try {
    currentDocument().personColors = {};
    noteSessionEdit();
    noteAbsorbedDirty("server");
    assert.deepEqual(currentDocument().personColors, {});
  } finally {
    window.__hostedTest.setSession({ role: "edit", docId: null });
    unnamed();
  }
});
