import assert from "node:assert/strict";
import { test } from "node:test";
import { runProjectionLimits } from "../../src/proj/limits.ts";

test("PROJ seeded merged limits: both operations valid separately; deterministic observed failures retained", () => {
  const results = runProjectionLimits();
  assert.equal(results.length, 520);
  for (const result of results) {
    assert.equal(result.converged, true, `${result.family} ${result.seed} ${result.candidate} ${result.order}`);
    assert.ok(result.individually.every(value => value <= result.limit), `${result.family}: each operation must be valid alone`);
    assert.equal(result.stableAppSave, true);
    const projected = result.family === "heading" ? 1 : result.level;
    assert.equal(result.projected, projected, `${result.family} projection`);
    const retained = result.family === "heading" ? 2 : result.family === "people" || result.family === "tags" ? 3 : result.level;
    assert.equal(result.retainedSharedObjects, retained, `${result.family}: unresolved objects stay in shared state`);
    const saved = result.family === "gallery" ? Math.min(61, result.level) : result.family === "props" ? Math.min(40, result.level) : result.family === "poster" ? 1 : projected;
    assert.equal(result.afterAppSave, saved, `${result.family} app save`);
    if (result.family === "heading") assert.equal(result.headings.length, result.level === 1 ? 2 : 1);
  }
});
