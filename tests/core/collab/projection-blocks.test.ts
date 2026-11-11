import assert from "node:assert/strict";
import { test } from "node:test";
import { projectSharedBlocks } from "../../../src/core/collab/projection/blocks.ts";
import type { SharedProjectionStream } from "../../../src/core/collab/projection/blocks.ts";

test("pure split interpretation keeps its frozen inputs and literal prefix offsets", () => {
  const unit = (value: string) => Object.freeze({ value, marks: Object.freeze([]) });
  const streams: readonly SharedProjectionStream[] = Object.freeze([Object.freeze({ segment: "S", inOrder: true,
    head: Object.freeze({ kind: "b" as const, id: "R1", before: null }), parts: Object.freeze([
      Object.freeze({ boundary: null, units: Object.freeze([unit("a")]), from: 0, to: 1 }),
      Object.freeze({ boundary: Object.freeze({ kind: "b" as const, id: "N", before: "R1" }), units: Object.freeze([]), from: 1, to: 2 }),
      Object.freeze({ boundary: null, units: Object.freeze([unit("b")]), from: 2, to: 3 })]) })]);
  const records = Object.freeze([Object.freeze({ id: "R1", valid: true, segment: null }), Object.freeze({ id: "N", valid: true, segment: "S" })]);
  const before = JSON.stringify({ streams, records });
  assert.deepEqual(projectSharedBlocks(streams, records), [
    { kind: "b", id: "N", segment: "S", from: 0, to: 1, units: [{ value: "a", marks: [] }], reason: null },
    { kind: "b", id: "R1", segment: "S", from: 2, to: 3, units: [{ value: "b", marks: [] }], reason: null }
  ]);
  assert.equal(JSON.stringify({ streams, records }), before);
});
