import test from "node:test";
import assert from "node:assert/strict";
import { runIsStale } from "../application/collaboration/workflow.ts";

test("a run is live only while it is the open run with the current sequence", () => {
  const run = { seq: 3 };
  assert.equal(runIsStale({ current: () => run, seq: () => 3 }, run), false);
  assert.equal(runIsStale({ current: () => null, seq: () => 3 }, run), true);
  assert.equal(runIsStale({ current: () => ({ seq: 3 }), seq: () => 3 }, run), true);
  assert.equal(runIsStale({ current: () => run, seq: () => 4 }, run), true);
});
