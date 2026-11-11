import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { undoLimits } from "./limits.ts";

const TESTS = ["stage1-records.test.ts", "limits.test.ts", "../../application/editing/undo/shared-undo.test.ts"]
  .map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");

test("the declared limits are exactly Stage 1's seven, each carried, resolved or waiting", () => {
  assert.deepEqual(undoLimits.map(limit => [limit.id, limit.state]), [
    ["double-restore", "carried"],
    ["later-format", "resolved"],
    ["sequential-status", "resolved"],
    ["status-redo-conflict", "resolved"],
    ["redone-recovery", "waits"],
    ["redone-mark-reversed", "waits"],
    ["pending-update", "waits"]
  ]);
});

test("every limit names the history that shows it and a test that exists", () => {
  for (const limit of undoLimits) {
    assert.ok(limit.history.length > 40, limit.id);
    assert.ok(TESTS.includes(`"${limit.shown}`) || TESTS.includes("`" + limit.shown.replace("remove", "${command}")), limit.id);
    assert.equal(limit.matches !== undefined || limit.literal !== undefined, limit.state === "carried", limit.id);
  }
});

test("carried limit double-restore: the literal history fails in the declared way", () => {
  const limit = undoLimits.find(candidate => candidate.id === "double-restore");
  assert.ok(limit?.literal);
  assert.throws(limit.literal.run, error => error instanceof Error && limit.literal !== undefined && limit.literal.failure.test(error.message));
});

test("waiting limits name the cut that examines them", () => {
  assert.deepEqual(undoLimits.filter(limit => limit.state === "waits").map(limit => [limit.id, /removal|adapter executor/.exec(limit.history)?.[0]]), [
    ["redone-recovery", "removal"], ["redone-mark-reversed", "adapter executor"], ["pending-update", "adapter executor"]
  ]);
});
