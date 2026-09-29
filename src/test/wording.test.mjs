/* The mechanical part of docs/STYLE.md: wording that was standardised once
 * and should not drift back. Reads the source, not a running page. */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const files = readdirSync(join(root, "src", "js")).filter((f) => f.endsWith(".js"))
  .map((f) => join("src", "js", f))
  .concat(["src/page.html", "docs/help.md", "desktop/main.js"]);
const text = new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));

function offenders(pattern) {
  const found = [];
  for (const [file, body] of text) {
    body.split("\n").forEach((line, i) => {
      if (pattern.test(line)) found.push(file + ":" + (i + 1) + "  " + line.trim().slice(0, 90));
    });
  }
  return found;
}

test("messages say \"Could not\", not \"Couldn't\"", () => {
  assert.deepEqual(offenders(/Couldn['’]t/), []);
});

test("British spelling in what a person reads", () => {
  assert.deepEqual(offenders(/\bMinimize the rundown\b|\blabeled lines\b/), []);
});

test("the bottom button and its messages say scene, not row", () => {
  assert.deepEqual(offenders(/\+ Add row<|That row (is no longer here|no longer exists)|No script rows found/), []);
});

test("no raw browser error text is appended to a toast", () => {
  assert.deepEqual(offenders(/showToast\([^)]*"\s*[—-]\s*"\s*\+\s*err\.message/), []);
});
