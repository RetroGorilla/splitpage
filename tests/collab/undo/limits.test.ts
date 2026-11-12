import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runBufferTrace } from "./buffer-cases.ts";
import { ADAPTER_BUFFER_LIMIT_RUNS, undoLimits } from "./limits.ts";
import { ADAPTER_WORLD, MODEL_WORLD } from "./scenario.ts";

const TESTS = ["stage1-records.test.ts", "limits.test.ts", "../../application/editing/undo/shared-undo.test.ts"]
  .map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");

test("the declared limits are Stage 1's seven and one of the shared document, each carried, resolved or waiting", () => {
  assert.deepEqual(undoLimits.map(limit => [limit.id, limit.state]), [
    ["double-restore", "carried"],
    ["later-format", "resolved"],
    ["sequential-status", "resolved"],
    ["status-redo-conflict", "resolved"],
    ["redone-recovery", "waits"],
    ["redone-mark-reversed", "waits"],
    ["pending-update", "waits"],
    ["insert-after-deleted-run", "carried"]
  ]);
});

test("carried limit insert-after-deleted-run: the literal histories fail in the declared way", () => {
  assert.deepEqual(ADAPTER_BUFFER_LIMIT_RUNS, [{ trace: "T01", order: "late-C" }, { trace: "T01 composition", order: "late-C" }]);
  const limit = undoLimits.find(candidate => candidate.id === "insert-after-deleted-run");
  assert.ok(limit?.literal);
  assert.throws(limit.literal.run, error => error instanceof Error && limit.literal !== undefined && limit.literal.failure.test(error.message));
  assert.throws(() => runBufferTrace("T01 composition", "late-C", ADAPTER_WORLD),
    /^Error: T01 composition late-C undone\/A\.rows\[0\]\.characters\[2\]\.identity\.client: expected 2, got 1$/);
  runBufferTrace("T01", "late-C", MODEL_WORLD);
  runBufferTrace("T01 composition", "late-C", MODEL_WORLD);
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
