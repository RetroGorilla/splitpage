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
  LENGTH_GAP_PX,
  LENS_DRIFT_SHARE,
  LENS_MIN_PX,
  RUNDOWN_TAIL_SECONDS,
  knotBlocks,
  knotMap,
  rundownBlocks,
  rundownDropGap,
  rundownKnots,
  rundownLens,
  rundownLensFollow,
  rundownLensRecenter,
  rundownLengthPlace,
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

/* ---- the script's length at the end of the strip (#207) ---- */

test("the length sits just after the last block, in the tail, when it fits there", () => {
  /* 1:35 on 1400px: the script ends at 1266.7, the tail is 133px */
  const p = rundownLengthPlace(95, 0, 1400, [40]);
  assert.equal(p.fit, 0);
  assert.equal(p.pinned, false);
  assert.equal(p.width, 1400, "the blocks keep the whole track");
  const end = 95 * rundownScale(95, 0, 1400);
  assert.ok(Math.abs(p.left - (end + LENGTH_GAP_PX)) < 0.1);
  /* against a target the whole label fits in the gap to it as well */
  const t = rundownLengthPlace(95, 120, 1400, [150, 40]);
  assert.equal(t.fit, 0);
  assert.ok(Math.abs(t.left - (95 * rundownScale(95, 120, 1400) + LENGTH_GAP_PX)) < 0.1);
});

test("a script that fills the strip puts its length at the track's right edge, and the blocks stop short of it", () => {
  /* twenty minutes: the 10s tail is 11px */
  const p = rundownLengthPlace(1200, 0, 1400, [44]);
  assert.equal(p.fit, 0);
  assert.equal(p.pinned, true);
  assert.equal(p.left, 1400 - 44);
  assert.equal(p.width, 1400 - 44 - LENGTH_GAP_PX);
  /* laid out in that width, the last block ends before the label */
  const blocks = rundownBlocks([{ seconds: 600, status: "todo" }, { seconds: 600, status: "todo" }], rundownScale(1200, 0, p.width));
  const last = blocks[1];
  assert.ok(last.left + last.width + LENGTH_GAP_PX <= p.left);
  /* over its target, the same */
  const over = rundownLengthPlace(125, 90, 1400, [160, 40]);
  assert.equal(over.pinned, true);
  assert.equal(over.fit, 0);
});

test("short of room, the length drops its target and delta before it goes, and goes only when it would take a quarter of the strip", () => {
  /* 400px, a long script: the whole label (150px) is over a quarter, the total alone is not */
  const p = rundownLengthPlace(1200, 1300, 400, [150, 40]);
  assert.equal(p.fit, 1);
  assert.equal(p.pinned, true);
  assert.equal(p.left, 360);
  /* the whole label anywhere before the total alone: at the edge rather
     than drop the delta... */
  const e = rundownLengthPlace(115, 120, 1000, [150, 40]);
  assert.equal(e.fit, 0);
  assert.equal(e.pinned, true);
  /* ...and the total alone in the tail when the whole label fits nowhere */
  const q = rundownLengthPlace(60, 0, 400, [150, 40]);
  assert.equal(q.fit, 1);
  assert.equal(q.pinned, false);
  /* too narrow even for the total */
  const none = rundownLengthPlace(1200, 0, 100, [40]);
  assert.equal(none.fit, -1);
  assert.equal(none.left, null);
  assert.equal(none.width, 100);
  /* and nothing to place */
  assert.equal(rundownLengthPlace(95, 0, 0, [40]).fit, -1);
  assert.equal(rundownLengthPlace(95, 0, 1400, []).fit, -1);
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

/* The room a lensed layout adds: what its scenes grew by, in all. */
function extraOf(U, Y) {
  let e = 0;
  for (let i = 0; i < U.length - 1; i++) e += Math.max(0, (Y[i + 1] - Y[i]) - (U[i + 1] - U[i]));
  return e;
}

test("the focus stays where it is anchored: what is under the pointer does not slide away", () => {
  const { U } = layout(longScript(), 1400);
  for (const focus of [333.3, 700, 1111]) {
    const Y = rundownLens(U, focus, focus);
    assert.ok(Math.abs(knotMap(U, Y, focus) - focus) < 0.01, "focus " + focus);
  }
  /* anchored somewhere else nearby (within the drift the anchor is
     allowed, #199), it is there instead */
  const cap = LENS_DRIFT_SHARE * extraOf(U, rundownLens(U, 700, 700));
  assert.ok(cap > 4, "the test's lens adds room: a cap of " + cap);
  const Y2 = rundownLens(U, 700, 700 + cap / 2);
  assert.ok(Math.abs(knotMap(U, Y2, 700) - (700 + cap / 2)) < 0.01);
});

test("#199: the anchor drifts from the focus by at most LENS_DRIFT_SHARE of the room the lens adds, and the rest is never stretched", () => {
  const { U, width } = layout(longScript(), 1400);
  for (const want of [1300, 100]) {
    const Y = rundownLens(U, 700, want);
    const at = knotMap(U, Y, 700);
    const cap = LENS_DRIFT_SHARE * extraOf(U, Y);
    assert.ok(Math.abs(at - 700) <= cap + 0.5, "drifted " + (at - 700).toFixed(1) + " past a cap of " + cap.toFixed(1));
    assert.ok(Math.abs(at - 700) >= cap - 0.5, "but as far as the cap, towards " + want);
    /* everything far from the focus is shrunk, never stretched (beyond the
       hair the focus scene's straightening can add) */
    for (let i = 0; i < 30; i++) assert.ok(Y[i + 1] - Y[i] <= (U[i + 1] - U[i]) * 1.02, "scene " + i);
    for (let i = 50; i < 80; i++) assert.ok(Y[i + 1] - Y[i] <= (U[i + 1] - U[i]) * 1.02, "scene " + i);
    assert.equal(Y[Y.length - 1], width);
  }
});

test("#199: at either end the lens moves inward rather than being cut short on the near side", () => {
  const { U, width } = layout(longScript(), 1400);
  const mid = (i) => (U[i] + U[i + 1]) / 2;
  /* the first scene and the last grow nearly as far as a scene in the
     middle (the half of them beyond the focus keeps only the floor of
     its own few pixels); before #199 the first was cut to under half */
  const Y0 = rundownLens(U, mid(0), mid(0));
  assert.ok(Y0[1] - Y0[0] >= LENS_MIN_PX * 0.9, "the first scene is " + (Y0[1] - Y0[0]).toFixed(1));
  const Yn = rundownLens(U, mid(79), mid(79));
  assert.ok(Yn[80] - Yn[79] >= LENS_MIN_PX * 0.9, "the last scene is " + (Yn[80] - Yn[79]).toFixed(1));
  /* the sliver near the start (scene 5, a 3s scene) grows as wide as the
     same kind of sliver in the middle (scene 13) */
  const Y4 = rundownLens(U, mid(4), mid(4));
  const Y13 = rundownLens(U, mid(13), mid(13));
  assert.ok(Math.abs((Y4[5] - Y4[4]) - (Y13[14] - Y13[13])) < 2.5, (Y4[5] - Y4[4]).toFixed(1) + " against " + (Y13[14] - Y13[13]).toFixed(1));
  /* and nothing leaves the strip or runs backwards */
  for (const Y of [Y0, Yn, Y4]) {
    assert.ok(ordered(Y));
    assert.equal(Y[0], 0);
    assert.equal(Y[Y.length - 1], width);
  }
});

test("scenes outside the lens shrink evenly, one factor each side", () => {
  const { U } = layout(longScript(), 1400);
  const Y = rundownLens(U, 700, 700);
  const ratios = [];
  for (let i = 0; i < 20; i++) ratios.push((Y[i + 1] - Y[i]) / (U[i + 1] - U[i]));
  ratios.forEach((r) => assert.ok(Math.abs(r - ratios[0]) < 1e-6));
  assert.ok(ratios[0] < 1 && ratios[0] > 0.1);
});

/* What the strip does: the lens opens on what is under the pointer, each
   move after that goes through rundownLensFollow at the speed it was made,
   and every frame the lens re-centres a frame's worth (#199). `moves` is
   [x, ms since the last], one per frame (the same x again is a frame with
   the pointer still); the answer is every frame, with the anchor as the
   lens really uses it. */
function drive(U, X, x0, moves) {
  let focus = knotMap(X, U, x0);
  let anchor = x0;
  let shown = rundownLens(U, focus, anchor);
  let x = x0;
  const out = [{ x, shown, focus, anchor: knotMap(U, shown, focus) }];
  for (const [nx, dt] of moves) {
    if (nx !== x) {
      const next = rundownLensFollow(U, X, shown, focus, anchor, nx, nx - x, dt);
      focus = next.focus;
      anchor = next.anchor;
    }
    x = nx;
    const settled = rundownLensRecenter(U, shown, focus, anchor, x, dt);
    focus = settled.focus;
    anchor = settled.anchor;
    shown = rundownLens(U, focus, anchor);
    out.push({ x, shown, focus, anchor: knotMap(U, shown, focus) });
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

test("aiming (#199): a slow pointer crosses a sliver drawn wide with time to click it, and the lens stays round the pointer", () => {
  const { U, X } = layout(longScript(), 1400);
  const i = 13;                             /* a 3s sliver */
  const x0 = X[i] - 30;
  const moves = [];
  for (let k = 1; k <= 140; k++) moves.push([x0 + k, 16]);   /* 1px a frame: ~60px a second */
  const frames = drive(U, X, x0, moves);
  const px = {};
  frames.slice(1).forEach((f) => { const sc = sceneAt(f.shown, f.x); px[sc] = (px[sc] || 0) + 1; });
  /* the sliver is under the pointer for a good stretch of travel — the
     plain magnifier would give it its 4px slot, and the lens before #199
     (which held still, then swung) gave it 2px */
  assert.ok(px[i] >= 16, "the sliver was under the pointer for " + px[i] + "px: " + JSON.stringify(px));
  /* and nothing the pointer crossed was skipped: the scenes under it go
     up one at a time */
  const seq = frames.map((f) => sceneAt(f.shown, f.x));
  for (let k = 1; k < seq.length; k++) assert.ok(seq[k] - seq[k - 1] >= 0 && seq[k] - seq[k - 1] <= 1, "scene " + seq[k - 1] + " to " + seq[k]);
  for (const f of frames) {
    assert.ok(ordered(f.shown));
    /* the lens's centre is never far from the pointer: it neither leads
       nor trails by more than about half a magnified scene */
    assert.ok(Math.abs(f.x - f.anchor) <= LENS_MIN_PX * 0.6, "the lens is " + (f.x - f.anchor).toFixed(1) + "px off the pointer at " + f.x);
    /* nor is it pushed to one side by more than the drift cap (extraOf
       reads the room net of the magnified scenes' own shrink, a few per
       cent under what the lens adds, hence the tenth) */
    assert.ok(Math.abs(f.anchor - f.focus) <= LENS_DRIFT_SHARE * extraOf(U, f.shown) * 1.1 + 1, "drift " + (f.anchor - f.focus).toFixed(1) + " at " + f.x);
  }
});

test("#199: a pointer that stops on a sliver keeps it, and the lens comes to rest centred on the pointer", () => {
  const { U, X } = layout(longScript(), 1400);
  const i = 13;
  /* move in slowly until the sliver is under the pointer, a few pixels
     more, then stop for a second */
  let moves = [];
  let frames = [];
  for (let k = 1; k <= 120; k++) {
    moves.push([X[i] - 30 + k, 16]);
    frames = drive(U, X, X[i] - 30, moves);
    if (sceneAt(frames[frames.length - 1].shown, frames[frames.length - 1].x) === i) break;
  }
  const xs = frames[frames.length - 1].x + 4;
  for (let k = 1; k <= 4; k++) moves.push([xs - 4 + k, 16]);
  for (let k = 0; k < 60; k++) moves.push([xs, 16]);
  frames = drive(U, X, X[i] - 30, moves);
  const stopped = frames.length - 61;
  for (let k = stopped; k < frames.length; k++) {
    assert.equal(sceneAt(frames[k].shown, xs), i, "the sliver left the pointer " + (k - stopped) + " frames after it stopped");
  }
  const rest = frames[frames.length - 1];
  assert.ok(rest.shown[i + 1] - rest.shown[i] >= 80, "and it is " + (rest.shown[i + 1] - rest.shown[i]).toFixed(1) + "px wide");
  /* at rest the lens is centred on the pointer, or all but — the last few
     pixels close slowly over a sliver, since closing them is what would
     slide the sliver away — and what the pointer is over is the focus */
  assert.ok(Math.abs(rest.anchor - xs) < 8, "the lens's centre is " + (rest.anchor - xs).toFixed(2) + "px off the pointer");
  assert.ok(Math.abs(knotMap(rest.shown, U, xs) - rest.focus) < 0.5);
  /* it is not moving by more than a hair a frame by then, nor at all
     without time passing */
  const again = rundownLensRecenter(U, rest.shown, rest.focus, rest.anchor, xs, 16);
  assert.ok(Math.abs(again.focus - rest.focus) < 0.1 && Math.abs(again.anchor - rest.anchor) < 1, "still moving " + (again.anchor - rest.anchor).toFixed(2) + "px a frame");
  const still = rundownLensFollow(U, X, rest.shown, rest.focus, rest.anchor, xs, 0, 16);
  assert.equal(still.focus, rest.focus);
  assert.equal(still.anchor, rest.anchor);
  const noTime = rundownLensRecenter(U, rest.shown, rest.focus, rest.anchor, xs, 0);
  assert.equal(noTime.focus, rest.focus);
  assert.equal(noTime.anchor, rest.anchor);
});

test("travelling: moving fast, the lens goes where the pointer goes, end to end", () => {
  const { U, X } = layout(longScript(), 1400);
  const moves = [];
  for (let x = 20; x <= 1400; x += 20) moves.push([x, 16]);   /* 20px a frame */
  const frames = drive(U, X, 0, moves);
  for (const f of frames.slice(1)) {
    /* a fast move puts the focus on the to-scale point under the pointer;
       the frame's re-centring after it moves it a few pixels at most */
    assert.ok(Math.abs(f.focus - knotMap(X, U, f.x)) < 8, "focus at " + f.x);
    assert.ok(ordered(f.shown));
  }
  /* the move alone, with no frame after it, is exactly the plain magnifier */
  const f1 = frames[20];
  const moved = rundownLensFollow(U, X, f1.shown, f1.focus, f1.anchor, f1.x + 20, 20, 16);
  assert.ok(Math.abs(moved.focus - knotMap(X, U, f1.x + 20)) < 1e-6);
  assert.ok(Math.abs(moved.anchor - (f1.x + 20)) < 1e-6);
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
