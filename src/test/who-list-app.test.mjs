import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { currentDocument } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { loadTestDocument } = await import("./_document.mjs");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { currentWhoList } = await import("../bootstrap/wiring/who-list.ts");

after(closeApp);

const KETTLE = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Kettle" contenteditable="false">kettle</span>';

function fixture(visualText = "Fill the " + KETTLE + " for ") {
  currentWhoList().cancel();
  loadTestDocument(migrateRows({
    schema: 5, title: "Name chips",
    people: [{ id: "pSam", name: "Sam" }, { id: "pSandy", name: "Sandy" }],
    productionTags: [{ id: "t1", cat: "prop", name: "Kettle", owner: "", notes: "", status: "needed" }],
    rows: [{ id: "r1", visualText, audioText: "Say hi.", status: "todo" }]
  }));
  undoOwner().flush();
  const cell = document.querySelector("#rows .visual-cell .cell-editable");
  caretAtEnd(cell);
  return cell;
}

function caretAtEnd(cell) {
  cell.focus();
  const last = cell.lastChild;
  const range = document.createRange();
  if (last && last.nodeType === 3) range.setStart(last, last.data.length);
  else range.setStart(cell, cell.childNodes.length);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function type(cell, text) {
  for (const char of text) {
    const sel = window.getSelection();
    let node = sel.anchorNode;
    let offset = sel.anchorOffset;
    if (node.nodeType !== 3) {
      const textNode = document.createTextNode("");
      sel.getRangeAt(0).insertNode(textNode);
      node = textNode;
      offset = 0;
    }
    node.insertData(offset, char);
    const range = document.createRange();
    range.setStart(node, offset + 1);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
  }
}

function key(target, value, opts = {}) {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: value, ...opts });
  target.dispatchEvent(e);
  return e;
}

function options() {
  const list = document.getElementById("who-list");
  return list.hidden ? [] : Array.from(list.querySelectorAll(".who-option"), (li) => [li.textContent, li.getAttribute("aria-selected")]);
}

const owner = () => currentDocument().productionTags[0].owner;

test("typing @ opens the People list, and Tab turns the pick into a chip that owns the sentence's tags", () => {
  const cell = fixture();
  type(cell, "@");
  assert.deepEqual(options(), [["Sam", "true"], ["Sandy", "false"]]);
  type(cell, "sa");
  assert.deepEqual(options(), [["Sam", "true"], ["Sandy", "false"], ["sa", "false"]]);
  undoOwner().flush();
  const steps = undoOwner().sizes().undo;
  assert.equal(key(cell, "Tab").defaultPrevented, true);
  assert.equal(currentWhoList().isOpen(), false);
  assert.match(currentDocument().rows[0].visualText, /for <span class="who-anchor" data-who="Sam" contenteditable="false">@Sam<\/span>$/);
  assert.equal(owner(), "pSam");
  assert.equal(undoOwner().sizes().undo, steps + 1);
  undoOwner().undo();
  assert.match(currentDocument().rows[0].visualText, /for @sa$/);
  assert.equal(owner(), "", "one undo takes back the chip and the owner together");
  undoOwner().redo();
  assert.equal(owner(), "pSam");
});

test("arrow keys move the pick and Enter takes it", () => {
  const cell = fixture();
  type(cell, "@");
  key(cell, "ArrowDown");
  assert.deepEqual(options(), [["Sam", "false"], ["Sandy", "true"]]);
  assert.equal(key(cell, "Enter").defaultPrevented, true);
  assert.match(currentDocument().rows[0].visualText, /data-who="Sandy"/);
  assert.equal(owner(), "pSandy");
});

test("a name not in People yet is added when its chip is made", () => {
  const cell = fixture();
  type(cell, "@Robin");
  assert.deepEqual(options(), [["Robin", "true"]]);
  key(cell, "Tab");
  const robin = currentDocument().people.find((p) => p.name === "Robin");
  assert.ok(robin);
  assert.equal(owner(), robin.id);
  undoOwner().undo();
  assert.equal(currentDocument().people.some((p) => p.name === "Robin"), false);
});

test("an @ inside a word never opens the list, and Tab keeps its normal job", () => {
  const cell = fixture("Mail adam");
  type(cell, "@x.com");
  assert.equal(currentWhoList().isOpen(), false);
  assert.deepEqual(options(), []);
  assert.equal(key(cell, "Tab").defaultPrevented, false);
  assert.doesNotMatch(currentDocument().rows[0].visualText, /who-anchor/);
});

test("Escape closes the list and leaves the typed text; a space after an unknown word closes it too", () => {
  const cell = fixture();
  type(cell, "@Sa");
  key(cell, "Escape");
  assert.equal(currentWhoList().isOpen(), false);
  assert.match(currentDocument().rows[0].visualText, /for @Sa$/);
  type(cell, " @Bo");
  assert.equal(currentWhoList().isOpen(), true);
  type(cell, " went");
  assert.equal(currentWhoList().isOpen(), false);
  assert.equal(key(cell, "Enter").defaultPrevented, true, "Enter is the editor's line break again");
  assert.doesNotMatch(currentDocument().rows[0].visualText, /who-anchor/);
});

test("the list stays shut in the Audio column", () => {
  fixture();
  const audio = document.querySelector("#rows .audio-cell .cell-editable");
  caretAtEnd(audio);
  type(audio, " @");
  assert.equal(currentWhoList().isOpen(), false);
});

test("deleting the chip clears the owner it set, and one undo brings both back", () => {
  const cell = fixture();
  type(cell, "@Sam");
  key(cell, "Tab");
  assert.equal(owner(), "pSam");
  cell.querySelector(".who-anchor").remove();
  cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  assert.equal(owner(), "");
  undoOwner().undo();
  assert.equal(owner(), "pSam");
});
