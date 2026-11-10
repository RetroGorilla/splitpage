import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { beatReport } from "../src/structure-report.ts";
import { runGlueRewrite, runStructure, structureTraces } from "./structure-runner.ts";

for (const [trace, orders] of Object.entries(structureTraces)) {
  for (const candidate of ["A", "B"] as const) {
    for (const order of orders) {
      test(`${candidate}: full ${trace} ${order}, including specified undo`, () => {
        const result = runStructure(trace, candidate, order);
        assert.equal(result.failure, null, result.history.join("\n"));
        assert.ok(result.checks >= 2);
      });
    }
  }
}

for (const candidate of ["A", "B"] as const) {
  test(`${candidate}: join cancellation still unjoins after Bob rewrites Alice's glue, preserving her earlier edit`, () => {
    assert.equal(runGlueRewrite(candidate).failure, null);
  });
  for (const swapped of [false, true]) {
    test(`${candidate}: plain per-writer join undo fails T06${swapped ? " swapped clientIDs" : ""}`, () => {
      const result = runStructure("T06", candidate, "D1", true, swapped);
      assert.match(result.failure ?? "", /T06 Alice undo\/client\d.rows\[0\].characters\[2\]/);
    });
    test(`${candidate}: semantic join undo passes T06${swapped ? " swapped clientIDs" : ""}`, () => {
      const result = runStructure("T06", candidate, "late-C", false, swapped);
      assert.equal(result.failure, null, result.history.join("\n"));
    });
  }
}

test("structural results and retained failure histories reproduce exactly", () => {
  const report = beatReport();
  assert.equal(report.runs.length, 94);
  for (const [path, content] of report.files) assert.equal(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), content, path);
});
