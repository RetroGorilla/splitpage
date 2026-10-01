import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimatedSeconds,
  formatDuration,
  formatTimecode,
  pad2,
  rowSeconds,
  targetClock,
  totalSeconds
} from "../../../src/core/production/timing.ts";
import { T, mapDecoder, readersOver } from "./cells.ts";

const cells = mapDecoder();
const readers = readersOver(cells);
const SIXTY_WORDS = cells.html([T(Array.from({ length: 60 }, (_, i) => "w" + i).join(" "))]);
const THIRTY_WORDS = cells.html([T(Array.from({ length: 30 }, (_, i) => "w" + i).join(" ")), T(" (not read)", { dir: true })]);

test("pad2 pads one digit to two", () => {
  assert.deepEqual([0, 9, 10, 99, 100].map(pad2), ["00", "09", "10", "99", "100"]);
});

test("formatDuration and formatTimecode round to the second and never go below zero", () => {
  const secs = [-5, 0, 0.4, 0.5, 59.4, 59.5, 3599, 3600, 3661, 36000];
  assert.deepEqual(secs.map(formatDuration), ["0:00", "0:00", "0:00", "0:01", "0:59", "1:00", "59:59", "1:00:00", "1:01:01", "10:00:00"]);
  assert.deepEqual(secs.map(formatTimecode), ["00:00", "00:00", "00:00", "00:01", "00:59", "01:00", "59:59", "1:00:00", "1:01:01", "10:00:00"]);
});

test("targetClock says how far the read time is from the target, and which side", () => {
  assert.deepEqual(targetClock(50.4, 60), { target: "1:00", delta: "0:10", over: false });
  assert.deepEqual(targetClock(75, 60), { target: "1:00", delta: "0:15", over: true });
  assert.deepEqual(targetClock(-20, 60), { target: "1:00", delta: "1:00", over: false });
  assert.deepEqual(targetClock(60, 60), { target: "1:00", delta: "0:00", over: false });
});

test("a scene's read time is its set length, or its spoken words at the document's reading speed", () => {
  const spoken = { audioText: SIXTY_WORDS };
  assert.equal(estimatedSeconds(spoken, { wordsPerMinute: 120, rows: [] }, readers), 30);
  assert.equal(estimatedSeconds(spoken, { rows: [] }, readers), 24, "150 words a minute when none is set");
  assert.equal(estimatedSeconds(spoken, { wordsPerMinute: 0, rows: [] }, readers), 24);
  assert.equal(estimatedSeconds(spoken, null, readers), 24);
  assert.equal(rowSeconds(Object.assign({ lengthSeconds: 7 }, spoken), null, readers), 7);
  assert.equal(rowSeconds(Object.assign({ lengthSeconds: 0 }, spoken), null, readers), 0);
  assert.equal(rowSeconds(Object.assign({ lengthSeconds: -1 }, spoken), null, readers), 24);
  assert.equal(rowSeconds(Object.assign({ lengthSeconds: "7" }, spoken), null, readers), 24);
});

test("the total read time adds every scene's", () => {
  const state = { wordsPerMinute: 60, rows: [{ audioText: SIXTY_WORDS }, { audioText: THIRTY_WORDS, lengthSeconds: 5 }, { audioText: THIRTY_WORDS }] };
  assert.equal(totalSeconds(state, readers), 60 + 5 + 30);
  assert.equal(totalSeconds({ rows: [] }, readers), 0);
});
