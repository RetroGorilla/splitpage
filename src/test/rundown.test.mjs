/* The rundown strip's layout (05f-rundown.js, #169): the pure half — how
 * many seconds the strip spans, how many pixels a second is, where each
 * scene's block goes and which of its labels fit, and where the ruler's
 * ticks and labels land. The painting reads these and nothing else, so a
 * strip that looks wrong is one of these being wrong, and they are
 * checked here without a page.
 *
 * The scale is also the hook a target length (#170) moves: its second
 * argument is a time the strip must reach as well as the script.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  RUNDOWN_TAIL_SECONDS,
  rundownBlocks,
  rundownScale,
  rundownSpan,
  rundownTicks
} from "../js/05f-rundown.js";

/* The boards' script: the To-camera starter, 1:35 in six scenes. */
const BOARD = [
  { seconds: 15, status: "shot" },
  { seconds: 16, status: "shot" },
  { seconds: 19, status: "ready" },
  { seconds: 14, status: "todo" },
  { seconds: 14, status: "todo" },
  { seconds: 17, status: "todo" }
];

test("the strip spans the script plus the tail, or a longer extra time plus the tail", () => {
  assert.equal(RUNDOWN_TAIL_SECONDS, 10);
  assert.equal(rundownSpan(95, 0), 105);
  assert.equal(rundownSpan(95, 120), 130);
  assert.equal(rundownSpan(95, 60), 105);
  assert.equal(rundownSpan(0, 0), 10);
  assert.equal(rundownSpan(undefined, undefined), 10);
});

test("the scale is the strip's width over its span, and nothing when it has no width", () => {
  assert.equal(rundownScale(95, 0, 1050), 10);
  assert.equal(rundownScale(95, 120, 1300), 10);
  assert.equal(rundownScale(95, 0, 0), 0);
  assert.equal(rundownScale(95, 0, -5), 0);
});

test("blocks are placed by start time and sized by read time, 2px apart", () => {
  const s = rundownScale(95, 0, 1400);
  const blocks = rundownBlocks(BOARD, s);
  assert.equal(blocks.length, 6);
  assert.deepEqual(blocks.map((b) => b.start), [0, 15, 31, 50, 64, 78]);
  blocks.forEach((b, i) => {
    assert.equal(b.index, i);
    assert.ok(Math.abs(b.left - b.start * s) <= 0.05, "left is the start in pixels");
    assert.ok(Math.abs(b.width - (b.seconds * s - 2)) <= 0.05, "width is the length less the gap");
  });
  /* each block ends before the next begins */
  for (let i = 1; i < blocks.length; i++) {
    assert.ok(blocks[i - 1].left + blocks[i - 1].width < blocks[i].left);
  }
  /* the last block ends the tail's width short of the edge */
  const last = blocks[blocks.length - 1];
  assert.ok(1400 - (last.left + last.width) >= 10 * s);
});

test("at the board's size every block shows its number and its read time", () => {
  const blocks = rundownBlocks(BOARD, rundownScale(95, 0, 1400));
  assert.ok(blocks.every((b) => b.showNumber && b.showLength));
});

test("one scene fills the strip but for the tail", () => {
  const [b] = rundownBlocks([{ seconds: 20, status: "todo" }], rundownScale(20, 0, 900));
  assert.equal(b.left, 0);
  assert.ok(Math.abs(b.width - (900 * 20 / 30 - 2)) <= 0.05);
  assert.ok(b.showNumber && b.showLength);
});

test("sixty scenes still fit, never under 2px, and a block too narrow for a label shows none", () => {
  const scenes = [];
  for (let i = 0; i < 60; i++) scenes.push({ seconds: i % 7 === 0 ? 0 : 3 + (i % 5) * 4, status: i % 3 === 0 ? "shot" : "todo" });
  const total = scenes.reduce((n, sc) => n + sc.seconds, 0);
  const width = 1400;
  const blocks = rundownBlocks(scenes, rundownScale(total, 0, width));
  assert.equal(blocks.length, 60);
  assert.ok(blocks.every((b) => b.width >= 2), "every block at least 2px");
  const last = blocks[59];
  assert.ok(last.left + last.width <= width, "nothing past the edge");
  const narrow = blocks.filter((b) => b.width < 28);
  assert.ok(narrow.length > 0, "the test has narrow blocks in it");
  assert.ok(narrow.every((b) => !b.showNumber && !b.showLength));
  /* the read time never shows without the number */
  assert.ok(blocks.every((b) => !b.showLength || b.showNumber));
});

test("an empty scene is a sliver, not nothing", () => {
  const blocks = rundownBlocks([{ seconds: 0, status: "todo" }, { seconds: 10, status: "todo" }], rundownScale(10, 0, 400));
  assert.equal(blocks[0].width, 2);
  assert.equal(blocks[1].left, 0);
});

test("a shot block needs a little more room for its read time — the check sits between", () => {
  const s = 5; /* 70px at 14s, 66 of it the block */
  const [todo] = rundownBlocks([{ seconds: 14, status: "todo" }], s);
  const [shot] = rundownBlocks([{ seconds: 14, status: "shot" }], s);
  assert.equal(todo.width, shot.width);
  assert.ok(todo.showLength);
  assert.ok(!shot.showLength && shot.showNumber);
});

test("the ruler ticks every 5s with a label every 15s for a two-minute piece", () => {
  const s = rundownScale(95, 0, 1400);
  const ticks = rundownTicks(rundownSpan(95, 0), s, 1400);
  assert.deepEqual(ticks.slice(0, 4).map((t) => t.seconds), [0, 5, 10, 15]);
  assert.deepEqual(ticks.filter((t) => t.major).map((t) => t.seconds), [0, 15, 30, 45, 60, 75, 90, 105]);
  assert.deepEqual(ticks.filter((t) => t.label).map((t) => t.label), ["0:00", "0:15", "0:30", "0:45", "1:00", "1:15", "1:30"]);
  /* 1:45 is the strip's last pixel: no room for its label */
  assert.equal(ticks.find((t) => t.seconds === 105).label, "");
});

test("a long script spaces the ruler out so labels never crowd", () => {
  const span = rundownSpan(20 * 60, 0);
  const s = rundownScale(20 * 60, 0, 1400);
  const ticks = rundownTicks(span, s, 1400);
  const labelled = ticks.filter((t) => t.label);
  for (let i = 1; i < labelled.length; i++) assert.ok(labelled[i].x - labelled[i - 1].x >= 56);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].x - ticks[i - 1].x >= 6);
  assert.ok(labelled.length >= 3);
});

test("no scale, no ruler", () => {
  assert.deepEqual(rundownTicks(105, 0, 0), []);
});
