import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GALLERY_FIELDS,
  ROW_FIELDS,
  SCHEMA_VERSION,
  STATE_FIELDS,
  STRATEGY_IDS,
  missingStateFields
} from "../../../src/core/document/fields.ts";
import { DEFAULT_WPM } from "../../../src/core/document/timing.ts";

interface UndoGolden {
  undone: string[];
  notUndone: string[];
  edits: { key: string; steps: string[] }[];
}

const UNDO_GOLDEN = JSON.parse(readFileSync(new URL("../../../src/test/fixtures/golden/undo-state-fields.json", import.meta.url), "utf8")) as UndoGolden;

const KEYS = [
  "title", "docId", "rows", "comments", "people", "productionTags", "brollShots",
  "wordsPerMinute", "rev", "lastEditedBy", "lastEditedAt", "personColors", "targetSeconds", "schema"
];

test("the document is schema 2, with its fields in their saved order", () => {
  assert.equal(SCHEMA_VERSION, 2);
  assert.deepEqual(STATE_FIELDS.map((f) => f.key), KEYS);
});

test("every field names a merge strategy from the closed list", () => {
  assert.equal(new Set(STRATEGY_IDS).size, STRATEGY_IDS.length);
  for (const f of STATE_FIELDS) assert.ok((STRATEGY_IDS as readonly string[]).includes(f.merge), f.key);
  assert.deepEqual(Object.fromEntries(STATE_FIELDS.map((f) => [f.key, f.merge])), {
    title: "title", docId: "doc-id", rows: "rows", comments: "comments",
    people: "list-union-with-base", productionTags: "list-union-with-base", brollShots: "list-union-with-base",
    wordsPerMinute: "changed-side-wins", rev: "max-plus-one", lastEditedBy: "theirs-wins", lastEditedAt: "theirs-wins",
    personColors: "person-colors", targetSeconds: "target-length", schema: "constant"
  });
  assert.ok(STATE_FIELDS.every((f) => !("mergeList" in f)), "core holds no merge callbacks");
});

test("defaults are fresh values, and only the fields a document always has carry one", () => {
  const defaults = Object.fromEntries(STATE_FIELDS.filter((f) => f.def).map((f) => [f.key, (f.def as () => unknown)()]));
  assert.deepEqual(defaults, {
    title: "", rows: [], comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: DEFAULT_WPM, rev: 0
  });
  const rows = STATE_FIELDS.find((f) => f.key === "rows");
  assert.notEqual(rows?.def?.(), rows?.def?.());
});

test("a field is undone as a document field exactly when the undo golden records a step for it", () => {
  const recorded = new Set(UNDO_GOLDEN.edits.flatMap((e) => e.steps.filter((s) => s === "docField:" + e.key).map(() => e.key)));
  assert.deepEqual(STATE_FIELDS.filter((f) => f.undo).map((f) => f.key), KEYS.filter((k) => recorded.has(k)));
  assert.deepEqual(UNDO_GOLDEN.notUndone.filter((k) => STATE_FIELDS.find((f) => f.key === k)?.undo !== false), []);
  assert.deepEqual(STATE_FIELDS.filter((f) => !f.undo).map((f) => f.key),
    ["docId", "rows", "rev", "lastEditedBy", "lastEditedAt", "personColors", "schema"]);
});

test("rows are undone scene by scene, not as one document field", () => {
  const rowEdits = UNDO_GOLDEN.edits.filter((e) => e.key === "rows");
  assert.ok(rowEdits.length > 0);
  assert.ok(rowEdits.every((e) => e.steps.length > 0 && e.steps.every((s) => !s.startsWith("docField:"))));
  assert.ok(UNDO_GOLDEN.undone.includes("rows"));
});

test("a row's content fields, and which of them are gallery lists", () => {
  assert.deepEqual([...ROW_FIELDS], ["visualText", "imageRef", "audioText", "imageLinks", "moreImages"]);
  assert.deepEqual(Object.keys(GALLERY_FIELDS).filter((k) => GALLERY_FIELDS[k]), ["imageLinks", "moreImages"]);
});

test("missingStateFields names the defaulted fields a document lacks", () => {
  const defaulted = ["title", "rows", "comments", "people", "productionTags", "brollShots", "wordsPerMinute", "rev"];
  assert.deepEqual(missingStateFields(null), defaulted);
  assert.deepEqual(missingStateFields(undefined), defaulted);
  assert.deepEqual(missingStateFields({}), defaulted);
  const whole = Object.fromEntries(defaulted.map((k) => [k, undefined]));
  assert.deepEqual(missingStateFields(whole), [], "a key that is present counts, whatever its value");
  const holed = Object.fromEntries(defaulted.filter((k) => k !== "people" && k !== "rev").map((k) => [k, 1]));
  assert.deepEqual(missingStateFields(holed), ["people", "rev"]);
  assert.deepEqual(missingStateFields({ ...whole, docId: undefined }), []);
  assert.throws(() => missingStateFields("a string"), TypeError);
});
