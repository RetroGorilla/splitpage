/* The rundown strip's layout (05f-rundown.js, #169): the pure half — how
 * many seconds the strip spans, how many pixels a second is, where each
 * scene's block goes and which of its labels fit, and where the ruler's
 * ticks and labels land. The painting reads these and nothing else, so a
 * strip that looks wrong is one of these being wrong, and they are
 * checked here without a page.
 *
 * The scale is also the hook a target length (#170) moves: its second
 * argument is a time the strip must reach as well as the script.
 *
 * Then the lens (#184): the knots a layout is made of, the slot
 * coordinates the lens works in, the lensed layout itself (a sliver made
 * readable, the rest shrunk evenly and never off the strip, the focus at
 * its anchor), how it follows the pointer (slowly it aims and nothing
 * slides, fast it travels end to end), and the gap a scene dragged onto
 * the strip would be dropped in (#185).
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  LENS_MIN_PX,
  RUNDOWN_TAIL_SECONDS,
  knotBlocks,
  knotMap,
  rundownBlocks,
  rundownDropGap,
  rundownKnots,
  rundownLens,
  rundownLensFollow,
  rundownLensSlots,
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

/* ---- the lens (#184) ----
 *
 * A layout is n + 2 knots: where each scene starts, where the last one
 * ends, and the strip's right edge. The lens is rundownLens over the slot
 * knots; the strip draws knotBlocks of whatever it has on screen. */

/* A ten-minute script with a sliver in it: 3s scenes among longer ones,
   and one scene with no words at all. */
function longScript() {
  const scenes = [];
  for (let i = 0; i < 80; i++) {
    scenes.push({ seconds: i === 40 ? 0 : i % 9 === 4 ? 3 : 4 + (i * 7) % 11, status: i % 4 === 0 ? "shot" : "todo" });
  }
  return scenes;
}

function layout(scenes, width) {
  const total = scenes.reduce((n, sc) => n + sc.seconds, 0);
  const s = rundownScale(total, 0, width);
  const blocks = rundownBlocks(scenes, s);
  return { blocks, s, width, X: rundownKnots(blocks, s, width), U: rundownLensSlots(blocks, s, width) };
}

function ordered(k) {
  for (let i = 1; i < k.length; i++) if (k[i] < k[i - 1] - 1e-9) return false;
  return true;
}

test("the to-scale knots are each block's left, the script's end and the strip's edge", () => {
  const { blocks, X, width } = layout(BOARD, 1400);
  assert.equal(X.length, BOARD.length + 2);
  blocks.forEach((b, i) => assert.equal(X[i], b.left));
  assert.equal(X[X.length - 1], width);
  assert.ok(ordered(X));
  /* drawing them gives the blocks back */
  knotBlocks(X).forEach((kb, i) => {
    assert.equal(kb.left, blocks[i].left);
    assert.ok(Math.abs(kb.width - blocks[i].width) <= 0.1);
  });
});

test("slot knots give every scene room, even one with no words, and still end at the edge", () => {
  const { U, X, width } = layout(longScript(), 1400);
  assert.equal(U.length, X.length);
  assert.equal(U[0], 0);
  assert.equal(U[U.length - 1], width);
  for (let i = 0; i < U.length - 1; i++) assert.ok(U[i + 1] - U[i] > 3, "slot " + i + " has room");
  /* the empty scene is a point in time on the to-scale layout, not in slots */
  assert.equal(X[41] - X[40], 0);
});

test("a script whose scenes are all wide already is not changed by the lens", () => {
  const { X, U, width } = layout(BOARD, 1400);
  assert.deepEqual(U.map((v) => Math.round(v * 10) / 10), X.map((v) => Math.round(v * 10) / 10));
  const Y = rundownLens(U, 500, 500);
  Y.forEach((y, i) => assert.ok(Math.abs(y - U[i]) < 0.01, "knot " + i));
  assert.equal(Y[Y.length - 1], width);
});

test("the scene under the lens is wide enough for its number and read time, and the rest still fits", () => {
  const { U, width } = layout(longScript(), 1400);
  const i = 13; /* a 3s sliver: i % 9 === 4 */
  assert.ok(U[i + 1] - U[i] < 12, "the test's scene is a sliver in slots");
  const focus = (U[i] + U[i + 1]) / 2;
  const Y = rundownLens(U, focus, focus);
  assert.ok(ordered(Y));
  assert.equal(Y[0], 0);
  assert.equal(Y[Y.length - 1], width);
  const blocks = knotBlocks(Y);
  assert.ok(blocks[i].width >= 80, "the sliver is " + blocks[i].width + "px under the lens");
  assert.ok(blocks[i].width <= LENS_MIN_PX + 1);
  /* its neighbours grow, less */
  assert.ok(blocks[i - 1].width > U[i] - U[i - 1]);
  /* every scene is still on the strip, and none has vanished */
  assert.equal(blocks.length, 80);
  blocks.forEach((b) => { assert.ok(b.left >= 0 && b.left + b.width <= width + 0.1); assert.ok(b.width >= 2); });
});

test("the focus stays where it is anchored: what is under the pointer does not slide away", () => {
  const { U } = layout(longScript(), 1400);
  for (const focus of [30, 333.3, 700, 1111, 1300]) {
    const Y = rundownLens(U, focus, focus);
    assert.ok(Math.abs(knotMap(U, Y, focus) - focus) < 0.01, "focus " + focus);
  }
  /* anchored somewhere else nearby (within the magnified room, which is
     all the anchor may drift), it is there instead */
  const Y2 = rundownLens(U, 700, 715);
  assert.ok(Math.abs(knotMap(U, Y2, 700) - 715) < 0.01);
});

test("the anchor never drifts further than the magnified room, so the rest is never stretched", () => {
  const { U, width } = layout(longScript(), 1400);
  const Y = rundownLens(U, 700, 1300);
  const at = knotMap(U, Y, 700);
  assert.ok(at < 1300, "clamped, at " + at);
  /* everything far from the focus is shrunk, never stretched (beyond the
     hair the focus scene's straightening can add) */
  for (let i = 0; i < 30; i++) assert.ok(Y[i + 1] - Y[i] <= (U[i + 1] - U[i]) * 1.02, "scene " + i);
  assert.equal(Y[Y.length - 1], width);
});

test("scenes outside the lens shrink evenly, one factor each side", () => {
  const { U } = layout(longScript(), 1400);
  const Y = rundownLens(U, 700, 700);
  const ratios = [];
  for (let i = 0; i < 20; i++) ratios.push((Y[i + 1] - Y[i]) / (U[i + 1] - U[i]));
  ratios.forEach((r) => assert.ok(Math.abs(r - ratios[0]) < 1e-6));
  assert.ok(ratios[0] < 1 && ratios[0] > 0.1);
});

/* What the strip does: the lens opens on what is under the pointer, and
   each move after that goes through rundownLensFollow at the speed it was
   made. `moves` is [x, ms since the last]; the answer is every frame. */
function drive(U, X, x0, moves) {
  let focus = knotMap(X, U, x0);
  let anchor = x0;
  let shown = rundownLens(U, focus, anchor);
  let x = x0;
  const out = [{ x, shown, focus, anchor }];
  for (const [nx, dt] of moves) {
    const next = rundownLensFollow(U, X, shown, focus, anchor, nx, nx - x, dt);
    focus = next.focus;
    anchor = next.anchor;
    shown = rundownLens(U, focus, anchor);
    x = nx;
    out.push({ x, shown, focus, anchor });
  }
  return out;
}

function sceneAt(K, x) {
  for (let i = 0; i < K.length - 2; i++) if (x >= K[i] && x < K[i + 1]) return i;
  return -1;
}

test("hovering a sliver opens the lens on it: under the pointer, its number and read time showing", () => {
  const { U, X } = layout(longScript(), 1400);
  const i = 13;
  const x = (X[i] + X[i + 1]) / 2;
  const [f] = drive(U, X, x, []);
  assert.equal(sceneAt(f.shown, x), i);
  assert.ok(f.shown[i + 1] - f.shown[i] - 2 >= 80);
});

test("aiming: moving slowly, what is under the pointer stays there, and a still pointer moves nothing", () => {
  const { U, X } = layout(longScript(), 1400);
  const x0 = 700;
  const moves = [];
  for (let k = 1; k <= 60; k++) moves.push([x0 + k, 16]);   /* 1px a frame: ~60px a second */
  const frames = drive(U, X, x0, moves);
  for (let k = 1; k < frames.length; k++) {
    const prev = frames[k - 1], f = frames[k];
    /* the point of the script the pointer is over on the old frame is
       where the pointer is on the new one */
    const u = knotMap(prev.shown, U, f.x);
    assert.ok(Math.abs(knotMap(U, f.shown, u) - f.x) < 1, "slipped at " + f.x);
    let jump = 0;
    for (let j = 0; j < f.shown.length; j++) jump = Math.max(jump, Math.abs(f.shown[j] - prev.shown[j]));
    assert.ok(jump < 6, "a knot jumped " + jump.toFixed(2) + "px at " + f.x);
  }
  /* 60px of slow travel crosses at most a scene or two, each drawn wide */
  const a = sceneAt(frames[0].shown, x0), b = sceneAt(frames[frames.length - 1].shown, x0 + 60);
  assert.ok(b - a >= 0 && b - a <= 2, "from scene " + a + " to " + b);
  /* standing still */
  const last = frames[frames.length - 1];
  const still = rundownLensFollow(U, X, last.shown, last.focus, last.anchor, last.x, 0, 16);
  assert.equal(still.focus, last.focus);
  assert.equal(still.anchor, last.anchor);
});

test("travelling: moving fast, the lens goes where the pointer goes, end to end", () => {
  const { U, X } = layout(longScript(), 1400);
  const moves = [];
  for (let x = 20; x <= 1400; x += 20) moves.push([x, 16]);   /* 20px a frame */
  const frames = drive(U, X, 0, moves);
  for (const f of frames.slice(1)) {
    assert.ok(Math.abs(f.focus - knotMap(X, U, f.x)) < 1e-6, "focus at " + f.x);
    assert.ok(ordered(f.shown));
  }
  /* and it reaches both ends: the last scene is under a pointer near the right edge */
  const end = frames[frames.length - 1];
  assert.equal(end.shown[end.shown.length - 1], 1400);
  const nearEnd = drive(U, X, 1370, [])[0];
  assert.ok(sceneAt(nearEnd.shown, 1370) >= 78 || sceneAt(nearEnd.shown, 1370) === -1);
});

test("every scene can be brought under the pointer, the one with no words too", () => {
  const { U, X } = layout(longScript(), 1400);
  const seen = new Set();
  for (let x = 0; x < 1400; x += 1) {
    const [f] = drive(U, X, x, []);
    const sc = sceneAt(f.shown, x);
    if (sc !== -1) seen.add(sc);
  }
  for (let i = 0; i < 80; i++) if (i !== 40) assert.ok(seen.has(i), "scene " + i);
  /* the empty one is a point in time, and to scale it sits under the
     next scene's first pixels; with the lens open beside it, it is a
     block of its own a slow move reaches */
  const moves = [];
  for (let k = 1; k <= 90; k++) moves.push([X[40] - k, 16]);
  const back = drive(U, X, X[40] + 1, moves);
  assert.ok(back.some((f) => sceneAt(f.shown, f.x) === 40), "scene 40 under the pointer");
  const f40 = back.find((f) => sceneAt(f.shown, f.x) === 40);
  assert.ok(f40.shown[41] - f40.shown[40] >= 28, "and wide enough for its number");
});

test("hundreds of scenes: the lens still fits, and still magnifies", () => {
  const scenes = [];
  for (let i = 0; i < 400; i++) scenes.push({ seconds: 2 + (i % 5), status: "todo" });
  const { U, width } = layout(scenes, 1200);
  const Y = rundownLens(U, 600, 600);
  assert.ok(ordered(Y));
  assert.equal(Y[Y.length - 1], width);
  const blocks = knotBlocks(Y);
  const widest = Math.max(...blocks.map((b) => b.width));
  /* a 3px slot drawn well over ten times as wide, though the lens may take
     only LENS_MAX_SHARE of the strip among all the scenes in its reach */
  assert.ok(widest >= 56, "the widest is " + widest);
});

test("knotMap is piecewise linear, clamps at the ends and inverts itself", () => {
  const from = [0, 10, 10, 30, 100];
  const to = [0, 50, 60, 80, 100];
  assert.equal(knotMap(from, to, -5), 0);
  assert.equal(knotMap(from, to, 5), 25);
  assert.equal(knotMap(from, to, 20), 70);
  assert.equal(knotMap(from, to, 200), 100);
  const { U } = layout(longScript(), 1400);
  const Y = rundownLens(U, 512, 512);
  for (const u of [3, 99.5, 512, 800.25, 1399]) assert.ok(Math.abs(knotMap(Y, U, knotMap(U, Y, u)) - u) < 1e-6);
});

/* ---- dropping a scene on the strip (#185) ---- */

test("a drop lands in the nearest gap between blocks, within reach", () => {
  const K = [0, 100, 200, 300, 400, 1000];  /* four scenes, then the tail */
  assert.equal(rundownDropGap(K, 3, 3, 20), 0, "before the first");
  assert.equal(rundownDropGap(K, 205, 3, 20), 2, "between the second and third");
  assert.equal(rundownDropGap(K, 390, 0, 20), 4, "after the last");
  assert.equal(rundownDropGap(K, 150, 3, 20), -1, "the middle of a block is not a gap");
  assert.equal(rundownDropGap(K, 700, 0, 20), -1, "nor is the tail");
});

test("a drop beside the dragged scene's own place moves nothing", () => {
  const K = [0, 100, 200, 300, 400, 1000];
  assert.equal(rundownDropGap(K, 99, 1, 20), -1, "just before itself");
  assert.equal(rundownDropGap(K, 199, 1, 20), -1, "just after itself");
  assert.equal(rundownDropGap(K, 299, 1, 20), 3);
});

test("between very short scenes the gap nearest the pointer wins", () => {
  const K = [0, 4, 8, 12, 16, 500];
  assert.equal(rundownDropGap(K, 7.4, 0, 20), 2);
  assert.equal(rundownDropGap(K, 11.2, 0, 20), 3);
});
