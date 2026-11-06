import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { LENS_MIN_PX, rundownLens, rundownLensIndex, rundownRestLayout } from "../features/rundown/rundown.ts";
import {
  LOCK_EDGE_PX,
  LOCK_MARGIN_PX,
  lensIndexAt,
  lensIndexFit,
  lensIndexMap,
  lensLockAnchor,
  lensLockStep,
  lensPointAt
} from "../features/rundown/lens-trial.ts";

function script(n, secondsOf) {
  return Array.from({ length: n }, (_, i) => ({ seconds: secondsOf(i), status: "todo" }));
}

const SCRIPTS = {
  alternating: script(30, (i) => (i % 2 === 0 ? 2 : 180)),
  mixed: script(150, (i) => [2, 5, 12, 30, 75, 150][(i * 7 + (i >> 2)) % 6]),
  even: script(40, () => 20)
};

function rest(beats, width) {
  const total = beats.reduce((n, b) => n + b.seconds, 0);
  const lay = rundownRestLayout(beats, total, 0, width);
  return { U: lay.knots, n: beats.length, W: width };
}

const widthOf = (K, i) => K[i + 1] - K[i];

function ordered(K) {
  for (let i = 1; i < K.length; i++) if (K[i] < K[i - 1] - 1e-9) return false;
  return true;
}

test("the index lens is the same lens: a focus given as a rest position or as its index draws the same strip", () => {
  const { U, W } = rest(SCRIPTS.mixed, 1360);
  for (const p of [0, 3, 211.5, 680, 1100, W - 8]) {
    for (const a of [p, p - 60, p + 90, 0, W]) {
      const byPosition = rundownLens(U, p, a);
      const byIndex = rundownLensIndex(U, lensIndexAt(U, p), a);
      byPosition.forEach((k, i) => assert.ok(Math.abs(k - byIndex[i]) < 1e-9, "knot " + i + " at " + p + "/" + a));
    }
  }
});

test("index and position read each other back on a lensed strip, and clamp at its two ends", () => {
  const { U, n } = rest(SCRIPTS.alternating, 1300);
  const anchor = lensPointAt(rundownLensIndex(U, 12.4, 1e6), 12.4);
  const Y = rundownLensIndex(U, 12.4, anchor);
  assert.ok(anchor > 100 && anchor < 1200);
  assert.ok(Math.abs(lensPointAt(Y, 12.4) - anchor) < 1e-9, "the focus lands on the anchor");
  let last = -1;
  for (let x = Y[0]; x <= Y[n]; x += 3) {
    const q = lensIndexAt(Y, x);
    assert.ok(q >= last - 1e-12, "monotone at " + x);
    assert.ok(Math.abs(lensPointAt(Y, q) - x) < 1e-6, "round trip at " + x);
    last = q;
  }
  assert.equal(lensIndexAt(Y, Y[0] - 50), 0);
  assert.equal(lensIndexAt(Y, Y[n] + 50), n);
  assert.equal(lensPointAt(Y, -3), Y[0]);
  assert.equal(lensPointAt(Y, n + 3), Y[n]);
});

test("the index map runs through the entry point and both ends, monotone and continuous", () => {
  const W = 1300, n = 30;
  for (const ref of [{ x: 0, q: 0 }, { x: 400, q: 3.4 }, { x: 650, q: 15 }, { x: 1100, q: 27 }, { x: W, q: n }]) {
    assert.ok(Math.abs(lensIndexMap(ref, ref.x, W, n) - ref.q) < 1e-9, "through the entry point");
    assert.equal(lensIndexMap(ref, 0, W, n), 0);
    assert.equal(lensIndexMap(ref, W, W, n), n);
    let last = -1;
    for (let x = 0; x <= W; x++) {
      const q = lensIndexMap(ref, x, W, n);
      assert.ok(q >= last, "monotone at " + x);
      if (last >= 0) assert.ok(q - last <= (n - 0) / Math.min(W - ref.x || W, ref.x || W) + 1e-9, "continuous at " + x);
      last = q;
    }
  }
  const slopeAfter = lensIndexMap({ x: 400, q: 3.4 }, 401, W, n) - lensIndexMap({ x: 400, q: 3.4 }, 400, W, n);
  assert.ok(Math.abs(slopeAfter - (n - 3.4) / (W - 400)) < 1e-12, "a beat is the same pointer travel all the way to the right end");
});

function sweepIndex(base, fromX, width, step) {
  const { U, n, W } = base;
  const layout = (index, anchor) => rundownLensIndex(U, index, anchor);
  const ref = { x: fromX, q: lensIndexAt(U, fromX) };
  const travel = new Array(n).fill(0);
  const seq = [];
  let prev = null;
  const shown = [];
  for (let x = fromX; x <= width; x += step) {
    const q = lensIndexFit(lensIndexMap(ref, x, W, n), x, layout, n);
    const T = rundownLensIndex(U, q, x);
    assert.ok(ordered(T), "ordered at " + x);
    const at = Math.min(n - 1, Math.floor(lensIndexAt(T, x)));
    if (prev !== null) travel[at] += step;
    if (!seq.length || seq[seq.length - 1] !== at) seq.push(at);
    shown.push({ x, q, at, T });
    prev = x;
  }
  return { travel, seq, shown };
}

test("index lens: every beat of an alternating 2s / 180s script gets about the same pointer travel", () => {
  const base = rest(SCRIPTS.alternating, 1300);
  const { travel, seq, shown } = sweepIndex(base, 0, base.W - 1, 1);
  for (let i = 1; i < seq.length; i++) assert.equal(seq[i] - seq[i - 1], 1, "no beat skipped or revisited: " + seq.slice(i - 1, i + 1));
  const shortTravel = travel.filter((_, i) => i % 2 === 0);
  assert.ok(Math.min(...shortTravel.slice(1, -1)) >= 20, "a 2s beat gets " + Math.min(...shortTravel.slice(1, -1)) + "px");
  for (const s of shown) assert.ok(Math.abs(lensPointAt(s.T, s.q) - s.x) < 1e-6 || s.x < 1 || s.x > base.W - 1, "the focus is under the pointer at " + s.x);
});

test("index lens: what is drawn under the pointer is the focus, wherever the pointer entered the bar", () => {
  for (const name of Object.keys(SCRIPTS)) {
    const base = rest(SCRIPTS[name], 1300);
    for (const entry of [4, 333, 650, 977, 1290]) {
      const layout = (index, anchor) => rundownLensIndex(base.U, index, anchor);
      const ref = { x: entry, q: lensIndexAt(base.U, entry) };
      let last = -1;
      for (let x = 0; x <= base.W; x += 7) {
        const q = lensIndexFit(lensIndexMap(ref, x, base.W, base.n), x, layout, base.n);
        const T = rundownLensIndex(base.U, q, x);
        assert.ok(Math.abs(lensPointAt(T, q) - x) < 1, name + " from " + entry + ": the focus is " + (lensPointAt(T, q) - x).toFixed(2) + "px off the pointer at " + x);
        assert.ok(T[0] <= 1e-9 && T[base.n + 1] >= base.W - 1e-9, name + ": a gap at an end");
        assert.ok(q >= last - 1e-9, name + ": the focus went back at " + x);
        last = q;
      }
      const first = lensIndexAt(base.U, entry);
      const atEntry = lensIndexFit(lensIndexMap(ref, entry, base.W, base.n), entry, layout, base.n);
      assert.ok(Math.abs(atEntry - first) < 1e-6, name + ": the beat under the pointer changed on entry (" + first.toFixed(2) + " to " + atEntry.toFixed(2) + ")");
    }
  }
});

test("index lens: the first and the last beat can be reached at the two ends of the bar", () => {
  for (const name of Object.keys(SCRIPTS)) {
    const base = rest(SCRIPTS[name], 1300);
    const layout = (index, anchor) => rundownLensIndex(base.U, index, anchor);
    const ref = { x: 650, q: lensIndexAt(base.U, 650) };
    const first = lensIndexFit(lensIndexMap(ref, 0, base.W, base.n), 0, layout, base.n);
    const last = lensIndexFit(lensIndexMap(ref, base.W - 1, base.W, base.n), base.W - 1, layout, base.n);
    assert.equal(Math.floor(first), 0, name);
    assert.ok(Math.floor(last) >= base.n - 1, name + ": the pointer at the right end is over beat " + Math.floor(last));
  }
});

test("lock: the locked beat holds while the pointer stays inside it, with a margin", () => {
  const { U, n, W } = rest(SCRIPTS.alternating, 1300);
  const T = rundownLensIndex(U, 14.5, 650);
  const k = 14;
  assert.equal(lensLockStep(T, k, (T[k] + T[k + 1]) / 2, W), k);
  assert.equal(lensLockStep(T, k, T[k] - LOCK_MARGIN_PX + 0.5, W), k, "just outside on the left, inside the margin");
  assert.equal(lensLockStep(T, k, T[k + 1] + LOCK_MARGIN_PX - 0.5, W), k, "just outside on the right, inside the margin");
  assert.equal(lensLockStep(T, k, T[k + 1] + LOCK_MARGIN_PX + 0.5, W), k + 1, "past the margin, the beat under the pointer");
  assert.equal(lensLockStep(T, k, T[k] - LOCK_MARGIN_PX - 0.5, W), k - 1);
  assert.equal(lensLockStep(T, -1, (T[3] + T[4]) / 2, W), 3, "no lock yet: the beat under the pointer");
  assert.equal(lensLockStep(T, 2 * n, 600, W), Math.floor(lensIndexAt(T, 600)), "a stale lock is dropped");
});

test("lock: the margin never swallows a narrow neighbour", () => {
  const { U, W } = rest(SCRIPTS.alternating, 1300);
  const T = rundownLensIndex(U, 14.5, 650);
  const wide = 5, narrow = 4;
  assert.ok(widthOf(T, narrow) < 2 * LOCK_MARGIN_PX, "the test's neighbour is narrow: " + widthOf(T, narrow));
  assert.ok(widthOf(T, wide) > 2 * LOCK_MARGIN_PX);
  const inNeighbour = T[wide] - widthOf(T, narrow) / 2 - 0.5;
  assert.equal(lensLockStep(T, wide, inNeighbour, W), narrow, "past the middle of the narrow neighbour, the lock moves to it");
  assert.equal(lensLockStep(T, wide, T[wide] - widthOf(T, narrow) / 2 + 0.5, W), wide, "short of its middle it holds");
});

test("lock: a pointer jittering across a boundary does not flip the lock back and forth", () => {
  const { U, W } = rest(SCRIPTS.mixed, 1360);
  let lock = -1;
  let T = U;
  let moves = 0;
  const start = 700;
  for (let k = 0; k < 400; k++) {
    const x = start + Math.sin(k / 3) * 4;
    const next = lensLockStep(T, lock, x, W);
    if (next !== lock) {
      moves++;
      lock = next;
      T = rundownLensIndex(U, lock + 0.5, lensLockAnchor(T, lock, W, LENS_MIN_PX));
    }
  }
  assert.ok(moves <= 1, "the lock moved " + moves + " times");
  assert.equal(lock, Math.floor(lensIndexAt(U, start)));
});

test("lock: the pointer stays inside the beat it just locked, however narrow that beat was", () => {
  for (const name of ["alternating", "mixed"]) {
    const { U, n, W } = rest(SCRIPTS[name], 1360);
    let lock = -1;
    let T = U;
    for (let x = 0; x <= W; x += 1.5) {
      const next = lensLockStep(T, lock, x, W);
      if (next !== lock) {
        const anchor = lensLockAnchor(T, next, W, LENS_MIN_PX);
        lock = next;
        T = rundownLensIndex(U, lock + 0.5, anchor);
      }
      assert.ok(ordered(T));
      assert.ok(x >= T[lock] - LOCK_MARGIN_PX - 1e-9 && x < T[lock + 1] + LOCK_MARGIN_PX + 1e-9, name + ": beat " + lock + " is [" + T[lock].toFixed(1) + ", " + T[lock + 1].toFixed(1) + "] and the pointer " + x);
    }
    assert.equal(n, U.length - 2);
  }
});

test("lock: at the track's right end the lock walks on to the last beat, which ends up on the track", () => {
  const { U, n, W } = rest(SCRIPTS.alternating, 1300);
  let lock = 22;
  let T = rundownLensIndex(U, lock + 0.5, lensLockAnchor(U, lock, W, LENS_MIN_PX));
  const x = W - 2;
  for (let frame = 0; frame < 3 * n; frame++) {
    const next = lensLockStep(T, lock, x, W);
    if (next === lock) break;
    const anchor = lensLockAnchor(T, next, W, LENS_MIN_PX);
    lock = next;
    T = rundownLensIndex(U, lock + 0.5, anchor);
  }
  assert.equal(lock, n - 1);
  assert.ok(T[n - 1] < W - 40 && T[n] <= W + 1, "the last beat is on the track: " + T[n - 1].toFixed(1) + " to " + T[n].toFixed(1));
  assert.ok(x >= T[n - 1] && x < T[n + 1] + 1);
  let back = n - 1;
  let L = T;
  for (let frame = 0; frame < 3 * n; frame++) {
    const next = lensLockStep(L, back, 2, W);
    if (next === back) break;
    const anchor = lensLockAnchor(L, next, W, LENS_MIN_PX);
    back = next;
    L = rundownLensIndex(U, back + 0.5, anchor);
  }
  assert.equal(back, 0);
  assert.ok(LOCK_EDGE_PX > 0);
});

test("lock: the anchor keeps the whole locked beat on the track", () => {
  const { U, n, W } = rest(SCRIPTS.alternating, 1300);
  for (let i = 0; i < n; i++) {
    const a = lensLockAnchor(U, i, W, LENS_MIN_PX);
    assert.ok(a >= LENS_MIN_PX / 2 - 1e-9 && a <= W - LENS_MIN_PX / 2 + 1e-9, "beat " + i + " anchored at " + a);
  }
  assert.equal(lensLockAnchor([0, 100, 200, 300], 0, 80, 96), 40, "a track narrower than the lens centres it");
});
