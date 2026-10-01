import { test } from "node:test";
import assert from "node:assert/strict";
import type { StateField } from "../../../src/core/document/fields.ts";
import type { MergeConflict } from "../../../src/core/merge/rows.ts";
import {
  mergeChangedSideWins, mergeMaxPlusOne, mergeTargetLength, mergeTheirsWins, mergeTitle
} from "../../../src/core/merge/scalars.ts";

function title(base: string | null, mine: string, theirs: string) {
  const conflicts: MergeConflict[] = [];
  const out = mergeTitle(base === null ? null : { title: base }, { title: mine }, { title: theirs }, conflicts);
  return { out: out, conflicts: conflicts };
}

test("title: the side that changed wins, and a change on both sides keeps theirs and records mine", () => {
  assert.deepEqual(title("Base", "Mine", "Base"), { out: "Mine", conflicts: [] });
  assert.deepEqual(title("Base", "Base", "Theirs"), { out: "Theirs", conflicts: [] });
  assert.deepEqual(title("Base", "Same", "Same"), { out: "Same", conflicts: [] });
  assert.deepEqual(title("Base", "Mine", "Theirs"),
    { out: "Theirs", conflicts: [{ rowId: null, field: "title", mine: "Mine", theirs: "Theirs" }] });
  assert.deepEqual(title(null, "Mine", "Theirs"),
    { out: "Theirs", conflicts: [{ rowId: null, field: "title", mine: "Mine", theirs: "Theirs" }] });
  assert.deepEqual(title("Base", "", "Theirs"), { out: "Theirs", conflicts: [] }, "a cleared title of mine is no conflict card");
});

const WPM: StateField = { key: "wordsPerMinute", def: function () { return 150; }, merge: "changed-side-wins", undo: true };
const NO_DEF: StateField = { key: "probe", merge: "changed-side-wins", undo: true };

test("changed-side-wins: mine when only mine changed, else theirs, then mine, then the default", () => {
  assert.equal(mergeChangedSideWins(WPM, { wordsPerMinute: 150 }, { wordsPerMinute: 180 }, { wordsPerMinute: 150 }), 180);
  assert.equal(mergeChangedSideWins(WPM, { wordsPerMinute: 150 }, { wordsPerMinute: 150 }, { wordsPerMinute: 200 }), 200);
  assert.equal(mergeChangedSideWins(WPM, { wordsPerMinute: 150 }, { wordsPerMinute: 180 }, { wordsPerMinute: 200 }), 200);
  assert.equal(mergeChangedSideWins(WPM, null, { wordsPerMinute: 180 }, { wordsPerMinute: 150 }), 150);
  assert.equal(mergeChangedSideWins(WPM, null, { wordsPerMinute: 180 }, {}), 180);
  assert.equal(mergeChangedSideWins(WPM, { wordsPerMinute: 150 }, { wordsPerMinute: 0 }, { wordsPerMinute: 150 }), 150);
  assert.equal(mergeChangedSideWins(WPM, null, {}, {}), 150);
  assert.equal(mergeChangedSideWins(NO_DEF, null, {}, {}), null);
});

test("max-plus-one and theirs-wins", () => {
  assert.equal(mergeMaxPlusOne("rev", { rev: 9 }, { rev: 6 }), 10);
  assert.equal(mergeMaxPlusOne("rev", {}, { rev: undefined }), 1);
  assert.equal(mergeTheirsWins("lastEditedBy", { lastEditedBy: "Mine" }, { lastEditedBy: "Theirs" }), "Theirs");
  assert.equal(mergeTheirsWins("lastEditedBy", { lastEditedBy: "Mine" }, { lastEditedBy: "" }), "Mine");
  assert.equal(mergeTheirsWins("lastEditedBy", {}, {}), null);
});

test("target length: the side that changed wins, with no base theirs if set, and junk reads as unset", () => {
  assert.equal(mergeTargetLength({ targetSeconds: 300 }, { targetSeconds: 420 }, { targetSeconds: 300 }), 420);
  assert.equal(mergeTargetLength({ targetSeconds: 300 }, { targetSeconds: 300 }, {}), null);
  assert.equal(mergeTargetLength({ targetSeconds: 300 }, { targetSeconds: 420 }, { targetSeconds: 360 }), 360);
  assert.equal(mergeTargetLength(null, { targetSeconds: 240 }, {}), 240);
  assert.equal(mergeTargetLength(null, { targetSeconds: 240 }, { targetSeconds: 60.4 }), 60);
  assert.equal(mergeTargetLength(null, { targetSeconds: "300" }, { targetSeconds: -5 }), null);
});
