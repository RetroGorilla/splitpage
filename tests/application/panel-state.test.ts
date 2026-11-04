import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrollAnchoring } from "../../src/application/broll-anchoring.ts";
import { createCommentSorting } from "../../src/application/comment-sort.ts";
import { createFindOptions } from "../../src/application/find-options.ts";
import { createImportMode } from "../../src/application/import-mode.ts";
import { createPrompterState } from "../../src/application/prompter-state.ts";
import { createTagPanelState } from "../../src/application/tag-panel-state.ts";

test("the tag panel starts on Scene prep with nothing open", () => {
  const panel = createTagPanelState();
  assert.equal(panel.tagRenamingKey(), null);
  assert.equal(panel.tagExpandedKey(), null);
  assert.equal(panel.tagAddingPersonKey(), null);
  assert.equal(panel.productionGroupBy(), "prep");
  assert.equal(panel.gearGroupBy(), "flat");
});

test("resetting the tag panel closes its rows and the production grouping but keeps the gear grouping", () => {
  const panel = createTagPanelState();
  panel.setTagRenaming("prop:hat");
  panel.setTagExpanded("prop:hat");
  panel.setTagAddingPerson("__bulk__");
  panel.setProductionGroupBy("scene");
  panel.setGearGroupBy("scene");
  assert.equal(panel.tagRenamingKey(), "prop:hat");
  assert.equal(panel.tagExpandedKey(), "prop:hat");
  assert.equal(panel.tagAddingPersonKey(), "__bulk__");
  panel.resetTagPanel();
  assert.equal(panel.tagRenamingKey(), null);
  assert.equal(panel.tagExpandedKey(), null);
  assert.equal(panel.tagAddingPersonKey(), null);
  assert.equal(panel.productionGroupBy(), "prep");
  assert.equal(panel.gearGroupBy(), "scene");
});

test("find is case-insensitive until the match-case button turns it on", () => {
  const find = createFindOptions();
  assert.equal(find.matchesCase(), false);
  find.setMatchCase(true);
  assert.equal(find.matchesCase(), true);
  find.setMatchCase(false);
  assert.equal(find.matchesCase(), false);
});

test("the comment sort accepts only recent or position and falls back to position", () => {
  const sort = createCommentSorting();
  assert.equal(sort.current(), "position");
  assert.equal(sort.choose("recent"), "recent");
  assert.equal(sort.current(), "recent");
  assert.equal(sort.choose("bogus"), "position");
  assert.equal(sort.current(), "position");
});

test("the prompter starts closed, paused, showing shot scenes and not following the voice", () => {
  const prompter = createPrompterState();
  assert.deepEqual([prompter.isOpen(), prompter.isPlaying(), prompter.skipsShot(), prompter.voiceFollowing()], [false, false, false, false]);
  prompter.setOpen(true);
  prompter.setPlaying(true);
  prompter.setSkipShot(true);
  prompter.setVoiceFollowing(true);
  assert.deepEqual([prompter.isOpen(), prompter.isPlaying(), prompter.skipsShot(), prompter.voiceFollowing()], [true, true, true, true]);
});

test("the import mode is untouched until the user picks one, and a reset forgets the pick", () => {
  const mode = createImportMode();
  assert.equal(mode.touched(), false);
  mode.touch();
  assert.equal(mode.touched(), true);
  mode.reset();
  assert.equal(mode.touched(), false);
});

test("declined b-roll rows stay declined until a reset", () => {
  const anchoring = createBrollAnchoring();
  assert.equal(anchoring.declined("r1"), false);
  anchoring.decline([{ id: "r1" }]);
  anchoring.decline(null);
  assert.equal(anchoring.declined("r1"), true);
  assert.equal(anchoring.declined("r2"), false);
  assert.equal(anchoring.declined("toString"), false);
  anchoring.reset();
  assert.equal(anchoring.declined("r1"), false);
});

test("each owner holds its own state", () => {
  const first = createPrompterState();
  const second = createPrompterState();
  first.setOpen(true);
  assert.equal(second.isOpen(), false);
  const panelA = createTagPanelState();
  const panelB = createTagPanelState();
  panelA.setGearGroupBy("scene");
  assert.equal(panelB.gearGroupBy(), "flat");
});
