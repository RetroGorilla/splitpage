import { bootApp, closeApp, rewireRunningApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { unsavedChanges } from "../legacy/save-bridge.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { undo, undoSizes, flushEdits } = await import("../js/12a-undo.js");
const { liveSession } = await import("../legacy/session-bridge.ts");
const { legacySessionEffects } = await import("../js/12-dirty-toast.js");
const { addRow, moveRowTo } = await import("../js/06-rows.js");
const { rowDrag } = await import("../legacy/editor-bridge.ts");
const writer = await import("../js/19-writer.js");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");

after(closeApp);

const appEffects = legacySessionEffects();
const effects = Object.assign({}, appEffects);
await rewireRunningApp({ effects: effects });

const realNow = Date.now;
let clock = 7_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const OLD = "2020-01-01T00:00:00.000Z";

function fixture() {
  return {
    schema: 2,
    title: "Rows",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "First line", status: "todo", updatedAt: OLD, updatedBy: "Old" },
      { id: "r2", visualText: "Close", audioText: "Second line", status: "ready", updatedAt: OLD, updatedBy: "Old" },
      { id: "r3", visualText: "Pier", audioText: "Third line", status: "todo", updatedAt: OLD, updatedBy: "Old" },
      { id: "r4", visualText: "", audioText: "", status: "todo", updatedAt: OLD, updatedBy: "Old" }
    ],
    comments: [{ id: "c1", rowId: "r2", field: "audioText", body: "Tighter", replies: [] }]
  };
}

let opened = 0;
async function open() {
  if (viewFlags().writerOpen()) writer.closeWriter();
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(fixture())))], "rows-" + (++opened) + ".splitpage", { lastModified: opened });
  await openProjectFile(file, null, { skipSnapshot: true });
  flushEdits();
}

const settle = () => new Promise((r) => setImmediate(r));
const ids = () => S.state.rows.map((r) => r.id);
const rowEl = (id) => document.querySelector('#rows .row[data-id="' + id + '"]');
const cellOf = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');

function click(el) {
  assert.ok(el, "the control is on the page");
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
}

function key(target, init) {
  const e = new window.KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, init));
  target.dispatchEvent(e);
  return e;
}

function caretIn(el) {
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
}

async function throughSession(gesture) {
  const before = undoSizes();
  const generation = liveSession().generation();
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c));
  try {
    gesture();
    await settle();
  } finally {
    stop();
  }
  assert.equal(seen.length, 1, "one publication for one gesture");
  assert.equal(seen[0].kind, "edit");
  assert.equal(seen[0].changes.whole, false, "the session is told exactly what changed, not just that something did");
  assert.equal(liveSession().generation(), generation + 1, "one generation");
  assert.equal(undoSizes().undo, before.undo + 1, "one undo entry");
  return seen[0].changes;
}

async function undoesInOneStep(expected) {
  undo();
  await settle();
  assert.deepEqual(ids(), expected, "one Ctrl+Z puts the scenes back");
}

beforeEach(() => { clock += 10_000; });

test("rows: Insert below in the scene menu adds the scene through the session", async () => {
  await open();
  const changes = await throughSession(() => click(rowEl("r2").querySelector('[data-action="insert-below"]')));
  assert.equal(changes.rowsInserted.length, 1);
  const made = S.state.rows[2];
  assert.equal(made.id, changes.rowsInserted[0]);
  assert.deepEqual(ids().filter((id) => id !== made.id), ["r1", "r2", "r3", "r4"]);
  assert.notEqual(made.updatedAt, OLD, "the new scene is stamped");
  assert.ok(S.state.rows.filter((r) => r.id !== made.id).every((r) => r.updatedAt === OLD), "no other scene is stamped");
  assert.ok(rowEl(made.id), "the new scene is painted");
  await undoesInOneStep(["r1", "r2", "r3", "r4"]);
});

test("rows: the add-scene button at the foot appends through the session", async () => {
  await open();
  const changes = await throughSession(() => click(document.querySelector('.add-row-bar [data-action="add-row"]')));
  assert.equal(changes.rowsInserted.length, 1);
  assert.equal(ids()[4], changes.rowsInserted[0]);
  await undoesInOneStep(["r1", "r2", "r3", "r4"]);
});

test("rows: Ctrl+Enter in a script cell adds the scene below through the session and puts the caret in it", async () => {
  await open();
  const cell = cellOf("r1", "audioText");
  caretIn(cell);
  const changes = await throughSession(() => key(cell, { key: "Enter", ctrlKey: true }));
  assert.equal(changes.rowsInserted.length, 1);
  assert.equal(ids()[1], changes.rowsInserted[0]);
  assert.equal(document.activeElement, cellOf(changes.rowsInserted[0], "audioText"), "the caret moves into the new scene");
  await undoesInOneStep(["r1", "r2", "r3", "r4"]);
});

test("rows: Move down in the scene menu reorders through the session and saves at once", async () => {
  await open();
  const changes = await throughSession(() => click(rowEl("r1").querySelector('[data-action="move-down"]')));
  assert.equal(changes.rowsMoved, true);
  assert.equal(changes.saveNow, true, "a reorder asks for an immediate save, as it always queued one");
  assert.deepEqual(ids(), ["r2", "r1", "r3", "r4"]);
  assert.ok(S.state.rows.every((r) => r.updatedAt === OLD), "moving stamps no scene");
  await undoesInOneStep(["r1", "r2", "r3", "r4"]);
});

test("rows: Alt+ArrowUp in a script cell swaps through the session", async () => {
  await open();
  const cell = cellOf("r3", "audioText");
  caretIn(cell);
  const changes = await throughSession(() => key(cell, { key: "ArrowUp", altKey: true }));
  assert.equal(changes.rowsMoved, true);
  assert.deepEqual(ids(), ["r1", "r3", "r2", "r4"]);
  await undoesInOneStep(["r1", "r2", "r3", "r4"]);
});

test("rows: dropping a dragged scene moves it through the session", async () => {
  await open();
  rowDrag().start("r1");
  const target = rowEl("r3");
  target.classList.add("drop-after");
  const changes = await throughSession(() => target.dispatchEvent(new window.Event("drop", { bubbles: true, cancelable: true })));
  assert.equal(changes.rowsMoved, true);
  assert.equal(rowDrag().dragging(), null);
  assert.deepEqual(ids(), ["r2", "r3", "r1", "r4"]);
  await undoesInOneStep(["r1", "r2", "r3", "r4"]);
});

test("rows: a drop that leaves the order as it was makes no edit", async () => {
  await open();
  const generation = liveSession().generation();
  const sizes = undoSizes();
  const wasDirty = unsavedChanges();
  moveRowTo("r2", "r1", true);
  await settle();
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(undoSizes(), sizes);
  assert.equal(unsavedChanges(), wasDirty, "nothing to save");
});

test("rows: deleting a blank scene goes through the session in one click", async () => {
  await open();
  const changes = await throughSession(() => click(rowEl("r4").querySelector('[data-action="delete-row"]')));
  assert.deepEqual(changes.rowsRemoved, ["r4"]);
  assert.deepEqual(ids(), ["r1", "r2", "r3"]);
  await undoesInOneStep(["r1", "r2", "r3", "r4"]);
});

test("rows: deleting a scene with words arms first, then deletes through the session", async () => {
  await open();
  const generation = liveSession().generation();
  click(rowEl("r2").querySelector('[data-action="delete-row"]'));
  await settle();
  assert.equal(liveSession().generation(), generation, "the first click only arms the button");
  assert.deepEqual(ids(), ["r1", "r2", "r3", "r4"]);
  const changes = await throughSession(() => click(rowEl("r2").querySelector('[data-action="delete-row"]')));
  assert.deepEqual(changes.rowsRemoved, ["r2"]);
  assert.deepEqual(ids(), ["r1", "r3", "r4"]);
  await undoesInOneStep(["r1", "r2", "r3", "r4"]);
});

test("rows: when the session refuses edits, a strip drop and an add leave the scenes untouched", async () => {
  await open();
  const before = JSON.stringify(S.state);
  const generation = liveSession().generation();
  effects.edit = () => ({ allowed: false, reason: "review" });
  try {
    moveRowTo("r1", "r3", true);
    addRow("r1");
    await settle();
  } finally {
    effects.edit = appEffects.edit;
  }
  assert.equal(JSON.stringify(S.state), before, "nothing was written around the session");
  assert.equal(liveSession().generation(), generation);
});
