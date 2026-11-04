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
    "src/features/file-menu/styles-save-button.css",
    "src/features/settings/styles.css",
    "src/features/file-menu/styles-file-chip.css",
    "src/features/settings/styles-identity-chip.css",
    "src/features/comments/styles-badge.css",
    "src/features/comments/styles-badge-narrow.css",
    "src/features/file-menu/styles-brand-narrow.css",
    "src/features/comments/styles-phone-controls.css",
    "src/features/file-menu/styles-save-button-narrow.css",
    "src/features/prompter/styles.css",
    "src/features/overlay/styles.css",
    "src/features/writer/styles.css",
    "src/features/gallery/styles.css",
    "src/styles/overrides-after-gallery-styles.css",
    "src/features/gallery/styles-tiles-and-modal.css",
    "src/features/gallery/styles-zoom-toast.css",
    "src/styles/overrides-annotate-icon.css",
    "src/features/imports/styles.css",
    "src/styles/overrides-modal-icons.css",
    "src/features/tags/styles.css",
    "src/features/settings/styles-wpm-editor.css",
    "src/features/find/styles.css",
    "src/features/tags/styles-scenes.css",
    "src/styles/overrides-after-tags-styles-scenes.css",
    "src/features/comments/styles-empty.css",
    "src/features/file-menu/styles-save-error.css",
    "src/features/settings/styles-identity-pill.css",
    "src/features/settings/styles-anchor-targets.css",
    "src/features/history/styles.css",
    "src/features/file-menu/styles-menu.css",
    "src/features/file-menu/styles-save-status.css",
    "src/features/comments/styles-anchors.css",
    "src/features/tags/styles-badge.css",
    "src/features/comments/styles-anchors-2.css",
    "src/features/panels/styles-open-offset.css",
    "src/styles/overrides-toolbar-buttons-fields.css",
    "src/features/comments/styles-panel.css",
    "src/features/panels/styles-tabbar.css",
    "src/features/tags/styles-gear.css",
    "src/features/comments/styles-thread.css",
    "src/features/comments/styles.css",
    "src/features/prompter/styles-frame.css",
    "src/features/comments/styles-prompter.css",
    "src/features/prompter/styles-bar-rundown.css",
    "src/features/writer/styles-shell.css",
    "src/features/prompter/styles-fade.css",
    "src/features/writer/styles-layout.css",
    "src/features/file-menu/styles-phone-topbar.css",
    "src/features/settings/styles-phone-identity-length.css",
    "src/features/prompter/styles-phone-present-button.css",
    "src/features/comments/styles-resize-narrow.css",
    "src/styles/overrides-after-comments-styles-resize-narrow.css",
    "src/features/overlay/styles-narrow.css",
    "src/features/find/styles-touch.css",
    "src/features/comments/styles-panel-narrow.css",
    "src/features/tags/styles-phone-controls.css",
    "src/features/prompter/styles-phone-bar.css",
    "src/features/file-menu/styles-phone-menu.css",
    "src/features/writer/styles-phone.css",
    "src/features/tags/styles-touch-fields.css",
    "src/features/writer/styles-phone-touch.css",
    "src/features/gallery/styles-touch.css",
    "src/features/tags/styles-touch-hint.css",
    "src/features/notices/styles.css",
    "src/features/settings/styles-panel.css",
    "src/styles/overrides-outline-button-stale.css",
    "src/features/broll/styles.css",
    "src/features/settings/styles-rundown-length.css",
    "src/features/comments/styles-motion.css",
    "src/features/panels/styles-open-transition.css",
    "src/features/imports/styles-new-document.css",
    "src/features/file-menu/styles-merge.css",
    "src/styles/overrides.css",
    "src/features/tags/styles-outline.css"
  ]);
  assert.equal(cssInputs[0], "src/styles/base.css");
  assert.equal(appCss(), cssInputs.map((path) => readFileSync(new URL(path, repoUrl), "utf8")).join("\n"));
  assert.deepEqual(readBuiltCss(), { paths: [...cssInputs], css: appCss() });
  assert.equal(readBuiltCss({ inputs, read }).css, appCss(inputs, read));
});
