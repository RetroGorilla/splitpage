import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { STATE_FIELDS, migrateRows, missingStateFields } from "../js/02-state.js";
import { changedBetween } from "../application/editing/undo/history.ts";
import { STATE_FIELDS as CORE_FIELDS } from "../core/document/fields.ts";
import * as sync from "../js/03-sync.js";
import { LIST_MERGERS } from "../core/merge/lists.ts";

function withProbe(field, run) {
  STATE_FIELDS.push(field);
  try {
    run();
  } finally {
    STATE_FIELDS.pop();
  }
  assert.equal(STATE_FIELDS.some((f) => f.key === field.key), false);
}

test("a field added to 02-state's STATE_FIELDS with a default is reported missing, as before the move", () => {
  withProbe({ key: "probe", merge: "constant", def: function () { return 7; } }, () => {
    assert.ok(missingStateFields({}).includes("probe"));
    assert.ok(missingStateFields(null).includes("probe"));
    const migrated = migrateRows({});
    assert.equal(migrated.probe, 7, "migrateRows fills it from the same table");
    assert.deepEqual(missingStateFields(migrated), []);
  });
});

test("a field added without a default is never reported missing", () => {
  withProbe({ key: "probe", merge: "constant" }, () => {
    assert.equal(missingStateFields({}).includes("probe"), false);
  });
});

test("02-state's STATE_FIELDS is a thawed copy of core's frozen table, with core's list mergers attached", () => {
  assert.ok(Object.isFrozen(CORE_FIELDS));
  assert.equal(Object.isFrozen(STATE_FIELDS), false);
  assert.equal(STATE_FIELDS.length, CORE_FIELDS.length);
  STATE_FIELDS.forEach((f, i) => {
    const core = CORE_FIELDS[i];
    assert.notEqual(f, core);
    assert.equal(Object.isFrozen(f), false, f.key);
    const { mergeList, ...rest } = f;
    assert.deepEqual(rest, { ...core }, f.key);
    assert.equal(typeof mergeList === "function", ["people", "productionTags", "brollShots"].includes(f.key), f.key);
    if (mergeList) assert.equal(mergeList, LIST_MERGERS[f.key], f.key);
  });
});

test("03-sync no longer re-exports core's ROW_FIELDS and GALLERY_FIELDS", () => {
  assert.equal("ROW_FIELDS" in sync, false);
  assert.equal("GALLERY_FIELDS" in sync, false);
});

test("the undo history skips exactly the fields core marks undo: false", () => {
  const every = Object.fromEntries(CORE_FIELDS.map((f) => [f.key, []]));
  const touched = changedBetween({}, every);
  assert.deepEqual(Object.keys(touched.doc), CORE_FIELDS.filter((f) => f.undo).map((f) => f.key));
  assert.deepEqual(CORE_FIELDS.filter((f) => !touched.doc[f.key]).map((f) => f.key),
    CORE_FIELDS.filter((f) => !f.undo).map((f) => f.key));
  assert.equal(touched.structure, false);
});
