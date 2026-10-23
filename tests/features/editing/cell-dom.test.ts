import { test } from "node:test";
import assert from "node:assert/strict";
import { domKeys, domToPos, placeSelection, posToDom, readSelection } from "../../../src/features/common/cell-dom.ts";
import { jsdomWindow } from "./jsdom.mjs";

const win: Window = jsdomWindow();
const doc = win.document;
const selection = (): Selection => win.getSelection() as Selection;

function cell(html: string): HTMLElement {
  doc.body.innerHTML = '<div class="cell-editable" contenteditable="true">' + html + "</div>";
  return doc.body.firstChild as HTMLElement;
}

test("the editor's keys are the model's positions: text without zero-width spaces, a line break, and a b-roll key by its id", () => {
  const el = cell('One <strong>two</strong><br><span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> three\u200B');
  assert.deepEqual(domKeys(el), ["O", "n", "e", " ", "t", "w", "o", "\n", "\u{FFFC}bs1", " ", "t", "h", "r", "e", "e"]);
});

test("every position goes to the page and back to itself", () => {
  const el = cell('Ab <em>cd</em><br><span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> ef');
  const length = domKeys(el).length;
  for (let pos = 0; pos <= length; pos++) {
    const point = posToDom(el, pos);
    assert.equal(domToPos(el, point.node, point.offset), pos, "position " + pos);
  }
});

test("a selection is read with its direction, and placed back with it", () => {
  const el = cell("Hello there");
  const text = el.firstChild as Text;
  selection().setBaseAndExtent(text, 11, text, 6);
  const read = readSelection(el, selection());
  assert.deepEqual(read, { anchor: 11, head: 6, affinity: "backward" });
  selection().removeAllRanges();
  assert.equal(placeSelection(el, selection(), { anchor: 9, head: 2, affinity: "backward" }), true);
  assert.equal(selection().anchorOffset, 9);
  assert.equal(selection().focusOffset, 2);
  assert.deepEqual(readSelection(el, selection()), { anchor: 9, head: 2, affinity: "backward" });
});

test("a caret at the start of a text run binds forward, one after a character binds backward", () => {
  const el = cell('ab<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span>cd');
  const after = el.lastChild as Text;
  selection().setBaseAndExtent(after, 0, after, 0);
  assert.deepEqual(readSelection(el, selection()), { anchor: 3, head: 3, affinity: "forward" });
  const before = el.firstChild as Text;
  selection().setBaseAndExtent(before, 2, before, 2);
  assert.deepEqual(readSelection(el, selection()), { anchor: 2, head: 2, affinity: "backward" });
  selection().setBaseAndExtent(before, 0, before, 0);
  assert.deepEqual(readSelection(el, selection()), { anchor: 0, head: 0, affinity: "forward" });
});

test("a selection outside the cell, or none, reads as nothing", () => {
  const el = cell("Inside");
  doc.body.insertAdjacentHTML("beforeend", "<p>Outside</p>");
  const outside = (doc.body.lastChild as HTMLElement).firstChild as Text;
  selection().setBaseAndExtent(outside, 1, outside, 3);
  assert.equal(readSelection(el, selection()), null);
  selection().removeAllRanges();
  assert.equal(readSelection(el, selection()), null);
  assert.equal(readSelection(el, null), null);
  assert.equal(placeSelection(el, null, { anchor: 0, head: 0, affinity: "forward" }), false);
});
