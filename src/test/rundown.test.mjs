import { lensIndexAt } from "../features/rundown/lens-index.ts";
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  LENGTH_GAP_PX,
  LENS_HOLD_PX,
  LENS_MIN_PX,
  LENS_REACH_BEATS,
  REST_MIN_PX,
  RUNDOWN_TAIL_SECONDS,
  knotBlocks,
  knotMap,
  rundownBlocks,
  rundownDropGap,
  rundownKeepLabels,
  rundownLengthPlace,
  rundownRestLayout,
  rundownLensIndex,
  rundownScale,
  rundownSpan,
  rundownTicks
} from "../features/rundown/rundown.ts";
import { targetOverlayParts } from "../features/rundown/target.ts";

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
  for (let i = 1; i < blocks.length; i++) {
    assert.ok(blocks[i - 1].left + blocks[i - 1].width < blocks[i].left);
  }
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
  const beats = [];
  for (let i = 0; i < 60; i++) beats.push({ seconds: i % 7 === 0 ? 0 : 3 + (i % 5) * 4, status: i % 3 === 0 ? "shot" : "todo" });
  const total = beats.reduce((n, sc) => n + sc.seconds, 0);
  const width = 1400;
  const blocks = rundownBlocks(beats, rundownScale(total, 0, width));
  assert.equal(blocks.length, 60);
  assert.ok(blocks.every((b) => b.width >= 2), "every block at least 2px");
  const last = blocks[59];
  assert.ok(last.left + last.width <= width, "nothing past the edge");
  const narrow = blocks.filter((b) => b.width < 28);
  assert.ok(narrow.length > 0, "the test has narrow blocks in it");
  assert.ok(narrow.every((b) => !b.showNumber && !b.showLength));
  assert.ok(blocks.every((b) => !b.showLength || b.showNumber));
});

test("an empty scene is a sliver, not nothing", () => {
  const blocks = rundownBlocks([{ seconds: 0, status: "todo" }, { seconds: 10, status: "todo" }], rundownScale(10, 0, 400));
  assert.equal(blocks[0].width, 2);
  assert.equal(blocks[1].left, 0);
});

test("a shot block needs a little more room for its read time — the check sits between", () => {
  const s = 5;
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

test("the length sits just after the last block, in the tail, when it fits there", () => {
  const p = rundownLengthPlace(95, 0, 1400, [40]);
  assert.equal(p.fit, 0);
  assert.equal(p.pinned, false);
  assert.equal(p.width, 1400, "the blocks keep the whole track");
  const end = 95 * rundownScale(95, 0, 1400);
  assert.ok(Math.abs(p.left - (end + LENGTH_GAP_PX)) < 0.1);
  const t = rundownLengthPlace(95, 120, 1400, [150, 40]);
  assert.equal(t.fit, 0);
  assert.ok(Math.abs(t.left - (95 * rundownScale(95, 120, 1400) + LENGTH_GAP_PX)) < 0.1);
});

test("a script that fills the strip puts its length at the track's right edge, and the blocks stop short of it", () => {
  const p = rundownLengthPlace(1200, 0, 1400, [44]);
  assert.equal(p.fit, 0);
  assert.equal(p.pinned, true);
  assert.equal(p.left, 1400 - 44);
  assert.equal(p.width, 1400 - 44 - LENGTH_GAP_PX);
  const blocks = rundownBlocks([{ seconds: 600, status: "todo" }, { seconds: 600, status: "todo" }], rundownScale(1200, 0, p.width));
  const last = blocks[1];
  assert.ok(last.left + last.width + LENGTH_GAP_PX <= p.left);
  const over = rundownLengthPlace(125, 90, 1400, [160, 40]);
  assert.equal(over.pinned, true);
  assert.equal(over.fit, 0);
});

test("short of room, the length drops its target and delta before it goes, and goes only when it would take a quarter of the strip", () => {
  const p = rundownLengthPlace(1200, 1300, 400, [150, 40]);
  assert.equal(p.fit, 1);
  assert.equal(p.pinned, true);
  assert.equal(p.left, 360);
  const e = rundownLengthPlace(115, 120, 1000, [150, 40]);
  assert.equal(e.fit, 0);
  assert.equal(e.pinned, true);
  const q = rundownLengthPlace(60, 0, 400, [150, 40]);
  assert.equal(q.fit, 1);
  assert.equal(q.pinned, false);
  const none = rundownLengthPlace(1200, 0, 100, [40]);
  assert.equal(none.fit, -1);
  assert.equal(none.left, null);
  assert.equal(none.width, 100);
  assert.equal(rundownLengthPlace(95, 0, 0, [40]).fit, -1);
  assert.equal(rundownLengthPlace(95, 0, 1400, []).fit, -1);
});

function longScript() {
  const beats = [];
  for (let i = 0; i < 80; i++) {
    beats.push({ seconds: i === 40 ? 0 : i % 9 === 4 ? 3 : 4 + (i * 7) % 11, status: i % 4 === 0 ? "shot" : "todo" });
  }
  return beats;
}

function denseScript(n) {
  const beats = [];
  for (let i = 0; i < n; i++) beats.push({ seconds: i % 25 === 7 ? 0 : 1 + (i * 7) % 4, status: "todo" });
  return beats;
}

const sumOf = (beats) => beats.reduce((n, sc) => n + sc.seconds, 0);

function layout(beats, width, floor) {
  const total = sumOf(beats);
  const lay = rundownRestLayout(beats, total, 0, width, floor);
  return { lay, total, blocks: lay.blocks, s: lay.pxPerSecond, width, X: lay.knots, U: lay.knots };
}

function ordered(k) {
  for (let i = 1; i < k.length; i++) if (k[i] < k[i - 1] - 1e-9) return false;
  return true;
}

const slotW = (K, i) => K[i + 1] - K[i];

test("the rest knots are each block's left, the script's end and the strip's edge", () => {
  const { blocks, X, width, total, s } = layout(BOARD, 1400);
  assert.equal(X.length, BOARD.length + 2);
  blocks.forEach((b, i) => assert.equal(Math.round(X[i] * 10) / 10, b.left));
  assert.ok(Math.abs(X[BOARD.length] - total * s) < 1e-9, "the script ends where it does to scale");
  assert.equal(X[X.length - 1], width);
  assert.ok(ordered(X));
  knotBlocks(X).forEach((kb, i) => {
    assert.equal(kb.left, blocks[i].left);
    assert.ok(Math.abs(kb.width - blocks[i].width) <= 0.1);
  });
});

test("the rest floor: every block at least REST_MIN_PX, the room out of the longer scenes in proportion", () => {
  assert.equal(REST_MIN_PX, 5);
  const beats = longScript();
  const { blocks, X, total, s, width } = layout(beats, 1400);
  const n = beats.length;
  blocks.forEach((b) => assert.ok(b.width >= REST_MIN_PX, "scene " + b.index + " is " + b.width + "px"));
  assert.ok(slotW(X, 40) >= REST_MIN_PX + 2 - 1e-9);
  assert.ok(Math.abs(X[n] - total * s) < 1e-9);
  assert.ok(Math.abs((X[n + 1] - X[n]) - (width - total * s)) < 1e-9);
  const held = [];
  for (let i = 0; i < n; i++) if (Math.abs(slotW(X, i) - (REST_MIN_PX + 2)) < 1e-9) held.push(i);
  assert.ok(held.includes(13) && held.includes(40), "held: " + held.join(","));
  const free = beats.map((sc, i) => i).filter((i) => !held.includes(i));
  const f = slotW(X, free[0]) / beats[free[0]].seconds;
  free.forEach((i) => assert.ok(Math.abs(slotW(X, i) / beats[i].seconds - f) < 1e-9, "scene " + i));
  assert.ok(f < s);
});

test("with too many scenes for it, the floor shrinks to what fits: 80% of an even share", () => {
  const beats = denseScript(500);
  const { X, total, s } = layout(beats, 1360);
  const n = beats.length;
  const even = total * s / n;
  assert.ok(even * 0.8 < REST_MIN_PX + 2, "the test's script is too dense for the floor");
  const narrowest = Math.min(...beats.map((sc, i) => slotW(X, i)));
  assert.ok(Math.abs(narrowest - even * 0.8) < 1e-9, "the narrowest is " + narrowest + ", an even share " + even);
  assert.ok(ordered(X));
  assert.ok(Math.abs(X[n] - total * s) < 1e-9);
  const fours = beats.map((sc, i) => i).filter((i) => beats[i].seconds === 4);
  assert.ok(fours.every((i) => slotW(X, i) > narrowest * 1.2));
});

test("a floor of 2px or less is exactly to scale", () => {
  const beats = longScript();
  for (const floor of [2, 0]) {
    const { blocks, X, s } = layout(beats, 1400, floor);
    const scale = rundownBlocks(beats, s);
    blocks.forEach((b, i) => {
      assert.ok(Math.abs(X[i] - b.start * s) < 1e-9, "knot " + i);
      assert.ok(Math.abs(b.left - scale[i].left) <= 0.1 && Math.abs(b.width - scale[i].width) <= 0.1, "block " + i);
    });
  }
});

test("the time map is monotonic, meets every block's edges, and is to scale in the tail", () => {
  const beats = longScript();
  const { lay, X, total, s } = layout(beats, 1400);
  assert.equal(lay.x(0), 0);
  lay.blocks.forEach((b, i) => {
    if (!(b.seconds > 0)) return;
    assert.ok(Math.abs(lay.x(b.start) - X[i]) < 1e-9, "start of " + i);
    assert.ok(Math.abs(lay.x(b.start + b.seconds - 1e-9) - X[i + 1]) < 1e-6, "end of " + i);
  });
  let prev = -Infinity;
  for (let t = 0; t <= total + 10; t += 0.25) {
    const x = lay.x(t);
    assert.ok(x >= prev - 1e-9, "at " + t + "s");
    prev = x;
  }
  assert.ok(Math.abs(lay.x(total) - X[beats.length]) < 1e-9);
  assert.ok(Math.abs(lay.x(total + 7) - (X[beats.length] + 7 * s)) < 1e-9);
  assert.ok(Math.abs(lay.x(lay.blocks[40].start) - X[41]) < 1e-9);
});

test("the ruler is placed by the time map, and a label too close to the one before it is left off", () => {
  const beats = [];
  for (let i = 0; i < 150; i++) beats.push({ seconds: 1 });
  beats.push({ seconds: 600 });
  const { lay, total, s, width } = layout(beats, 1400);
  const span = rundownSpan(total, 0);
  const plain = rundownTicks(span, s, width);
  const ticks = rundownTicks(span, s, width, lay.x);
  assert.equal(ticks.length, plain.length);
  ticks.forEach((t) => assert.equal(t.x, Math.round(lay.x(t.seconds) * 10) / 10));
  const labelled = ticks.filter((t) => t.label);
  for (let i = 1; i < labelled.length; i++) assert.ok(labelled[i].x - labelled[i - 1].x >= 56, labelled[i].label);
  assert.ok(labelled.length >= 3);
  assert.ok(labelled.length < plain.filter((t) => t.label).length, "some labels were left off");
  labelled.forEach((t) => assert.ok(t.x + 34 <= width));
});

test("the target is placed by the time map: the line where its time falls on the blocks", () => {
  const beats = longScript();
  const { lay, total, s } = layout(beats, 1400);
  const target = Math.round(total * 0.6);
  const p = targetOverlayParts(total, target, lay.x);
  assert.equal(p.lineX, Math.round(lay.x(target) * 10) / 10);
  assert.ok(Math.abs(p.lineX - target * s) > 1, "the floor moved it off the to-scale spot");
  assert.equal(p.hatch.over, true);
  assert.ok(Math.abs(p.hatch.left - p.lineX) < 0.05);
  assert.ok(Math.abs(p.hatch.left + p.hatch.width - Math.round(lay.x(total) * 10) / 10) < 0.15);
  const lay2 = rundownRestLayout(beats, total, total + 30, 1400);
  const q = targetOverlayParts(total, total + 30, lay2.x);
  assert.ok(Math.abs(q.lineX - (total + 30) * lay2.pxPerSecond) < 0.1);
  assert.equal(targetOverlayParts(total, target, s).lineX, Math.round(target * s * 10) / 10);
});

test("the length label goes after the script's end on the rest layout", () => {
  const beats = longScript();
  const total = sumOf(beats);
  const p = rundownLengthPlace(total, total + 60, 1400, [40]);
  const lay = rundownRestLayout(beats, total, total + 60, p.width);
  assert.equal(p.pinned, false);
  assert.ok(Math.abs(p.left - (lay.knots[beats.length] + LENGTH_GAP_PX)) < 0.1);
  const last = lay.blocks[beats.length - 1];
  assert.ok(last.left + last.width < p.left);
});

const mid = (K, i) => (K[i] + K[i + 1]) / 2;

test("a script whose scenes are all wide already is not changed by the lens", () => {
  const { U, width } = layout(BOARD, 1400);
  const Y = rundownLensIndex(U, lensIndexAt(U, 500), 500);
  Y.forEach((y, i) => assert.ok(Math.abs(y - U[i]) < 1e-9, "knot " + i));
  assert.equal(Y[Y.length - 1], width);
});

test("the scene under the lens grows to LENS_MIN_PX, its number and read time showing, under the anchor", () => {
  assert.equal(LENS_MIN_PX, 96);
  const { U } = layout(longScript(), 1400);
  const i = 13;
  assert.ok(slotW(U, i) < 12, "the test's scene is a sliver");
  const focus = mid(U, i);
  const Y = rundownLensIndex(U, lensIndexAt(U, focus), focus);
  assert.ok(ordered(Y));
  const blocks = knotBlocks(Y);
  assert.ok(Math.abs(blocks[i].width - (LENS_MIN_PX - 2)) <= 0.1, "the sliver is " + blocks[i].width + "px under the lens");
  assert.ok(Math.abs(knotMap(U, Y, focus) - focus) < 1e-9);
  assert.ok(blocks[i - 1].width > slotW(U, i - 1) && blocks[i - 1].width < blocks[i].width);
  assert.ok(blocks[i + 1].width > slotW(U, i + 1) && blocks[i + 1].width < blocks[i].width);
});

test("distant blocks keep their rest width exactly: nothing away from the pointer shrinks", () => {
  const { U } = layout(longScript(), 1400);
  for (const i of [13, 40, 66]) {
    for (const opts of [undefined, { minWidth: LENS_HOLD_PX }]) {
      const Y = rundownLensIndex(U, lensIndexAt(U, mid(U, i)), mid(U, i), opts);
      for (let j = 0; j < U.length - 1; j++) {
        if (Math.abs(j - i) <= LENS_REACH_BEATS) assert.ok(slotW(Y, j) >= slotW(U, j) - 1e-9, "scene " + j + " shrank");
        else assert.ok(Math.abs(slotW(Y, j) - slotW(U, j)) < 1e-9, "scene " + j + " is " + slotW(Y, j) + ", at rest " + slotW(U, j));
      }
    }
  }
});

test("the strip grows by what the lens adds and slides: the focus lands on the anchor", () => {
  const { U, width } = layout(longScript(), 1400);
  for (const [focus, anchor] of [[333.3, 333.3], [700, 700], [700, 760], [700, 640], [1111, 1111]]) {
    const Y = rundownLensIndex(U, lensIndexAt(U, focus), anchor);
    assert.ok(Math.abs(knotMap(U, Y, focus) - anchor) < 1e-9, "focus " + focus + " at " + anchor);
    let grew = 0;
    for (let j = 0; j < U.length - 1; j++) grew += slotW(Y, j) - slotW(U, j);
    assert.ok(grew > 100, "the lens adds " + grew);
    assert.ok(Math.abs((Y[Y.length - 1] - Y[0]) - (width + grew)) < 1e-6);
    assert.ok(Y[0] < 0 && Y[Y.length - 1] > width);
  }
});

test("the ends are clamped: the strip never slides far enough to leave a gap at either end", () => {
  const { U, width } = layout(longScript(), 1400);
  const m = U.length - 1;
  for (let i = 0; i < 80; i += 3) {
    for (const anchor of [-500, 0, 20, mid(U, i), 1380, 1400, 3000]) {
      const Y = rundownLensIndex(U, lensIndexAt(U, mid(U, i)), anchor);
      assert.ok(Y[0] <= 1e-9, "a gap at the left: scene " + i + ", anchor " + anchor);
      assert.ok(Y[m] >= width - 1e-9, "a gap at the right: scene " + i + ", anchor " + anchor);
      assert.ok(ordered(Y));
    }
  }
  const Y0 = rundownLensIndex(U, lensIndexAt(U, 0), 0);
  assert.equal(Y0[0], 0);
  assert.ok(slotW(Y0, 0) >= 80, "the first scene is " + slotW(Y0, 0));
  const n = m - 1;
  const Yn = rundownLensIndex(U, lensIndexAt(U, U[n]), U[n]);
  assert.ok(Math.abs(Yn[n] - U[n]) < 1e-9 && Math.abs(Yn[m] - width) < 1e-9);
  assert.ok(slotW(Yn, n - 1) >= 80, "the last scene is " + slotW(Yn, n - 1));
  const Yt = rundownLensIndex(U, lensIndexAt(U, width - 2), width - 2);
  assert.ok(Math.abs(Yt[n] - (width - 2)) < 1e-9, "the Index focus clamps to the last beat, before the tail");
  assert.ok(Math.abs(slotW(Yn, n) - slotW(U, n)) < 1e-9);
  const Yh = rundownLensIndex(U, lensIndexAt(U, mid(U, 0)), mid(U, 0));
  assert.ok(Yh[0] < 0 && Math.abs(knotMap(U, Yh, mid(U, 0)) - mid(U, 0)) < 1e-9);
});

test("reach is counted in scenes: the focus and LENS_REACH_SCENES either side grow however thin they are, none beyond", () => {
  assert.equal(LENS_REACH_BEATS, 3);
  const { U } = layout(denseScript(600), 1400, 0);
  const i = 300;
  assert.ok(slotW(U, i + 3) < 4 && slotW(U, i - 3) < 4, "the test's scenes are thin");
  const Y = rundownLensIndex(U, lensIndexAt(U, mid(U, i)), mid(U, i));
  for (let j = i - 6; j <= i + 6; j++) {
    const d = Math.abs(j - i);
    if (d <= LENS_REACH_BEATS) assert.ok(slotW(Y, j) > slotW(U, j) + 0.5, "scene " + j + " (" + d + " away) did not grow");
    else assert.ok(Math.abs(slotW(Y, j) - slotW(U, j)) < 1e-9, "scene " + j + " (" + d + " away) grew");
  }
  const wide = layout(Array.from({ length: 30 }, () => ({ seconds: 1 })), 1400);
  assert.ok(Math.abs(slotW(wide.U, 15) - 35) < 1e-9);
  const Yw = rundownLensIndex(wide.U, 15.5, mid(wide.U, 15));
  for (let j = 10; j <= 20; j++) {
    const grew = slotW(Yw, j) > slotW(wide.U, j) + 1e-9;
    assert.equal(grew, Math.abs(j - 15) <= 2, "scene " + j);
  }
});

test("a scene already wider than the lens keeps its width, and its neighbours still grow", () => {
  const beats = [];
  for (let i = 0; i < 40; i++) beats.push({ seconds: i === 20 ? 120 : 3 });
  const { U } = layout(beats, 1400);
  assert.ok(slotW(U, 20) > LENS_MIN_PX * 2, "the test's scene is wide");
  const Y = rundownLensIndex(U, lensIndexAt(U, mid(U, 20)), mid(U, 20));
  assert.ok(Math.abs(slotW(Y, 20) - slotW(U, 20)) < 1e-9);
  assert.ok(slotW(Y, 19) > slotW(U, 19) + 20 && slotW(Y, 21) > slotW(U, 21) + 20);
});

test("the second stage is the same lens, wider", () => {
  const { U } = layout(longScript(), 1400);
  const i = 30;
  const Y = rundownLensIndex(U, lensIndexAt(U, mid(U, i)), mid(U, i), { minWidth: LENS_HOLD_PX });
  assert.ok(Math.abs(slotW(Y, i) - LENS_HOLD_PX) < 1e-9);
  assert.ok(Math.abs(knotMap(U, Y, mid(U, i)) - mid(U, i)) < 1e-9);
});

test("knots stay ordered wherever the focus and anchor are", () => {
  const { U } = layout(longScript(), 1400);
  for (let f = 0; f <= 1400; f += 7) {
    for (const a of [f, f - 90, f + 90]) assert.ok(ordered(rundownLensIndex(U, lensIndexAt(U, f), a)), f + " at " + a);
  }
});

test("hundreds of scenes: the lens magnifies as much, and the rest keep their width", () => {
  const beats = denseScript(500);
  const { U, width } = layout(beats, 1360);
  const i = 250;
  const Y = rundownLensIndex(U, lensIndexAt(U, mid(U, i)), mid(U, i));
  assert.ok(ordered(Y));
  assert.ok(Y[0] < 0 && Y[Y.length - 1] > width);
  assert.ok(Math.abs(slotW(Y, i) - LENS_MIN_PX) < 1e-9, "the focus is " + slotW(Y, i));
  for (let j = 0; j < 500; j++) if (Math.abs(j - i) > LENS_REACH_BEATS) assert.ok(Math.abs(slotW(Y, j) - slotW(U, j)) < 1e-9);
});

test("knotMap is piecewise linear, clamps at the ends and inverts itself", () => {
  const from = [0, 10, 10, 30, 100];
  const to = [0, 50, 60, 80, 100];
  assert.equal(knotMap(from, to, -5), 0);
  assert.equal(knotMap(from, to, 5), 25);
  assert.equal(knotMap(from, to, 20), 70);
  assert.equal(knotMap(from, to, 200), 100);
  const { U } = layout(longScript(), 1400);
  const Y = rundownLensIndex(U, lensIndexAt(U, 512), 512);
  for (const u of [3, 99.5, 512, 800.25, 1399]) assert.ok(Math.abs(knotMap(Y, U, knotMap(U, Y, u)) - u) < 1e-6);
});

test("a drop lands in the nearest gap between blocks, within reach", () => {
  const K = [0, 100, 200, 300, 400, 1000];
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

test("the lens keeps a label a block showed at rest while it fits", () => {
  const [a, b] = rundownBlocks([{ seconds: 30 }, { seconds: 4 }], 1);
  assert.equal(a.showNumber, true);
  assert.equal(a.showLength, false);
  assert.deepEqual(rundownKeepLabels(a, 20, false), { number: true, length: false });
  assert.deepEqual(rundownKeepLabels(a, 17, false), { number: false, length: false });
  assert.equal(b.showNumber, false);
  assert.deepEqual(rundownKeepLabels(b, 90, false), { number: false, length: false });
});

test("the read time is kept down to the tight width, wider for a shot block", () => {
  const [a] = rundownBlocks([{ seconds: 90 }], 1);
  assert.equal(a.showLength, true);
  assert.equal(rundownKeepLabels(a, 56, false).length, true);
  assert.equal(rundownKeepLabels(a, 55, false).length, false);
  assert.equal(rundownKeepLabels(a, 69, true).length, false);
  assert.equal(rundownKeepLabels(a, 70, true).length, true);
});

test("from scene 100 the number needs room for three digits", () => {
  const rest = { index: 99, showNumber: true, showLength: false };
  assert.equal(rundownKeepLabels(rest, 24, false).number, false);
  assert.equal(rundownKeepLabels(rest, 25, false).number, true);
  assert.equal(rundownKeepLabels({ index: 98, showNumber: true }, 18, false).number, true);
});
