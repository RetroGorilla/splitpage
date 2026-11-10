import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { undoRecordReport } from "../../src/undo-records/report.ts";

test("command-record undo results and retained histories reproduce exactly", () => {
  const report = undoRecordReport();
  assert.deepEqual(report.failures, []);
  assert.equal(report.files.size, 26);
  for (const [path, content] of report.files) assert.equal(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"), content, path);
});
