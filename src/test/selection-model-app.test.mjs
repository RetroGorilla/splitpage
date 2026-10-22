import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { cloneState } from "../core/document/clone.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { applyMerge } = await import("../js/03-sync.js");
const { renderAbsorbed, renderRow } = await import("../js/05-render.js");
const { posToDom } = await import("../js/05b-cell-edit.js");
const { domToPos } = await import("../features/editing/cell-dom.ts");
const { flushEdits, undoSizes } = await import("../js/12a-undo.js");
const { clearDirty } = await import("../js/12-dirty-toast.js");
const { closeCommandMenu, openCommandMenu } = await import("../js/18d-command-menu.js");
const { liveSession } = await import("../legacy/session-bridge.ts");
const writer = await import("../js/19-writer.js");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

const realNow = Date.now;
let clock = 7_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const session = liveSession();

function fixture(title) {
  return {
    schema: 2,
    title: title,
    rows: [
      { id: "r1", visualText: "Wide", audioText: "First one.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Mine two words.", status: "ready" },
      { id: "r3", visualText: "", audioText: "Third three.", status: "todo" }
    ]
  };
}

function fresh(title) {
  if (writer.writerOpen) writer.closeWriter();
  window.__hostedTest.setSession({ role: "edit", docId: null });
  clock += 10_000;
  loadTestDocument(migrateRows(fixture(title)));
  flushEdits();
  renderAbsorbed();
  clearDirty();
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  return S.state;
}

const para = (id) => document.querySelector('#writer-doc .wr-para[data-id="' + id + '"]');
const gridCell = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + (field || "audioText") + '"]');
const audio = (id) => S.state.rows.find((r) => r.id === id).audioText;

function select(el, anchor, head = anchor) {
  el.focus();
  const a = posToDom(el, anchor);
  const h = posToDom(el, head);
  window.getSelection().setBaseAndExtent(a.node, a.offset, h.node, h.offset);
}

function selectionIn(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return null;
  return { anchor: domToPos(el, sel.anchorNode, sel.anchorOffset), head: domToPos(el, sel.focusNode, sel.focusOffset) };
}

function merge(theirs) {
  return applyMerge({ theirs: theirs, source: "server-conflict", unchanged: true, report: false });
}

function observe(run) {
  flushEdits();
  const generation = session.generation(), sizes = undoSizes();
  const value = run();
  flushEdits();
  return { value: value, generation: session.generation() - generation, undo: undoSizes().undo - sizes.undo, dirty: S.dirty };
}

const NO_EDIT = { generation: 0, undo: 0, dirty: false };
const noEdit = (got) => ({ generation: got.generation, undo: got.undo, dirty: got.dirty });

test("#464: a collaborator's words added before the caret move it along with the text it sat in, in the grid", () => {
  const doc = fresh("Before the caret");
  select(gridCell("r2"), 5);
  const theirs = cloneState(doc);
  theirs.rows[1].audioText = "Their intro. Mine two words.";
  assert.deepEqual(noEdit(observe(() => merge(theirs))), NO_EDIT);
  assert.equal(audio("r2"), "Their intro. Mine two words.");
  assert.equal(document.activeElement, gridCell("r2"));
  assert.deepEqual(selectionIn(gridCell("r2")), { anchor: 18, head: 18 }, "still just before \"two\"");
});

test("#464: a line break and a b-roll key added before the caret each count as one position", () => {
  const doc = fresh("Break and key");
  select(gridCell("r2"), 9);
  const theirs = cloneState(doc);
  theirs.rows[1].audioText = "Mine<br>two words.";
  merge(theirs);
  assert.deepEqual(selectionIn(gridCell("r2")), { anchor: 9, head: 9 }, "a space became a line break: the caret stays before \"words\"");
  select(gridCell("r2"), 9);
  const again = cloneState(S.state);
  again.rows[1].audioText = '<span class="broll-key" data-broll-id="bs7" contenteditable="false">B-roll:</span> Mine<br>two words.';
  again.brollShots = [{ id: "bs7", name: "", origin: "script" }];
  merge(again);
  assert.match(audio("r2"), /broll-key/);
  assert.equal(document.activeElement, gridCell("r2"));
  assert.deepEqual(selectionIn(gridCell("r2")), { anchor: 11, head: 11 },
    "the key, its space, \"Mine\", the line break and \"two \": still just before \"words\"");
});

test("#464: a backward selection keeps its words and its direction when the update changes other words of the cell", () => {
  const doc = fresh("Backward selection");
  select(gridCell("r2"), 14, 9);
  const theirs = cloneState(doc);
  theirs.rows[1].audioText = "Now Mine two words.";
  merge(theirs);
  assert.equal(document.activeElement, gridCell("r2"));
  assert.deepEqual(selectionIn(gridCell("r2")), { anchor: 18, head: 13 });
  assert.equal(window.getSelection().toString(), "words");
});

test("#464: a selection whose words the collaborator changed collapses to its head, so the next keystroke cannot type over their words", () => {
  const doc = fresh("Changed selection");
  select(gridCell("r2"), 5, 14);
  const theirs = cloneState(doc);
  theirs.rows[1].audioText = "Mine two other words.";
  merge(theirs);
  assert.deepEqual(selectionIn(gridCell("r2")), { anchor: 20, head: 20 }, "collapsed after \"words\", where the head was");
  assert.equal(window.getSelection().isCollapsed, true);
});

test("#464: in the Writer, the caret maps through the update in the Writer paragraph and not by its old offset", () => {
  const doc = fresh("Writer caret");
  writer.openWriter();
  select(para("r2"), 9);
  const theirs = cloneState(doc);
  theirs.rows[1].audioText = "Their intro. Mine two words.";
  assert.deepEqual(noEdit(observe(() => merge(theirs))), NO_EDIT);
  assert.equal(document.activeElement, para("r2"));
  assert.deepEqual(selectionIn(para("r2")), { anchor: 22, head: 22 }, "still just before \"words\"");
  assert.ok(!document.activeElement.closest("#rows"));
  writer.closeWriter();
});

test("#464: when the update removes the selected scene, the caret goes to the end of the scene before it, in the same surface", () => {
  const doc = fresh("Vanished scene");
  select(gridCell("r2"), 4);
  const theirs = cloneState(doc);
  theirs.rows.splice(1, 1);
  assert.deepEqual(noEdit(observe(() => merge(theirs))), NO_EDIT);
  assert.equal(document.activeElement, gridCell("r1"));
  assert.deepEqual(selectionIn(gridCell("r1")), { anchor: 10, head: 10 });

  const doc2 = fresh("Vanished in the Writer");
  writer.openWriter();
  select(para("r2"), 4);
  const theirs2 = cloneState(doc2);
  theirs2.rows.splice(1, 1);
  merge(theirs2);
  assert.equal(document.activeElement, para("r1"));
  assert.deepEqual(selectionIn(para("r1")), { anchor: 10, head: 10 });
  writer.closeWriter();
});

test("#464: when the update joins the selected scene into the one before it, the caret follows its words into the joined scene", () => {
  const doc = fresh("Joined");
  select(gridCell("r2"), 9);
  const theirs = cloneState(doc);
  theirs.rows[0].audioText = "First one. Mine two words.";
  theirs.rows.splice(1, 1);
  merge(theirs);
  assert.equal(document.activeElement, gridCell("r1"));
  assert.deepEqual(selectionIn(gridCell("r1")), { anchor: 20, head: 20 });
});

test("#464: when the update splits the selected scene before the caret, the caret moves into the new scene", () => {
  const doc = fresh("Split");
  select(gridCell("r2"), 12);
  const theirs = cloneState(doc);
  theirs.rows[1].audioText = "Mine two ";
  theirs.rows.splice(2, 0, { id: "r9", visualText: "", audioText: "words.", status: "todo" });
  merge(theirs);
  assert.deepEqual(S.state.rows.map((r) => r.id), ["r1", "r2", "r9", "r3"]);
  assert.equal(document.activeElement, gridCell("r9"));
  assert.deepEqual(selectionIn(gridCell("r9")), { anchor: 3, head: 3 });
});

test("#464: a scene redrawn on its own keeps the caret mapped in that scene", () => {
  fresh("Row redraw");
  select(gridCell("r2"), 5);
  S.state.rows[1].audioText = "So Mine two words.";
  assert.equal(renderRow("r2"), true);
  assert.equal(document.activeElement, gridCell("r2"));
  assert.deepEqual(selectionIn(gridCell("r2")), { anchor: 8, head: 8 });
});

test("#464: a selection belongs to its document: a new document with the same scene ids gets no caret from the old one", () => {
  fresh("Old document");
  select(gridCell("r2"), 5);
  const next = migrateRows(fixture("New document"));
  next.rows[1].audioText = "Another script entirely.";
  loadTestDocument(next);
  flushEdits();
  renderAbsorbed();
  assert.equal(audio("r2"), "Another script entirely.");
  assert.ok(!gridCell("r2").contains(window.getSelection().focusNode) || document.activeElement !== gridCell("r2"),
    "the old caret was not put into the new document");
});

test("#464: focus and selection are separate: the command menu holds the focus while an update redraws the cell, and closing it puts the mapped caret back", () => {
  const doc = fresh("Menu over the editor");
  select(gridCell("r2"), 5);
  assert.equal(openCommandMenu(), true);
  assert.equal(document.activeElement.id, "cmdk-input");
  const theirs = cloneState(doc);
  theirs.rows[1].audioText = "Their intro. Mine two words.";
  merge(theirs);
  assert.equal(document.activeElement.id, "cmdk-input", "the redraw did not take the focus from the menu");
  closeCommandMenu();
  assert.equal(document.activeElement, gridCell("r2"));
  assert.deepEqual(selectionIn(gridCell("r2")), { anchor: 18, head: 18 });
});
