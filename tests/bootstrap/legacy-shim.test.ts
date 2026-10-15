import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeScript, resolveSpecifier } from "../../tools/dep-report.mjs";
import { REPO, isScript, listRepoFiles } from "../../tools/source-scan.mjs";

const SHIM = "src/js/_entry.js";

const FROZEN_SHIM_IMPORTS: readonly string[] = [
  "./00-prelude.js", "./00p-prefs.js", "./01-scene-status.js", "./01b-hide-shot.js", "./02-state.js", "./02b-doc-id.js",
  "./02c-blobs.js", "./02d-gallery.js", "./03-sync.js", "./03a-history-store.js", "./03b-side-panels.js", "./04-richtext.js",
  "./04a-row-motion.js", "./04b-busy.js", "./04c-doc-model.js", "./05-render.js", "./05b-cell-edit.js", "./05c-clipboard.js",
  "./05d-draft-edit.js", "./05e-gallery-overlay.js", "./05f-rundown.js", "./05g-scene-clip.js", "./05h-scene-select.js", "./05p-rundown-presence.js",
  "./05q-cell-reach.js", "./05r-read-time.js", "./05s-script-zoom.js", "./05t-target.js", "./05v-video.js", "./05w-annotate.js",
  "./06-rows.js", "./07-production-tags.js", "./07b-plain-tags.js", "./08-production-panels.js", "./08c-broll.js", "./08d-broll-panel.js",
  "./09-find-replace.js", "./10-comments.js", "./11-import.js", "./12-dirty-toast.js", "./12a-undo.js", "./13-hosted.js",
  "./13a-presence.js", "./13b-collaborate.js", "./14-export.js", "./14b-export-kit.js", "./14e-export-formats.js", "./15-docx.js",
  "./16-csv.js", "./16b-xlsx.js", "./17-pdf.js", "./18-local-files.js", "./18a-local-merge.js", "./18b-file-menu.js",
  "./18c-export-dialog.js", "./18d-command-menu.js", "./19-writer.js", "./20-teleprompter.js", "./20a-update.js", "./20b-onboarding.js",
  "./20c-help.js", "./20d-formats.js", "./20e-connect.js", "./20f-desktop.js", "./20g-drafts.js", "./20h-appdata.js",
  "./20i-topbar.js", "./20j-newtab.js", "./20k-phone-bar.js", "./20s-settings.js",
  "../bootstrap/wiring.ts", "../bootstrap/app.ts"
];

const MIGRATED = ["src/application/", "src/features/", "src/bootstrap/"];

interface Import {
  readonly spec: string;
}

function importsOf(path: string): readonly Import[] {
  const analysis = analyzeScript(path, readFileSync(join(REPO, path), "utf8")) as { imports: readonly Import[] };
  return analysis.imports;
}

test("the frozen shim import set has the 69 started modules, 14e and the two bootstrap modules", () => {
  assert.equal(new Set(FROZEN_SHIM_IMPORTS).size, FROZEN_SHIM_IMPORTS.length);
  assert.equal(FROZEN_SHIM_IMPORTS.length, 72);
  assert.equal(FROZEN_SHIM_IMPORTS.filter((s) => /^\.\/\d/.test(s)).length, 70);
  assert.ok(FROZEN_SHIM_IMPORTS.includes("./14e-export-formats.js"));
});

test("the legacy shim imports nothing outside its frozen set, so nothing new registers into it", () => {
  const specs = importsOf(SHIM).map((i) => i.spec);
  assert.ok(specs.length > 0, "the shim's imports were read");
  const added = specs.filter((s) => !FROZEN_SHIM_IMPORTS.includes(s));
  assert.deepEqual(added, [], "the shim's import list may only shrink");
});

test("no migrated module under application, features or bootstrap imports the legacy shim", () => {
  const files = listRepoFiles(REPO) as readonly string[];
  const fileSet = new Set(files);
  const migrated = files.filter((f) => isScript(f) && MIGRATED.some((dir) => f.startsWith(dir)));
  assert.ok(migrated.some((f) => f === "src/bootstrap/wiring.ts"), "the scan covers the wiring step");
  const offenders: string[] = [];
  for (const path of migrated) {
    for (const i of importsOf(path)) {
      const resolved = resolveSpecifier(path, i.spec, fileSet) as { kind: string; target: string };
      if (resolved.kind === "file" && resolved.target === SHIM) offenders.push(path + " imports " + i.spec);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the resolver used by the scan does find an import of the shim", () => {
  const fileSet = new Set([SHIM, "src/bootstrap/probe.ts"]);
  assert.deepEqual(resolveSpecifier("src/bootstrap/probe.ts", "../js/_entry.js", fileSet), { kind: "file", target: SHIM });
});
