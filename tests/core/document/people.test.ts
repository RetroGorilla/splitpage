import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanAuthorName } from "../../../src/core/document/people.ts";
import { EDITOR_NAME_MAX } from "../../../src/core/document/fields.ts";

test("cleanAuthorName trims a name and caps it at the editor name length", () => {
  assert.equal(cleanAuthorName("  Dana  "), "Dana");
  assert.equal(cleanAuthorName("x".repeat(EDITOR_NAME_MAX + 5)), "x".repeat(EDITOR_NAME_MAX));
});

test("cleanAuthorName turns anything that is not a usable name into an empty string", () => {
  assert.equal(cleanAuthorName("   "), "");
  assert.equal(cleanAuthorName(""), "");
  assert.equal(cleanAuthorName(null), "");
  assert.equal(cleanAuthorName(undefined), "");
  assert.equal(cleanAuthorName(42), "");
});
