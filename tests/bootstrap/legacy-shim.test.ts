import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeScript, resolveSpecifier } from "../../tools/dep-report.mjs";
import { REPO, isScript, listRepoFiles } from "../../tools/source-scan.mjs";
import { frozenShimImports, readLoadManifests } from "./load-manifests.ts";

const SHIM = "src/js/_entry.js";
const FROZEN_SHIM_IMPORTS = frozenShimImports(readLoadManifests());

const MIGRATED = ["src/application/", "src/features/", "src/bootstrap/"];

interface Import {
  readonly spec: string;
}

function importsOf(path: string): readonly Import[] {
  const analysis = analyzeScript(path, readFileSync(join(REPO, path), "utf8")) as { imports: readonly Import[] };
  return analysis.imports;
}

test("the frozen shim import set contains no duplicates or retired export registry", () => {
  assert.equal(new Set(FROZEN_SHIM_IMPORTS).size, FROZEN_SHIM_IMPORTS.length);
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
