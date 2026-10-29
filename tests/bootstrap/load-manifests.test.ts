import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPOSITION_ROOT, manifestTargets, parseLoadManifest, readLoadManifests, validateManifestCoverage, validateManifestNames } from "./load-manifests.ts";
import type { LoadManifest } from "./load-manifests.ts";

const adapter = "src/adapters/storage/02c-blobs.js";
const migrated = "src/features/example/view.ts";
const storage: LoadManifest = { area: "storage", loadOnly: [adapter], expectedLoads: 1 };
const feature: LoadManifest = { area: "example", loadOnly: [migrated], expectedLoads: 1 };

test("the area catalog rejects a deleted, renamed, extra or duplicate manifest", () => {
  validateManifestNames(["storage", "example"], ["storage.json", "example.json"]);
  assert.throws(() => validateManifestNames(["storage", "example"], ["storage.json"]), /every registered area/);
  assert.throws(() => validateManifestNames(["storage", "example"], ["storage.json", "renamed.json"]), /every registered area/);
  assert.throws(() => validateManifestNames(["storage"], ["storage.json", "extra.json"]), /every registered area/);
  assert.throws(() => validateManifestNames(["storage", "storage"], ["storage.json"]), /no duplicates/);
});

test("load coverage rejects a duplicate, a missing file and a removed target", () => {
  const files = [COMPOSITION_ROOT, adapter, migrated];
  validateManifestCoverage([storage, feature], files);
  assert.throws(() => validateManifestCoverage([storage, feature, { ...feature, area: "other" }], files), /exactly one owner/);
  assert.throws(() => validateManifestCoverage([storage, feature], [COMPOSITION_ROOT, adapter]), /target exists/);
  assert.throws(() => validateManifestCoverage([storage, { ...feature, loadOnly: [] }], files), /pinned load-only coverage/);
});

test("a manifest cannot list the composition root or malformed coverage data", () => {
  assert.throws(() => validateManifestCoverage([{ ...feature, loadOnly: [COMPOSITION_ROOT] }], [COMPOSITION_ROOT]), /never load-only/);
  assert.throws(() => validateManifestCoverage([{ ...feature, loadOnly: ["tests/x.ts"] }], ["tests/x.ts"]), /source target/);
  assert.throws(() => validateManifestCoverage([{ ...feature, loadOnly: ["src/a/../b.ts"] }], ["src/a/../b.ts"]), /normalized target/);
  assert.throws(() => parseLoadManifest("bad", '{"loadOnly":[],"expectedLoads":-1}'), /expected load count/);
  assert.throws(() => parseLoadManifest("bad", '{"loadOnly":[null],"expectedLoads":1}'), /target strings/);
  assert.throws(() => parseLoadManifest("bad", '{"legacyImports":[],"loadOnly":[],"expectedLoads":0}'), /manifest fields/);
});

test("the registered manifests pin their coverage", () => {
  for (const manifest of readLoadManifests()) assert.equal(manifestTargets(manifest).length, manifest.expectedLoads, manifest.area);
});
