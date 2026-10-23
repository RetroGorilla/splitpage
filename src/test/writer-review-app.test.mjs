import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { confirmSavedNow, saveChanges, unsavedChanges } from "../legacy/save-bridge.ts";
import { restoreDesktop, useDesktopForTest } from "../adapters/desktop/desktop-port.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { flushEdits, undoSizes } = await import("../legacy/undo-bridge.ts");
const { currentDocument, liveSession, runCommand, sessionTextPorts, REVIEW_ONLY } = await import("../legacy/session-bridge.ts");
const { joinScenesCommand, splitSceneCommand, textCut } = await import("../application/commands/split-join.ts");
const { htmlToPlainText } = await import("../legacy/plain-text.ts");
const writer = await import("../js/19-writer.js");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");
const { cellEditing } = await import("../legacy/editor-bridge.ts");
const { openDocument } = await import("../legacy/transition-bridge.ts");

after(closeApp);

const realNow = Date.now;
let clock = 1_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const VIEWING_ONLY = "Viewing only — you can comment on this script, but not change it.";

function fixture() {
  return {
    schema: 2,
    title: "Writer in review",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Hello there", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Alpha bravo", status: "ready" },
      { id: "r3", visualText: "", audioText: "Three.", status: "todo" },
      { id: "r4", visualText: "", audioText: "Four.", status: "shot" }
    ]
  };
}

let opened = 0;
async function open() {
  if (viewFlags().writerOpen()) writer.closeWriter();
  window.__hostedTest.setSession({ role: "edit", docId: null });
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(fixture())))], "writer-review-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file: file, handle: null, options: { skipSnapshot: true } });
  flushEdits();
}

const para = (id) => document.querySelector('#writer-doc .wr-para[data-id="' + id + '"]');
const host = () => document.getElementById("toast-host");
const toasts = () => Array.from(host().querySelectorAll(".toast:not(.is-leaving)"));
const settle = () => new Promise((r) => setImmediate(r));

function lastText(el) {
  const walker = document.createTreeWalker(el, 4);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  return last;
}

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
  const start = textNodeAt(el, from), end = textNodeAt(el, to);
  const r = document.createRange();
  r.setStart(start[0], start[1]);
  r.setEnd(end[0], end[1]);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function typeChar(el, ch) {
  el.focus();
  const node = lastText(el);
  node.data += ch;
  const r = document.createRange();
  r.setStart(node, node.data.length);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
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

function toReview() {
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
}

function toEdit() {
  window.__hostedTest.setSession({ role: "edit", docId: null });
}

async function writerInReview() {
  await open();
  writer.openWriter();
  toReview();
  flushEdits();
  confirmSavedNow();
}

function untouched(run) {
  flushEdits();
  host().textContent = "";
  const model = JSON.stringify(currentDocument()), seq = saveChanges(), generation = liveSession().generation(), sizes = undoSizes();
  const out = run();
  flushEdits();
  assert.equal(JSON.stringify(currentDocument()), model, "the document is unchanged");
  assert.equal(saveChanges(), seq, "saveChanges() is unchanged");
  assert.equal(unsavedChanges(), false, "the script is not marked dirty");
  assert.equal(liveSession().generation(), generation, "the session did not change");
  assert.deepEqual(undoSizes(), sizes, "the undo stack is unchanged");
  return out;
}

function oneRefusal() {
  const shown = toasts();
  assert.equal(shown.length, 1, "exactly one toast");
  assert.equal(shown[0].textContent, VIEWING_ONLY);
  assert.ok(shown[0].classList.contains("warn"));
}

beforeEach(() => { clock += 10_000; });

test("a Writer open when the session turns review keeps its paragraphs and title read-only", async () => {
  await writerInReview();
  ["r1", "r2", "r3", "r4"].forEach((id) => assert.equal(para(id).getAttribute("contenteditable"), "false", id));
  assert.equal(document.getElementById("writer-title").readOnly, true);
  assert.equal(viewFlags().writerOpen(), true);
  toEdit();
  ["r1", "r2", "r3", "r4"].forEach((id) => assert.equal(para(id).getAttribute("contenteditable"), "true", id));
  assert.equal(document.getElementById("writer-title").readOnly, false);
  writer.closeWriter();
});

test("typing in the Writer in review mode is refused with one toast and changes nothing", async () => {
  await writerInReview();
  untouched(() => typeChar(para("r1"), "!"));
  oneRefusal();
  assert.equal(currentDocument().rows[0].audioText, "Hello there");
  toEdit();
  writer.closeWriter();
});

test("a beforeinput in a Writer paragraph in review mode is cancelled", async () => {
  await writerInReview();
  const p = para("r1");
  p.focus();
  const ev = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "x" });
  untouched(() => p.dispatchEvent(ev));
  assert.equal(ev.defaultPrevented, true);
  oneRefusal();
  toEdit();
  writer.closeWriter();
});

test("pasting into the Writer in review mode is refused with one toast", async () => {
  await writerInReview();
  const p = para("r2");
  p.focus();
  selectText(p, 5, 5);
  untouched(() => clip("paste", p, { "text/plain": "PASTED", "text/html": "<b>PASTED</b>" }));
  oneRefusal();
  toEdit();
  writer.closeWriter();
});

test("cutting in the Writer in review mode is refused with one toast and keeps the text", async () => {
  await writerInReview();
  const p = para("r2");
  p.focus();
  selectText(p, 0, 5);
  const store = untouched(() => clip("cut", p));
  oneRefusal();
  assert.equal(store["text/plain"], undefined);
  assert.equal(currentDocument().rows[1].audioText, "Alpha bravo");
  toEdit();
  writer.closeWriter();
});

test("copying in the Writer in review mode still works and shows no toast", async () => {
  await writerInReview();
  const p = para("r2");
  p.focus();
  selectText(p, 0, 5);
  const store = untouched(() => clip("copy", p));
  assert.equal(store["text/plain"], "Alpha");
  assert.equal(toasts().length, 0);
  toEdit();
  writer.closeWriter();
});

test("Enter in the Writer in review mode does not split: one toast, no new scene, no undo step", async () => {
  await writerInReview();
  const p = para("r1");
  p.focus();
  selectText(p, 5, 5);
  const ev = untouched(() => key(p, "Enter"));
  assert.equal(ev.defaultPrevented, true);
  oneRefusal();
  assert.equal(currentDocument().rows.length, 4);
  assert.equal(document.querySelectorAll("#writer-doc .wr-para").length, 4);
  toEdit();
  writer.closeWriter();
});

test("Shift+Enter in the Writer in review mode is refused too", async () => {
  await writerInReview();
  const p = para("r1");
  p.focus();
  selectText(p, 5, 5);
  const ev = untouched(() => key(p, "Enter", { shiftKey: true }));
  assert.equal(ev.defaultPrevented, true);
  oneRefusal();
  toEdit();
  writer.closeWriter();
});

test("Backspace at the start and Delete at the end do not join scenes in review mode", async () => {
  await writerInReview();
  const second = para("r3");
  second.focus();
  selectText(second, 0, 0);
  const back = untouched(() => key(second, "Backspace"));
  assert.equal(back.defaultPrevented, true);
  oneRefusal();
  clock += 3_000;
  const first = para("r1");
  first.focus();
  selectText(first, 11, 11);
  const del = untouched(() => key(first, "Delete"));
  assert.equal(del.defaultPrevented, true);
  oneRefusal();
  assert.equal(currentDocument().rows.length, 4);
  toEdit();
  writer.closeWriter();
});

test("Ctrl+B and the Bold button in the Writer in review mode do not format", async () => {
  await writerInReview();
  const p = para("r2");
  p.focus();
  selectText(p, 0, 5);
  const ev = untouched(() => key(p, "b", { ctrlKey: true }));
  assert.equal(ev.defaultPrevented, true);
  oneRefusal();
  clock += 3_000;
  selectText(p, 0, 5);
  untouched(() => document.querySelector('.writer-bar .wr-fmt[data-cmd="bold"]').click());
  oneRefusal();
  assert.equal(currentDocument().rows[1].audioText, "Alpha bravo");
  toEdit();
  writer.closeWriter();
});

test("Ctrl+Z and Ctrl+Y in the Writer in review mode refuse and leave the undo stack alone", async () => {
  await open();
  writer.openWriter();
  clock += 10_000;
  typeChar(para("r1"), "!");
  flushEdits();
  assert.equal(currentDocument().rows[0].audioText, "Hello there!");
  toReview();
  flushEdits();
  confirmSavedNow();
  const p = para("r1");
  p.focus();
  const undone = untouched(() => key(p, "z", { ctrlKey: true }));
  assert.equal(undone.defaultPrevented, true);
  oneRefusal();
  clock += 3_000;
  const redone =untouched(() => key(p, "y", { ctrlKey: true }));
  assert.equal(redone.defaultPrevented, true);
  oneRefusal();
  assert.equal(currentDocument().rows[0].audioText, "Hello there!");
  assert.equal(viewFlags().writerOpen(), true);
  toEdit();
  writer.closeWriter();
});

test("the Writer title in review mode cannot be edited", async () => {
  await writerInReview();
  const title = document.getElementById("writer-title");
  untouched(() => {
    title.value = "Renamed";
    title.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  oneRefusal();
  assert.equal(currentDocument().title, "Writer in review");
  assert.equal(document.getElementById("doc-title").value, "Writer in review");
  toEdit();
  writer.closeWriter();
});

test("a burst of refused edits shows one toast, and a later attempt after a pause shows another", async () => {
  await writerInReview();
  const p = para("r1");
  p.focus();
  host().textContent = "";
  for (let i = 0; i < 6; i++) { clock += 300; key(p, "Enter"); }
  assert.equal(toasts().length, 1);
  clock += 2_000;
  key(p, "Backspace");
  assert.equal(toasts().length, 1, "still the same burst: an attempt exactly two seconds after the last joins it");
  clock += 1_999;
  key(p, "Enter");
  assert.equal(toasts().length, 1, "and each attempt keeps the burst going");
  clock += 2_001;
  key(p, "Enter");
  assert.equal(toasts().length, 2, "more than two seconds after the last attempt starts a new burst");
  toEdit();
  writer.closeWriter();
});

test("every other edit chord and a typed character are refused as edits, each with the default cancelled", async () => {
  await writerInReview();
  const p = para("r1");
  p.focus();
  const attempts = [
    ["i", { ctrlKey: true }], ["u", { metaKey: true }], ["Z", { ctrlKey: true, shiftKey: true }],
    ["ArrowUp", { altKey: true }], ["ArrowDown", { altKey: true }], ["a", {}], ["7", {}], ["?", { shiftKey: true }],
    ["Delete", {}], ["Enter", { altKey: true }], ["Enter", { ctrlKey: true }]
  ];
  attempts.forEach(([name, mods]) => {
    clock += 3_000;
    const ev = untouched(() => key(p, name, mods));
    assert.equal(ev.defaultPrevented, true, name + " " + JSON.stringify(mods));
    oneRefusal();
  });
  toEdit();
  writer.closeWriter();
});

test("the refusal wording is the one the split view gives for a blocked edit", async () => {
  const hosted = await import("../js/13-hosted.js");
  assert.equal(hosted.VIEWING_ONLY, VIEWING_ONLY);
});

test("clicking a scene's gutter in the Writer in review mode still jumps to it, with no toast", async () => {
  await writerInReview();
  host().textContent = "";
  document.querySelector('#writer-doc .wr-gutter[data-action="writer-jump"]').click();
  assert.equal(viewFlags().writerOpen(), false);
  assert.equal(toasts().length, 0);
  toEdit();
});

test("navigation and selection keys in the Writer in review mode are not edits: no toast", async () => {
  await writerInReview();
  const p = para("r1");
  p.focus();
  host().textContent = "";
  ["ArrowLeft", "ArrowDown", "Home", "End", "PageDown", "Shift", " "].forEach((name) => key(p, name));
  key(p, "a", { ctrlKey: true });
  key(p, "c", { ctrlKey: true });
  key(p, "a", { metaKey: true });
  key(p, "c", { metaKey: true });
  assert.equal(toasts().length, 0);
  toEdit();
  writer.closeWriter();
});

test("the Writer's other controls keep working in review mode: no toast and no cancelled default", async () => {
  await writerInReview();
  host().textContent = "";
  const close = document.getElementById("wr-close");
  const enter = key(close, "Enter");
  assert.equal(enter.defaultPrevented, false);
  const size = document.getElementById("wr-size");
  const typed = new window.KeyboardEvent("keydown", { key: "5", bubbles: true, cancelable: true });
  size.dispatchEvent(typed);
  assert.equal(typed.defaultPrevented, false);
  const bar = new window.Event("input", { bubbles: true, cancelable: true });
  size.dispatchEvent(bar);
  assert.equal(toasts().length, 0);
  toEdit();
  writer.closeWriter();
});

test("a Writer split in review mode with the Writer open is refused: one toast, no scene, no undo step", async () => {
  await writerInReview();
  const p = para("r1");
  p.focus();
  selectText(p, 5, 5);
  untouched(() => key(p, "Enter"));
  oneRefusal();
  assert.equal(currentDocument().rows.length, 4);
  toEdit();
  writer.closeWriter();
});

test("the split and join commands themselves are rejected by the session in review mode", async () => {
  await writerInReview();
  const before = JSON.stringify(currentDocument());
  const split = runCommand(splitSceneCommand("r1", "audioText", textCut(5, 5), "new-row", sessionTextPorts));
  assert.deepEqual(split, { kind: "rejected", reason: REVIEW_ONLY });
  const join = runCommand(joinScenesCommand("r3", Object.assign({}, sessionTextPorts, { plainText: htmlToPlainText })));
  assert.deepEqual(join, { kind: "rejected", reason: REVIEW_ONLY });
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.equal(unsavedChanges(), false);
  toEdit();
  writer.closeWriter();
});

test("back in edit mode the Writer types, splits and formats again", async () => {
  await writerInReview();
  toEdit();
  const p = para("r1");
  p.focus();
  host().textContent = "";
  typeChar(p, "!");
  flushEdits();
  assert.equal(currentDocument().rows[0].audioText, "Hello there!");
  selectText(para("r1"), 5, 5);
  key(para("r1"), "Enter");
  assert.equal(currentDocument().rows.length, 5);
  assert.equal(toasts().length, 0);
  await settle();
  writer.closeWriter();
});

const removedWhileFocused = [];

function focusOutOnRemoval() {
  const doc = document.getElementById("writer-doc");
  const inner = Object.getOwnPropertyDescriptor(window.Element.prototype, "innerHTML");
  Object.defineProperty(doc, "innerHTML", {
    configurable: true,
    get() { return inner.get.call(this); },
    set(value) {
      const active = document.activeElement;
      if (active && active !== this && this.contains(active)) {
        removedWhileFocused.push({ connected: active.isConnected, text: active.textContent });
        active.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
      }
      inner.set.call(this, value);
    }
  });
  return () => { delete doc.innerHTML; };
}

function composeInto(p, text, opts) {
  const ends = !opts || opts.end !== false;
  removedWhileFocused.length = 0;
  const restore = focusOutOnRemoval();
  try {
    p.setAttribute("contenteditable", "true");
    p.focus();
    p.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    const node = lastText(p);
    node.data += text;
    const r = document.createRange();
    r.setStart(node, node.data.length);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    p.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: text, isComposing: true }));
    if (!ends) return;
    const now = para(p.getAttribute("data-id"));
    now.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: text }));
  } finally {
    restore();
  }
}

const COMPOSED = String.fromCharCode(0x3042);

test("composition text that lands in a Writer paragraph not yet redrawn read-only is put back, so a focusout saves nothing", async () => {
  await writerInReview();
  untouched(() => {
    composeInto(para("r1"), COMPOSED);
    para("r1").dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  });
  assert.equal(currentDocument().rows[0].audioText, "Hello there");
  assert.equal(para("r1").textContent, "Hello there");
  assert.equal(para("r1").getAttribute("contenteditable"), "false");
  toEdit();
  writer.closeWriter();
});

test("composition text that lands in a Writer paragraph not yet redrawn read-only is put back, so closing the Writer saves nothing", async () => {
  await writerInReview();
  untouched(() => {
    composeInto(para("r2"), COMPOSED);
    writer.closeWriter();
  });
  assert.equal(viewFlags().writerOpen(), false);
  assert.equal(currentDocument().rows[1].audioText, "Alpha bravo");
  toEdit();
});

test("a refused composition whose redraw fires focusout on the removed paragraph, as Chromium does, saves nothing", async () => {
  await writerInReview();
  untouched(() => composeInto(para("r1"), COMPOSED, { end: false }));
  assert.deepEqual(removedWhileFocused, [{ connected: true, text: "Hello there" + COMPOSED }], "the old paragraph got a focusout while connected, holding the composed text");
  oneRefusal();
  assert.equal(currentDocument().rows[0].audioText, "Hello there");
  assert.equal(para("r1").textContent, "Hello there");
  assert.equal(para("r1").getAttribute("contenteditable"), "false");
  toEdit();
  writer.closeWriter();
});

test("in review mode, a Writer paragraph whose text differs from the model is not saved by a direct sync, a focusout or closing the Writer", async () => {
  await writerInReview();
  const p = para("r2");
  p.innerHTML = "Alpha bravo CHANGED";
  untouched(() => cellEditing().sync(p));
  untouched(() => p.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })));
  p.setAttribute("contenteditable", "true");
  p.focus();
  untouched(() => writer.closeWriter());
  assert.equal(viewFlags().writerOpen(), false);
  assert.equal(currentDocument().rows[1].audioText, "Alpha bravo");
  toEdit();
});

test("in review mode, a grid cell whose text or formatting differs from the model is not saved by a focusout or a direct sync", async () => {
  await open();
  toReview();
  flushEdits();
  confirmSavedNow();
  const cell = document.querySelector('#rows .cell-editable[data-id="r1"][data-field="audioText"]');
  cell.innerHTML = "Hello there CHANGED";
  untouched(() => cell.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })));
  cell.innerHTML = "Hello <strong>there</strong>";
  untouched(() => cellEditing().sync(cell));
  assert.equal(currentDocument().rows[0].audioText, "Hello there");
  toEdit();
});

test("in review mode, a comment anchor reaching the grid through the same sync is still stored", async () => {
  await open();
  toReview();
  flushEdits();
  const cell = document.querySelector('#rows .cell-editable[data-id="r1"][data-field="audioText"]');
  const generation = liveSession().generation();
  cell.innerHTML = 'Hello <span class="cmt-anchor" data-cmt="c-review">there</span>';
  cellEditing().sync(cell);
  assert.equal(currentDocument().rows[0].audioText, 'Hello <span class="cmt-anchor" data-cmt="c-review">there</span>');
  assert.equal(liveSession().generation(), generation + 1);
  toEdit();
});

test("in review mode, an input on the grid's title does not rename the script and gives the title back", async () => {
  await open();
  toReview();
  flushEdits();
  confirmSavedNow();
  const title = document.getElementById("doc-title");
  untouched(() => {
    title.value = "Renamed";
    title.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(title.value, "Writer in review");
  assert.equal(currentDocument().title, "Writer in review");
  toEdit();
});

test("a refused composition in the Writer title not yet redrawn read-only gives the title back from the model", async () => {
  await writerInReview();
  const title = document.getElementById("writer-title");
  title.readOnly = false;
  title.focus();
  assert.equal(document.activeElement, title);
  untouched(() => {
    title.value = "Writer in review" + COMPOSED;
    title.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: COMPOSED, isComposing: true }));
  });
  oneRefusal();
  assert.equal(title.value, "Writer in review");
  assert.equal(title.readOnly, true);
  assert.equal(currentDocument().title, "Writer in review");
  assert.equal(document.getElementById("doc-title").value, "Writer in review");
  toEdit();
  writer.closeWriter();
});

test("cutting and pasting with the selection inside bold text in the Writer in review mode are refused", async () => {
  await writerInReview();
  const p = para("r2");
  p.innerHTML = "Alpha <b>bravo</b>";
  const bold = p.querySelector("b");
  p.focus();
  selectText(p, 7, 10);
  const cutStore = untouched(() => clip("cut", bold));
  oneRefusal();
  assert.equal(cutStore["text/plain"], undefined);
  clock += 3_000;
  selectText(p, 7, 10);
  untouched(() => clip("paste", bold, { "text/plain": "PASTED", "text/html": "<i>PASTED</i>" }));
  oneRefusal();
  assert.equal(currentDocument().rows[1].audioText, "Alpha bravo");
  toEdit();
  writer.closeWriter();
});

test("the gutter-mode and export buttons keep working in the Writer in review mode: no toast", async () => {
  await writerInReview();
  const writerEl = document.getElementById("writer");
  const before = writerEl.getAttribute("data-gutter");
  host().textContent = "";
  document.getElementById("wr-gutter-mode").click();
  assert.notEqual(writerEl.getAttribute("data-gutter"), before);
  assert.equal(toasts().length, 0);
  document.getElementById("wr-gutter-mode").click();
  document.getElementById("wr-gutter-mode").click();
  assert.equal(writerEl.getAttribute("data-gutter"), before);
  let asked = 0;
  useDesktopForTest({ saveFileDialog: async () => { asked++; return null; } });
  try {
    document.getElementById("wr-export").click();
    for (let i = 0; i < 400 && !asked; i++) await settle();
  } finally {
    restoreDesktop();
  }
  assert.equal(asked, 1);
  assert.equal(toasts().length, 0);
  toEdit();
  writer.closeWriter();
});
