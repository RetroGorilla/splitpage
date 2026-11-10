import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runBufferExperiments } from "../src/buffer-report.ts";

test("the retained result table and deciding histories reproduce exactly", () => {
  const report = runBufferExperiments();
  assert.equal(report.cases.length, 144);
  assert.equal(report.cases.filter(result => result.status === "PASS").length, 144);
  assert.equal(report.probes.length, 34);
  for (const [name, contents] of report.files) {
    assert.equal(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"), contents, `Stale experiment artifact: ${name}`);
  }
});
