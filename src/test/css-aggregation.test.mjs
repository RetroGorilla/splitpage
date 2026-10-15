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
  assert.deepEqual(cssInputs, ["src/app.css", "src/features/comments/styles-badge.css", "src/styles/after-comments-badge.css", "src/features/comments/styles-badge-narrow.css", "src/styles/after-comments-badge-narrow.css", "src/features/comments/styles-phone-controls.css", "src/styles/after-comments-phone-controls.css", "src/features/comments/styles-assignee.css", "src/styles/after-comments-assignee.css", "src/features/comments/styles-empty.css", "src/styles/after-comments-empty.css", "src/features/comments/styles-anchors.css", "src/styles/after-comments-anchors.css", "src/features/comments/styles-panel.css", "src/styles/after-comments-panel.css", "src/features/comments/styles-thread.css", "src/styles/after-comments-thread.css", "src/features/comments/styles.css", "src/styles/after-comments-styles.css", "src/features/comments/styles-prompter.css", "src/styles/after-comments-prompter.css", "src/features/comments/styles-resize-narrow.css", "src/styles/after-comments-resize-narrow.css", "src/features/comments/styles-panel-narrow.css", "src/styles/after-comments-panel-narrow.css", "src/features/comments/styles-touch-fields.css", "src/styles/after-comments-touch-fields.css", "src/features/comments/styles-motion.css", "src/styles/after-comments-motion.css"]);
  assert.equal(appCss(), cssInputs.map((path) => readFileSync(new URL(path, repoUrl), "utf8")).join("\n"));
  assert.deepEqual(readBuiltCss(), { paths: [...cssInputs], css: appCss() });
  assert.equal(readBuiltCss({ inputs, read }).css, appCss(inputs, read));
});
