import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssInputs } from "../../tools/css-inputs.mjs";

const root = new URL("../../", import.meta.url);

function unbalanced(text) {
  let depth = 0;
  for (const char of text) {
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (depth < 0) return true;
  }
  return depth !== 0;
}

test("every feature stylesheet balances its own braces", () => {
  const features = cssInputs.filter((path) => path.startsWith("src/features/"));
  assert.ok(features.length > 0);
  for (const path of features) {
    assert.equal(unbalanced(readFileSync(new URL(path, root), "utf8")), false, path + " closes or leaves open a block it does not own");
  }
});