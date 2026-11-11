import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalSharedProjection } from "../../../src/core/collab/projection/canonical.ts";
import { projectSharedBeatFields } from "../../../src/core/collab/projection/fields.ts";

test("canonical projection orders known fields first and opaque nested keys by UTF-16 without altering values", () => {
  const source = { future: { z: null, a: [false, { z: "", a: 0 }] }, title: "T", rows: [{ future: 1, audioText: "x", id: "R" }], schema: 2 };
  const actual = canonicalSharedProjection(source) as typeof source;
  assert.deepEqual(actual, source); assert.deepEqual(Object.keys(actual), ["schema", "title", "rows", "future"]);
  const row = actual.rows[0]; assert.ok(row); assert.deepEqual(Object.keys(row), ["id", "audioText", "future"]);
  assert.deepEqual(Object.keys(actual.future), ["a", "z"]);
  const special = JSON.parse('{"constructor":{"z":0,"a":1},"__proto__":{"z":2,"a":3}}') as Record<string, unknown>;
  assert.deepEqual(canonicalSharedProjection(special), special);
});
test("field assembly retains zero length, null stamp attribution, unknown values and empty gallery", () => {
  assert.deepEqual(projectSharedBeatFields("R", { lengthSeconds: 0, stamp: { at: "", by: null }, extra: '{"z":null,"a":false}' }, "todo", []),
    { z: null, a: false, id: "R", status: "todo", lengthSeconds: 0, updatedAt: "", updatedBy: null });
});
