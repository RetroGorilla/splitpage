import "./_dom.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STATE_FIELDS, migrateRows, missingStateFields } from "../js/02-state.js";
import { mergeStates } from "../js/03-sync.js";
import { buildSplitpageFile } from "../js/20d-formats.js";
import { exportDocumentOf } from "../js/14b-export-kit.js";
import { parseSplitpageFile } from "../adapters/formats/splitpage-file.ts";

const SEED = JSON.parse(readFileSync(new URL("../seed-state.json", import.meta.url), "utf8"));

test("every registry field has a strategy mergeStates knows", () => {
  const known = {
    "title": 1, "doc-id": 1, "rows": 1, "comments": 1, "list-union-with-base": 1,
    "changed-side-wins": 1, "max-plus-one": 1, "theirs-wins": 1, "constant": 1,
    "person-colors": 1, "target-length": 1
  };
  const bad = STATE_FIELDS.filter((f) =>
    !known[f.merge] || (f.merge === "list-union-with-base" && typeof f.mergeList !== "function")
  ).map((f) => f.key);
  assert.deepEqual(bad, []);
});

test("a merge keeps every field a migrated document has", () => {
  const empty = migrateRows({});
  const merged = mergeStates(null, migrateRows({}), migrateRows({})).merged;
  const lost = Object.keys(empty).filter((k) => !(k in merged));
  assert.deepEqual(lost, []);
});

test("nothing migrateRows produces is outside the table", () => {
  const empty = migrateRows({});
  const known = Object.create(null);
  STATE_FIELDS.forEach((f) => { known[f.key] = true; });
  const unlisted = Object.keys(empty).filter((k) => !known[k]);
  assert.deepEqual(unlisted, []);
});

test("a migrated document is never missing a defaulted field", () => {
  assert.deepEqual(missingStateFields(migrateRows({})), []);
});

test("the shipped seed document is complete once migrated", () => {
  assert.deepEqual(missingStateFields(migrateRows(JSON.parse(JSON.stringify(SEED)))), []);
});

test("a merged document is still a complete document", () => {
  const doc = () => migrateRows(JSON.parse(JSON.stringify(SEED)));
  assert.deepEqual(missingStateFields(mergeStates(doc(), doc(), doc()).merged), []);
});

test("a .splitpage save carries every registry field", () => {
  const round = migrateRows(parseSplitpageFile(buildSplitpageFile(exportDocumentOf(migrateRows(JSON.parse(JSON.stringify(SEED)))))));
  assert.deepEqual(missingStateFields(round), []);
});

test("missingStateFields names what is actually absent", () => {
  const holed = migrateRows({});
  delete holed.people;
  delete holed.brollShots;
  assert.deepEqual(missingStateFields(holed).sort(), ["brollShots", "people"]);
  assert.deepEqual(missingStateFields(null).sort(),
    STATE_FIELDS.filter((f) => f.def).map((f) => f.key).sort());
});

test("INV-04: a field added to STATE_FIELDS survives migrateRows, mergeStates and a .splitpage save, with no other edit", () => {
  STATE_FIELDS.push({
    key: "probe",
    def: () => "start",
    normalize: (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined),
    merge: "changed-side-wins",
    undo: true
  });
  try {
    const doc = () => migrateRows(JSON.parse(JSON.stringify(SEED)));
    const base = doc();
    assert.equal(base.probe, "start");
    const mine = JSON.parse(JSON.stringify(base));
    mine.probe = "  mine  ";
    const merged = mergeStates(base, mine, JSON.parse(JSON.stringify(base))).merged;
    assert.equal(merged.probe, "mine");
    const file = buildSplitpageFile(exportDocumentOf(merged));
    assert.equal(JSON.parse(file).probe, "mine");
    const round = migrateRows(parseSplitpageFile(file));
    assert.equal(round.probe, "mine");
    assert.deepEqual(Object.keys(round), Object.keys(merged));
    assert.equal("probe" in migrateRows({ probe: "   " }), false, "its normaliser decides what is kept");
  } finally {
    STATE_FIELDS.pop();
  }
  assert.equal(STATE_FIELDS.some((f) => f.key === "probe"), false);
});

test("a b-roll shot keeps every field it has — props too — through a merge and a save", () => {
  const doc = () => migrateRows({
    productionTags: [{ cat: "prop", name: "Kettle" }],
    brollShots: [{ id: "b1", name: "Rooftop", props: [{ name: "Kettle" }, { name: "Tarp" }] }]
  });
  const shotKeys = Object.keys(doc().brollShots[0]).sort();
  assert.ok(shotKeys.includes("props"));
  const merged = mergeStates(doc(), doc(), doc()).merged.brollShots[0];
  assert.deepEqual(Object.keys(merged).sort(), shotKeys);
  assert.deepEqual(merged.props, doc().brollShots[0].props);
  const round = migrateRows(parseSplitpageFile(buildSplitpageFile(exportDocumentOf(doc())))).brollShots[0];
  assert.deepEqual(Object.keys(round).sort(), shotKeys);
  assert.deepEqual(round.props, doc().brollShots[0].props);
});
