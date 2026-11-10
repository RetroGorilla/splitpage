import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { projectionEvidence } from "../../src/proj/evidence.ts";

test("PROJ concurrent, detached, limits and cue evidence reproduces exactly", () => {
  const recorded = JSON.parse(readFileSync(new URL("../../src/proj/experiment-results.json", import.meta.url), "utf8")) as unknown;
  const actual = projectionEvidence();
  assert.deepEqual(actual, recorded);
  assert.equal(actual.concurrent.length, 64);
  assert.ok(actual.concurrent.every(result => result.passed));
  assert.equal(actual.detached.length, 16);
  assert.equal(actual.limits.length, 520);
  assert.equal(actual.cues.length, 12);
});
