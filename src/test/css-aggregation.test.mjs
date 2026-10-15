import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appCss, cssInputs } from "../../tools/css-inputs.mjs";
import { readBuiltCss, repoUrl } from "../../tools/css-colours.mjs";

test("CSS aggregation preserves listed order, separators and single-file bytes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "splitpage-css-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = { "second.css": ".second { color: blue; }", "first.css": ".first { color: red; }\n", "third.css": "@media print { .third { color: black; } }\n" };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(directory, path), text);
  const read = (path) => readFileSync(join(directory, path), "utf8");
  const inputs = ["third.css", "first.css", "second.css"];
  assert.equal(appCss(inputs, read), inputs.map((path) => files[path]).join("\n"));
  assert.equal(appCss(["first.css"], read), read("first.css"));
  assert.throws(() => appCss(["first.css", "missing.css"], read), { code: "ENOENT" });
  assert.throws(() => appCss(["first.css", "first.css"], read), /Duplicate CSS input/);
  assert.throws(() => appCss(["first.css", "FIRST.css"], read), /Duplicate CSS input/);
  assert.throws(() => appCss(["src/App.css"]), /incorrectly cased CSS input/);
  assert.throws(() => appCss(["src/missing.css"]), /Missing/);
  assert.deepEqual(cssInputs, [
    "src/app.css",
    "src/features/tags/styles.css",
    "src/app-after-tags.css",
    "src/features/find/styles.css",
    "src/features/tags/styles-scenes.css",
    "src/styles/after-tag-scenes.css",
    "src/features/tags/styles-badge.css",
    "src/styles/after-tag-badge.css",
    "src/features/tags/styles-gear.css",
    "src/styles/after-gear.css",
    "src/features/find/styles-touch.css",
    "src/styles/after-find-touch.css",
    "src/features/tags/styles-phone-controls.css",
    "src/styles/after-tag-phone.css",
    "src/features/tags/styles-touch-fields.css",
    "src/styles/after-tag-touch-fields.css",
    "src/features/tags/styles-touch-hint.css",
    "src/styles/app-tail.css",
    "src/features/broll/styles.css",
    "src/styles/after-broll.css"
  ]);
  assert.equal(cssInputs[0], "src/app.css");
  assert.equal(appCss(), cssInputs.map((path) => readFileSync(new URL(path, repoUrl), "utf8")).join("\n"));
  assert.deepEqual(readBuiltCss(), { paths: [...cssInputs], css: appCss() });
  assert.equal(readBuiltCss({ inputs, read }).css, appCss(inputs, read));
});
