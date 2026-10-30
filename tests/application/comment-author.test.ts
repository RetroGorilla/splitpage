import test from "node:test";
import assert from "node:assert/strict";
import { getSavedAuthorName, saveAuthorName } from "../../src/application/comment-author.ts";

test("the saved author name is read from preferences and cleaned", () => {
  assert.equal(getSavedAuthorName({ commentAuthor: () => "  Mara Quill " }), "Mara Quill");
});

test("a missing or blank saved author name reads as an empty string", () => {
  assert.equal(getSavedAuthorName({ commentAuthor: () => "" }), "");
  assert.equal(getSavedAuthorName({ commentAuthor: () => "   " }), "");
  assert.equal(getSavedAuthorName({ commentAuthor: () => null as unknown as string }), "");
});

test("a name is cleaned before it is remembered", () => {
  const remembered: string[] = [];
  saveAuthorName({ rememberCommentAuthor: (name) => { remembered.push(name); } }, "  Mara Quill ");
  assert.deepEqual(remembered, ["Mara Quill"]);
});

test("a non-text or blank name is remembered as an empty string, clearing the saved one", () => {
  const remembered: string[] = [];
  const preferences = { rememberCommentAuthor: (name: string) => { remembered.push(name); } };
  saveAuthorName(preferences, 42);
  saveAuthorName(preferences, null);
  saveAuthorName(preferences, "   ");
  assert.deepEqual(remembered, ["", "", ""]);
});
