import { test } from "node:test";
import assert from "node:assert/strict";
import { createRowDrag } from "../../../src/application/editing/row-drag.ts";

test("a row drag holds the scene picked up until it ends, and a new start replaces it", () => {
  const drag = createRowDrag();
  assert.equal(drag.dragging(), null);
  drag.start("r1");
  assert.equal(drag.dragging(), "r1");
  drag.start("r2");
  assert.equal(drag.dragging(), "r2");
  drag.end();
  assert.equal(drag.dragging(), null);
  drag.end();
  assert.equal(drag.dragging(), null, "ending twice is harmless");
});

test("two row drags do not share a scene", () => {
  const one = createRowDrag();
  const two = createRowDrag();
  one.start("r1");
  assert.equal(two.dragging(), null);
});

test("each end tells the end listeners after the drag is cleared, and an unsubscribed listener hears nothing more", () => {
  const drag = createRowDrag();
  const heard: (string | null)[] = [];
  const off = drag.onEnd(() => { heard.push(drag.dragging()); });
  drag.start("r1");
  drag.end();
  drag.end();
  assert.deepEqual(heard, [null, null]);
  off();
  drag.start("r2");
  drag.end();
  assert.deepEqual(heard, [null, null]);
});
