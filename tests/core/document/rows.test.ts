import { test } from "node:test";
import assert from "node:assert/strict";
import { rowIndexOf } from "../../../src/core/document/rows.ts";

const doc = {
  rows: [
    { id: "r0" },
    { id: "r1" },
    { id: "r2" }
  ]
};

test("rowIndexOf returns the index of the row with the id", () => {
  assert.equal(rowIndexOf(doc, "r0"), 0);
  assert.equal(rowIndexOf(doc, "r2"), 2);
});

test("rowIndexOf returns -1 for an id no row has", () => {
  assert.equal(rowIndexOf(doc, "missing"), -1);
  assert.equal(rowIndexOf(doc, undefined), -1);
});

test("rowIndexOf returns -1 when there is no document", () => {
  assert.equal(rowIndexOf(null, "r0"), -1);
});

test("rowIndexOf returns the first row when an id repeats", () => {
  const repeated = { rows: [{ id: "r0" }, { id: "r1" }, { id: "r0" }] };
  assert.equal(rowIndexOf(repeated, "r0"), 0);
});
