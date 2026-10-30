import test from "node:test";
import assert from "node:assert/strict";
import { productionIndex, startProductionIndex } from "../../../src/application/production/index-owner.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

const readers = fakeMigration().ports.readers;

test("the production index is unavailable until it is started", () => {
  assert.throws(() => productionIndex(), /not started yet/);
});

test("starting the index makes it available, and the stop function makes it unavailable again", () => {
  const stop = startProductionIndex(readers, deepFreeze);
  try {
    const owner = productionIndex();
    assert.deepEqual(owner.entries(null), []);
    assert.equal(productionIndex(), owner);
  } finally {
    stop();
  }
  assert.throws(() => productionIndex(), /not started yet/);
});

test("starting twice without stopping is refused and leaves the first index in place", () => {
  const stop = startProductionIndex(readers, deepFreeze);
  try {
    const owner = productionIndex();
    assert.throws(() => startProductionIndex(readers, deepFreeze), /already started/);
    assert.equal(productionIndex(), owner);
  } finally {
    stop();
  }
});

test("a restarted index is a new one, and a stale stop function leaves it running", () => {
  const stopFirst = startProductionIndex(readers, deepFreeze);
  const first = productionIndex();
  stopFirst();
  const stopSecond = startProductionIndex(readers, deepFreeze);
  try {
    assert.notEqual(productionIndex(), first);
    stopFirst();
    assert.doesNotThrow(() => productionIndex());
  } finally {
    stopSecond();
  }
  assert.throws(() => productionIndex(), /not started yet/);
});
