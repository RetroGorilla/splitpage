import { test } from "node:test";
import assert from "node:assert/strict";
import { followPaintedCaret } from "../../../src/application/editing/painted-selection.ts";
import type { SharedContentRef } from "../../../src/core/collab/operations.ts";

test("a long Split deletion uses a linear number of identity reads to find the preceding surviving character", () => {
  let reads = 0;
  const before = { revision: 1, text: "a".repeat(10000), identity: (index: number) => { reads++; return "unit" + index as SharedContentRef; } };
  const after = { revision: 2, text: "a".repeat(5001), identity: (index: number) => { reads++; return "unit" + index as SharedContentRef; } };
  assert.deepEqual(followPaintedCaret(before, [{ key: "R1", base: after, length: 5001 }], 9999, "R1"), { key: "R1", offset: 5001 });
  assert.ok(reads <= 20000, "a long deleted span cannot cause a quadratic scan of the surviving field");
});
