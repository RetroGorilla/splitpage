import { test } from "node:test";
import assert from "node:assert/strict";
import { createFocusMemory } from "../../../src/application/editing/focus-memory.ts";

interface Cell { readonly id: string }

test("focus memory starts empty and keeps the last scene and Writer paragraph the editor focused", () => {
  const memory = createFocusMemory<Cell>();
  assert.equal(memory.lastRow(), null);
  assert.equal(memory.writerParagraph(), null);
  const para = { id: "p1" };
  memory.focusedRow("r1");
  memory.focusedParagraph(para);
  memory.focusedRow("r2");
  assert.equal(memory.lastRow(), "r2");
  assert.equal(memory.writerParagraph(), para);
  memory.focusedParagraph(null);
  assert.equal(memory.writerParagraph(), null);
  assert.equal(memory.lastRow(), "r2", "forgetting the paragraph keeps the scene");
});

test("the untagged prompt stays muted for one cell until it is unmuted", () => {
  const memory = createFocusMemory<Cell>();
  const a = { id: "a" };
  const b = { id: "b" };
  assert.equal(memory.promptMutedFor(), null);
  memory.mutePrompt(a);
  assert.equal(memory.promptMutedFor(), a);
  memory.mutePrompt(b);
  assert.equal(memory.promptMutedFor(), b, "muting another cell moves the mute");
  memory.unmutePrompt();
  assert.equal(memory.promptMutedFor(), null);
});

test("two focus memories share nothing", () => {
  const one = createFocusMemory<Cell>();
  const two = createFocusMemory<Cell>();
  one.focusedRow("r1");
  one.mutePrompt({ id: "a" });
  assert.equal(two.lastRow(), null);
  assert.equal(two.promptMutedFor(), null);
});
