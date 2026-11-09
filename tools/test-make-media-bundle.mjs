import { test } from "node:test";
import assert from "node:assert/strict";
import { planMedia } from "./make-media-bundle.mjs";

test("media plan is deterministic, unique and unevenly distributed", () => {
  const plan = planMedia(300, 60, 150);
  assert.deepEqual(plan, planMedia(300, 60, 150));
  assert.equal(plan.length, 360);
  assert.equal(new Set(plan.map((item) => item.name)).size, 360);
  assert.equal(plan.filter((item) => item.kind === "photo").length, 300);
  assert.equal(plan.filter((item) => item.kind === "video").length, 60);
  assert.ok(plan.some((item) => item.name.endsWith(".jpg")));
  assert.ok(plan.some((item) => item.name.endsWith(".png")));
  const counts = Array.from({ length: 150 }, (_, beat) => plan.filter((item) => item.beat === beat).length);
  assert.ok(counts.some((count) => count === 0));
  assert.ok(counts.some((count) => count > 2));
});
