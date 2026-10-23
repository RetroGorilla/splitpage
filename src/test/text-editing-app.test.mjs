import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { saveChanges, unsavedChanges } from "../legacy/save-bridge.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { render } = await import("../js/05-render.js");
const { cellEditing, undoGuard } = await import("../legacy/editor-bridge.ts");
const { undo, redo, undoSizes, lastUndoEntry, flushEdits } = await import("../js/12a-undo.js");
const writer = await import("../js/19-writer.js");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");

after(closeApp);

const realNow = Date.now;
let clock = 1_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const ZW = String.fromCharCode(0x200b);
const cmt = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const KEY = (id) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;
const comment = (id, rowId, field) => ({ id, rowId, field, anchorId: id, quotedText: "", kind: "anchor", text: "note", replies: [] });

function fixture() {
  return {
    schema: 2,
    title: "Text characterisation",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Hello there", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Alpha " + cmt("c1", "bravo charlie") + " delta", status: "ready" },
      { id: "r3", visualText: KEY("bsA") + " gulls", audioText: "Three.", status: "todo" },
      { id: "r4", visualText: "", audioText: "Four " + cmt("c2", "words") + ".", status: "shot" }
    ],
    comments: [comment("c1", "r2", "audioText"), comment("c2", "r4", "audioText")]
  };
}

let opened = 0;
async function open(doc) {
  if (viewFlags().writerOpen()) writer.closeWriter();
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(doc || fixture())))], "text-" + (++opened) + ".splitpage", { lastModified: opened });
  await openProjectFile(file, null, { skipSnapshot: true });
  flushEdits();
}

const settle = () => new Promise((r) => setImmediate(r));
const row = (id) => currentDocument().rows.find((r) => r.id === id);
const cellOf = (id, field, root) => document.querySelector((root || "#rows") + ' .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');
const anchors = () => currentDocument().comments.map((c) => [c.id, c.rowId, c.field]);

function lastText(el) {
  const walker = document.createTreeWalker(el, 4);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  return last;
}

function caretAt(node, offset) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function caretTextOffset(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().split(ZW).join("").length;
}

function input(el, data, extra) {
  el.dispatchEvent(new window.InputEvent("input", Object.assign({ bubbles: true, inputType: "insertText", data }, extra || {})));
}

function typeChar(el, ch, extra) {
  el.focus();
  const node = lastText(el);
  node.data += ch;
  caretAt(node, node.data.length);
  input(el, ch, extra);
}

async function typeWord(el, text, gap) {
  for (const ch of text) {
    clock += gap;
    typeChar(el, ch);
    await settle();
  }
}

function key(el, name, mods) {
  const ev = new window.KeyboardEvent("keydown", Object.assign({ key: name, bubbles: true, cancelable: true }, mods || {}));
  el.dispatchEvent(ev);
  return ev;
}

function clip(type, el, data) {
  const store = Object.assign({}, data || {});
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: { getData: (t) => store[t] || "", setData: (t, v) => { store[t] = v; }, files: [], types: Object.keys(store) }
  });
  el.dispatchEvent(ev);
  return store;
}

function selectText(el, from, to) {
  const walker = document.createTreeWalker(el, 4);
  let at = 0, start = null, end = null;
  while (walker.nextNode()) {
    const n = walker.currentNode, len = n.data.length;
    if (!start && from <= at + len) start = [n, from - at];
    if (!end && to <= at + len) { end = [n, to - at]; break; }
    at += len;
  }
  const r = document.createRange();
  r.setStart(start[0], start[1]);
  r.setEnd(end[0], end[1]);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

beforeEach(() => { clock += 10_000; });

test("a keystroke stores the cell through the run model, stamps the row and advances saveChanges() once", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  const stamp = row("r1").updatedAt;
  const seq = saveChanges();
  clock += 5;
  typeChar(el, "!");
  assert.equal(row("r1").audioText, "Hello there!");
  assert.equal(saveChanges(), seq + 1);
  assert.equal(unsavedChanges(), true);
  assert.notEqual(row("r1").updatedAt, stamp);
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  assert.deepEqual(lastUndoEntry().steps, [{ op: "rowField", rowId: "r1", key: "audioText", before: "Hello there", after: "Hello there!" }]);
});

test("the zero-width caret spot is stripped before storing; an input that only adds one changes nothing", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  const seq = saveChanges();
  el.appendChild(document.createTextNode(ZW));
  input(el, ZW);
  assert.equal(row("r1").audioText, "Hello there");
  assert.equal(saveChanges(), seq);
  lastText(el).data = ZW + "!";
  input(el, "!");
  assert.equal(row("r1").audioText, "Hello there!");
  assert.equal(saveChanges(), seq + 1);
});

test("in a cell ending in a video card, the caret spot after the card is not stored", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  el.innerHTML = 'Hello <a class="video-embed-card" href="https://youtu.be/abc" contenteditable="false">Watch</a>';
  el.appendChild(document.createTextNode(ZW));
  input(el, "");
  assert.match(row("r1").audioText, /^Hello <a class="video-embed-card"/);
  assert.equal(row("r1").audioText.indexOf(ZW), -1);
  assert.match(row("r1").audioText, /<\/a>$/);
});

test("while an undo applies, a cell's input stores nothing", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  const seq = saveChanges();
  undoGuard().whileApplying(() => typeChar(el, "x"));
  assert.equal(row("r1").audioText, "Hello there");
  assert.equal(saveChanges(), seq);
  input(el, "x");
  assert.equal(row("r1").audioText, "Hello therex", "the next input outside the guard stores it");
});

test("a cell no longer in the page stores nothing", async () => {
  await open();
  const el = cellOf("r1", "audioText").cloneNode(true);
  const seq = saveChanges();
  lastText(el).data += "x";
  assert.equal(el.isConnected, false);
  cellEditing().sync(el);
  assert.equal(row("r1").audioText, "Hello there");
  assert.equal(saveChanges(), seq);
});

test("after a keystroke the row's paint record holds the stored field, so the next render repaints no cell", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  typeChar(el, "!");
  const node = lastText(el);
  window.__renderTest.reset();
  render();
  const counts = window.__renderTest.counts();
  assert.equal(counts.render, 1);
  assert.equal(counts.cellsPainted, 0);
  assert.equal(cellOf("r1", "audioText"), el);
  assert.equal(node.isConnected, true, "the text node the caret is in survives");
});

test("typing never repaints the cell: the caret stays in the same text node at the same offset", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  typeChar(el, "!");
  const node = lastText(el);
  typeChar(el, "?");
  assert.equal(lastText(el), node);
  const sel = window.getSelection().getRangeAt(0);
  assert.equal(sel.startContainer, node);
  assert.equal(sel.startOffset, node.data.length);
  assert.equal(caretTextOffset(el), "Hello there!?".length);
});

test("undo puts the caret at the end of what it changed, in the cell it changed", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  selectText(el, 5, 5);
  const node = window.getSelection().getRangeAt(0).startContainer;
  node.data = "Hello, there";
  caretAt(node, 6);
  clock += 5;
  input(el, ",");
  await settle();
  cellOf("r2", "audioText").focus();
  assert.equal(undo().ok, true);
  assert.equal(row("r1").audioText, "Hello there");
  const live = cellOf("r1", "audioText");
  assert.equal(document.activeElement, live);
  assert.equal(caretTextOffset(live), 5);
  assert.equal(redo().ok, true);
  assert.equal(caretTextOffset(cellOf("r1", "audioText")), 6);
});

test("keystrokes in one cell less than 1,000 ms apart are one entry, until a word starts after a space", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  await typeWord(el, "ly", 999);
  assert.equal(undoSizes().undo, 1);
  assert.equal(lastUndoEntry().steps[0].after, "Hello therely");
  await typeWord(el, " ", 300);
  assert.equal(undoSizes().undo, 1, "a space joins the word before it");
  await typeWord(el, "day", 300);
  assert.equal(undoSizes().undo, 2, "the d after the space starts a new entry");
  assert.deepEqual(lastUndoEntry().steps, [{ op: "rowField", rowId: "r1", key: "audioText", before: "Hello therely ", after: "Hello therely day" }]);
  await typeWord(el, "s", 300);
  assert.equal(undoSizes().undo, 2);
  assert.equal(undo().ok, true);
  assert.equal(row("r1").audioText, "Hello therely ");
  assert.equal(undo().ok, true);
  assert.equal(row("r1").audioText, "Hello there");
});

test("a pause of 1,000 ms starts a new entry; 999 ms does not", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  await typeWord(el, "ab", 999);
  assert.equal(undoSizes().undo, 1);
  await typeWord(el, "c", 1000);
  assert.equal(undoSizes().undo, 2);
  assert.equal(lastUndoEntry().steps[0].before, "Hello thereab");
});

test("a keystroke in another cell starts a new entry, and so does coming back", async () => {
  await open();
  await typeWord(cellOf("r1", "audioText"), "a", 10);
  await typeWord(cellOf("r1", "visualText"), "b", 10);
  await typeWord(cellOf("r1", "audioText"), "c", 10);
  assert.equal(undoSizes().undo, 3);
});

test("a change to a media cell's markup that leaves the runs alone stores nothing and records no entry", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  const card = '<a class="video-embed-card" href="https://youtu.be/abc" contenteditable="false">Watch</a>';
  el.innerHTML = "Hello <strong>there</strong> " + card;
  input(el, "");
  await settle();
  const first = row("r1").audioText;
  assert.match(first, /^Hello <strong>there<\/strong> <a class="video-embed-card"/, "a cell holding media is stored as the canonical form of its runs");
  assert.equal(undoSizes().undo, 1);
  const seq = saveChanges();
  const entry = lastUndoEntry();
  clock += 5000;
  el.innerHTML = "Hello <strong>the</strong><strong>re</strong> " + card;
  input(el, "");
  assert.equal(row("r1").audioText, first, "the same runs are the same stored cell");
  assert.equal(saveChanges(), seq);
  await settle();
  assert.equal(undoSizes().undo, 1, "five seconds later a real change would be an entry of its own");
  assert.equal(lastUndoEntry(), entry);
  assert.equal(lastUndoEntry().steps[0].after, first, "and the last entry was not stretched over it");
});

test("during a composition every input stores the composing text at once; the composed word is one entry", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  const seq = saveChanges();
  el.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  clock += 5;
  typeChar(el, "か", { inputType: "insertCompositionText", isComposing: true });
  assert.equal(row("r1").audioText, "Hello thereか");
  await settle();
  const node = lastText(el);
  node.data = "Hello thereかな";
  caretAt(node, node.data.length);
  clock += 5;
  input(el, "かな", { inputType: "insertCompositionText", isComposing: true });
  assert.equal(row("r1").audioText, "Hello thereかな");
  await settle();
  el.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "かな" }));
  assert.equal(saveChanges(), seq + 2, "one per composition update that changed the cell");
  assert.equal(lastText(el), node, "the cell was never repainted under the composition");
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  assert.equal(undo().ok, true);
  assert.equal(row("r1").audioText, "Hello there");
});


function record(run) {
  flushEdits();
  const seq0 = saveChanges();
  const undo0 = undoSizes().undo;
  const top0 = lastUndoEntry();
  window.__renderTest.reset();
  run();
  const seq = saveChanges() - seq0;
  const render = window.__renderTest.counts().render;
  flushEdits();
  const top = lastUndoEntry();
  const steps = top && top !== top0 ? top.steps.map((s) => s.op + ":" + (s.op === "rowField" ? s.rowId + "." + s.key : s.op === "docField" ? s.key : s.row ? s.row.id : "")) : [];
  return { seq, render, undo: undoSizes().undo - undo0, steps };
}

function selectAll(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

const para = (id) => document.querySelector('#writer-doc .wr-para[data-id="' + id + '"]');
const toasts = () => Array.from(document.querySelectorAll("#toast-host .toast")).map((t) => t.textContent);

test("a split (Alt+Enter) through a commented phrase: one entry, one dirty, one render; both halves marked, the comment stays", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 12, 12);
  const stamp = row("r2").updatedAt;
  const got = record(() => key(el, "Enter", { altKey: true }));
  const created = currentDocument().rows[2].id;
  assert.deepEqual(got, { seq: 1, render: 1, undo: 1, steps: ["rowField:r2.audioText", "insertRow:" + created] });
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r2", created, "r3", "r4"]);
  assert.equal(row("r2").audioText, "Alpha " + cmt("c1", "bravo "));
  assert.equal(row(created).audioText, cmt("c1", "charlie") + " delta");
  assert.equal(row(created).status, "todo");
  assert.equal(row(created).visualText, "");
  assert.notEqual(row("r2").updatedAt, stamp);
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
  assert.equal(document.activeElement, cellOf(created, "audioText"));
  assert.equal(caretTextOffset(document.activeElement), 0);
});

test("a split before a commented phrase moves its comment to the new scene in the same entry; one undo puts both back", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 3, 3);
  const got = record(() => key(el, "Enter", { altKey: true }));
  const created = currentDocument().rows[2].id;
  assert.deepEqual(got, { seq: 1, render: 1, undo: 1, steps: ["rowField:r2.audioText", "insertRow:" + created, "docField:comments"] });
  assert.equal(row("r2").audioText, "Alp");
  assert.deepEqual(anchors(), [["c1", created, "audioText"], ["c2", "r4", "audioText"]]);
  assert.equal(undo().ok, true);
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r2", "r3", "r4"]);
  assert.equal(row("r2").audioText, "Alpha " + cmt("c1", "bravo charlie") + " delta");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a Writer join (Backspace at a scene's start): one entry; words glued with a space, status by rank, the comment follows", async () => {
  await open();
  writer.openWriter();
  const p4 = para("r4");
  p4.focus();
  selectText(p4, 0, 0);
  const got = record(() => key(p4, "Backspace"));
  assert.deepEqual(got, { seq: 1, render: 0, undo: 1, steps: ["deleteRow:r4", "rowField:r3.audioText", "rowField:r3.status", "docField:comments"] });
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r2", "r3"]);
  assert.equal(row("r3").audioText, "Three. Four " + cmt("c2", "words") + ".");
  assert.equal(row("r3").status, "shot", "the joined scene takes the further status");
  assert.equal(row("r3").visualText, KEY("bsA") + " gulls");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r3", "audioText"]]);
  assert.equal(document.activeElement, para("r3"));
  assert.equal(caretTextOffset(document.activeElement), "Three.".length, "the caret lands where the two met");
  assert.equal(undo().ok, true);
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r2", "r3", "r4"]);
  assert.equal(row("r3").status, "todo");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
  writer.closeWriter();
});

test("a Writer join of two scenes that both have a visual is refused with a toast and changes nothing", async () => {
  await open();
  writer.openWriter();
  const before = JSON.stringify(currentDocument());
  const p2 = para("r2");
  p2.focus();
  selectText(p2, 0, 0);
  const got = record(() => key(p2, "Backspace"));
  assert.deepEqual(got, { seq: 0, render: 0, undo: 0, steps: [] });
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.equal(toasts().at(-1), "Both scenes have a visual \u2014 join them in the split view, so you can pick which one to keep.");
  writer.closeWriter();
});

test("a Writer split (Enter) before a commented word: one entry, and the comment moves to the new scene", async () => {
  await open();
  writer.openWriter();
  const p4 = para("r4");
  p4.focus();
  selectText(p4, 2, 2);
  const got = record(() => key(p4, "Enter"));
  const created = currentDocument().rows[4].id;
  assert.deepEqual(got, { seq: 1, render: 0, undo: 1, steps: ["rowField:r4.audioText", "insertRow:" + created, "docField:comments"] });
  assert.equal(row("r4").audioText, "Fo");
  assert.equal(row(created).audioText, "ur " + cmt("c2", "words") + ".");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", created, "audioText"]]);
  assert.equal(document.activeElement, para(created));
  assert.equal(caretTextOffset(document.activeElement), 0);
  writer.closeWriter();
});

test("a cut is one entry and one dirty; its comment keeps its last place until the words land again", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  let store;
  const got = record(() => { store = clip("cut", el); });
  assert.deepEqual(got, { seq: 1, render: 0, undo: 1, steps: ["rowField:r2.audioText"] });
  assert.equal(row("r2").audioText, "Alpha  delta");
  assert.equal(store["text/plain"], "bravo charlie");
  assert.match(store["text/html"], /^<span data-splitpage-cut="[0-9a-f]{32}"><span class="cmt-anchor" data-cmt="c1">bravo charlie<\/span><\/span>$/);
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

test("pasting that cut elsewhere is one entry holding the cell and the comment, and dirties once", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const store = clip("cut", el);
  const to = cellOf("r4", "audioText");
  to.focus();
  selectText(to, 11, 11);
  const got = record(() => clip("paste", to, store));
  assert.deepEqual(got, { seq: 1, render: 0, undo: 1, steps: ["rowField:r4.audioText", "docField:comments"] });
  assert.equal(row("r4").audioText, "Four " + cmt("c2", "words") + "." + cmt("c1", "bravo charlie"));
  assert.deepEqual(anchors(), [["c1", "r4", "audioText"], ["c2", "r4", "audioText"]]);
  assert.equal(undo().ok, true);
  assert.equal(row("r4").audioText, "Four " + cmt("c2", "words") + ".");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
  assert.equal(undo().ok, true);
  assert.equal(row("r2").audioText, "Alpha " + cmt("c1", "bravo charlie") + " delta");
});

test("a copied b-roll key pasted onto an empty line gets a fresh id and a shot record of its own", async () => {
  await open();
  const el = cellOf("r3", "visualText");
  el.focus();
  selectAll(el);
  const store = clip("copy", el);
  assert.equal(row("r3").visualText, KEY("bsA") + " gulls", "a copy changes nothing");
  const to = cellOf("r4", "visualText");
  to.focus();
  selectAll(to);
  const got = record(() => clip("paste", to, store));
  assert.deepEqual(got, { seq: 1, render: 0, undo: 1, steps: ["rowField:r4.visualText", "docField:brollShots"] });
  const id = /data-broll-id="([^"]+)"/.exec(row("r4").visualText)[1];
  assert.notEqual(id, "bsA");
  assert.match(id, /^bs[a-z0-9]+$/);
  assert.equal(row("r4").visualText, KEY(id) + " gulls");
  assert.deepEqual(currentDocument().brollShots.map((s) => s.id), ["bsA", id]);
  assert.equal(row("r3").visualText, KEY("bsA") + " gulls");
});

test("a cut b-roll key pasted in the same tab keeps its id and makes no second record", async () => {
  await open();
  const el = cellOf("r3", "visualText");
  el.focus();
  selectAll(el);
  const store = clip("cut", el);
  assert.equal(row("r3").visualText, "");
  const to = cellOf("r4", "visualText");
  to.focus();
  selectAll(to);
  clip("paste", to, store);
  assert.equal(row("r4").visualText, KEY("bsA") + " gulls");
  assert.deepEqual(currentDocument().brollShots.map((s) => s.id), ["bsA"]);
});
test("a Writer join into a scene with no visual takes the later scene's visual and gallery slot, in one entry", async () => {
  const doc = fixture();
  doc.rows[3].visualText = "Drone over the bay";
  doc.rows[3].imageLinks = [{ href: "https://youtu.be/abc" }];
  doc.rows.splice(3, 0, { id: "r3b", visualText: "", audioText: "Bridge.", status: "todo" });
  await open(doc);
  const links = JSON.stringify(row("r4").imageLinks);
  assert.ok(row("r4").imageLinks && row("r4").imageLinks.length === 1, "the fixture's slot survives the load");
  assert.ok(!row("r3b").imageLinks);
  writer.openWriter();
  const p4 = para("r4");
  p4.focus();
  selectText(p4, 0, 0);
  const got = record(() => key(p4, "Backspace"));
  assert.equal(got.seq, 1);
  assert.equal(got.undo, 1);
  assert.ok(got.steps.includes("deleteRow:r4"));
  assert.ok(got.steps.includes("rowField:r3b.visualText"));
  assert.ok(got.steps.includes("rowField:r3b.imageLinks"));
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r2", "r3", "r3b"]);
  assert.equal(row("r3b").visualText, "Drone over the bay");
  assert.equal(JSON.stringify(row("r3b").imageLinks), links);
  assert.equal(row("r3b").audioText, "Bridge. Four " + cmt("c2", "words") + ".");
  assert.equal(row("r3b").status, "shot");
  assert.equal(undo().ok, true);
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r2", "r3", "r3b", "r4"]);
  assert.equal(row("r3b").visualText, "");
  assert.ok(!row("r3b").imageLinks);
  assert.equal(JSON.stringify(row("r4").imageLinks), links);
  writer.closeWriter();
});

test("a Writer join by Delete at a scene's end pulls the next scene up into it, in one entry", async () => {
  await open();
  writer.openWriter();
  const p3 = para("r3");
  p3.focus();
  selectText(p3, "Three.".length, "Three.".length);
  const got = record(() => key(p3, "Delete"));
  assert.deepEqual(got, { seq: 1, render: 0, undo: 1, steps: ["deleteRow:r4", "rowField:r3.audioText", "rowField:r3.status", "docField:comments"] });
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r2", "r3"]);
  assert.equal(row("r3").audioText, "Three. Four " + cmt("c2", "words") + ".");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r3", "audioText"]]);
  assert.equal(document.activeElement, para("r3"));
  assert.equal(caretTextOffset(document.activeElement), "Three.".length);
  assert.equal(undo().ok, true);
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r2", "r3", "r4"]);
  writer.closeWriter();
});

test("leaving a cell and coming back inside 1,000 ms keeps typing in the same entry", async () => {
  await open();
  const a = cellOf("r1", "audioText");
  await typeWord(a, "ab", 100);
  const v = cellOf("r1", "visualText");
  clock += 100;
  v.focus();
  assert.equal(document.activeElement, v);
  clock += 100;
  a.focus();
  await typeWord(a, "c", 100);
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  assert.equal(lastUndoEntry().steps[0].after, "Hello thereabc");
});

test("a composition straight after typing in the same cell joins the typing's entry", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  await typeWord(el, "ab", 100);
  el.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  clock += 100;
  typeChar(el, "\u304B", { inputType: "insertCompositionText", isComposing: true });
  el.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "\u304B" }));
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  assert.equal(lastUndoEntry().steps[0].after, "Hello thereab\u304B");
});

test("any same-tab cut then paste counts one edit in one entry, even with no comment in it", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  el.focus();
  selectText(el, 0, 6);
  const store = clip("cut", el);
  assert.equal(row("r1").audioText, "there");
  assert.doesNotMatch(store["text/html"], /cmt-anchor/);
  const to = cellOf("r3", "audioText");
  to.focus();
  selectText(to, 6, 6);
  const got = record(() => clip("paste", to, store));
  assert.deepEqual(got, { seq: 1, render: 0, undo: 1, steps: ["rowField:r3.audioText"] });
  assert.equal(row("r3").audioText, "Three.Hello ");
});
