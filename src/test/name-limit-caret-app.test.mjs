import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const GRIN = String.fromCodePoint(0x1F600);
const NAME_KEY = "splitpage-comment-author";
const FULL = "abcdefghij".repeat(3);

await bootApp(JSON.stringify({ schema: 2, title: "Mine", rows: [], rev: 5 }));

const { migrateRows } = await import("../js/02-state.js");
const { promptForName } = await import("../js/03-sync.js");
const { toggleReplyComposer } = await import("../js/10-comments.js");
const { maybeAskGuestName } = await import("../js/13b-collaborate.js");
const { openSettings } = await import("../features/settings/settings.js");
const { render } = await import("../js/05-render.js");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

function insert(field, at, text, end = at, inputType = "insertText") {
  const v = field.value;
  field.value = v.slice(0, at) + text + v.slice(end);
  field.setSelectionRange(at + text.length, at + text.length);
  field.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType, data: inputType === "insertText" ? text : null }));
  return { value: field.value, caret: field.selectionStart, end: field.selectionEnd };
}

function fresh(field, value, caret) {
  field.value = value;
  field.setSelectionRange(caret, caret);
}

function commentName() {
  return document.getElementById("comment-name");
}

test("typing in the middle of a full name is refused: the text is unchanged and the caret stays", () => {
  const field = commentName();
  fresh(field, FULL, 10);
  assert.deepEqual(insert(field, 10, "X"), { value: FULL, caret: 10, end: 10 });
});

test("typing at the start and at the end of a full name is refused the same way", () => {
  const field = commentName();
  fresh(field, FULL, 0);
  assert.deepEqual(insert(field, 0, "X"), { value: FULL, caret: 0, end: 0 });
  fresh(field, FULL, 30);
  assert.deepEqual(insert(field, 30, "X"), { value: FULL, caret: 30, end: 30 });
});

test("typing in the middle of a name with room for it is kept, with the caret after the character", () => {
  const field = commentName();
  const name = FULL.slice(0, 29);
  fresh(field, name, 10);
  assert.deepEqual(insert(field, 10, "X"), { value: name.slice(0, 10) + "X" + name.slice(10), caret: 11, end: 11 });
});

test("replacing a selection in a full name with one character is kept", () => {
  const field = commentName();
  fresh(field, FULL, 3);
  assert.deepEqual(insert(field, 3, "Z", 6), { value: FULL.slice(0, 3) + "Z" + FULL.slice(6), caret: 4, end: 4 });
});

test("a paste into the middle of a nearly full name keeps what fits, and the text after it", () => {
  const field = commentName();
  const name = FULL.slice(0, 28);
  fresh(field, name, 5);
  assert.deepEqual(insert(field, 5, "12345"), { value: name.slice(0, 5) + "12" + name.slice(5), caret: 7, end: 7 });
});

test("a paste into a full name is refused whole", () => {
  const field = commentName();
  fresh(field, FULL, 12);
  assert.deepEqual(insert(field, 12, "pasted text"), { value: FULL, caret: 12, end: 12 });
});

test("a paste over a selection keeps its first 30 characters when it is longer", () => {
  const field = commentName();
  fresh(field, FULL, 0);
  const pasted = "0123456789".repeat(4);
  assert.deepEqual(insert(field, 0, pasted, 30), { value: pasted.slice(0, 30), caret: 30, end: 30 });
});

test("an emoji counts as one character: refused whole when full, kept whole when it fits", () => {
  const field = commentName();
  const name = GRIN + "b".repeat(29);
  fresh(field, name, 2);
  assert.deepEqual(insert(field, 2, GRIN), { value: name, caret: 2, end: 2 });
  const shorter = GRIN + "b".repeat(28);
  fresh(field, shorter, 2);
  assert.deepEqual(insert(field, 2, GRIN + GRIN), { value: GRIN + GRIN + "b".repeat(28), caret: 4, end: 4 });
});

const FLAG = String.fromCodePoint(0x1F1E9, 0x1F1F0);
const FAMILY = String.fromCodePoint(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467);
const THUMB = String.fromCodePoint(0x1F44D, 0x1F3FD);
const ACUTE = String.fromCodePoint(0x301);

const CLUSTERS = [
  ["flag", FLAG, 2],
  ["family emoji", FAMILY, 5],
  ["skin-tone emoji", THUMB, 2],
  ["keycap", "1️⃣", 3]
];

for (const inputType of ["insertText", "insertFromPaste"]) {
  const how = inputType === "insertText" ? "typed" : "pasted";
  for (const [label, emoji, size] of CLUSTERS) {
    test(`a ${label} ${how} where it does not fit is refused whole, at the end and in the middle`, () => {
      const field = commentName();
      const name = FULL.slice(0, 30 - size + 1);
      fresh(field, name, name.length);
      assert.deepEqual(insert(field, name.length, emoji, name.length, inputType), { value: name, caret: name.length, end: name.length });
      fresh(field, name, 5);
      assert.deepEqual(insert(field, 5, emoji, 5, inputType), { value: name, caret: 5, end: 5 });
    });

    test(`a ${label} ${how} where it fits exactly is kept whole`, () => {
      const field = commentName();
      const name = FULL.slice(0, 30 - size);
      fresh(field, name, 5);
      const expected = name.slice(0, 5) + emoji + name.slice(5);
      assert.deepEqual(insert(field, 5, emoji, 5, inputType), { value: expected, caret: 5 + emoji.length, end: 5 + emoji.length });
    });
  }
}

test("a character typed after a whole emoji in a full name is refused and the emoji stays", () => {
  const field = commentName();
  const name = FULL.slice(0, 30 - 5) + FAMILY;
  fresh(field, name, name.length);
  assert.deepEqual(insert(field, name.length, "x"), { value: name, caret: name.length, end: name.length });
});

test("a combining mark typed after a letter in a full plain-text name is refused alone, as before", () => {
  const field = commentName();
  fresh(field, FULL, 10);
  assert.deepEqual(insert(field, 10, ACUTE), { value: FULL, caret: 10, end: 10 });
});

test("a value set in code that ends in half a flag over the limit is cut before the flag", () => {
  const field = commentName();
  const name = FULL.slice(0, 29);
  field.value = name + FLAG;
  field.setSelectionRange(0, 5);
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(field.value, name);
});

test("while a composition is open the field is left alone; it is cut when the composition ends", () => {
  const field = commentName();
  const name = FULL.slice(0, 29);
  fresh(field, name, 10);
  field.value = name.slice(0, 10) + "ABC" + name.slice(10);
  field.setSelectionRange(13, 13);
  field.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "ABC", isComposing: true }));
  assert.equal(field.value, name.slice(0, 10) + "ABC" + name.slice(10));
  assert.equal(field.selectionStart, 13);
  field.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "ABC" }));
  assert.equal(field.value, name.slice(0, 10) + "A" + name.slice(10));
  assert.equal(field.selectionStart, 11);
});

test("a value set in code over the limit is still cut at the end", () => {
  const field = commentName();
  field.value = FULL + "tail";
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(field.value, FULL);
});

function openReply() {
  loadTestDocument(migrateRows({
    schema: 2, title: "T",
    rows: [{ id: "r1", status: "todo", audioText: "the mug", visualText: "" }],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", anchorId: "c1", quotedText: "mug", author: "Ann", body: "x", createdAt: "2026-10-01T10:00:00Z", kind: "anchor", replies: [] }]
  }));
  render();
  toggleReplyComposer("c1");
  return document.querySelector(".reply-composer .reply-name-input");
}

const OTHER_FIELDS = [
  ["reply", openReply],
  ["identity chip", () => { localStorage.setItem(NAME_KEY, "Sam"); promptForName(); return document.getElementById("identity-input"); }],
  ["Settings", () => { localStorage.setItem(NAME_KEY, "Sam"); openSettings(); return document.getElementById("settings-name"); }],
  ["guest", () => { localStorage.removeItem(NAME_KEY); sessionStorage.clear(); maybeAskGuestName(); return document.getElementById("guest-name"); }]
];

for (const [label, open] of OTHER_FIELDS) {
  test(`the ${label} name field refuses typing in the middle of a full name and keeps the caret`, () => {
    const field = open();
    assert.ok(field, "the field shows");
    fresh(field, FULL, 10);
    assert.deepEqual(insert(field, 10, "X"), { value: FULL, caret: 10, end: 10 });
  });
}
