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
