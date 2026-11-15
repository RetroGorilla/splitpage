import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entryCapabilityCallers } from "./shared-entry-capability-callers.ts";

test("C8 every permission caller and named binding is classified as entry or bookkeeping", () => {
  const literal = JSON.parse(readFileSync(new URL("./shared-entry-callers.json", import.meta.url), "utf8")) as Record<string, Record<string, { kind: string; count: number }>>;
  const expected: Record<string, Record<string, number>> = {};
  for (const [group, rows] of Object.entries(literal)) {
    expected[group] = {};
    for (const [caller, row] of Object.entries(rows)) {
      assert.ok(row.kind === "entry" || row.kind === "bookkeeping", caller);
      expected[group][caller] = row.count;
    }
  }
  assert.deepEqual(entryCapabilityCallers(), expected);
});
