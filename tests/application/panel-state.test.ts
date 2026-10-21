import { test } from "node:test";
import assert from "node:assert/strict";
import { commentSortMode, setCommentSort } from "../../src/application/comment-sort.ts";
import { findMatchesCase, setFindMatchCase } from "../../src/application/find-options.ts";
import {
  gearGroupBy,
  productionGroupBy,
  resetTagPanel,
  setGearGroupBy,
  setProductionGroupBy,
  setTagAddingPerson,
  setTagExpanded,
  setTagRenaming,
  tagAddingPersonKey,
  tagExpandedKey,
  tagRenamingKey
} from "../../src/application/tag-panel-state.ts";

test("the tag panel starts on the category view with nothing open", () => {
  assert.equal(tagRenamingKey(), null);
  assert.equal(tagExpandedKey(), null);
  assert.equal(tagAddingPersonKey(), null);
  assert.equal(productionGroupBy(), "cat");
  assert.equal(gearGroupBy(), "flat");
});

test("resetting the tag panel closes its rows and the production grouping but keeps the gear grouping", () => {
  setTagRenaming("prop:hat");
  setTagExpanded("prop:hat");
  setTagAddingPerson("__bulk__");
  setProductionGroupBy("scene");
  setGearGroupBy("scene");
  assert.equal(tagRenamingKey(), "prop:hat");
  assert.equal(tagExpandedKey(), "prop:hat");
  assert.equal(tagAddingPersonKey(), "__bulk__");
  resetTagPanel();
  assert.equal(tagRenamingKey(), null);
  assert.equal(tagExpandedKey(), null);
  assert.equal(tagAddingPersonKey(), null);
  assert.equal(productionGroupBy(), "cat");
  assert.equal(gearGroupBy(), "scene");
  setGearGroupBy("flat");
});

test("find is case-insensitive until the match-case button turns it on", () => {
  assert.equal(findMatchesCase(), false);
  setFindMatchCase(true);
  assert.equal(findMatchesCase(), true);
  setFindMatchCase(false);
});

test("the comment sort accepts only recent or position and falls back to position", () => {
  assert.equal(commentSortMode(), "position");
  assert.equal(setCommentSort("recent"), "recent");
  assert.equal(commentSortMode(), "recent");
  assert.equal(setCommentSort("bogus"), "position");
  assert.equal(commentSortMode(), "position");
});
