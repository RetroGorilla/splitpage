import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { availableUnless } from "../../src/legacy/screen.ts";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const SOURCE = /\.(?:js|mjs|ts)$/;
const LITERAL = /(["'`])((?:(?!\1)[^\n\\])*Still loading(?:(?!\1)[^\n\\])*)\1/g;

function loadingReason(): string {
  const view = availableUnless(["loading"], { loading: true, prompter: false, writer: false, tour: false });
  assert.equal(view.enabled, false);
  return (!view.enabled && view.reason) || "";
}

test("every Still loading literal in src reads exactly as the loading blocker's reason", () => {
  const reason = loadingReason();
  const found: { file: string; text: string }[] = [];
  for (const entry of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
    if (!SOURCE.test(entry)) continue;
    const source = readFileSync(`${SRC}${entry}`, "utf8");
    for (const match of source.matchAll(LITERAL)) found.push({ file: entry.replaceAll("\\", "/"), text: match[2] ?? "" });
  }
  assert.ok(found.length >= 2, "the search finds the literals it is meant to check");
  assert.deepEqual(found.filter((f) => f.text !== reason), []);
});
