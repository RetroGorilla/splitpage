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
import type { StateField } from "../../../src/core/document/fields.ts";
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

test("the field table and its entries are frozen at run time, not only in their type", () => {
  assert.ok(Object.isFrozen(STATE_FIELDS));
  assert.ok(STATE_FIELDS.every((f) => Object.isFrozen(f)));
  const table = STATE_FIELDS as StateField[];
  assert.throws(() => table.push({ key: "probe", merge: "constant", undo: false }), TypeError);
  assert.throws(() => { (table[0] as StateField).undo = false; }, TypeError);
  assert.throws(() => { delete (table[0] as StateField).def; }, TypeError);
  assert.equal(STATE_FIELDS.length, KEYS.length);
  assert.equal(STATE_FIELDS[0]?.undo, true);
  assert.equal(typeof STATE_FIELDS[0]?.def, "function");
  assert.ok(Object.isFrozen(ROW_FIELDS));
  assert.ok(Object.isFrozen(GALLERY_FIELDS));
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

test("normalize: three fields carry one, and undefined from it means the field goes", () => {
  assert.deepEqual(STATE_FIELDS.filter((f) => f.normalize).map((f) => f.key), ["wordsPerMinute", "personColors", "targetSeconds"]);
  const norm = (key: string, v: unknown) => (STATE_FIELDS.find((f) => f.key === key)?.normalize as (v: unknown) => unknown)(v);
  assert.equal(norm("wordsPerMinute", "212.5"), 213);
  assert.equal(norm("wordsPerMinute", undefined), DEFAULT_WPM);
  assert.equal(norm("wordsPerMinute", 401), DEFAULT_WPM);
  assert.deepEqual(norm("personColors", { Ann: "#80bdfb" }), { Ann: "#80BDFB" });
  assert.equal(norm("personColors", { Ann: "red" }), undefined);
  assert.equal(norm("personColors", null), undefined);
  assert.equal(norm("targetSeconds", 59.6), 60);
  assert.equal(norm("targetSeconds", 0), undefined);
  assert.equal(norm("targetSeconds", "60"), undefined);
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

test("missingStateFields reads the table it is given, core's by default", () => {
  const probe: StateField = { key: "probe", def: () => 0, merge: "constant", undo: false };
  const plain: StateField = { key: "plain", merge: "constant", undo: false };
  const table = [...STATE_FIELDS, probe, plain];
  assert.deepEqual(missingStateFields({}, table), [...missingStateFields({}), "probe"]);
  assert.deepEqual(missingStateFields({ probe: undefined }, [probe, plain]), []);
  assert.deepEqual(missingStateFields(null, [probe, plain]), ["probe"]);
  assert.deepEqual(missingStateFields({}, []), []);
});
