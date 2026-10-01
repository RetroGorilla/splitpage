import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WPM,
  ROW_STATUS_IDS,
  SCENE_LENGTH_MAX,
  hasSetLength,
  nextRowStatus,
  normalizeSceneLength,
  normalizeTargetLength,
  parseSceneLength,
  rowStatusId,
  targetLengthOf
} from "../../../src/core/document/timing.ts";

test("a scene's status is to do, ready or shot, and cycles in that order", () => {
  assert.deepEqual([...ROW_STATUS_IDS], ["todo", "ready", "shot"]);
  for (const id of ROW_STATUS_IDS) assert.equal(rowStatusId(id), id);
  for (const id of ["Todo", "", null, undefined, "done", "constructor"]) assert.equal(rowStatusId(id), null, String(id));
  assert.equal(nextRowStatus("todo"), "ready");
  assert.equal(nextRowStatus("ready"), "shot");
  assert.equal(nextRowStatus("shot"), "todo");
  assert.equal(nextRowStatus("bogus"), "todo");
  assert.equal(nextRowStatus(undefined), "todo");
});

test("the reading speed and the longest length", () => {
  assert.equal(DEFAULT_WPM, 150);
  assert.equal(SCENE_LENGTH_MAX, 86400);
});

test("a scene has a set length only when it holds a whole day or less", () => {
  assert.equal(hasSetLength({ lengthSeconds: 0 }), true);
  assert.equal(hasSetLength({ lengthSeconds: 12.5 }), true);
  assert.equal(hasSetLength({ lengthSeconds: SCENE_LENGTH_MAX }), true);
  assert.equal(hasSetLength({ lengthSeconds: SCENE_LENGTH_MAX + 0.1 }), false);
  assert.equal(hasSetLength({ lengthSeconds: -1 }), false);
  assert.equal(hasSetLength({ lengthSeconds: NaN }), false);
  assert.equal(hasSetLength({ lengthSeconds: Infinity }), false);
  assert.equal(hasSetLength({ lengthSeconds: "30" }), false);
  assert.equal(hasSetLength({}), false);
  assert.equal(hasSetLength(null), false);
  assert.equal(hasSetLength(undefined), false);
});

test("a stored scene length rounds to whole seconds and is dropped out of range", () => {
  const cases: [unknown, number | undefined][] = [
    [-0.1, undefined], [0, 0], [0.4, 0], [0.5, 1], [61.49, 61],
    [SCENE_LENGTH_MAX, SCENE_LENGTH_MAX], [SCENE_LENGTH_MAX + 0.1, undefined],
    [NaN, undefined], [Infinity, undefined], ["30", undefined], [null, undefined], [undefined, undefined]
  ];
  for (const [input, want] of cases) assert.equal(normalizeSceneLength(input), want, String(input));
  assert.ok(Object.is(normalizeSceneLength(-0), -0));
});

test("a typed length reads clock times and units, largest unit first", () => {
  const cases: [unknown, number | null][] = [
    ["", null], ["   ", null], [null, null], [undefined, null],
    ["90", 90], ["1:30", 90], ["  1:30  ", 90], ["0:05", 5], ["1:00:05", 3605], ["24:00:00", 86400],
    ["1m", 60], ["1m 30", 90], ["2m30s", 150], ["1 hour 2 minutes", 3720], ["1h 5", 3900], ["1h 2m 3", 3723],
    ["1.5m", 90], [".5h", 1800], ["1 HR", 3600], ["10 secs", 10], ["0.4", 0], ["0.5", 1]
  ];
  for (const [input, want] of cases) assert.equal(parseSceneLength(input), want, String(input));
  const refused = ["1:60", "1:5", "25:00:00", "86401", "30s 2m", "1m 1m", "1s 2", "1m 2 3", "5 parsecs", "abc", "1:30x", "-5", "m"];
  for (const input of refused) assert.ok(Number.isNaN(parseSceneLength(input)), input);
});

test("a target length is a whole number of seconds from one to a day", () => {
  const cases: [unknown, number | undefined][] = [
    [0.4, undefined], [0.5, 1], [1, 1], [300.4, 300], [SCENE_LENGTH_MAX, SCENE_LENGTH_MAX],
    [SCENE_LENGTH_MAX + 0.4, SCENE_LENGTH_MAX], [SCENE_LENGTH_MAX + 0.5, undefined],
    [-1, undefined], [NaN, undefined], [Infinity, undefined], ["60", undefined], [null, undefined]
  ];
  for (const [input, want] of cases) assert.equal(normalizeTargetLength(input), want, String(input));
  assert.equal(targetLengthOf({ targetSeconds: 299.6 }), 300);
  assert.equal(targetLengthOf({ targetSeconds: 0 }), null);
  assert.equal(targetLengthOf({}), null);
  assert.equal(targetLengthOf(null), null);
  assert.equal(targetLengthOf(undefined), null);
});
