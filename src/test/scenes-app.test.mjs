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
const { sceneView } = await import("../bootstrap/wiring/editor-owners.ts");
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
  const cell = document.querySelector('#writer-doc .wr-beat[data-id="' + id + '"]');
  assert.ok(cell);
  (cell.matches(".wr-beat") ? document.getElementById("writer-doc") : cell).focus();
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
  if ((name === "Backspace" || name === "Delete") && !event.defaultPrevented && cell.closest("#writer")) {
    const input = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: name === "Backspace" ? "deleteContentBackward" : "deleteContentForward" });
    input.getTargetRanges = () => [];
    cell.dispatchEvent(input);
  }
  return event;
}

const state = () => JSON.stringify(currentDocument());

const ids = () => currentDocument().rows.map(row => row.id);

test("sectionless new-scene input does not inspect section boundaries", async (context) => {
  await open([]);
  const cell = document.querySelector('#rows .row[data-id="r2"] .audio-cell .cell-editable');
  (cell.matches(".wr-beat") ? document.getElementById("writer-doc") : cell).focus();
  const range = document.createRange();
  range.selectNodeContents(cell); range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  const closest = window.Element.prototype.closest;
  let probes = 0;
  context.mock.method(window.Element.prototype, "closest", function (selector) {
    if (selector === "#writer-doc .wr-beat") probes++;
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
    (cell.matches(".wr-beat") ? document.getElementById("writer-doc") : cell).focus();
    const before = state(), undo = undoOwner().sizes().undo;
    key(direction, cell, { altKey: true });
    assert.equal(state(), before);
    assert.equal(document.querySelector('#rows [data-section-id="s1"] .section-hint').textContent, "Press again to remove the scene header");
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

function mouse(target, type) {
  target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, detail: type === "click" ? 1 : 0 }));
}

function press(target, how) {
  target.focus();
  if (how === "mouse") { mouse(target, "pointerdown"); mouse(target, "mousedown"); mouse(target, "mouseup"); mouse(target, "click"); return; }
  key(how === "space" ? " " : "Enter", target);
  mouse(target, "click");
}

function openMenu(id) {
  const more = document.querySelector('#rows .row[data-id="' + id + '"] .row-more');
  press(more, "mouse");
  const menu = more.parentNode.querySelector(".row-menu");
  assert.equal(menu.hidden, false);
  return menu;
}

const singleton = () => open([{ id: "s1", name: "Only scene", firstSceneId: "r2" }, { id: "s2", name: "Ending", firstSceneId: "r3" }]);
const hintOf = () => document.querySelector('#rows [data-section-id="s1"] .section-hint').textContent;

for (const how of ["mouse", "keyboard", "space"]) {
  test("row menu Move up and Move down confirm by " + how + " before removing a one-beat scene header", async () => {
    for (const [action, expected] of [["move-up", ["r2", "r1", "r3", "r4"]], ["move-down", ["r1", "r3", "r2", "r4"]]]) {
      await singleton();
      const menu = openMenu("r2");
      const button = menu.querySelector('[data-action="' + action + '"]');
      const before = state(), undo = undoOwner().sizes().undo;
      press(button, how);
      assert.equal(state(), before);
      assert.equal(hintOf(), "Press again to remove the scene header");
      assert.equal(menu.hidden, false);
      assert.equal(document.activeElement, button);
      press(button, how);
      assert.deepEqual(ids(), expected);
      assert.equal(currentDocument().sections.length, 1);
      undoOwner().flush();
      assert.equal(undoOwner().sizes().undo, undo + 1);
      undoOwner().undo();
      assert.equal(state(), before);
    }
  });
}

test("row menu Move that changes nothing drops a pending header confirmation", async () => {
  await open([{ id: "s1", name: "Only scene", firstSceneId: "r1" }, { id: "s2", name: "Ending", firstSceneId: "r2" }]);
  const menu = openMenu("r1");
  press(menu.querySelector('[data-action="move-down"]'), "mouse");
  assert.equal(hintOf(), "Press again to remove the scene header");
  const before = state();
  press(menu.querySelector('[data-action="move-up"]'), "mouse");
  assert.equal(state(), before);
  assert.equal(hintOf(), "");
  assert.equal(menu.hidden, true);
  press(openMenu("r1").querySelector('[data-action="move-down"]'), "mouse");
  assert.equal(state(), before);
  assert.equal(hintOf(), "Press again to remove the scene header");
});

test("row menu Move ignores a held Enter instead of confirming", async () => {
  await singleton();
  const button = openMenu("r2").querySelector('[data-action="move-down"]');
  const before = state();
  press(button, "keyboard");
  assert.equal(hintOf(), "Press again to remove the scene header");
  const held = key("Enter", button, { repeat: true });
  assert.equal(held.defaultPrevented, true);
  assert.equal(state(), before);
  assert.equal(hintOf(), "Press again to remove the scene header");
  press(button, "keyboard");
  assert.deepEqual(ids(), ["r1", "r3", "r2", "r4"]);
});

test("row menu Move without a header to remove moves at once", async () => {
  await open();
  const before = undoOwner().sizes().undo;
  press(openMenu("r1").querySelector('[data-action="move-down"]'), "mouse");
  assert.deepEqual(ids(), ["r2", "r1", "r3", "r4"]);
  undoOwner().flush();
  assert.equal(undoOwner().sizes().undo, before + 1);
});

test("singleton move confirmation survives modifier-only keydowns, including repeated Alt and Alt+Shift", async () => {
  for (const shiftKey of [false, true]) {
    await open([{ id: "s1", name: "Only scene", firstSceneId: "r2" }, { id: "s2", name: "Ending", firstSceneId: "r3" }]);
    const cell = document.querySelector('#rows .row[data-id="r2"] .audio-cell .cell-editable');
    (cell.matches(".wr-beat") ? document.getElementById("writer-doc") : cell).focus();
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
  sceneView().toggle("s1");
  const cell = document.querySelector('#rows .row[data-id="r3"] .audio-cell .cell-editable');
  (cell.matches(".wr-beat") ? document.getElementById("writer-doc") : cell).focus();
  key("ArrowUp", cell, { altKey: true });
  assert.deepEqual(ids(), ["r1", "r3", "r2", "r4"]);
  assert.equal(sceneView().folded("s1"), false);
  assert.equal(document.activeElement.getAttribute("data-id"), "r3");
  assert.equal(document.activeElement.getAttribute("data-field"), "audioText");
});

test("Find and Replace reveal a folded match through their real wiring", async () => {
  const find = await import("../features/find/find.ts");
  await open();
  sceneView().toggle("s2");
  find.openFindBar();
  document.getElementById("find-input").value = "Three";
  find.findQueryChanged();
  assert.equal(sceneView().folded("s2"), false);
  assert.match(document.querySelector('#rows .row[data-id="r3"]').textContent, /Three/);
  sceneView().toggle("s2");
  document.getElementById("replace-input").value = "Replaced";
  document.getElementById("find-replace").click();
  assert.equal(sceneView().folded("s2"), false);
  assert.match(document.querySelector('#rows .row[data-id="r3"]').textContent, /Replaced/);
  find.closeFindBar();
});

test("comment jump reveals its folded anchor", async () => {
  await open(undefined, { schema: 2, rows: [{ id: "r1", audioText: '<span class="cmt-anchor" data-cmt="c_one">One</span>', visualText: "" }],
    comments: [{ id: "c_one", kind: "anchor", rowId: "r1", field: "audioText", anchorId: "c_one", quotedText: "One", author: "Ada", body: "Comment", replies: [] }] });
  sceneView().toggle("s1");
  const { jumpToAnchor } = await import("../features/comments/comments.ts");
  jumpToAnchor("c_one");
  assert.equal(sceneView().folded("s1"), false);
  assert.ok(document.querySelector('#rows .cmt-anchor[data-cmt="c_one"].flash'));
});

test("headers expose headings, Escape closes the menu, and non-element drag targets are ignored", async context => {
  await open();
  const header = document.querySelector('#rows [data-section-id="s1"]');
  assert.equal(header.querySelector('[role="heading"][aria-level="2"]').textContent, "A Opening");
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



test("section dividers count all scenes, fold without an edit and reset when another file opens", async () => {
  await open();
  const before = state(), undo = undoOwner().sizes().undo;
  const header = document.querySelector('#rows [data-section-id="s1"]');
  assert.ok(header);
  assert.equal(header.classList.contains("row"), false);
  assert.match(header.querySelector(".section-stats").textContent, /2 beats/);
  assert.equal(header.querySelector("[data-section-total]").textContent, "0:30");
  header.querySelector(".section-fold").click();
  assert.equal(document.activeElement, document.querySelector('#rows [data-section-id="s1"] .section-fold'));
  assert.equal(document.querySelectorAll("#rows .row").length, 2);
  assert.equal(state(), before);
  assert.equal(undoOwner().sizes().undo, undo);
  sceneView().reveal(currentDocument(), "r2");
  assert.equal(document.querySelectorAll("#rows .row").length, 4);
  sceneView().toggle("s1");
  await open();
  assert.equal(sceneView().folded("s1"), false);
  assert.equal(document.querySelectorAll("#rows .row").length, 4);
});

test("mounted Writer navigates to the heading without editing, then removes it as text and undo restores its name", async () => {
  await open(); writer.openWriter();
  caret("r3");
  const before = state(), undo = undoOwner().sizes().undo;
  key("Backspace");
  assert.equal(state(), before);
  assert.equal(window.__writerFlowTest.selection().head.kind, "heading");
  assert.equal(window.__writerFlowTest.selection().head.offset, 6);
  assert.equal(undoOwner().sizes().undo, undo);
  const heading = document.querySelector('.wr-heading[data-scene="s2"]');
  const range = document.createRange();
  range.selectNodeContents(heading); range.collapse(true);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  key("Backspace");
  assert.equal(currentDocument().sections.length, 1);
  assert.deepEqual(currentDocument().rows.map(row => row.audioText), ["One.", "Two.", "Ending", "Three.", "Four."]);
  undoOwner().flush();
  assert.equal(undoOwner().sizes().undo, undo + 1);
  undoOwner().undo();
  assert.equal(currentDocument().sections[1].name, "Ending");
});

test("the writer reaches beats in folded scenes and reveals the caret's scene on return to split view", async () => {
  await open(); sceneView().toggle("s1"); writer.openWriter();
  caret("r2", true);
  assert.equal(document.querySelectorAll("#writer-doc .wr-beat").length, 4);
  assert.equal(sceneView().folded("s1"), true);
  writer.closeWriter();
  assert.equal(sceneView().folded("s1"), false);
  assert.equal(document.activeElement.getAttribute("data-id"), "r2");
  assert.equal(currentDocument().sections.length, 2);
});

test("mounted Writer Delete moves to the heading start without editing", async () => {
  await open(); writer.openWriter(); caret("r2", true);
  const before = state();
  key("Delete");
  assert.equal(state(), before);
  assert.deepEqual(window.__writerFlowTest.selection().head, { kind: "heading", sceneId: "s2", offset: 0 });
  key("Backspace");
  assert.equal(currentDocument().sections.length, 1);
  assert.deepEqual(currentDocument().rows.map(row => row.audioText), ["One.", "Two.", "Ending", "Three.", "Four."]);
});
