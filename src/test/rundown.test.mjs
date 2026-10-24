import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  LENGTH_GAP_PX,
  LENS_HOLD_PX,
  LENS_MIN_PX,
  LENS_REACH_SCENES,
  REST_MIN_PX,
  RUNDOWN_TAIL_SECONDS,
  knotBlocks,
  knotMap,
  rundownBlocks,
  rundownDropGap,
  rundownKeepLabels,
  rundownLens,
  rundownLensFollow,
  LENS_SLOW_PX_MS,
  rundownLensRecenter,
  rundownLengthPlace,
  rundownRestLayout,
  rundownScale,
  rundownSpan,
  rundownTicks
} from "../features/rundown/rundown.js";
import { targetOverlayParts } from "../features/rundown/target.js";

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
  const scenes = [];
  for (let i = 0; i < 80; i++) {
    scenes.push({ seconds: i === 40 ? 0 : i % 9 === 4 ? 3 : 4 + (i * 7) % 11, status: i % 4 === 0 ? "shot" : "todo" });
  }
  return scenes;
}

function denseScript(n) {
  const scenes = [];
  for (let i = 0; i < n; i++) scenes.push({ seconds: i % 25 === 7 ? 0 : 1 + (i * 7) % 4, status: "todo" });
  return scenes;
}

const sumOf = (scenes) => scenes.reduce((n, sc) => n + sc.seconds, 0);

function layout(scenes, width, floor) {
  const total = sumOf(scenes);
  const lay = rundownRestLayout(scenes, total, 0, width, floor);
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
  const scenes = longScript();
  const { blocks, X, total, s, width } = layout(scenes, 1400);
  const n = scenes.length;
  blocks.forEach((b) => assert.ok(b.width >= REST_MIN_PX, "scene " + b.index + " is " + b.width + "px"));
  assert.ok(slotW(X, 40) >= REST_MIN_PX + 2 - 1e-9);
  assert.ok(Math.abs(X[n] - total * s) < 1e-9);
  assert.ok(Math.abs((X[n + 1] - X[n]) - (width - total * s)) < 1e-9);
  const held = [];
  for (let i = 0; i < n; i++) if (Math.abs(slotW(X, i) - (REST_MIN_PX + 2)) < 1e-9) held.push(i);
  assert.ok(held.includes(13) && held.includes(40), "held: " + held.join(","));
  const free = scenes.map((sc, i) => i).filter((i) => !held.includes(i));
  const f = slotW(X, free[0]) / scenes[free[0]].seconds;
  free.forEach((i) => assert.ok(Math.abs(slotW(X, i) / scenes[i].seconds - f) < 1e-9, "scene " + i));
  assert.ok(f < s);
});

test("with too many scenes for it, the floor shrinks to what fits: 80% of an even share", () => {
  const scenes = denseScript(500);
  const { X, total, s } = layout(scenes, 1360);
  const n = scenes.length;
  const even = total * s / n;
  assert.ok(even * 0.8 < REST_MIN_PX + 2, "the test's script is too dense for the floor");
  const narrowest = Math.min(...scenes.map((sc, i) => slotW(X, i)));
  assert.ok(Math.abs(narrowest - even * 0.8) < 1e-9, "the narrowest is " + narrowest + ", an even share " + even);
  assert.ok(ordered(X));
  assert.ok(Math.abs(X[n] - total * s) < 1e-9);
  const fours = scenes.map((sc, i) => i).filter((i) => scenes[i].seconds === 4);
  assert.ok(fours.every((i) => slotW(X, i) > narrowest * 1.2));
});

test("a floor of 2px or less is exactly to scale", () => {
  const scenes = longScript();
  for (const floor of [2, 0]) {
    const { blocks, X, s } = layout(scenes, 1400, floor);
    const scale = rundownBlocks(scenes, s);
    blocks.forEach((b, i) => {
      assert.ok(Math.abs(X[i] - b.start * s) < 1e-9, "knot " + i);
      assert.ok(Math.abs(b.left - scale[i].left) <= 0.1 && Math.abs(b.width - scale[i].width) <= 0.1, "block " + i);
    });
  }
});

test("the time map is monotonic, meets every block's edges, and is to scale in the tail", () => {
  const scenes = longScript();
  const { lay, X, total, s } = layout(scenes, 1400);
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
  assert.ok(Math.abs(lay.x(total) - X[scenes.length]) < 1e-9);
  assert.ok(Math.abs(lay.x(total + 7) - (X[scenes.length] + 7 * s)) < 1e-9);
  assert.ok(Math.abs(lay.x(lay.blocks[40].start) - X[41]) < 1e-9);
});

test("the ruler is placed by the time map, and a label too close to the one before it is left off", () => {
  const scenes = [];
  for (let i = 0; i < 150; i++) scenes.push({ seconds: 1 });
  scenes.push({ seconds: 600 });
  const { lay, total, s, width } = layout(scenes, 1400);
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
  const scenes = longScript();
  const { lay, total, s } = layout(scenes, 1400);
  const target = Math.round(total * 0.6);
  const p = targetOverlayParts(total, target, lay.x);
  assert.equal(p.lineX, Math.round(lay.x(target) * 10) / 10);
  assert.ok(Math.abs(p.lineX - target * s) > 1, "the floor moved it off the to-scale spot");
  assert.equal(p.hatch.over, true);
  assert.ok(Math.abs(p.hatch.left - p.lineX) < 0.05);
  assert.ok(Math.abs(p.hatch.left + p.hatch.width - Math.round(lay.x(total) * 10) / 10) < 0.15);
  const lay2 = rundownRestLayout(scenes, total, total + 30, 1400);
  const q = targetOverlayParts(total, total + 30, lay2.x);
  assert.ok(Math.abs(q.lineX - (total + 30) * lay2.pxPerSecond) < 0.1);
  assert.equal(targetOverlayParts(total, target, s).lineX, Math.round(target * s * 10) / 10);
});

test("the length label goes after the script's end on the rest layout", () => {
  const scenes = longScript();
  const total = sumOf(scenes);
  const p = rundownLengthPlace(total, total + 60, 1400, [40]);
  const lay = rundownRestLayout(scenes, total, total + 60, p.width);
  assert.equal(p.pinned, false);
  assert.ok(Math.abs(p.left - (lay.knots[scenes.length] + LENGTH_GAP_PX)) < 0.1);
  const last = lay.blocks[scenes.length - 1];
  assert.ok(last.left + last.width < p.left);
});

const mid = (K, i) => (K[i] + K[i + 1]) / 2;

test("a script whose scenes are all wide already is not changed by the lens", () => {
  const { U, width } = layout(BOARD, 1400);
  const Y = rundownLens(U, 500, 500);
  Y.forEach((y, i) => assert.ok(Math.abs(y - U[i]) < 1e-9, "knot " + i));
  assert.equal(Y[Y.length - 1], width);
});

test("the scene under the lens grows to LENS_MIN_PX, its number and read time showing, under the anchor", () => {
  assert.equal(LENS_MIN_PX, 96);
  const { U } = layout(longScript(), 1400);
  const i = 13;
  assert.ok(slotW(U, i) < 12, "the test's scene is a sliver");
  const focus = mid(U, i);
  const Y = rundownLens(U, focus, focus);
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
      const Y = rundownLens(U, mid(U, i), mid(U, i), opts);
      for (let j = 0; j < U.length - 1; j++) {
        if (Math.abs(j - i) <= LENS_REACH_SCENES) assert.ok(slotW(Y, j) >= slotW(U, j) - 1e-9, "scene " + j + " shrank");
        else assert.ok(Math.abs(slotW(Y, j) - slotW(U, j)) < 1e-9, "scene " + j + " is " + slotW(Y, j) + ", at rest " + slotW(U, j));
      }
    }
  }
});

test("the strip grows by what the lens adds and slides: the focus lands on the anchor", () => {
  const { U, width } = layout(longScript(), 1400);
  for (const [focus, anchor] of [[333.3, 333.3], [700, 700], [700, 760], [700, 640], [1111, 1111]]) {
    const Y = rundownLens(U, focus, anchor);
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
      const Y = rundownLens(U, mid(U, i), anchor);
      assert.ok(Y[0] <= 1e-9, "a gap at the left: scene " + i + ", anchor " + anchor);
      assert.ok(Y[m] >= width - 1e-9, "a gap at the right: scene " + i + ", anchor " + anchor);
      assert.ok(ordered(Y));
    }
  }
  const Y0 = rundownLens(U, 0, 0);
  assert.equal(Y0[0], 0);
  assert.ok(slotW(Y0, 0) >= 80, "the first scene is " + slotW(Y0, 0));
  const n = m - 1;
  const Yn = rundownLens(U, U[n], U[n]);
  assert.ok(Math.abs(Yn[n] - U[n]) < 1e-9 && Math.abs(Yn[m] - width) < 1e-9);
  assert.ok(slotW(Yn, n - 1) >= 80, "the last scene is " + slotW(Yn, n - 1));
  const Yt = rundownLens(U, width - 2, width - 2);
  assert.ok(Math.abs(Yt[m] - width) < 1e-9);
  assert.ok(Math.abs(slotW(Yn, n) - slotW(U, n)) < 1e-9);
  const Yh = rundownLens(U, mid(U, 0), mid(U, 0));
  assert.ok(Yh[0] < 0 && Math.abs(knotMap(U, Yh, mid(U, 0)) - mid(U, 0)) < 1e-9);
});

test("reach is counted in scenes: the focus and LENS_REACH_SCENES either side grow however thin they are, none beyond", () => {
  assert.equal(LENS_REACH_SCENES, 3);
  const { U } = layout(denseScript(600), 1400, 0);
  const i = 300;
  assert.ok(slotW(U, i + 3) < 4 && slotW(U, i - 3) < 4, "the test's scenes are thin");
  const Y = rundownLens(U, mid(U, i), mid(U, i));
  for (let j = i - 6; j <= i + 6; j++) {
    const d = Math.abs(j - i);
    if (d <= LENS_REACH_SCENES) assert.ok(slotW(Y, j) > slotW(U, j) + 0.5, "scene " + j + " (" + d + " away) did not grow");
    else assert.ok(Math.abs(slotW(Y, j) - slotW(U, j)) < 1e-9, "scene " + j + " (" + d + " away) grew");
  }
  const wide = layout(Array.from({ length: 30 }, () => ({ seconds: 1 })), 1400);
  assert.ok(Math.abs(slotW(wide.U, 15) - 35) < 1e-9);
  const Yw = rundownLens(wide.U, mid(wide.U, 15), mid(wide.U, 15));
  for (let j = 10; j <= 20; j++) {
    const grew = slotW(Yw, j) > slotW(wide.U, j) + 1e-9;
    assert.equal(grew, Math.abs(j - 15) <= 2, "scene " + j);
  }
});

test("a scene already wider than the lens keeps its width, and its neighbours still grow", () => {
  const scenes = [];
  for (let i = 0; i < 40; i++) scenes.push({ seconds: i === 20 ? 120 : 3 });
  const { U } = layout(scenes, 1400);
  assert.ok(slotW(U, 20) > LENS_MIN_PX * 2, "the test's scene is wide");
  const Y = rundownLens(U, mid(U, 20), mid(U, 20));
  assert.ok(Math.abs(slotW(Y, 20) - slotW(U, 20)) < 1e-9);
  assert.ok(slotW(Y, 19) > slotW(U, 19) + 20 && slotW(Y, 21) > slotW(U, 21) + 20);
});

test("the second stage is the same lens, wider", () => {
  const { U } = layout(longScript(), 1400);
  const i = 30;
  const Y = rundownLens(U, mid(U, i), mid(U, i), { minWidth: LENS_HOLD_PX });
  assert.ok(Math.abs(slotW(Y, i) - LENS_HOLD_PX) < 1e-9);
  assert.ok(Math.abs(knotMap(U, Y, mid(U, i)) - mid(U, i)) < 1e-9);
});

test("knots stay ordered wherever the focus and anchor are", () => {
  const { U } = layout(longScript(), 1400);
  for (let f = 0; f <= 1400; f += 7) {
    for (const a of [f, f - 90, f + 90]) assert.ok(ordered(rundownLens(U, f, a)), f + " at " + a);
  }
});

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
  const i = 31;
  const x0 = X[i] - 30;
  const moves = [];
  for (let k = 1; k <= 400; k++) moves.push([x0 + k, 16]);
  const frames = drive(U, X, x0, moves);
  const px = {};
  frames.slice(1).forEach((f) => { const sc = sceneAt(f.shown, f.x); px[sc] = (px[sc] || 0) + 1; });
  assert.ok(px[i] >= 40, "the sliver was under the pointer for " + px[i] + "px: " + JSON.stringify(px));
  const seq = frames.map((f) => sceneAt(f.shown, f.x));
  for (let k = 1; k < seq.length; k++) assert.ok(seq[k] - seq[k - 1] >= 0 && seq[k] - seq[k - 1] <= 1, "scene " + seq[k - 1] + " to " + seq[k]);
  for (const f of frames) {
    assert.ok(ordered(f.shown));
    assert.ok(Math.abs(f.x - f.anchor) <= LENS_MIN_PX * 1.5, "the lens is " + (f.x - f.anchor).toFixed(1) + "px off the pointer at " + f.x);
    const jf = sceneAt(U, f.focus);
    for (let j = 0; j < 80; j++) if (Math.abs(j - jf) > LENS_REACH_SCENES + 1) assert.ok(Math.abs(slotW(f.shown, j) - slotW(U, j)) < 1e-9, "scene " + j + ", the focus in " + jf);
  }
});

test("#199: a pointer that stops on a sliver keeps it, and the lens comes to rest centred on the pointer", () => {
  const { U, X } = layout(longScript(), 1400);
  const i = 31;
  const x0 = X[i] - 8;
  const moves = [];
  let frames = [];
  for (let k = 1; k <= 400; k++) {
    moves.push([x0 + k, 16]);
    frames = drive(U, X, x0, moves);
    if (sceneAt(frames[frames.length - 1].shown, frames[frames.length - 1].x) === i) break;
  }
  const xs = frames[frames.length - 1].x + 4;
  for (let k = 1; k <= 4; k++) moves.push([xs - 4 + k, 16]);
  for (let k = 0; k < 150; k++) moves.push([xs, 16]);
  frames = drive(U, X, x0, moves);
  const stopped = frames.length - 151;
  for (let k = stopped; k < frames.length; k++) {
    assert.equal(sceneAt(frames[k].shown, xs), i, "the sliver left the pointer " + (k - stopped) + " frames after it stopped");
  }
  const rest = frames[frames.length - 1];
  assert.ok(rest.shown[i + 1] - rest.shown[i] >= 80, "and it is " + (rest.shown[i + 1] - rest.shown[i]).toFixed(1) + "px wide");
  assert.ok(Math.abs(rest.anchor - xs) < 8, "the lens's centre is " + (rest.anchor - xs).toFixed(2) + "px off the pointer");
  assert.ok(Math.abs(knotMap(rest.shown, U, xs) - rest.focus) < 0.5);
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
  for (let x = 20; x <= 1400; x += 20) moves.push([x, 6]);
  const frames = drive(U, X, 0, moves);
  for (const f of frames.slice(1)) {
    assert.ok(Math.abs(f.focus - knotMap(X, U, f.x)) < 8, "focus at " + f.x);
    assert.ok(ordered(f.shown));
  }
  const f1 = frames[20];
  const moved = rundownLensFollow(U, X, f1.shown, f1.focus, f1.anchor, f1.x + 20, 20, 6);
  assert.ok(Math.abs(moved.focus - knotMap(X, U, f1.x + 20)) < 1e-6);
  assert.ok(Math.abs(moved.anchor - (f1.x + 20)) < 1e-6);
  const end = frames[frames.length - 1];
  assert.ok(end.shown[end.shown.length - 1] >= 1400 - 1e-9);
  assert.ok(sceneAt(end.shown, 1399) === 79 || sceneAt(end.shown, 1399) === -1, "scene " + sceneAt(end.shown, 1399) + " at the edge");
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
  const moves = [];
  for (let k = 1; k <= 90; k++) moves.push([X[40] - k, 16]);
  const back = drive(U, X, X[40] + 1, moves);
  assert.ok(back.some((f) => sceneAt(f.shown, f.x) === 40), "scene 40 under the pointer");
  const f40 = back.find((f) => sceneAt(f.shown, f.x) === 40);
  assert.ok(f40.shown[41] - f40.shown[40] >= 28, "and wide enough for its number");
});

test("hundreds of scenes: the lens magnifies as much, and the rest keep their width", () => {
  const scenes = denseScript(500);
  const { U, width } = layout(scenes, 1360);
  const i = 250;
  const Y = rundownLens(U, mid(U, i), mid(U, i));
  assert.ok(ordered(Y));
  assert.ok(Y[0] < 0 && Y[Y.length - 1] > width);
  assert.ok(Math.abs(slotW(Y, i) - LENS_MIN_PX) < 1e-9, "the focus is " + slotW(Y, i));
  for (let j = 0; j < 500; j++) if (Math.abs(j - i) > LENS_REACH_SCENES) assert.ok(Math.abs(slotW(Y, j) - slotW(U, j)) < 1e-9);
});

function sweep(U, X, x0, px, speed) {
  const moves = [];
  const step = speed * 16;
  for (let d = step; d <= px + 1e-9; d += step) moves.push([x0 + d, 16]);
  return drive(U, X, x0, moves);
}

test("a slow pointer over a 500-scene script passes at most 3 scenes per 100px (860ada2, with the rest floor and the slide)", () => {
  const scenes = denseScript(500);
  const { U, X } = layout(scenes, 1360);
  for (const speed of [0.1, 0.2, 0.3]) {
    for (const x0 of [200, 680, 1100]) {
      for (const dir of [1, -1]) {
        const frames = sweep(U, X, x0, 100 * dir, speed * dir);
        const seen = new Set(frames.map((f) => sceneAt(f.shown, f.x)));
        assert.ok(seen.size - 1 <= 3, "at " + speed + "px/ms from " + x0 + (dir > 0 ? " right" : " left") + ": " + (seen.size - 1) + " scenes");
      }
    }
  }
});

test("a still pointer moves nothing; a flick over a 500-scene script travels end to end", () => {
  const scenes = denseScript(500);
  const { U, X } = layout(scenes, 1360);
  const moves = [];
  for (let k = 0; k < 200; k++) moves.push([680, 16]);
  const frames = drive(U, X, 680, moves);
  const last = frames[frames.length - 1], before = frames[frames.length - 2];
  last.shown.forEach((y, k) => assert.ok(Math.abs(y - before.shown[k]) < 0.05, "knot " + k + " still moving"));
  const still = rundownLensFollow(U, X, last.shown, last.focus, last.anchor, 680, 0, 16);
  assert.equal(still.focus, last.focus);
  assert.equal(still.anchor, last.anchor);
  const flick = [];
  for (let x = 30; x <= 1350; x += 30) flick.push([x, 6]);
  const f = drive(U, X, 0, flick);
  assert.ok(sceneAt(f[0].shown, 0) <= 1);
  assert.ok(sceneAt(f[f.length - 1].shown, 1350) >= 490, "the flick ended over scene " + sceneAt(f[f.length - 1].shown, 1350));
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

test("over dense scenes a moderate speed aims; over wide ones it travels", () => {
  const dense = [0];
  for (let i = 0; i < 500; i++) dense.push(dense[dense.length - 1] + 2.7);
  dense.push(1360);
  const sparse = [0];
  for (let i = 0; i < 10; i++) sparse.push(sparse[sparse.length - 1] + 120);
  sparse.push(1360);
  const speed = 0.3, dt = 16, dx = speed * dt;
  const d = rundownLensFollow(dense, dense, dense, 675, 675, 675 + dx, dx, dt);
  assert.equal(d.focus, 675);
  const s = rundownLensFollow(sparse, sparse, sparse, 600, 600, 600 + dx, dx, dt);
  assert.ok(s.focus > 600, "travels a little over wide scenes");
  const f = rundownLensFollow(dense, dense, dense, 675, 675, 675 + 48, 48, dt);
  assert.ok(f.focus > 700);
  assert.ok(LENS_SLOW_PX_MS > 0);
});
