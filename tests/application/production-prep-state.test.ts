import { test } from "node:test";
import assert from "node:assert/strict";
import { createProductionPrepState } from "../../src/application/production/prep-state.ts";

test("prep opens around the focused beat once, preserving browsing until the document lifetime changes", () => {
  const state = createProductionPrepState();
  state.initialize(1, "scene-d", "r119", 17);
  assert.equal(state.current().offsets.get("scene-d"), 12);
  assert.equal(state.current().beat, "r119");
  state.toggleScene("scene-d");
  state.toggleScene("scene-a");
  state.toggleNotes("some notes");
  state.initialize(1, "scene-b", "r40", 5);
  assert.deepEqual([...state.current().scenes], ["scene-a"]);
  assert.equal(state.current().beat, "r119");
  state.initialize(2, "scene-b", "r40", 5);
  assert.deepEqual([...state.current().scenes], ["scene-b"]);
  assert.equal(state.current().beat, "r40");
  assert.equal(state.current().notes, null);
});

test("prep folds and progressive disclosure are independent for each scene", () => {
  const state = createProductionPrepState();
  state.initialize(1, "a", "r1", 0);
  state.showMore("a");
  state.showMore("b");
  state.toggleFilmed("a");
  state.toggleRequirements("b");
  state.toggleSelecting();
  assert.equal(state.current().shown.get("a"), 16);
  assert.equal(state.current().shown.get("b"), 16);
  assert.equal(state.current().filmed.has("a"), true);
  assert.equal(state.current().filmed.has("b"), false);
  assert.equal(state.current().requirements.has("a"), false);
  assert.equal(state.current().requirements.has("b"), true);
  state.reset();
  assert.equal(state.current().scenes.size, 0);
  assert.equal(state.current().selecting, false);
});

test("an explicit script tag reveal opens the correct scene, beat and notes without losing other scene folds", () => {
  const state = createProductionPrepState();
  state.initialize(1, "a", "r1", 0);
  state.reveal("d", "r119", 17, "d/r119/hat");
  assert.deepEqual([...state.current().scenes], ["a", "d"]);
  assert.equal(state.current().offsets.get("d"), 12);
  assert.equal(state.current().notes, "d/r119/hat");
  state.toggleBeat("r119");
  assert.equal(state.current().beat, null);
  assert.equal(state.current().notes, null);
});
