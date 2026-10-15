import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { undo, undoSizes, flushEdits, breakUndoCoalescing } = await import("../js/12a-undo.js");
const { liveSession } = await import("../legacy/session-bridge.ts");
const writer = await import("../js/19-writer.js");

after(closeApp);

const realNow = Date.now;
let clock = 9_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const OLD = "2020-01-01T00:00:00.000Z";

function fixture() {
  return {
    schema: 2,
    title: "Writer commands",
    rows: [
      { id: "r1", visualText: "", audioText: "First line", status: "todo", updatedAt: OLD, updatedBy: "Old" },
      { id: "r2", visualText: "", audioText: "Second line", status: "ready", updatedAt: OLD, updatedBy: "Old" },
      { id: "r3", visualText: "Pier", audioText: "Third line", status: "todo", updatedAt: OLD, updatedBy: "Old" }
    ]
  };
}

let opened = 0;
async function open() {
  if (writer.writerOpen) writer.closeWriter();
  window.__hostedTest.setSession({ role: "edit", docId: null });
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(fixture())))], "writer-commands-" + (++opened) + ".splitpage", { lastModified: opened });
  await openProjectFile(file, null, { skipSnapshot: true });
  flushEdits();
}

async function openInWriter() {
  await open();
  writer.openWriter();
  flushEdits();
  breakUndoCoalescing();
}

const settle = () => new Promise((r) => setImmediate(r));
const ids = () => S.state.rows.map((r) => r.id);
const para = (id) => document.querySelector('#writer-doc .wr-para[data-id="' + id + '"]');
const writerTitle = () => document.getElementById("writer-title");
const docTitle = () => document.getElementById("doc-title");

function textNodeAt(el, offset) {
  const walker = document.createTreeWalker(el, 4);
  let at = 0;
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (offset <= at + n.data.length) return [n, offset - at];
    at += n.data.length;
  }
  return null;
}

function selectText(el, from, to) {
  el.focus();
  const start = textNodeAt(el, from), end = textNodeAt(el, to);
  const r = document.createRange();
  r.setStart(start[0], start[1]);
  r.setEnd(end[0], end[1]);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function typeChar(el, ch) {
  const end = el.textContent.length;
  selectText(el, end, end);
  const [node] = textNodeAt(el, end);
  node.data += ch;
  const r = document.createRange();
  r.setStart(node, node.data.length);
  r.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
  el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
}

function key(el, name, mods) {
  const ev = new window.KeyboardEvent("keydown", Object.assign({ key: name, bubbles: true, cancelable: true }, mods || {}));
  el.dispatchEvent(ev);
  return ev;
}

function typeTitle(input, value) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value.slice(-1) }));
}

function click(el) {
  assert.ok(el, "the control is on the page");
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
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
  flushEdits();
  assert.equal(seen.length, 1, "one publication for one gesture");
  assert.equal(seen[0].kind, "edit");
  assert.equal(seen[0].changes.whole, false, "the session is told exactly what changed, not just that something did");
  assert.equal(liveSession().generation(), generation + 1, "one generation");
  assert.equal(undoSizes().undo, before.undo + 1, "one undo entry");
  assert.equal(S.dirty, true, "the script is marked unsaved");
  return seen[0].changes;
}

function untouched(gesture) {
  flushEdits();
  const model = JSON.stringify(S.state), generation = liveSession().generation(), sizes = undoSizes();
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c));
  try {
    gesture();
  } finally {
    stop();
  }
  flushEdits();
  assert.equal(JSON.stringify(S.state), model, "the document is unchanged");
  assert.equal(liveSession().generation(), generation, "the session did not change");
  assert.deepEqual(undoSizes(), sizes, "the undo stack is unchanged");
  assert.deepEqual(seen, [], "nothing was published");
}

beforeEach(() => { clock += 10_000; });

test("writer: typing in a paragraph is one set-cell-text edit naming the paragraph", async () => {
  await openInWriter();
  const changes = await throughSession(() => typeChar(para("r2"), "!"));
  assert.deepEqual(changes.cells.map((c) => c.rowId + ":" + c.field).filter((c) => c.endsWith("audioText")), ["r2:audioText"]);
  assert.deepEqual(changes.docFields, []);
  assert.equal(S.state.rows[1].audioText, "Second line!");
  assert.notEqual(S.state.rows[1].updatedAt, OLD, "the paragraph's scene is stamped");
  assert.equal(S.state.rows[0].updatedAt, OLD, "no other scene is stamped");
  undo();
  await settle();
  assert.equal(S.state.rows[1].audioText, "Second line");
  writer.closeWriter();
});

test("writer: Enter splits the scene through the session in one undo step", async () => {
  await openInWriter();
  const p = para("r1");
  selectText(p, 5, 5);
  const changes = await throughSession(() => key(p, "Enter"));
  assert.equal(changes.rowsInserted.length, 1);
  assert.equal(S.state.rows.length, 4);
  assert.equal(S.state.rows[1].id, changes.rowsInserted[0]);
  undo();
  await settle();
  assert.deepEqual(ids(), ["r1", "r2", "r3"], "one Ctrl+Z puts the scenes back");
  assert.equal(S.state.rows[0].audioText, "First line");
  writer.closeWriter();
});

test("writer: Backspace at the start of a paragraph joins it to the one before through the session", async () => {
  await openInWriter();
  const p = para("r2");
  selectText(p, 0, 0);
  const changes = await throughSession(() => key(p, "Backspace"));
  assert.deepEqual(changes.rowsRemoved, ["r2"]);
  assert.deepEqual(ids(), ["r1", "r3"]);
  undo();
  await settle();
  assert.deepEqual(ids(), ["r1", "r2", "r3"], "one Ctrl+Z puts the scenes back");
  writer.closeWriter();
});

test("writer: Delete at the end of a paragraph joins the next one through the session", async () => {
  await openInWriter();
  const p = para("r1");
  const end = p.textContent.length;
  selectText(p, end, end);
  const changes = await throughSession(() => key(p, "Delete"));
  assert.deepEqual(changes.rowsRemoved, ["r2"]);
  assert.deepEqual(ids(), ["r1", "r3"]);
  writer.closeWriter();
});

test("writer: the bar's Bold button formats the selection as one edit", async () => {
  await openInWriter();
  const p = para("r1");
  selectText(p, 0, 5);
  S.writerLastCell = p;
  const changes = await throughSession(() => click(document.querySelector('.writer-bar .wr-fmt[data-cmd="bold"]')));
  assert.ok(changes.cells.some((c) => c.rowId === "r1" && c.field === "audioText"));
  assert.match(S.state.rows[0].audioText, /<(b|strong)>First<\/(b|strong)>/);
  undo();
  await settle();
  assert.equal(S.state.rows[0].audioText, "First line");
  writer.closeWriter();
});

test("writer: typing the Writer's title is one set-title edit, mirrored to the main title", async () => {
  await openInWriter();
  const changes = await throughSession(() => typeTitle(writerTitle(), "Writer commands!"));
  assert.deepEqual(changes.docFields, ["title"]);
  assert.deepEqual(changes.cells, []);
  assert.equal(S.state.title, "Writer commands!");
  assert.equal(docTitle().value, "Writer commands!", "the main title shows the same words");
  assert.ok(S.state.rows.every((r) => r.updatedAt === OLD), "a title stamps no scene");
  undo();
  await settle();
  assert.equal(S.state.title, "Writer commands", "one Ctrl+Z puts the title back");
  writer.closeWriter();
});

test("writer: typing the main title is one set-title edit and updates the page title", async () => {
  await open();
  breakUndoCoalescing();
  const changes = await throughSession(() => typeTitle(docTitle(), "Main title"));
  assert.deepEqual(changes.docFields, ["title"]);
  assert.equal(S.state.title, "Main title");
  assert.match(document.title, /Main title/);
  undo();
  await settle();
  assert.equal(S.state.title, "Writer commands");
});

test("writer: an input that leaves the title as it was makes no edit", async () => {
  await openInWriter();
  S.dirty = false;
  untouched(() => typeTitle(writerTitle(), "Writer commands"));
  untouched(() => typeTitle(docTitle(), "Writer commands"));
  assert.equal(S.dirty, false);
  writer.closeWriter();
});

test("writer: a review copy refuses either title, puts the words back and changes nothing", async () => {
  await openInWriter();
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
  flushEdits();
  S.dirty = false;
  untouched(() => typeTitle(writerTitle(), "Not mine"));
  assert.equal(writerTitle().value, "Writer commands");
  writer.closeWriter();
  untouched(() => typeTitle(docTitle(), "Not mine either"));
  assert.equal(docTitle().value, "Writer commands");
  assert.equal(S.dirty, false);
  window.__hostedTest.setSession({ role: "edit", docId: null });
});
