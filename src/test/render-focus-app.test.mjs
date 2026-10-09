import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { applyMerge, cloneState } = await import("../js/03-sync.js");
const { renderAbsorbed, renderRow } = await import("../js/05-render.js");
const { flushEdits, undoSizes } = await import("../js/12a-undo.js");
const { clearDirty } = await import("../js/12-dirty-toast.js");
const { liveSession } = await import("../legacy/session-bridge.ts");
const writer = await import("../js/19-writer.js");

after(closeApp);

const realNow = Date.now;
let clock = 5_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const session = liveSession();
const published = [];
session.subscribe((c) => published.push(c.kind));

const REDRAW = "Could not redraw the script after the update. Nothing was lost — press Redraw before you keep editing.";

function fixture(title) {
  return {
    schema: 2,
    title: title,
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Mine one.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Mine two.", status: "ready" },
      { id: "r3", visualText: "", audioText: "Mine three.", status: "todo" }
    ]
  };
}

function fresh(title) {
  if (writer.writerOpen) writer.closeWriter();
  window.__hostedTest.setSession({ role: "edit", docId: null });
  clock += 10_000;
  S.state = migrateRows(fixture(title));
  flushEdits();
  renderAbsorbed();
  clearDirty();
  document.getElementById("toast-host").textContent = "";
  return S.state;
}

const para = (id) => document.querySelector('#writer-doc .wr-para[data-id="' + id + '"]');
const gridCell = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + (field || "audioText") + '"]');
const audio = (id) => S.state.rows.find((r) => r.id === id).audioText;

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

function caretAt(el, offset) {
  el.focus();
  const [node, at] = textNodeAt(el, offset);
  const r = document.createRange();
  r.setStart(node, at);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function caretOffset(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) return null;
  const probe = document.createRange();
  probe.selectNodeContents(el);
  probe.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return probe.toString().length;
}

const removals = [];

function chromiumRemoval(run) {
  const proto = window.Element.prototype;
  const nodeProto = window.Node.prototype;
  const inner = Object.getOwnPropertyDescriptor(proto, "innerHTML");
  const replaceChild = nodeProto.replaceChild;
  const removeChild = nodeProto.removeChild;
  function leaving(subtree) {
    const active = document.activeElement;
    if (!active || active === document.body || !subtree || !subtree.contains || !subtree.contains(active)) return;
    removals.push({ id: active.getAttribute && active.getAttribute("data-id"), connected: active.isConnected, text: active.textContent });
    active.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  }
  Object.defineProperty(proto, "innerHTML", {
    configurable: true,
    get() { return inner.get.call(this); },
    set(value) {
      const active = document.activeElement;
      if (active && active !== this && this.contains(active)) leaving(this);
      inner.set.call(this, value);
    }
  });
  nodeProto.replaceChild = function (fresh, old) { leaving(old); return replaceChild.call(this, fresh, old); };
  nodeProto.removeChild = function (child) { leaving(child); return removeChild.call(this, child); };
  removals.length = 0;
  try {
    return run();
  } finally {
    Object.defineProperty(proto, "innerHTML", inner);
    nodeProto.replaceChild = replaceChild;
    nodeProto.removeChild = removeChild;
  }
}

function observe(run) {
  flushEdits();
  const seq = S.editSeq, generation = session.generation(), sizes = undoSizes();
  published.length = 0;
  const value = chromiumRemoval(run);
  flushEdits();
  return {
    value: value,
    edits: published.filter((k) => k === "edit").length,
    seq: S.editSeq - seq,
    generation: session.generation() - generation,
    undo: undoSizes().undo - sizes.undo
  };
}

const NO_EDIT = { edits: 0, seq: 0, generation: 0, undo: 0 };
const noEdit = (got) => ({ edits: got.edits, seq: got.seq, generation: got.generation, undo: got.undo });

function merge(theirs) {
  return applyMerge({ theirs: theirs, source: "server-conflict", unchanged: true, report: false });
}

test("an update drawn while a Writer paragraph has focus keeps the incoming text, makes no edit and leaves the caret where it was in the Writer (#477)", () => {
  const doc = fresh("Writer focus");
  writer.openWriter();
  caretAt(para("r2"), 4);
  const theirs = cloneState(doc);
  theirs.rows[0].audioText = "Theirs one.";
  theirs.rows[1].audioText = "Theirs two.";
  const got = observe(() => merge(theirs));
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.equal(audio("r1"), "Theirs one.");
  assert.equal(audio("r2"), "Theirs two.");
  assert.equal(S.dirty, false);
  assert.ok(removals.some((r) => r.id === "r2" && r.text === "Mine two."), "the old paragraph lost focus while it held the old text");
  const active = document.activeElement;
  assert.equal(active, para("r2"), "the focus stays in the Writer, on the same scene");
  assert.equal(active.textContent, "Theirs two.");
  assert.equal(caretOffset(active), 4);
  assert.equal(gridCell("r2").textContent, "Theirs two.");
  writer.closeWriter();
});

test("an update drawn while a grid cell has focus keeps the incoming text in that cell, makes no edit and keeps the focus on the redrawn cell (#477)", () => {
  const doc = fresh("Grid focus");
  caretAt(gridCell("r1"), 3);
  const theirs = cloneState(doc);
  theirs.rows[0].audioText = "Theirs one, longer.";
  const got = observe(() => merge(theirs));
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.equal(audio("r1"), "Theirs one, longer.");
  assert.equal(S.dirty, false);
  assert.ok(removals.some((r) => r.id === "r1" && r.connected && r.text === "Mine one."), "the old cell lost focus while it held the old text");
  const active = document.activeElement;
  assert.equal(active, gridCell("r1"));
  assert.equal(active.textContent, "Theirs one, longer.");
  assert.equal(caretOffset(active), "Theirs one, longer.".length);
});

test("an update that removes the focused scene makes no edit, in the grid and in the Writer (#477)", () => {
  const doc = fresh("Removed in grid");
  caretAt(gridCell("r2"), 2);
  const theirs = cloneState(doc);
  theirs.rows.splice(1, 1);
  theirs.rows[0].audioText = "Theirs one.";
  assert.deepEqual(noEdit(observe(() => merge(theirs))), NO_EDIT);
  assert.deepEqual(S.state.rows.map((r) => r.id), ["r1", "r3"]);
  assert.equal(audio("r1"), "Theirs one.");
  assert.equal(gridCell("r2"), null);

  const doc2 = fresh("Removed in Writer");
  writer.openWriter();
  caretAt(para("r2"), 2);
  const theirs2 = cloneState(doc2);
  theirs2.rows.splice(1, 1);
  theirs2.rows[1].audioText = "Theirs three.";
  assert.deepEqual(noEdit(observe(() => merge(theirs2))), NO_EDIT);
  assert.deepEqual(S.state.rows.map((r) => r.id), ["r1", "r3"]);
  assert.equal(audio("r3"), "Theirs three.");
  assert.equal(para("r2"), null);
  assert.ok(!document.activeElement.closest("#rows"), "the focus is not moved into the hidden grid");
  writer.closeWriter();
});

test("a Writer redraw on its own does not write the focused paragraph's old text over the model (#477)", () => {
  fresh("Writer redraw");
  writer.openWriter();
  caretAt(para("r1"), 2);
  S.state.rows[0].audioText = "Changed under the Writer.";
  const got = observe(() => writer.renderWriter());
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.equal(audio("r1"), "Changed under the Writer.");
  assert.equal(document.activeElement, para("r1"));
  assert.equal(para("r1").textContent, "Changed under the Writer.");
  writer.closeWriter();
});

test("a single-row redraw does not write the focused cell's old text over the model (#477)", () => {
  fresh("Row redraw");
  caretAt(gridCell("r2"), 2);
  S.state.rows[1].audioText = "Changed under the cell.";
  const got = observe(() => renderRow("r2"));
  assert.equal(got.value, true);
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.equal(audio("r2"), "Changed under the cell.");
  assert.equal(gridCell("r2").textContent, "Changed under the cell.");
});

test("a render that throws between the grid and the Writer makes no edit, and typing after Redraw is saved again (#477)", () => {
  const doc = fresh("Throw mid-render");
  writer.openWriter();
  caretAt(para("r2"), 3);
  const theirs = cloneState(doc);
  theirs.rows[1].audioText = "Theirs two.";
  const box = document.getElementById("doc-title");
  const real = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  Object.defineProperty(box, "value", { configurable: true, get() { return real.get.call(this); }, set() { throw new Error("render broke (#477)"); } });
  const consoles = [...new Set([window.console, globalThis.console])];
  const was = consoles.map((c) => c.error);
  const logged = [];
  consoles.forEach((c) => { c.error = (e) => { logged.push((e && e.message) || String(e)); }; });
  let got;
  try {
    got = observe(() => merge(theirs));
  } finally {
    delete box.value;
    consoles.forEach((c, i) => { c.error = was[i]; });
  }
  assert.deepEqual(logged, ["render broke (#477)"]);
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.equal(audio("r2"), "Theirs two.");
  const toast = Array.from(document.querySelectorAll("#toast-host .toast:not(.is-leaving)"))
    .find((el) => el.firstChild && el.firstChild.nodeValue === REDRAW);
  assert.ok(toast, "the redraw toast is offered");
  toast.querySelector(".toast-action").click();
  assert.equal(para("r2").textContent, "Theirs two.");
  const p = para("r2");
  caretAt(p, "Theirs two.".length);
  const typed = observe(() => {
    const [node] = textNodeAt(p, "Theirs two.".length);
    node.data += "!";
    caretAt(p, "Theirs two.!".length);
    p.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "!" }));
  });
  assert.equal(typed.edits, 1, "typing after the redraw is an edit again");
  assert.equal(audio("r2"), "Theirs two.!");
  const blurred = observe(() => {
    const [node] = textNodeAt(p, "Theirs two.!".length);
    node.data += "?";
    p.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  });
  assert.equal(blurred.edits, 1, "a focusout after the redraw saves the cell again");
  assert.equal(audio("r2"), "Theirs two.!?");
  writer.closeWriter();
});
