import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { saveChanges } from "../legacy/save-bridge.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { cellEditing } = await import("../legacy/editor-bridge.ts");
const { toggleCellFormat, maybeCueShortcut } = await import("../js/05-render.js");
const { undo, undoSizes, lastUndoEntry, flushEdits } = await import("../js/12a-undo.js");
const { currentDocument, liveSession } = await import("../legacy/session-bridge.ts");
const { setMark } = await import("../js/04c-doc-model.js");
const writer = await import("../js/19-writer.js");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");
const { openDocument } = await import("../legacy/transition-bridge.ts");

after(closeApp);

const realNow = Date.now;
let clock = 7_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

function fixture() {
  return {
    schema: 2,
    title: "Cell edit command",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Hello there", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Sound", status: "ready" }
    ]
  };
}

let opened = 0;
async function open() {
  if (viewFlags().writerOpen()) writer.closeWriter();
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(fixture())))], "cell-edit-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file: file, handle: null, options: { skipSnapshot: true } });
  flushEdits();
}

const settle = () => new Promise((r) => setImmediate(r));
const row = (id) => currentDocument().rows.find((r) => r.id === id);
const cellOf = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');

function lastText(el) {
  const walker = document.createTreeWalker(el, 4);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  return last;
}

function select(el, from, to) {
  el.focus();
  const text = lastText(el);
  const r = document.createRange();
  r.setStart(text, from);
  r.setEnd(text, to);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
}

function watch() {
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c));
  return { seen, stop };
}

function bold(cell, sel) {
  return { cell: setMark(cell, sel.from, sel.to, "b", true), sel: sel };
}

beforeEach(() => { clock += 10_000; });

test("a model edit in a script cell is one set-cell-text command: one generation, one edit count, and it publishes the cell and its stamps", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  select(el, 6, 11);
  const generation = liveSession().generation();
  const seq = saveChanges();
  const stamp = row("r1").updatedAt;
  const w = watch();
  try {
    assert.ok(toggleCellFormat(el, "bold"));
  } finally {
    w.stop();
  }
  assert.equal(row("r1").audioText, "Hello <strong>there</strong>");
  assert.notEqual(row("r1").updatedAt, stamp);
  assert.equal(liveSession().generation(), generation + 1);
  assert.equal(saveChanges(), seq + 1);
  assert.equal(w.seen.length, 1);
  const change = w.seen[0];
  assert.equal(change.kind, "edit");
  assert.equal(change.changes.whole, false);
  assert.deepEqual(change.changes.cells.map((c) => c.rowId + "." + c.field), ["r1.audioText", "r1.updatedAt", "r1.updatedBy"]);
  assert.deepEqual(change.changes.derive, ["production", "broll"]);
});

test("the edit is one undo entry, and undo takes the cell back", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  select(el, 0, 5);
  toggleCellFormat(el, "italic");
  await settle();
  assert.equal(row("r1").audioText, "<em>Hello</em> there");
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  assert.deepEqual(lastUndoEntry().steps.map((s) => s.op + ":" + s.key), ["rowField:audioText"]);
  undo();
  assert.equal(row("r1").audioText, "Hello there");
});

test("a shortcut that rewrites the cell (an audio cue) goes through the same command", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  lastText(el).data = "SFX:";
  const text = lastText(el);
  const r = document.createRange();
  r.setStart(text, 4);
  r.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
  const w = watch();
  try {
    maybeCueShortcut({ inputType: "insertText", data: ":" }, el);
  } finally {
    w.stop();
  }
  assert.match(row("r2").audioText, /audio-cue/);
  const edits = w.seen.filter((c) => c.kind === "edit");
  assert.ok(edits.length >= 1);
  for (const c of edits) assert.equal(c.changes.whole, false);
  assert.deepEqual(edits[edits.length - 1].changes.cells.map((c) => c.rowId + "." + c.field), ["r2.audioText", "r2.updatedAt", "r2.updatedBy"]);
});

test("an edit that leaves the stored cell as it is makes no command, no stamp and no edit count", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  select(el, 0, 5);
  const generation = liveSession().generation();
  const seq = saveChanges();
  const stamp = row("r1").updatedAt;
  const w = watch();
  try {
    cellEditing().edit(el, (cell, sel) => ({ cell: cell, sel: sel }));
  } finally {
    w.stop();
  }
  assert.equal(liveSession().generation(), generation);
  assert.equal(saveChanges(), seq);
  assert.equal(row("r1").updatedAt, stamp);
  assert.deepEqual(w.seen, []);
});

test("in review mode the session refuses a formatting edit: the document, the cell on screen and the edit count stay as they were", async () => {
  await open();
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
  try {
    const el = cellOf("r1", "audioText");
    select(el, 6, 11);
    const before = JSON.stringify(currentDocument());
    const shown = el.innerHTML;
    const generation = liveSession().generation();
    const seq = saveChanges();
    const w = watch();
    let out;
    try {
      out = cellEditing().edit(el, bold);
    } finally {
      w.stop();
    }
    assert.equal(out, null);
    assert.equal(JSON.stringify(currentDocument()), before);
    assert.equal(el.innerHTML, shown);
    assert.equal(liveSession().generation(), generation);
    assert.equal(saveChanges(), seq);
    assert.deepEqual(w.seen, []);
  } finally {
    window.__hostedTest.setSession({ role: "edit", docId: null });
  }
});

test("a command that fails is thrown, and leaves the document, the cell on screen, the edit count and undo as they were", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  select(el, 6, 11);
  await settle();
  const before = JSON.stringify(currentDocument());
  const shown = el.innerHTML;
  const seq = saveChanges(), generation = liveSession().generation(), sizes = undoSizes();
  const real = Date.prototype.toISOString;
  Date.prototype.toISOString = function () { throw new Error("no clock"); };
  try {
    assert.throws(() => cellEditing().edit(el, bold), /no clock/);
  } finally {
    Date.prototype.toISOString = real;
  }
  await settle();
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.equal(el.innerHTML, shown);
  assert.equal(saveChanges(), seq);
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(undoSizes(), sizes);
});
