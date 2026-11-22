import "./_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cellCaretAfterStep } from "../bootstrap/wiring/editor.ts";

test("undo caret: a cell is measured with the Split decoder, not the Writer media decoder (comment removed in a tag with a picture)", () => {
  const picture = '<img class="comment-img" data-blob="' + "c".repeat(64) + '" data-w="3" data-h="3" data-mime="image/png">';
  const tagged = inner => '<span class="tag-anchor" data-tag-cat="cast" data-tag-name="Ada">' + inner + picture + "b</span>";
  assert.equal(cellCaretAfterStep({ before: tagged('<span class="cmt-anchor" data-cmt="c1">a</span>'), after: tagged("a") }), 2);
});
