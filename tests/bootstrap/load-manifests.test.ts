import { test } from "node:test";
import assert from "node:assert/strict";
import { frozenShimImports, manifestTargets, parseLoadManifest, readLoadManifests, validateManifestCoverage, validateManifestNames } from "./load-manifests.ts";
import type { LoadManifest } from "./load-manifests.ts";

const numbered = "src/js/01-example.js";
const migrated = "src/features/example/view.ts";
const shim = "src/js/_entry.js";
const legacy: LoadManifest = { area: "legacy", legacyImports: ["./01-example.js"], loadOnly: [], expectedLoads: 1 };
const feature: LoadManifest = { area: "example", legacyImports: [], loadOnly: [migrated], expectedLoads: 1 };

test("the area catalog rejects a deleted, renamed, extra or duplicate manifest", () => {
  validateManifestNames(["legacy", "example"], ["legacy.json", "example.json"]);
  assert.throws(() => validateManifestNames(["legacy", "example"], ["legacy.json"]), /every registered area/);
  assert.throws(() => validateManifestNames(["legacy", "example"], ["legacy.json", "renamed.json"]), /every registered area/);
  assert.throws(() => validateManifestNames(["legacy"], ["legacy.json", "extra.json"]), /every registered area/);
  assert.throws(() => validateManifestNames(["legacy", "legacy"], ["legacy.json"]), /no duplicates/);
});

test("load coverage rejects an omitted numbered module, a duplicate, a missing file and a removed migrated target", () => {
  const files = [shim, numbered, migrated];
  validateManifestCoverage([legacy, feature], files);
  assert.throws(() => validateManifestCoverage([feature], files), /every remaining numbered module/);
  assert.throws(() => validateManifestCoverage([legacy, feature, { ...feature, area: "other" }], files), /exactly one owner/);
  assert.throws(() => validateManifestCoverage([legacy, feature], [shim, numbered]), /target exists/);
  assert.throws(() => validateManifestCoverage([legacy, { ...feature, loadOnly: [] }], files), /pinned load-only coverage/);
});

test("a manifest cannot introduce another bootstrap doorway or malformed coverage data", () => {
  assert.throws(() => validateManifestCoverage([{ ...legacy, legacyImports: ["../bootstrap/extra.ts"] }], [shim, numbered, "src/bootstrap/extra.ts"]), /only numbered legacy shim imports/);
  assert.throws(() => parseLoadManifest("bad", '{"legacyImports":[],"loadOnly":[],"expectedLoads":-1}'), /expected load count/);
  assert.throws(() => parseLoadManifest("bad", '{"legacyImports":[],"loadOnly":[null],"expectedLoads":1}'), /target strings/);
});

test("the final numbered module can migrate without changing the common coverage checks", () => {
  validateManifestCoverage([{ ...legacy, legacyImports: [], expectedLoads: 0 }, feature], [shim, migrated]);
  assert.throws(() => validateManifestCoverage([feature], [migrated]), /scan includes the legacy shim/);
});

test("the registered manifests pin their coverage and provide the frozen shim imports", () => {
  const manifests = readLoadManifests();
  const imports = frozenShimImports(manifests);
  assert.equal(new Set(imports).size, imports.length);
  assert.deepEqual(imports.filter((spec) => spec.startsWith("../bootstrap/")), ["../bootstrap/wiring.ts", "../bootstrap/app.ts"]);
  for (const manifest of manifests) assert.equal(manifestTargets(manifest).length, manifest.expectedLoads, manifest.area);
});
