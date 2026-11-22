import "./_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayPlacement } from "../features/undo/caret.ts";
import { beatPos } from "../core/flow/flow.ts";
import { cellCaretAfterStep } from "../bootstrap/wiring/editor.ts";

test("undo caret: a cell is measured with the Split decoder, not the Writer media decoder (comment removed in a tag with a picture)", () => {
  const picture = '<img class="comment-img" data-blob="' + "c".repeat(64) + '" data-w="3" data-h="3" data-mime="image/png">';
  const tagged = inner => '<span class="tag-anchor" data-tag-cat="cast" data-tag-name="Ada">' + inner + picture + "b</span>";
  assert.equal(cellCaretAfterStep({ before: tagged('<span class="cmt-anchor" data-cmt="c1">a</span>'), after: tagged("a") }), 2);
});

test("standalone Writer replay prefers the recorded selection to a measured narration step", () => {
  const before = { anchor: beatPos("r1", 1), head: beatPos("r1", 3) };
  const after = { anchor: beatPos("r1", 2), head: beatPos("r1", 2) };
  const steps = [{ op: "rowField", rowId: "r1", key: "audioText", before: "abcd", after: "aZd" }];
  const input = { surface: "writer", recorded: { before, after }, steps };
  assert.deepEqual(replayPlacement({ ...input, dir: "undo" }), { kind: "recorded", range: before });
  assert.deepEqual(replayPlacement({ ...input, dir: "redo" }), { kind: "recorded", range: after });
  assert.deepEqual(replayPlacement({ ...input, recorded: null, dir: "undo" }), { kind: "step", step: steps[0] });
});
