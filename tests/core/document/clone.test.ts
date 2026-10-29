import { test } from "node:test";
import assert from "node:assert/strict";
import { cloneState } from "../../../src/core/document/clone.ts";

test("cloneState returns an independent copy of the document", () => {
  const doc = { title: "T", rows: [{ id: "a", audioText: "x" }], wordsPerMinute: 150 };
  const copy = cloneState(doc);
  assert.deepEqual(copy, doc);
  assert.notEqual(copy, doc);
  assert.notEqual(copy.rows, doc.rows);
  copy.rows.push({ id: "b", audioText: "y" });
  assert.equal(doc.rows.length, 1);
  assert.equal(copy.rows.length, 2);
});

test("cloneState drops what JSON cannot hold", () => {
  const copy = cloneState({ keep: 1, gone: undefined, nested: { when: new Date(0) } });
  assert.deepEqual(copy, { keep: 1, nested: { when: "1970-01-01T00:00:00.000Z" } });
});

test("cloneState isolates nested row content in both directions", () => {
  const doc = { rows: [{ id: "a", content: { marks: ["bold"] } }] };
  const copy = cloneState(doc);
  const originalRow = doc.rows[0], copiedRow = copy.rows[0];
  assert.ok(originalRow && copiedRow);
  copiedRow.content.marks.push("italic");
  assert.deepEqual(originalRow.content.marks, ["bold"]);
  originalRow.id = "changed";
  assert.equal(copiedRow.id, "a");
});
