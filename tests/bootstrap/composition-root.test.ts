import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeScript, resolveSpecifier } from "../../tools/dep-report.mjs";
import { REPO, isScript, listRepoFiles } from "../../tools/source-scan.mjs";
import { COMPOSITION_ROOT } from "./load-manifests.ts";

const OUTSIDE_BOOTSTRAP = ["../adapters/storage/02c-blobs.js", "../adapters/storage/02d-gallery.js"];

const MOUNT_ORDER = [
  "mountScreenStateOwner", "mountPageEntry", "mountSceneStatusFeature", "mountHideShotFeature", "mountDocumentIdentityOwner", "startBlobs", "startGalleryStore",
  "mountSessionMergeOwner", "mountHistoryOwner", "mountScriptPlaceFeature", "mountRowsRenderFeature", "mountDraftEditFeature",
  "mountGalleryOverlayFeature", "mountRundownFeature", "mountCopyPasteFeature", "mountReadTimeFeature", "mountScriptZoomFeature",
  "mountTargetFeature", "mountGalleryVideoFeature", "mountGalleryFeature", "mountVideoFilesFeature", "mountScenesFeature",
  "mountSceneMediaFeature", "mountProductionTagsFeature", "mountPlainTagsFeature", "mountTagPanelsFeature", "mountBrollFeature",
  "mountBrollPanelStateFeature", "mountFindFeature", "mountCommentsLogicFeature", "mountImportDialogFeature", "mountSaveStatusFeature",
  "mountFileSavingFeature", "mountLocalFilesFeature", "mountMergeReviewFeature", "mountFileMenuDropdownFeature",
  "mountFileMenuExportFeature", "mountCommandMenuFeature", "mountWriterRuntimeFeature", "mountPrompterRuntimeFeature",
  "mountUpdateFeature", "mountOnboardingFeature", "mountHelpFeature", "mountProjectFiles", "mountDesktopFeature", "mountDraftsFeature",
  "mountAppDataFeature", "mountNewTabFeature", "mountSettingsFeature", "startAppWhenReady"
];

interface Import {
  readonly spec: string;
}

function importsOf(path: string): readonly Import[] {
  const analysis = analyzeScript(path, readFileSync(join(REPO, path), "utf8")) as { imports: readonly Import[] };
  return analysis.imports;
}

function mountCalls(text: string): string[] {
  const body = text.slice(text.indexOf("\nif (wiring) {"));
  return [...body.matchAll(/^ {2}(?:var \w+ = )?(\w+)\(/gm)].map((m) => m[1] ?? "");
}

test("src/js is gone, so no legacy initializer or numbered module can come back", () => {
  const files = listRepoFiles(REPO) as readonly string[];
  assert.deepEqual(files.filter((f) => f.startsWith("src/js/")), []);
});

test("the build bundles the composition root", () => {
  const build = readFileSync(join(REPO, "build.mjs"), "utf8");
  assert.match(build, /entryPoints: \[join\(ROOT, "src", "bootstrap", "main\.js"\)\]/);
});

test("outside src/bootstrap the composition root imports only its frozen set, which may only shrink", () => {
  const specs = importsOf(COMPOSITION_ROOT).map((i) => i.spec);
  assert.ok(specs.length > 0, "the composition root's imports were read");
  assert.equal(new Set(specs).size, specs.length, "each module is imported once");
  const added = specs.filter((s) => !(s.startsWith("./") || OUTSIDE_BOOTSTRAP.includes(s)));
  assert.deepEqual(added, []);
});

test("the composition root mounts the owners and features in the pinned order", () => {
  assert.deepEqual(mountCalls(readFileSync(join(REPO, COMPOSITION_ROOT), "utf8")), MOUNT_ORDER);
});

test("the mount-order reader lists each call in the started block in order", () => {
  const text = "x();\nif (wiring) {\n  b();\n  var s = a();\n  c(wiring.d);\n}\n";
  assert.deepEqual(mountCalls(text), ["b", "a", "c"]);
});

test("no production module imports the composition root", () => {
  const files = listRepoFiles(REPO) as readonly string[];
  const fileSet = new Set(files);
  const production = files.filter((f) => isScript(f) && f.startsWith("src/") && !f.startsWith("src/test/"));
  assert.ok(production.includes("src/bootstrap/wiring.ts"), "the scan covers the wiring step");
  const offenders: string[] = [];
  for (const path of production) {
    for (const i of importsOf(path)) {
      const resolved = resolveSpecifier(path, i.spec, fileSet) as { kind: string; target: string };
      if (resolved.kind === "file" && resolved.target === COMPOSITION_ROOT) offenders.push(path + " imports " + i.spec);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the resolver used by the scan does find an import of the composition root", () => {
  const fileSet = new Set([COMPOSITION_ROOT, "src/features/probe/view.ts"]);
  assert.deepEqual(resolveSpecifier("src/features/probe/view.ts", "../../bootstrap/main.js", fileSet), { kind: "file", target: COMPOSITION_ROOT });
});
