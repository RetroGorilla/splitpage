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
    "src/styles/base.css",
    "src/styles/layout.css",
    "src/styles/components.css",
    "src/features/panels/styles.css",
    "src/features/file-menu/styles.css",
    "src/features/file-menu/styles-2.css",
    "src/features/settings/styles.css",
    "src/features/file-menu/styles-3.css",
    "src/features/file-menu/styles-4.css",
    "src/features/settings/styles-2.css",
    "src/features/settings/styles-3.css",
    "src/features/comments/styles-badge.css",
    "src/features/comments/styles-badge-narrow.css",
    "src/features/file-menu/styles-5.css",
    "src/features/comments/styles-phone-controls.css",
    "src/features/file-menu/styles-6.css",
    "src/features/prompter/styles.css",
    "src/features/overlay/styles.css",
    "src/features/writer/styles.css",
    "src/features/gallery/styles.css",
    "src/features/gallery/styles-2.css",
    "src/features/gallery/styles-3.css",
    "src/features/settings/styles-4.css",
    "src/features/settings/styles-5.css",
    "src/features/imports/styles.css",
    "src/features/imports/styles-2.css",
    "src/features/imports/styles-3.css",
    "src/features/tags/styles.css",
    "src/features/settings/styles-6.css",
    "src/features/find/styles.css",
    "src/features/tags/styles-scenes.css",
    "src/features/comments/styles-empty.css",
    "src/features/file-menu/styles-7.css",
    "src/features/settings/styles-7.css",
    "src/features/settings/styles-8.css",
    "src/features/history/styles.css",
    "src/features/file-menu/styles-8.css",
    "src/features/file-menu/styles-9.css",
    "src/features/comments/styles-anchors.css",
    "src/features/tags/styles-badge.css",
    "src/features/comments/styles-anchors-2.css",
    "src/features/panels/styles-2.css",
    "src/features/comments/styles-panel.css",
    "src/features/panels/styles-3.css",
    "src/features/tags/styles-gear.css",
    "src/features/comments/styles-thread.css",
    "src/features/comments/styles.css",
    "src/features/prompter/styles-2.css",
    "src/features/comments/styles-prompter.css",
    "src/features/prompter/styles-3.css",
    "src/features/writer/styles-2.css",
    "src/features/prompter/styles-4.css",
    "src/features/writer/styles-3.css",
    "src/features/file-menu/styles-10.css",
    "src/features/file-menu/styles-11.css",
    "src/features/file-menu/styles-12.css",
    "src/features/settings/styles-9.css",
    "src/features/prompter/styles-5.css",
    "src/features/comments/styles-resize-narrow.css",
    "src/features/overlay/styles-narrow.css",
    "src/features/find/styles-touch.css",
    "src/features/comments/styles-panel-narrow.css",
    "src/features/tags/styles-phone-controls.css",
    "src/features/prompter/styles-6.css",
    "src/features/file-menu/styles-13.css",
    "src/features/writer/styles-4.css",
    "src/features/tags/styles-touch-fields.css",
    "src/features/writer/styles-5.css",
    "src/features/gallery/styles-4.css",
    "src/features/tags/styles-touch-hint.css",
    "src/features/notices/styles.css",
    "src/features/settings/styles-10.css",
    "src/features/broll/styles.css",
    "src/features/settings/styles-11.css",
    "src/features/comments/styles-motion.css",
    "src/features/panels/styles-4.css",
    "src/features/imports/styles-4.css",
    "src/features/file-menu/styles-14.css",
    "src/styles/overrides.css"
  ]);
  assert.equal(cssInputs[0], "src/styles/base.css");
  assert.equal(appCss(), cssInputs.map((path) => readFileSync(new URL(path, repoUrl), "utf8")).join("\n"));
  assert.deepEqual(readBuiltCss(), { paths: [...cssInputs], css: appCss() });
  assert.equal(readBuiltCss({ inputs, read }).css, appCss(inputs, read));
});
