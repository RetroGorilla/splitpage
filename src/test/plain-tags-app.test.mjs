import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");
const { currentDocument } = await import("../bootstrap/wiring/session-owner.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
after(closeApp);

async function open(html, comments = []) {
  const doc = migrateRows({ schema: 2, title: "Existing tag marks", rows: [{ id: "r1", visualText: html, audioText: "", status: "todo" }], comments });
  const file = new File([buildSplitpageFile(exportDocumentOf(doc))], "tag-marks.splitpage");
  await openDocument({ kind: "file", file, handle: null, options: { skipSnapshot: true } });
  const cell = document.querySelector('#rows .cell-editable[data-field="visualText"]');
  cell.focus();
  const node = document.createTreeWalker(cell, 4).nextNode();
  const selected = window.getSelection();
  for (const [offset, ch] of [..."VFX:"].entries()) {
    node.insertData(offset, ch);
    const range = document.createRange();
    range.setStart(node, offset + 1);
    range.collapse(true);
    selected.removeAllRanges();
    selected.addRange(range);
    cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
  }
  undoOwner().flush();
  return cell;
}

function close(cell) {
  cell.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", keyCode: 9, bubbles: true, cancelable: true }));
}

test("one undo restores mixed bold formatting after immediate Tab", async () => {
  const cell = await open(" glow <strong>across</strong> the logo");
  const before = currentDocument().rows[0].visualText;
  const size = undoOwner().sizes().undo;
  close(cell);
  assert.equal(cell.querySelector(".tag-anchor").textContent, "glow across the logo");
  assert.equal(undoOwner().sizes().undo, size + 1);
  undoOwner().undo();
  assert.equal(currentDocument().rows[0].visualText, before);
  assert.equal(document.querySelector('#rows .cell-editable[data-field="visualText"] strong').textContent, "across");
});

test("immediate Tab preserves an existing link", async () => {
  const cell = await open(' glow <a href="https://example.com/">across</a> the logo');
  close(cell);
  assert.equal(cell.querySelector(".tag-anchor").textContent, "glow");
  assert.equal(cell.querySelector("a").getAttribute("href"), "https://example.com/");
  assert.equal(cell.querySelector("a").textContent, "across");
});

test("immediate Tab preserves existing comment marks", async () => {
  const cell = await open(' glow <span class="cmt-anchor" data-cmt="c1">across</span> the logo', [
    { id: "c1", rowId: "r1", field: "visualText", anchorId: "c1", quotedText: "across", kind: "anchor", text: "Keep this anchor", replies: [] }
  ]);
  close(cell);
  assert.equal(cell.querySelector(".tag-anchor").textContent, "glow");
  assert.equal(cell.querySelector('[data-cmt="c1"]')?.textContent, "across");
  assert.equal(currentDocument().comments[0].anchorId, "c1");
});

test("immediate Tab makes no tag when the following words have different comment marks", async () => {
  const cell = await open(' <span class="cmt-anchor" data-cmt="c1">glow across</span> the logo', [
    { id: "c1", rowId: "r1", field: "visualText", anchorId: "c1", quotedText: "glow across", kind: "anchor", text: "Keep this anchor", replies: [] }
  ]);
  const before = currentDocument().rows[0].visualText;
  const size = undoOwner().sizes().undo;
  close(cell);
  assert.equal(cell.querySelector(".tag-anchor"), null);
  assert.equal(cell.querySelector(".plain-tag-keyword"), null);
  assert.equal(currentDocument().rows[0].visualText, before);
  assert.equal(cell.querySelector('[data-cmt="c1"]').textContent, "glow across");
  assert.equal(undoOwner().sizes().undo, size);
  assert.match(cell.textContent, /^VFX: /);
});

test("typed-word close keeps an existing comment beyond its caret boundary", async () => {
  const cell = await open(' glow <span class="cmt-anchor" data-cmt="c1">across</span> the logo', [
    { id: "c1", rowId: "r1", field: "visualText", anchorId: "c1", quotedText: "across", kind: "anchor", text: "Keep this anchor", replies: [] }
  ]);
  const node = cell.querySelector(".plain-tag-keyword").nextSibling;
  node.insertData(1, "new");
  const range = document.createRange();
  range.setStart(node, 4);
  range.collapse(true);
  const selected = window.getSelection();
  selected.removeAllRanges();
  selected.addRange(range);
  cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "new" }));
  close(cell);
  assert.equal(cell.querySelector(".tag-anchor").textContent, "new");
  assert.equal(cell.querySelector('[data-cmt="c1"]').textContent, "across");
  assert.equal(currentDocument().comments[0].anchorId, "c1");
});

for (const typed of ["", "new"]) {
  test("a keyword inside an existing comment keeps its marks when closed" + (typed ? " after typing" : " immediately"), async () => {
    const cell = await open('<span class="cmt-anchor" data-cmt="c1">glow</span> the logo', [
      { id: "c1", rowId: "r1", field: "visualText", anchorId: "c1", quotedText: "glow", kind: "anchor", text: "Keep this anchor", replies: [] }
    ]);
    if (typed) {
      const node = cell.querySelector(".plain-tag-keyword").nextSibling;
      node.insertData(1, typed);
      const range = document.createRange();
      range.setStart(node, 1 + typed.length);
      range.collapse(true);
      const selected = window.getSelection();
      selected.removeAllRanges();
      selected.addRange(range);
      cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: typed }));
    }
    close(cell);
    assert.equal(cell.querySelector(".tag-anchor").textContent, typed || "glow");
    assert.equal(cell.querySelector('[data-cmt="c1"]').textContent, typed + "glow");
    assert.equal(currentDocument().comments[0].anchorId, "c1");
  });
}

test("immediate Tab stops before a change in stage-direction marks", async () => {
  const cell = await open(' glow <span class="stage-dir">across</span> the logo');
  close(cell);
  assert.equal(cell.querySelector(".tag-anchor").textContent, "glow");
  assert.equal(cell.querySelector(".stage-dir").textContent, "across");
});

test("immediate Tab makes no tag when the first following words are a stage direction", async () => {
  const cell = await open(' <span class="stage-dir">glow across</span> the logo');
  const before = currentDocument().rows[0].visualText;
  const size = undoOwner().sizes().undo;
  close(cell);
  assert.equal(cell.querySelector(".tag-anchor"), null);
  assert.equal(cell.querySelector(".plain-tag-keyword"), null);
  assert.equal(currentDocument().rows[0].visualText, before);
  assert.equal(cell.querySelector(".stage-dir").textContent, "glow across");
  assert.equal(undoOwner().sizes().undo, size);
  assert.match(cell.textContent, /^VFX: /);
});

test("typed-word close keeps a stage direction beyond its caret boundary", async () => {
  const cell = await open(' glow <span class="stage-dir">across</span> the logo');
  const node = cell.querySelector(".plain-tag-keyword").nextSibling;
  node.insertData(1, "new");
  const range = document.createRange();
  range.setStart(node, 4);
  range.collapse(true);
  const selected = window.getSelection();
  selected.removeAllRanges();
  selected.addRange(range);
  cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "new" }));
  close(cell);
  assert.equal(cell.querySelector(".tag-anchor").textContent, "new");
  assert.equal(cell.querySelector(".stage-dir").textContent, "across");
});

for (const typed of ["", "new"]) {
  test("a keyword inside a stage direction keeps its marks when closed" + (typed ? " after typing" : " immediately"), async () => {
    const cell = await open('<span class="stage-dir">glow</span> the logo');
    if (typed) {
      const node = cell.querySelector(".plain-tag-keyword").nextSibling;
      node.insertData(1, typed);
      const range = document.createRange();
      range.setStart(node, 1 + typed.length);
      range.collapse(true);
      const selected = window.getSelection();
      selected.removeAllRanges();
      selected.addRange(range);
      cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: typed }));
    }
    close(cell);
    assert.equal(cell.querySelector(".tag-anchor").textContent, typed || "glow");
    assert.equal(cell.querySelector(".stage-dir").textContent, typed + "glow");
  });
}
