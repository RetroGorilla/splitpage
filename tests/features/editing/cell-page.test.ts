import { test } from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "./jsdom.mjs";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
Object.assign(globalThis, { window: win, document: win.document, NodeFilter: win.NodeFilter });
const doc: Document = win.document;

const { createCellPage, isDraftBox, isScriptCell } = await import("../../../src/features/editing/cell-page.ts");
const { caretTextOffset, placeCaretAtTextOffset } = await import("../../../src/features/editing/caret.ts");

function page() {
  doc.body.innerHTML =
    '<div id="rows"><div class="cell-editable" contenteditable="true" data-id="r1" data-field="audioText">Hello​ there</div></div>' +
    '<div id="writer-doc"><div class="cell-editable wr-para" contenteditable="true" data-id="r1" data-field="audioText">Para</div></div>' +
    '<div id="composer"><div class="cell-editable" contenteditable="true">Draft</div></div>' +
    '<div id="tags"><span class="tag-anchor" contenteditable="false">Pentax</span></div>';
  return {
    cell: doc.querySelector("#rows .cell-editable") as HTMLElement,
    para: doc.querySelector("#writer-doc .wr-para") as HTMLElement,
    draft: doc.querySelector("#composer .cell-editable") as HTMLElement
  };
}

test("the page reads a cell's address, whether it is on the page, and its stored text without zero-width spaces", () => {
  const { cell } = page();
  const stored: string[] = [];
  const cells = createCellPage({ storedHtml: function (html) { stored.push(html); return "[" + html + "]"; }, caretSpot: function () {} });
  assert.deepEqual(cells.address(cell), { rowId: "r1", field: "audioText" });
  assert.deepEqual(cells.address(doc.createElement("div")), { rowId: null, field: null });
  assert.equal(cells.attached(cell), true);
  assert.equal(cells.attached(doc.createElement("div")), false);
  assert.equal(cells.html(cell), "[Hello there]");
  assert.deepEqual(stored, ["Hello there"], "the stored form is taken from the shown HTML once the spaces are gone");
});

test("writing a cell replaces its HTML and then keeps a caret spot after a trailing atom", () => {
  const { cell } = page();
  const order: string[] = [];
  const cells = createCellPage({ storedHtml: function (html) { return html; }, caretSpot: function (el) { order.push("spot:" + el.innerHTML); } });
  cells.write(cell, "New <b>text</b>");
  assert.equal(cell.innerHTML, "New <b>text</b>");
  assert.deepEqual(order, ["spot:New <b>text</b>"]);
});

test("focusing a cell puts the selection back where it was asked, or leaves it when none is given", () => {
  const { cell } = page();
  const cells = createCellPage({ storedHtml: function (html) { return html; }, caretSpot: function () {} });
  cell.innerHTML = "Hello there";
  cells.focus(cell, { from: 2, to: 5 });
  assert.equal(doc.activeElement, cell);
  assert.deepEqual(cells.selection(cell), { from: 2, to: 5 });
  cells.focus(cell, null);
  assert.deepEqual(cells.selection(cell), { from: 2, to: 5 });
});

test("script cells are the grid's and the writer's fields; draft boxes are editable cells anywhere else", () => {
  const { cell, para, draft } = page();
  assert.equal(isScriptCell(cell), true);
  assert.equal(isScriptCell(para), true);
  assert.equal(isScriptCell(draft), false);
  assert.equal(isScriptCell(null), false);
  assert.equal(isDraftBox(draft), true);
  assert.equal(isDraftBox(cell), false);
  draft.setAttribute("contenteditable", "false");
  assert.equal(isDraftBox(draft), false);
  assert.equal(isDraftBox(null), false);
});

test("the caret goes to a text offset and reads back the same offset", () => {
  const { cell } = page();
  cell.innerHTML = "One <b>two</b> three";
  for (const at of [0, 3, 5, 7, 13]) {
    placeCaretAtTextOffset(cell, at);
    assert.equal(caretTextOffset(cell), at, "offset " + at);
  }
  placeCaretAtTextOffset(cell, 99);
  assert.equal(caretTextOffset(cell), 0, "an offset past the text collapses to the cell's start");
});

test("the caret never lands inside a tag: it goes before the tag at its start and after it otherwise", () => {
  const { cell } = page();
  cell.innerHTML = 'A <span class="tag-anchor" contenteditable="false">Pentax</span> B';
  const tag = cell.querySelector(".tag-anchor") as HTMLElement;
  placeCaretAtTextOffset(cell, 2);
  const before = (win.getSelection() as Selection).getRangeAt(0);
  assert.equal(before.startContainer, cell.firstChild, "offset 2 is the end of the text before the tag");
  placeCaretAtTextOffset(cell, 4);
  const after = (win.getSelection() as Selection).getRangeAt(0);
  assert.equal(after.startContainer, cell);
  assert.equal(after.startOffset, Array.prototype.indexOf.call(cell.childNodes, tag) + 1);
  const empty = doc.createElement("div");
  doc.body.appendChild(empty);
  placeCaretAtTextOffset(empty, 3);
  assert.equal(caretTextOffset(empty), 0, "a cell with no text holds the caret at its start");
  assert.equal(caretTextOffset(doc.body.querySelector("#writer-doc") as Element), 0, "a caret outside the element reads as 0");
});
