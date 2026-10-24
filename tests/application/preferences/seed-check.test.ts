import { test } from "node:test";
import assert from "node:assert/strict";
import { seedCheckMatches } from "../../../src/application/preferences/seed-check.ts";
import { checksumText } from "../../../shared/text.js";
import "../../../src/test/_dom.mjs";
import { sharedPorts } from "../../../src/bootstrap/wiring/shared-ports.ts";

test("the seed check passes when the page's content is the length and checksum of its state text", () => {
  const text = "{\"rows\":[]}";
  assert.equal(seedCheckMatches(text.length + "-" + checksumText(text), text), true);
});

test("the shared seed check reads the page again on every call", () => {
  const seed = sharedPorts().seedCheck;
  const meta = document.createElement("meta");
  meta.name = "splitpage-seed-check";
  const state = document.createElement("script");
  state.id = "state-data";
  const text = '{"rows":[]}';
  meta.content = text.length + "-" + checksumText(text);
  state.textContent = text;
  document.head.appendChild(meta);
  document.body.appendChild(state);
  try {
    assert.equal(seed.passes(), true);
    state.textContent = text + " ";
    assert.equal(seed.passes(), false);
    state.textContent = text;
    assert.equal(seed.passes(), true);
    meta.remove();
    assert.equal(seed.passes(), false);
  } finally {
    meta.remove();
    state.remove();
  }
});

test("the seed check fails when the state text changed, or when either part of the page is missing", () => {
  const text = "{\"rows\":[]}";
  const content = text.length + "-" + checksumText(text);
  assert.equal(seedCheckMatches(content, text + " "), false);
  assert.equal(seedCheckMatches("0-0", text), false);
  assert.equal(seedCheckMatches(null, text), false);
  assert.equal(seedCheckMatches(content, null), false);
});
