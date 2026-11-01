import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { AUTHOR_NAME_FIELDS, limitAuthorNameField } from "../../../src/features/comments/comments.ts";
import { EDITOR_NAME_MAX } from "../../../src/core/document/fields.ts";

function field(value: string, caret?: number, end?: number): HTMLInputElement {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.value = value;
  if (caret !== undefined) input.setSelectionRange(caret, end ?? caret);
  return input;
}

const MAX = EDITOR_NAME_MAX;

test("limitAuthorNameField: leaves a name at or under the limit alone", () => {
  const exact = field("a".repeat(MAX), 5);
  limitAuthorNameField(exact);
  assert.equal(exact.value, "a".repeat(MAX));
  assert.equal(exact.selectionStart, 5);
  const short = field("Sam");
  limitAuthorNameField(short);
  assert.equal(short.value, "Sam");
});

test("limitAuthorNameField: cuts the end off when the caret is inside the surplus", () => {
  const input = field("a".repeat(MAX + 5), MAX + 5);
  limitAuthorNameField(input);
  assert.equal(input.value, "a".repeat(MAX));
});

test("limitAuthorNameField: cuts the end when the caret sits at the start of an overlong value", () => {
  const input = field("b".repeat(MAX + 3), 0);
  limitAuthorNameField(input);
  assert.equal(input.value, "b".repeat(MAX));
});

test("limitAuthorNameField: removes the surplus just before the caret, as when typing in the middle", () => {
  const input = field("a".repeat(10) + "NEW" + "b".repeat(MAX - 10), 13);
  limitAuthorNameField(input);
  assert.equal(input.value, "a".repeat(10) + "b".repeat(MAX - 10));
  assert.equal(input.selectionStart, 10);
  assert.equal(input.selectionEnd, 10);
});

test("limitAuthorNameField: with a selection range, trims from the end instead of the caret", () => {
  const input = field("c".repeat(MAX + 4), 2, 8);
  limitAuthorNameField(input);
  assert.equal(input.value, "c".repeat(MAX));
});

test("limitAuthorNameField: counts an emoji as one character", () => {
  const emoji = "\u{1F600}";
  const fits = field(emoji.repeat(MAX), MAX * 2);
  limitAuthorNameField(fits);
  assert.equal(Array.from(fits.value).length, MAX);
  const over = field(emoji.repeat(MAX + 2), (MAX + 2) * 2);
  limitAuthorNameField(over);
  assert.equal(over.value, emoji.repeat(MAX));
});

test("limitAuthorNameField: never cuts through a flag or a joined emoji", () => {
  const flag = "\u{1F1E9}\u{1F1EA}";
  const flags = flag.repeat(MAX);
  const input = field("a" + flags, 1 + flags.length);
  limitAuthorNameField(input);
  const rest = input.value.slice(1);
  assert.equal(rest.length % flag.length, 0);
  assert.equal(rest, flag.repeat(rest.length / flag.length));
});

test("limitAuthorNameField: keeps the whole family emoji or drops all of it", () => {
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
  const input = field("a".repeat(MAX - 2) + family, (MAX - 2) + family.length);
  limitAuthorNameField(input);
  const kept = input.value.slice(MAX - 2);
  assert.ok(kept === "" || kept === family, "got " + JSON.stringify(kept));
});

test("AUTHOR_NAME_FIELDS: names the four author name inputs", () => {
  assert.deepEqual(AUTHOR_NAME_FIELDS.split(",").map((s) => s.trim()), [
    "#settings-name", "#comment-name", ".reply-name-input", "#identity-input"
  ]);
});
