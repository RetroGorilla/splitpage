import { test } from "node:test";
import assert from "node:assert/strict";
import { seedCheckMatches } from "../../../src/application/preferences/seed-check.ts";
import { checksumText } from "../../../shared/text.js";

test("the seed check passes when the page's content is the length and checksum of its state text", () => {
  const text = "{\"rows\":[]}";
  assert.equal(seedCheckMatches(text.length + "-" + checksumText(text), text), true);
});

test("the seed check fails when the state text changed, or when either part of the page is missing", () => {
  const text = "{\"rows\":[]}";
  const content = text.length + "-" + checksumText(text);
  assert.equal(seedCheckMatches(content, text + " "), false);
  assert.equal(seedCheckMatches("0-0", text), false);
  assert.equal(seedCheckMatches(null, text), false);
  assert.equal(seedCheckMatches(content, null), false);
});
