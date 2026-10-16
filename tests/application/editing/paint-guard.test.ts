import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaintGuard } from "../../../src/application/editing/paint-guard.ts";

test("a paint is guarded for its whole length, nested paints included, and returns what it drew", () => {
  const guard = createPaintGuard();
  assert.equal(guard.painting(), false);
  const seen: boolean[] = [];
  const out = guard.whilePainting(() => {
    seen.push(guard.painting());
    guard.whilePainting(() => { seen.push(guard.painting()); });
    seen.push(guard.painting());
    return 7;
  });
  assert.equal(out, 7);
  assert.deepEqual(seen, [true, true, true]);
  assert.equal(guard.painting(), false);
});

test("work queued during a paint runs once, after the outermost paint, and at once outside a paint", () => {
  const guard = createPaintGuard();
  const runs: string[] = [];
  guard.afterThisPaint(() => { runs.push("now"); });
  guard.whilePainting(() => {
    guard.afterThisPaint(() => { runs.push("queued"); });
    guard.whilePainting(() => { guard.afterThisPaint(() => { runs.push("nested"); }); });
    assert.deepEqual(runs, ["now"], "a nested paint finishing does not run the queue");
  });
  assert.deepEqual(runs, ["now", "queued", "nested"]);
  guard.whilePainting(() => {});
  assert.equal(runs.length, 3, "nothing runs twice");
});

test("a paint that throws runs each failure handler, keeps work that has none for the next paint that finishes, and ends the guard", () => {
  const guard = createPaintGuard();
  const runs: string[] = [];
  assert.throws(() => guard.whilePainting(() => {
    guard.afterThisPaint(() => { runs.push("typed"); });
    guard.afterThisPaint(() => { runs.push("length"); }, () => { runs.push("length failed"); });
    throw new Error("draw failed");
  }), /draw failed/);
  assert.equal(guard.painting(), false);
  assert.deepEqual(runs, ["length failed"]);
  guard.whilePainting(() => {});
  assert.deepEqual(runs, ["length failed", "typed"]);
});
