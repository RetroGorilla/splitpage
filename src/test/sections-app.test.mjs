import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();
after(closeApp);

const { currentDocument } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { viewFlags } = await import("../bootstrap/wiring/preferences-owner.ts");
const { sectionView } = await import("../bootstrap/wiring/editor-owners.ts");
const writer = await import("../features/writer/writer.ts");
let opened = 0;

async function open(sections = [{ id: "s1", name: "Opening", firstSceneId: "r1" }, { id: "s2", name: "Ending", firstSceneId: "r3" }], fields = {}) {
  if (viewFlags().writerOpen()) writer.closeWriter();
  const doc = migrateRows({ title: "Sections", rows: ["One.", "Two.", "Three.", "Four."].map((audioText, i) => ({
    id: "r" + (i + 1), audioText, visualText: "", status: i === 1 ? "shot" : "todo", lengthSeconds: (i + 1) * 10
  })), sections, ...fields });
  const file = new File([buildSplitpageFile(exportDocumentOf(doc))], "sections-" + (++opened) + ".splitpage");
  await openDocument({ kind: "file", file, handle: null, options: { skipSnapshot: true } });
  undoOwner().flush();
}

function caret(id, end = false) {
  const cell = document.querySelector('#writer-doc .wr-para[data-id="' + id + '"]');
  assert.ok(cell);
  cell.focus();
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(!end);
  const selection = window.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  return cell;
}

function key(name, cell = document.activeElement, options = {}) {
  const event = new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options });
  cell.dispatchEvent(event);
  return event;
}

const state = () => JSON.stringify(currentDocument());
const hint = () => document.querySelector('#writer-doc [data-section-id="s2"] .section-hint');
const ids = () => currentDocument().rows.map(row => row.id);

test("sectionless new-scene input does not inspect section boundaries", async (context) => {
  await open([]);
  const cell = document.querySelector('#rows .row[data-id="r2"] .audio-cell .cell-editable');
  cell.focus();
  const range = document.createRange();
  range.selectNodeContents(cell); range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  const closest = window.Element.prototype.closest;
  let probes = 0;
  context.mock.method(window.Element.prototype, "closest", function (selector) {
    if (selector === "#writer-doc .wr-para") probes++;
    return closest.call(this, selector);
  });
  key("Enter", cell, { ctrlKey: true });
  assert.equal(currentDocument().rows.length, 5);
  assert.equal(probes, 0);
});

test("singleton Alt moves require consecutive confirmation and undo restores the header and row order", async () => {
  for (const direction of ["ArrowUp", "ArrowDown"]) {
    await open([{ id: "s1", name: "Only scene", firstSceneId: "r2" }, { id: "s2", name: "Ending", firstSceneId: "r3" }]);
    const cell = document.querySelector('#rows .row[data-id="r2"] .audio-cell .cell-editable');
    cell.focus();
    const before = state(), undo = undoOwner().sizes().undo;
    key(direction, cell, { altKey: true });
    assert.equal(state(), before);
    assert.equal(document.querySelector('#rows [data-section-id="s1"] .section-hint').textContent, "Press again to remove the section header");
    key("ArrowRight", cell);
    key(direction, cell, { altKey: true });
    assert.equal(state(), before);
    assert.equal(undoOwner().sizes().undo, undo);
    key(direction, cell, { altKey: true });
    assert.deepEqual(ids(), direction === "ArrowUp" ? ["r2", "r1", "r3", "r4"] : ["r1", "r3", "r2", "r4"]);
    assert.equal(currentDocument().sections.length, 1);
    undoOwner().flush();
    assert.equal(undoOwner().sizes().undo, undo + 1);
    undoOwner().undo();
    assert.equal(state(), before);
  }
});

test("singleton move confirmation survives modifier-only keydowns, including repeated Alt and Alt+Shift", async () => {
  for (const shiftKey of [false, true]) {
    await open([{ id: "s1", name: "Only scene", firstSceneId: "r2" }, { id: "s2", name: "Ending", firstSceneId: "r3" }]);
    const cell = document.querySelector('#rows .row[data-id="r2"] .audio-cell .cell-editable');
    cell.focus();
    const before = state();
    key("ArrowDown", cell, { altKey: true, shiftKey });
    assert.equal(state(), before);
    for (const modifier of ["Alt", "Shift", "Control", "Meta"]) key(modifier, cell, { altKey: true });
    key("Alt", cell, { altKey: true, repeat: true });
    key("ArrowDown", cell, { altKey: true, shiftKey });
    assert.deepEqual(ids(), ["r1", "r3", "r2", "r4"]);
    assert.equal(currentDocument().sections.length, 1);
    undoOwner().flush(); undoOwner().undo();
    assert.equal(state(), before);
  }
});

test("moving a scene into a folded section reveals the destination and restores its caret", async () => {
  await open();
  sectionView().toggle("s1");
  const cell = document.querySelector('#rows .row[data-id="r3"] .audio-cell .cell-editable');
  cell.focus();
  key("ArrowUp", cell, { altKey: true });
  assert.deepEqual(ids(), ["r1", "r3", "r2", "r4"]);
  assert.equal(sectionView().folded("s1"), false);
  assert.equal(document.activeElement.getAttribute("data-id"), "r3");
  assert.equal(document.activeElement.getAttribute("data-field"), "audioText");
});

test("Find and Replace reveal a folded match through their real wiring", async () => {
  const find = await import("../features/find/find.ts");
  await open();
  sectionView().toggle("s2");
  find.openFindBar();
  document.getElementById("find-input").value = "Three";
  find.findQueryChanged();
  assert.equal(sectionView().folded("s2"), false);
  assert.match(document.querySelector('#rows .row[data-id="r3"]').textContent, /Three/);
  sectionView().toggle("s2");
  document.getElementById("replace-input").value = "Replaced";
  document.getElementById("find-replace").click();
  assert.equal(sectionView().folded("s2"), false);
  assert.match(document.querySelector('#rows .row[data-id="r3"]').textContent, /Replaced/);
  find.closeFindBar();
});

test("comment jump reveals its folded anchor", async () => {
  await open(undefined, { schema: 2, rows: [{ id: "r1", audioText: '<span class="cmt-anchor" data-cmt="c_one">One</span>', visualText: "" }],
    comments: [{ id: "c_one", kind: "anchor", rowId: "r1", field: "audioText", anchorId: "c_one", quotedText: "One", author: "Ada", body: "Comment", replies: [] }] });
  sectionView().toggle("s1");
  const { jumpToAnchor } = await import("../features/comments/comments.ts");
  jumpToAnchor("c_one");
  assert.equal(sectionView().folded("s1"), false);
  assert.ok(document.querySelector('#rows .cmt-anchor[data-cmt="c_one"].flash'));
});

test("headers expose headings, Escape closes the menu, and non-element drag targets are ignored", async context => {
  await open();
  const header = document.querySelector('#rows [data-section-id="s1"]');
  assert.equal(header.querySelector('[role="heading"][aria-level="2"]').textContent, "Opening");
  const menu = header.querySelector("details"), summary = menu.querySelector("summary");
  menu.open = true; summary.focus();
  key("Escape", summary);
  assert.equal(menu.open, false);
  assert.equal(document.activeElement, summary);
  const errors = [];
  const listen = event => { errors.push(event.error); event.preventDefault(); };
  window.addEventListener("error", listen);
  context.after(() => window.removeEventListener("error", listen));
  document.dispatchEvent(new window.Event("dragstart", { bubbles: true }));
  assert.deepEqual(errors, []);
});

test("boundary hint uses one persistent live region and only the visible Writer header", async () => {
  await open();
  const live = document.getElementById("section-hint-live");
  assert.ok(live); assert.equal(live.hidden, false); assert.equal(live.textContent, "");
  writer.openWriter(); caret("r3"); key("Backspace");
  assert.equal(document.getElementById("section-hint-live"), live);
  assert.equal(live.textContent, "Press Backspace again to remove the section header");
  assert.equal(document.querySelectorAll('.section-hint:not([hidden])').length, 1);
  assert.equal(document.querySelectorAll('.section-hint[role="status"]').length, 0);
  key("ArrowRight");
  assert.equal(live.textContent, "");
  assert.equal(document.getElementById("section-hint-live"), live);
});

test("section dividers count all scenes, fold without an edit and reset when another file opens", async () => {
  await open();
  const before = state(), undo = undoOwner().sizes().undo;
  const header = document.querySelector('#rows [data-section-id="s1"]');
  assert.ok(header);
  assert.equal(header.classList.contains("row"), false);
  assert.match(header.querySelector(".section-stats").textContent, /2 scenes/);
  assert.equal(header.querySelector("[data-section-total]").textContent, "0:30");
  header.querySelector(".section-fold").click();
  assert.equal(document.activeElement, document.querySelector('#rows [data-section-id="s1"] .section-fold'));
  assert.equal(document.querySelectorAll("#rows .row").length, 2);
  assert.equal(state(), before);
  assert.equal(undoOwner().sizes().undo, undo);
  sectionView().reveal(currentDocument(), "r2");
  assert.equal(document.querySelectorAll("#rows .row").length, 4);
  sectionView().toggle("s1");
  await open();
  assert.equal(sectionView().folded("s1"), false);
  assert.equal(document.querySelectorAll("#rows .row").length, 4);
});

test("mounted Writer confirms Backspace once, removes only the header, and undo restores its name", async () => {
  await open(); writer.openWriter();
  caret("r3");
  const before = state(), undo = undoOwner().sizes().undo;
  assert.equal(key("Backspace").defaultPrevented, true);
  assert.equal(state(), before);
  assert.equal(hint().hidden, false);
  assert.equal(hint().textContent, "Press Backspace again to remove the section header");
  assert.equal(undoOwner().sizes().undo, undo);
  key("Backspace");
  assert.deepEqual(ids(), ["r1", "r2", "r3", "r4"]);
  assert.equal(currentDocument().sections.length, 1);
  undoOwner().flush();
  assert.equal(undoOwner().sizes().undo, undo + 1);
  undoOwner().undo();
  assert.equal(currentDocument().sections[1].name, "Ending");
});

test("mounted Writer cancels confirmation on another key, click or caret movement", async () => {
  for (const interrupt of [
    () => key("ArrowRight"),
    () => document.body.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
    () => { caret("r3", true); document.dispatchEvent(new window.Event("selectionchange")); caret("r3"); }
  ]) {
    await open(); writer.openWriter(); caret("r3");
    const before = state();
    key("Backspace");
    interrupt();
    assert.equal(hint().hidden, true);
    key("Backspace");
    assert.equal(state(), before);
  }
});

test("boundary removal reveals a folded predecessor and preserves the current caret", async () => {
  await open(); sectionView().toggle("s1"); writer.openWriter(); caret("r3");
  key("Backspace"); key("Backspace");
  assert.equal(sectionView().folded("s1"), false);
  assert.equal(document.activeElement.getAttribute("data-id"), "r3");
  assert.equal(currentDocument().sections.length, 1);
  key("Backspace");
  assert.deepEqual(ids(), ["r1", "r2", "r4"]);
});

test("mounted Writer Delete mirrors removal, and a further Backspace joins normally", async () => {
  await open(); writer.openWriter(); caret("r2", true);
  const before = state();
  key("Delete");
  assert.equal(state(), before);
  assert.equal(hint().textContent, "Press Delete again to remove the section header");
  key("Delete");
  assert.equal(currentDocument().sections.length, 1);
  assert.deepEqual(ids(), ["r1", "r2", "r3", "r4"]);
  caret("r3");
  key("Backspace");
  assert.deepEqual(ids(), ["r1", "r2", "r4"]);
  const joined = currentDocument().rows.find(row => row.id === "r2").audioText;
  assert.match(joined, /Two/); assert.match(joined, /Three/);
});
