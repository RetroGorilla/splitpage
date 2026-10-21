import { test } from "node:test";
import assert from "node:assert/strict";
import { createMergeUndo } from "../../src/application/session/merge-undo.ts";

test("the merge undo holds the last armed record until another arm replaces or clears it", () => {
  const undo = createMergeUndo();
  assert.equal(undo.last(), null);
  const first = { id: "s-1", docId: "d1", source: "stash" };
  const second = { id: "s-2", docId: "d1", source: "server-conflict" };
  undo.arm(first);
  assert.equal(undo.last(), first);
  undo.arm(second);
  assert.equal(undo.last(), second);
  undo.arm(null);
  assert.equal(undo.last(), null);
});

test("two merge undos do not share a record", () => {
  const one = createMergeUndo();
  const two = createMergeUndo();
  one.arm({ id: "s-1", docId: "d1", source: undefined });
  assert.equal(two.last(), null);
});
