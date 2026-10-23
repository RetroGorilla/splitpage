import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { analyzeScript, resolveSpecifier } from "../../tools/dep-report.mjs";
import { REPO, isScript, listRepoFiles } from "../../tools/source-scan.mjs";
import { CONFIGURATION } from "../../src/test/_load-order-hooks.mjs";

const SHIM = "src/js/_entry.js";

const FROZEN_SHIM_IMPORTS: readonly string[] = [
  "./00-prelude.js", "./01-scene-status.js", "./01b-hide-shot.js", "./02-state.js", "./02b-doc-id.js",
  "../adapters/storage/02c-blobs.js", "../adapters/storage/02d-gallery.js", "./03-sync.js", "./03a-history-store.js", "./03b-side-panels.js", "./04-richtext.js",
  "./04c-doc-model.js", "./05-render.js", "./05c-clipboard.js",
  "./05d-draft-edit.js", "./05e-gallery-overlay.js", "./05f-rundown.js", "./05g-scene-clip.js", "./05h-scene-select.js", "./05p-rundown-presence.js",
  "./05r-read-time.js", "./05t-target.js", "./05v-video.js", "./05w-annotate.js",
  "./06-rows.js", "./07-production-tags.js", "./07b-plain-tags.js", "./08-production-panels.js", "./08c-broll.js", "./08d-broll-panel.js",
  "./09-find-replace.js", "./10-comments.js", "./11-import.js", "./12-dirty-toast.js", "./12a-undo.js", "./13-hosted.js",
  "./13a-presence.js", "./13b-collaborate.js", "./14-export.js", "./14b-export-kit.js", "./18-local-files.js", "./18a-local-merge.js", "./18b-file-menu.js",
  "./18c-export-dialog.js", "./18d-command-menu.js", "./19-writer.js", "./20-teleprompter.js", "./20a-update.js", "./20b-onboarding.js",
  "./20d-formats.js", "./20e-connect.js", "./20f-desktop.js", "./20g-drafts.js", "./20h-appdata.js",
  "./20j-newtab.js", "./20s-settings.js",
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

test("the frozen shim import set has the 56 started modules and the two bootstrap modules", () => {
  assert.equal(new Set(FROZEN_SHIM_IMPORTS).size, FROZEN_SHIM_IMPORTS.length);
  assert.equal(FROZEN_SHIM_IMPORTS.length, 58);
  assert.equal(FROZEN_SHIM_IMPORTS.filter((s) => /^\.\/\d/.test(s)).length, 54);
  assert.ok(!FROZEN_SHIM_IMPORTS.includes("./14e-export-formats.js"));
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

interface LoadReport {
  readonly target: string;
  readonly calls: readonly { readonly file: string; readonly name: string; readonly from: string }[];
  readonly error: string | null;
  readonly owners: Readonly<Record<string, boolean | string>>;
}

const NOTHING_STARTED = { session: false, saves: false, recovery: false, editor: false, productionEditing: false, preferences: false, location: false, effects: false, transitions: false, actions: false, exports: false, exportServices: false, projectFileServices: false };
const CONFIGURES = /^(?:start|install|register|provide|configure|route|watch|hand|use|on)[A-Z]/;
const run = promisify(execFile);

async function loadAlone(target: string): Promise<LoadReport> {
  const { stdout } = await run(process.execPath, [join(REPO, "src/test/_load-order-probe.mjs"), target], { cwd: REPO, maxBuffer: 1 << 24 });
  return JSON.parse(stdout.trim().split("\n").pop() ?? "") as LoadReport;
}

async function loadEachAlone(targets: readonly string[]): Promise<LoadReport[]> {
  const reports: LoadReport[] = [];
  const queue = [...targets];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) reports.push(await loadAlone(next));
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, availableParallelism())) }, worker));
  return reports.sort((a, b) => (a.target < b.target ? -1 : 1));
}

const NUMBERED = readdirSync(join(REPO, "src/js")).filter((name) => /^\d/.test(name) && name.endsWith(".js")).map((name) => "src/js/" + name);

test("every configuration function the load-order check spies on exists, and every bridge or bootstrap export that configures is spied on", () => {
  const listed = new Set<string>();
  for (const [file, entry] of Object.entries(CONFIGURATION)) {
    const spec = entry as { readonly functions: readonly string[]; readonly facade?: { readonly name: string } };
    const source = readFileSync(join(REPO, file), "utf8");
    for (const name of spec.functions) {
      assert.equal(source.split("export function " + name + "(").length, 2, file + " declares " + name + " once");
      listed.add(file + "#" + name);
    }
    if (spec.facade) assert.match(source, new RegExp("export const " + spec.facade.name + "\\b"), file + " has the " + spec.facade.name + " facade");
  }
  const unlisted: string[] = [];
  const files = (listRepoFiles(REPO) as readonly string[]).filter((f) => /^src\/(?:legacy|bootstrap)\/.+\.ts$/.test(f));
  for (const file of files) {
    for (const found of readFileSync(join(REPO, file), "utf8").matchAll(/^export (?:async )?function (\w+)/gm)) {
      const name = found[1] ?? "";
      if (CONFIGURES.test(name) && !listed.has(file + "#" + name)) unlisted.push(file + "#" + name);
    }
  }
  assert.deepEqual(unlisted, [], "a new function that stores a callback, an effect or an owner is added to the spy list");
});

test("the load-order check catches a module that configures a bridge while it loads, including one that only stores a callback", async () => {
  const report = await loadAlone("src/test/_configures-on-load.mjs");
  assert.equal(report.error, null);
  assert.deepEqual(report.calls.map((c) => [c.file, c.name, c.from]), [
    ["src/legacy/tour-pause.ts", "handTourPauseTo", "src/test/_configures-on-load.mjs"],
    ["src/legacy/export-formats.ts", "installExportFormats", "src/test/_configures-on-load.mjs"]
  ]);
  assert.deepEqual(report.owners, { ...NOTHING_STARTED, exports: true });
});

test("no numbered module configures a bridge or starts an owner while it loads: each is imported alone, with fresh module state", { timeout: 600_000 }, async () => {
  assert.equal(NUMBERED.length, 54, "every remaining numbered module");
  const targets = [...NUMBERED, "src/adapters/formats/export-projections.ts", "src/adapters/formats/export-kit.ts", "src/adapters/formats/export-assets.ts", "src/adapters/formats/export-text.ts", "src/adapters/formats/csv.ts", "src/adapters/formats/xlsx.ts", "src/adapters/formats/docx.ts", "src/adapters/formats/pdf.ts", "src/features/rows/row-motion.js", "src/features/title/topbar.ts", "src/features/notices/busy.js", "src/features/editing/cell-reach.js", "src/features/script-zoom/script-zoom.js", "src/features/notices/phone-bar.ts", "src/adapters/storage/02c-blobs.js", "src/adapters/storage/02d-gallery.js", "src/adapters/storage/03c-history-idb.js", "src/bootstrap/wiring/editor.ts", "src/bootstrap/wiring/production.ts", "src/bootstrap/wiring/production-editing.ts", "src/bootstrap/wiring/comments.ts", "src/bootstrap/wiring/views.ts", "src/bootstrap/wiring/overlay.ts", "src/bootstrap/wiring/startup.ts", "src/bootstrap/wiring/exporters.ts", "src/bootstrap/wiring/script-zoom.ts", "src/application/screen.ts", "src/features/script-zoom/actions.ts", "src/bootstrap/wiring/shared-ports.ts", "src/features/help/help.js", "src/features/help/actions.ts", "src/bootstrap/wiring/help.ts"];
  assert.equal(targets.length, 86);
  for (const loadOnly of ["src/features/rows/row-motion.js", "src/features/title/topbar.ts", "src/features/notices/busy.js", "src/features/editing/cell-reach.js", "src/features/notices/phone-bar.ts", "src/adapters/storage/03c-history-idb.js", "src/adapters/formats/export-projections.ts", "src/adapters/formats/export-kit.ts", "src/adapters/formats/export-assets.ts", "src/adapters/formats/export-text.ts", "src/adapters/formats/csv.ts", "src/adapters/formats/xlsx.ts", "src/adapters/formats/docx.ts", "src/adapters/formats/pdf.ts", "src/bootstrap/wiring/exporters.ts", "src/bootstrap/wiring/editor.ts", "src/bootstrap/wiring/production.ts", "src/bootstrap/wiring/production-editing.ts", "src/bootstrap/wiring/comments.ts", "src/bootstrap/wiring/views.ts", "src/bootstrap/wiring/overlay.ts", "src/bootstrap/wiring/startup.ts"]) {
    assert.ok(targets.includes(loadOnly), loadOnly);
  }
  const reports = await loadEachAlone(targets);
  assert.equal(reports.length, targets.length);
  const offenders = reports
    .filter((r) => r.error !== null || r.calls.length || JSON.stringify(r.owners) !== JSON.stringify(NOTHING_STARTED))
    .map((r) => ({ target: r.target, error: r.error?.split("\n")[0] ?? null, calls: r.calls.map((c) => c.from + " -> " + c.file + "#" + c.name), owners: r.owners }));
  assert.deepEqual(offenders, []);
});
