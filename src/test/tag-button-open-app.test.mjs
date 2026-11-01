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
const { currentPlainTags } = await import("../bootstrap/wiring/plain-tags.ts");

after(closeApp);

function fixture(visualText = "Before  after", audioText = "Audio ") {
  currentPlainTags().cancelCategory();
  currentPlainTags().cancel();
  loadTestDocument(migrateRows({ schema: 2, title: "Tag button", rows: [{ id: "r1", visualText, audioText, status: "todo" }] }));
  undoOwner().flush();
  const cell = document.querySelector('#rows .visual-cell .cell-editable');
  const button = cell.closest(".field-wrap").querySelector(".tb-tag");
  return { cell, button, modal: document.getElementById("tag-modal") };
}

function caret(cell, node, offset) {
  cell.focus();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function type(cell, text) {
  for (const char of text) {
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: char });
    cell.dispatchEvent(before);
    if (before.defaultPrevented) continue;
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
    caret(cell, node, offset + char.length);
    cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
  }
}

function key(target, value) {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: value }));
}

test("Tag at a Visual caret chooses a category and inserts one undoable open keyword at the saved position", () => {
  const { cell, button, modal } = fixture();
  caret(cell, cell.firstChild, 7);
  const before = undoOwner().sizes().undo;
  button.click();
  assert.equal(modal.hidden, false);
  assert.equal(modal.classList.contains("is-category-only"), true);
  assert.equal(document.activeElement, modal.querySelector(".tag-cat-btn"));
  modal.querySelector('[data-tag-cat="prop"]').click();
  assert.equal(modal.hidden, true);
  assert.equal(currentDocument().rows[0].visualText, "Before prop: after");
  assert.equal(currentPlainTags().isOpen(cell), true);
  const span = cell.querySelector(".plain-tag-keyword");
  assert.equal(span.textContent, "prop:");
  assert.equal(span.nextSibling.data, "\u200b after");
  assert.equal(document.activeElement, cell);
  assert.equal(window.getSelection().anchorNode, span.nextSibling);
  assert.equal(window.getSelection().anchorOffset, 1);
  assert.equal(undoOwner().sizes().undo, before + 1);
  undoOwner().undo();
  assert.equal(currentDocument().rows[0].visualText, "Before  after");
});

test("a repaint while choosing a category never inserts at a relocated caret", () => {
  const { cell, button, modal } = fixture();
  caret(cell, cell.firstChild, 7);
  button.click();
  const html = cell.innerHTML;
  cell.innerHTML = html;
  modal.querySelector('[data-tag-cat="prop"]').click();
  assert.equal(currentDocument().rows[0].visualText, "Before  after");
  assert.equal(currentPlainTags().isOpen(), false);
});

for (const dismiss of ["Escape", "backdrop", "close"]) {
  test(`category-only ${dismiss} dismisses without an edit and restores the saved caret`, () => {
    const { cell, button, modal } = fixture();
    caret(cell, cell.firstChild, 7);
    const before = JSON.stringify(currentDocument());
    const steps = undoOwner().sizes().undo;
    button.click();
    if (dismiss === "Escape") key(document.activeElement, "Escape");
    else if (dismiss === "backdrop") modal.click();
    else document.getElementById("tag-close").click();
    assert.equal(modal.hidden, true);
    assert.equal(modal.classList.contains("is-category-only"), false);
    assert.equal(document.activeElement, cell);
    assert.equal(window.getSelection().anchorNode, cell.firstChild);
    assert.equal(window.getSelection().anchorOffset, 7);
    assert.equal(JSON.stringify(currentDocument()), before);
    assert.equal(undoOwner().sizes().undo, steps);
  });
}

for (const [category, keyword] of [["prop", "prop"], ["location", "location"], ["cast", "cast"], ["vfx", "vfx"], ["sound", "sfx"], ["gear", "gear"]]) {
  test(`the ${category} category opens at an empty cell's element caret`, () => {
    const { cell, button, modal } = fixture("");
    caret(cell, cell, 0);
    button.click();
    modal.querySelector(`[data-tag-cat="${category}"]`).click();
    assert.equal(currentDocument().rows[0].visualText, `${keyword}:`);
    assert.equal(currentPlainTags().isOpen(cell), true);
    assert.equal(currentPlainTags().emptyAtCaret(), true);
    type(cell, "Lens");
    key(cell, "Tab");
    assert.match(currentDocument().rows[0].visualText, new RegExp(`data-tag-cat="${category}" data-tag-name="Lens"`));
  });
}

for (const end of ["Enter", "Escape", "blur", "Tab"]) {
  test(`button and typed keyword have identical ${end} behavior`, () => {
    const run = (buttonRoute) => {
      const { cell, button, modal } = fixture("Before ");
      caret(cell, cell.firstChild, 7);
      if (buttonRoute) {
        button.click();
        modal.querySelector('[data-tag-cat="prop"]').click();
      } else type(cell, "prop:");
      type(cell, "Lamp");
      if (end === "blur") cell.blur();
      else key(cell, end);
      currentPlainTags().refresh();
      return {
        html: currentDocument().rows[0].visualText,
        open: currentPlainTags().isOpen(),
        registry: currentDocument().productionTags.map(({ cat, name }) => ({ cat, name }))
      };
    };
    assert.deepEqual(run(true), run(false));
  });
}

test("Tag refuses collapsed carets in Audio, a link, a tag or after a word, as typed keywords do", () => {
  for (const [html, target, offset, audio] of [
    ["Words", null, 5, false],
    ['<b>Words</b>', "b, strong", 5, false],
    ['<a href="https://example.com">Link</a>', "a", 0, false],
    ['<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Lamp">Lamp</span>', ".tag-anchor", 0, false],
    ["", null, 0, true]
  ]) {
    const h = fixture(html, "Audio ");
    const cell = audio ? document.querySelector('#rows .audio-cell .cell-editable') : h.cell;
    const container = target ? cell.querySelector(target) : cell;
    assert.ok(container, `${target}: ${cell.innerHTML}`);
    const node = target ? container.firstChild : cell.firstChild || cell;
    caret(cell, node, offset);
    const before = JSON.stringify(currentDocument());
    cell.closest(".field-wrap").querySelector(".tb-tag").click();
    assert.equal(h.modal.hidden, true, html || "Audio");
    assert.equal(currentPlainTags().isOpen(), false);
    assert.equal(JSON.stringify(currentDocument()), before);
  }
});

test("a selection still opens the full composer and adds its chosen label", () => {
  const { cell, button, modal } = fixture("Lamp");
  caret(cell, cell.firstChild, 0);
  window.getSelection().getRangeAt(0).setEnd(cell.firstChild, 4);
  button.click();
  assert.equal(modal.hidden, false);
  assert.equal(modal.classList.contains("is-category-only"), false);
  assert.equal(document.getElementById("tag-name").value, "Lamp");
  modal.querySelector('[data-tag-cat="gear"]').click();
  assert.equal(modal.hidden, false);
  document.getElementById("tag-apply").click();
  assert.match(currentDocument().rows[0].visualText, /data-tag-cat="gear" data-tag-name="Lamp"/);
});

for (const [command, html] of [["bold", "Before "], ["italic", "Before "], ["bold", "<strong>Before </strong>"], ["italic", "<em>Before </em>"]]) {
  test(`button keyword keeps pending ${command} formatting for ${html}`, () => {
    const run = (buttonRoute) => {
      const { cell, button, modal } = fixture(html);
      const node = cell.querySelector("strong, em")?.firstChild || cell.firstChild;
      caret(cell, node, node.length);
      cell.closest(".field-wrap").querySelector(`[data-cmd="${command}"]`).click();
      if (buttonRoute) {
        button.click();
        modal.querySelector('[data-tag-cat="prop"]').click();
      } else type(cell, "prop:");
      assert.equal(currentPlainTags().isOpen(cell), true);
      type(cell, "Lamp");
      key(cell, "Tab");
      return currentDocument().rows[0].visualText;
    };
    assert.equal(run(true), run(false));
  });
}
