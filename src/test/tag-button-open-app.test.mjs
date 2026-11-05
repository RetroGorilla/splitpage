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
const { openWriter, closeWriter, writerFlowControl } = await import("../features/writer/writer.ts");

after(closeApp);

function fixture(visualText = "Before  after", audioText = "Audio ") {
  closeWriter();
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

function notice() {
  return [...document.querySelectorAll("#toasts .toast, .toast")].map((el) => el.textContent).join("|");
}

function snapshot(cell) {
  const sel = window.getSelection();
  return { html: cell.innerHTML, doc: currentDocument().rows[0].visualText, steps: undoOwner().sizes(), node: sel.anchorNode, offset: sel.anchorOffset };
}

function pickProp({ button, modal }) {
  button.click();
  modal.querySelector('[data-tag-cat="prop"]').click();
}

const STUCK = [
  ["right after a word", "Words", (cell) => cell.firstChild, 5, ""],
  ["inside a word", "Words", (cell) => cell.firstChild, 2, "rds"],
  ["inside bold text", "<b>Words</b>", (cell) => cell.querySelector("b, strong").firstChild, 5, ""]
];

for (const [label, html, node, offset, tail] of STUCK) {
  test(`Tag opens the category menu ${label}, adds no space and writes nothing until a name is typed`, () => {
    const h = fixture(html);
    caret(h.cell, node(h.cell), offset);
    const plain = h.cell.textContent;
    const before = snapshot(h.cell);
    h.button.click();
    assert.equal(h.modal.hidden, false);
    assert.equal(h.modal.classList.contains("is-category-only"), true);
    h.modal.querySelector('[data-tag-cat="prop"]').click();
    assert.equal(h.modal.hidden, true);
    assert.equal(currentPlainTags().isOpen(h.cell), true);
    assert.equal(h.cell.querySelector(".plain-tag-keyword").textContent, "");
    assert.equal(h.cell.querySelector(".plain-tag-keyword").nextSibling.data, "\u200b" + tail);
    assert.equal(h.cell.textContent.replace(/\u200b/g, ""), plain);
    assert.equal(currentDocument().rows[0].visualText, before.doc);
    assert.deepEqual(undoOwner().sizes(), before.steps);
  });
}

for (const [label, html, node, offset] of STUCK) {
  for (const end of ["Escape", "blur", "caret moved away"]) {
    test(`Tag ${label}: ${end} with nothing typed leaves the cell exactly as it was`, () => {
      const h = fixture(html);
      caret(h.cell, node(h.cell), offset);
      const before = snapshot(h.cell);
      pickProp(h);
      if (end === "Escape") key(h.cell, "Escape");
      else if (end === "blur") h.cell.blur();
      else caret(h.cell, h.cell, 0);
      currentPlainTags().refresh();
      assert.equal(currentPlainTags().isOpen(), false);
      assert.equal(h.cell.innerHTML, before.html);
      assert.equal(currentDocument().rows[0].visualText, before.doc);
      assert.deepEqual(undoOwner().sizes(), before.steps);
      if (end === "Escape") {
        assert.equal(window.getSelection().anchorNode, before.node);
        assert.equal(window.getSelection().anchorOffset, before.offset);
      }
    });
  }
}

for (const end of ["Escape", "blur"]) {
  test(`Tag inside a word: ${end} with a name typed removes only the keyword and keeps the typed words`, () => {
    const h = fixture("Words");
    caret(h.cell, h.cell.firstChild, 2);
    pickProp(h);
    type(h.cell, "Lamp");
    if (end === "Escape") key(h.cell, "Escape");
    else h.cell.blur();
    currentPlainTags().refresh();
    assert.equal(currentPlainTags().isOpen(), false);
    assert.equal(h.cell.textContent, "WoLamprds");
    assert.equal(currentDocument().rows[0].visualText, "WoLamprds");
    assert.equal(h.cell.querySelector(".plain-tag-keyword"), null);
    if (end === "Escape") assert.equal(window.getSelection().anchorOffset, 6);
  });
}

test("Tag after a word: moving the caret away with a name typed never leaves the keyword stuck to the word", () => {
  const h = fixture("Words");
  caret(h.cell, h.cell.firstChild, 5);
  pickProp(h);
  type(h.cell, "Lamp");
  caret(h.cell, h.cell, 0);
  currentPlainTags().refresh();
  assert.equal(currentDocument().rows[0].visualText, "WordsLamp");
});

test("Tag after a word with Bold pending: Escape removes the keyword and its empty bold wrapper", () => {
  const h = fixture("Words");
  caret(h.cell, h.cell.firstChild, 5);
  const before = snapshot(h.cell);
  h.cell.closest(".field-wrap").querySelector('[data-cmd="bold"]').click();
  pickProp(h);
  assert.equal(h.cell.querySelector(".plain-tag-keyword").closest("strong, b") !== null, true);
  key(h.cell, "Escape");
  currentPlainTags().refresh();
  assert.equal(h.cell.innerHTML, before.html);
  assert.equal(currentDocument().rows[0].visualText, before.doc);
  assert.deepEqual(undoOwner().sizes(), before.steps);
  h.cell.closest(".field-wrap").querySelector('[data-cmd="bold"]').click();
});

test("Tag after a word: Tab with a name typed still makes the tag and keeps the word", () => {
  const h = fixture("Words");
  caret(h.cell, h.cell.firstChild, 5);
  pickProp(h);
  type(h.cell, "Lamp");
  key(h.cell, "Tab");
  assert.match(currentDocument().rows[0].visualText, /^Words<span[^>]*data-tag-cat="prop" data-tag-name="Lamp"/);
  assert.equal(currentPlainTags().isOpen(), false);
});

test("Tag inside a word: the name goes between the halves and nothing is lost or reordered", () => {
  const h = fixture("Words");
  caret(h.cell, h.cell.firstChild, 2);
  pickProp(h);
  type(h.cell, "Lamp");
  key(h.cell, "Tab");
  assert.match(currentDocument().rows[0].visualText, /^Wo<span[^>]*data-tag-name="Lamp"[^>]*>Lamp<\/span>rds$/);
});
test("Tag inside a word: Tab with no name typed tags the rest of the line, as an open keyword before text does", () => {
  const { cell, button, modal } = fixture("Words more<br>next line");
  caret(cell, cell.firstChild, 2);
  button.click();
  modal.querySelector('[data-tag-cat="prop"]').click();
  key(cell, "Tab");
  assert.match(currentDocument().rows[0].visualText, /^Wo<span[^>]*data-tag-name="rds more"[^>]*>[^<]*<\/span><br>next line$/);
});
function press(target, value, init = {}) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: value, ...init });
  target.dispatchEvent(event);
  return event;
}

for (const route of ["button", "keyword"]) {
  for (const edit of ["bold", "italic", "underline", "paste", "rich paste", "mixed paste"]) {
    test(`open ${route} tag survives ${edit} until Tab`, () => {
      const h = fixture(route === "button" ? "Words" : "Wo rds");
      caret(h.cell, h.cell.firstChild, route === "button" ? 2 : 3);
      if (route === "button") pickProp(h);
      else type(h.cell, "prop:");
      if (["bold", "italic", "underline"].includes(edit)) {
        press(h.cell, { bold: "b", italic: "i", underline: "u" }[edit], { ctrlKey: true });
        type(h.cell, "Lamp");
      } else {
        const event = new window.Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: {
          types: ["text/plain", "text/html"], files: [],
          getData: kind => kind === "text/plain" ? "Lamp" : edit === "rich paste" ? "<strong>Lamp</strong>" : edit === "mixed paste" ? "La<em>mp</em>" : ""
        } });
        h.cell.dispatchEvent(event);
      }
      assert.equal(currentPlainTags().isOpen(), true);
      key(h.cell, "Tab");
      const tag = h.cell.querySelector('.tag-anchor[data-tag-cat="prop"][data-tag-name="Lamp"]');
      assert.equal(tag?.textContent, "Lamp");
      if (edit !== "paste") {
        const selector = { bold: "strong", italic: "em", underline: "u", "rich paste": "strong", "mixed paste": "em" }[edit];
        assert.equal(tag.querySelector(selector)?.textContent, edit === "mixed paste" ? "mp" : "Lamp");
      }
      assert.equal(h.cell.textContent, route === "button" ? "WoLamprds" : "Wo Lamprds");
    });
  }
}

for (const route of ["button", "keyword"]) {
  for (const [html, text] of [["", "Lamp\nChair"], ["<p>Lamp</p><p><strong>Chair</strong></p>", "Lamp\nChair"], ["Lamp<br>Chair", "Lamp\nChair"]]) {
    test(`open ${route} tag cancels on multiline paste ${JSON.stringify(html)} without losing text`, () => {
      const h = fixture(route === "button" ? "Words" : "Wo rds");
      caret(h.cell, h.cell.firstChild, route === "button" ? 2 : 3);
      if (route === "button") pickProp(h);
      else type(h.cell, "prop:");
      type(h.cell, "Red ");
      const event = new window.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: {
        types: ["text/plain", "text/html"], files: [], getData: kind => kind === "text/plain" ? text : html
      } });
      h.cell.dispatchEvent(event);
      assert.equal(currentPlainTags().isOpen(), false);
      assert.equal(h.cell.querySelector(".tag-anchor, .plain-tag-keyword"), null);
      const stored = currentDocument().rows[0].visualText;
      assert.match(stored, route === "button" ? /^WoRed Lamp<br>/ : /^Wo prop:Red Lamp<br>/);
      assert.match(stored, /Chair(?:<\/strong>)?rds$/);
      if (html.includes("strong")) assert.equal(h.cell.querySelector("strong")?.textContent, "Chair");
      key(h.cell, "Tab");
      assert.equal(currentDocument().rows[0].visualText, stored);
      undoOwner().undo();
      assert.equal(currentDocument().rows[0].visualText, route === "button" ? "WoRed rds" : "Wo prop:Red rds");
      undoOwner().redo();
      assert.equal(currentDocument().rows[0].visualText, stored);
    });
  }
}

test("formatted tag creation keeps conversion and the formatting edit's own undo steps", () => {
  const h = fixture("");
  caret(h.cell, h.cell, 0);
  type(h.cell, "Words");
  pickProp(h);
  press(h.cell, "b", { ctrlKey: true });
  type(h.cell, "Lamp");
  const named = currentDocument().rows[0].visualText;
  assert.equal(named, "Words<strong>Lamp</strong>");
  key(h.cell, "Tab");
  const tagged = currentDocument().rows[0].visualText;
  assert.match(tagged, /data-tag-name="Lamp"/);
  undoOwner().undo();
  assert.equal(currentDocument().rows[0].visualText, named);
  undoOwner().undo();
  assert.equal(currentDocument().rows[0].visualText, "Words<strong>L</strong>");
  undoOwner().undo();
  assert.equal(currentDocument().rows[0].visualText, "Words");
  undoOwner().undo();
  assert.equal(currentDocument().rows[0].visualText, "");
  undoOwner().redo();
  undoOwner().redo();
  undoOwner().redo();
  undoOwner().redo();
  assert.equal(currentDocument().rows[0].visualText, tagged);
});

for (const pick of [false, true]) {
  test(`empty tag cancellation ${pick ? "after" : "before"} picking preserves the typing undo group`, () => {
    const h = fixture("");
    caret(h.cell, h.cell, 0);
    type(h.cell, "Words");
    if (pick) pickProp(h);
    else h.button.click();
    key(document.activeElement, "Escape");
    type(h.cell, "Lamp");
    undoOwner().undo();
    assert.equal(currentDocument().rows[0].visualText, "");
  });
}

test("a first Delete in an open silent tag separates undo even when the caret stays put", () => {
  const h = fixture("");
  caret(h.cell, h.cell, 0);
  type(h.cell, "Words");
  caret(h.cell, h.cell.firstChild, 2);
  pickProp(h);
  assert.equal(press(h.cell, "Delete").defaultPrevented, false);
  const tail = window.getSelection().anchorNode;
  const offset = window.getSelection().anchorOffset;
  tail.deleteData(offset, 1);
  caret(h.cell, tail, offset);
  h.cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentForward", data: null }));
  assert.equal(currentDocument().rows[0].visualText, "Wods");
  key(h.cell, "Escape");
  undoOwner().undo();
  assert.equal(currentDocument().rows[0].visualText, "Words");
  undoOwner().undo();
  assert.equal(currentDocument().rows[0].visualText, "");
});

test("an unchanged input in an open silent tag preserves the earlier typing group", () => {
  const h = fixture("");
  caret(h.cell, h.cell, 0);
  type(h.cell, "Words");
  caret(h.cell, h.cell.firstChild, 2);
  pickProp(h);
  h.cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
  key(h.cell, "Escape");
  type(h.cell, "Lamp");
  assert.equal(currentDocument().rows[0].visualText, "WoLamprds");
  undoOwner().undo();
  assert.equal(currentDocument().rows[0].visualText, "");
});

for (const editor of ["split", "writer"]) {
  for (const wrapper of ["p", "div"]) {
    test(`${editor} tag keeps a single ${wrapper}-wrapped HTML paste open and formatted`, () => {
      const h = fixture("");
      try {
        if (editor === "writer") {
          openWriter();
          writerFlowControl().openVisual("r1");
        }
        const cell = editor === "writer" ? document.querySelector(".wr-flow-visual-text") : h.cell;
        caret(cell, cell, 0);
        type(cell, "prop:");
        const event = new window.Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: {
          types: ["text/plain", "text/html"], files: [],
          getData: kind => kind === "text/plain" ? "Lamp" : `<${wrapper}>La<em>mp</em></${wrapper}>`
        } });
        cell.dispatchEvent(event);
        assert.equal(currentDocument().rows[0].visualText, "prop:La<em>mp</em>");
        assert.equal(currentPlainTags().isOpen(cell), true);
        key(cell, "Tab");
        const tag = cell.querySelector('.tag-anchor[data-tag-cat="prop"][data-tag-name="Lamp"]');
        assert.equal(tag?.textContent, "Lamp");
        assert.equal(tag.querySelector("em")?.textContent, "mp");
        assert.equal(currentDocument().rows[0].visualText,
          '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Lamp" contenteditable="false">La<em>mp</em></span>');
      } finally { closeWriter(); }
    });
  }
}

function never(text) {
  assert.doesNotMatch(text, /prop:/);
  assert.doesNotMatch(text, /plain-tag-keyword/);
}

test("Tag in a word: Backspace with nothing typed cancels, is swallowed and leaves the cell as it was", () => {
  const h = fixture("Words");
  caret(h.cell, h.cell.firstChild, 2);
  const before = snapshot(h.cell);
  pickProp(h);
  const event = press(h.cell, "Backspace");
  currentPlainTags().refresh();
  assert.equal(event.defaultPrevented, true);
  assert.equal(currentPlainTags().isOpen(), false);
  assert.equal(h.cell.innerHTML, before.html);
  assert.equal(currentDocument().rows[0].visualText, before.doc);
  assert.deepEqual(undoOwner().sizes(), before.steps);
});

test("Tag in a word: Backspace after a name was typed is left to the browser", () => {
  const h = fixture("Words");
  caret(h.cell, h.cell.firstChild, 2);
  pickProp(h);
  type(h.cell, "L");
  assert.equal(press(h.cell, "Backspace").defaultPrevented, false);
  assert.equal(currentPlainTags().isOpen(), true);
});

test("a typed keyword's Backspace with nothing typed still cancels and is not swallowed", () => {
  const h = fixture("Before ");
  caret(h.cell, h.cell.firstChild, 7);
  type(h.cell, "prop:");
  assert.equal(currentPlainTags().isOpen(), true);
  assert.equal(press(h.cell, "Backspace").defaultPrevented, false);
  assert.equal(currentPlainTags().isOpen(), false);
});

test("Tag in a word: no edit while the tag is open ever stores the keyword", () => {
  const h = fixture("Words");
  caret(h.cell, h.cell.firstChild, 2);
  pickProp(h);
  never(currentDocument().rows[0].visualText);
  h.cell.closest(".field-wrap").querySelector('[data-cmd="bold"]').click();
  never(JSON.stringify(currentDocument()));
  type(h.cell, "Lamp");
  never(JSON.stringify(currentDocument()));
  press(h.cell, "Enter");
  never(JSON.stringify(currentDocument()));
  currentPlainTags().refresh();
  never(JSON.stringify(currentDocument()));
  assert.equal(h.cell.querySelector(".plain-tag-keyword"), null);
});

test("Tag in a word: undo and redo of the tag never hold the keyword", () => {
  const h = fixture("Words");
  caret(h.cell, h.cell.firstChild, 2);
  pickProp(h);
  type(h.cell, "Lamp");
  key(h.cell, "Tab");
  const tagged = currentDocument().rows[0].visualText;
  assert.match(tagged, /data-tag-name="Lamp"/);
  undoOwner().undo();
  never(currentDocument().rows[0].visualText);
  assert.equal(currentDocument().rows[0].visualText, "WoLamprds");
  undoOwner().redo();
  assert.equal(currentDocument().rows[0].visualText, tagged);
  undoOwner().undo();
  undoOwner().undo();
  assert.equal(currentDocument().rows[0].visualText, "Words");
});

test("Tag after typing: the name does not merge into the typing before it", () => {
  const h = fixture("");
  caret(h.cell, h.cell, 0);
  type(h.cell, "Words");
  pickProp(h);
  type(h.cell, "Lamp");
  assert.equal(currentDocument().rows[0].visualText, "WordsLamp");
  undoOwner().undo();
  assert.equal(currentDocument().rows[0].visualText, "Words");
});
test("typing a keyword right after a word still starts no tag", () => {
  const { cell } = fixture("Words");
  caret(cell, cell.firstChild, 5);
  type(cell, "prop:");
  assert.equal(currentPlainTags().isOpen(), false);
  assert.equal(cell.querySelector(".plain-tag-keyword"), null);
});

for (const [label, html, target, offset, audio, message] of [
  ["Audio", "", null, 0, true, /Visual column/],
  ["a link", '<a href="https://example.com">Link</a>', "a", 0, false, /inside a link/],
  ["a tag", '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Lamp">Lamp</span>', ".tag-anchor", 0, false, /inside another tag/]
]) {
  test(`Tag still refuses a collapsed caret in ${label} and says why`, () => {
    const h = fixture(html, "Audio ");
    const cell = audio ? document.querySelector('#rows .audio-cell .cell-editable') : h.cell;
    const container = target ? cell.querySelector(target) : cell;
    assert.ok(container, `${target}: ${cell.innerHTML}`);
    caret(cell, target ? container.firstChild : cell.firstChild || cell, offset);
    const before = currentDocument().rows[0].visualText;
    cell.closest(".field-wrap").querySelector(".tb-tag").click();
    assert.equal(h.modal.hidden, true);
    assert.equal(currentPlainTags().isOpen(), false);
    assert.equal(currentDocument().rows[0].visualText, before);
    assert.match(notice(), message);
    assert.doesNotMatch(notice(), /Select the words/);
  });
}

test("Tag says an open tag is in progress when one is already open", () => {
  const { cell, button, modal } = fixture("Before ");
  caret(cell, cell.firstChild, 7);
  button.click();
  modal.querySelector('[data-tag-cat="prop"]').click();
  button.click();
  assert.equal(modal.hidden, true);
  assert.match(notice(), /already open/);
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
