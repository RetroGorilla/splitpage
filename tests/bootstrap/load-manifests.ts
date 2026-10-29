import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { REPO, listRepoFiles } from "../../tools/source-scan.mjs";

export interface LoadManifest {
  readonly area: string;
  readonly loadOnly: readonly string[];
  readonly expectedLoads: number;
}

const FOLDER = "tests/bootstrap/load-order";
export const COMPOSITION_ROOT = "src/bootstrap/main.js";

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseLoadManifest(area: string, text: string): LoadManifest {
  const value = JSON.parse(text) as Partial<LoadManifest>;
  assert.ok(value && typeof value === "object" && !Array.isArray(value), area + ": manifest object");
  assert.deepEqual(Object.keys(value).sort(), ["expectedLoads", "loadOnly"], area + ": manifest fields");
  assert.ok(strings(value.loadOnly), area + ": load-only target strings");
  assert.ok(typeof value.expectedLoads === "number" && Number.isInteger(value.expectedLoads) && value.expectedLoads >= 0, area + ": expected load count");
  return { area, loadOnly: value.loadOnly, expectedLoads: value.expectedLoads };
}

export function manifestTargets(manifest: LoadManifest): readonly string[] {
  return manifest.loadOnly;
}

export function validateManifestNames(areas: readonly string[], names: readonly string[]): void {
  assert.ok(areas.length > 0, "the load-only area catalog is not empty");
  assert.equal(new Set(areas).size, areas.length, "the area catalog has no duplicates");
  assert.ok(areas.every((area) => /^[a-z][a-z0-9-]*$/.test(area)), "area names stay inside the manifest folder");
  assert.deepEqual([...names].sort(), areas.map((area) => area + ".json").sort(), "every registered area has exactly one manifest");
}

export function validateManifestCoverage(manifests: readonly LoadManifest[], sourceFiles: readonly string[]): void {
  const files = new Set(sourceFiles);
  const targets: string[] = [];
  for (const manifest of manifests) {
    const owned = manifestTargets(manifest);
    assert.equal(owned.length, manifest.expectedLoads, manifest.area + ": pinned load-only coverage");
    for (const target of owned) {
      assert.ok(files.has(target), manifest.area + ": target exists: " + target);
      assert.ok(/^src\//.test(target), manifest.area + ": source target: " + target);
      assert.equal(posix.normalize(target), target, manifest.area + ": normalized target: " + target);
      assert.notEqual(target, COMPOSITION_ROOT, manifest.area + ": the composition root starts the app, so it is never load-only");
    }
    targets.push(...owned);
  }
  assert.equal(new Set(targets).size, targets.length, "each load-only target has exactly one owner");
}

export function readLoadManifests(): readonly LoadManifest[] {
  const areas: unknown = JSON.parse(readFileSync(join(REPO, "tests/bootstrap/load-order-areas.json"), "utf8"));
  assert.ok(strings(areas), "the load-only area catalog contains strings");
  const names = readdirSync(join(REPO, FOLDER));
  validateManifestNames(areas, names);
  const manifests = areas.map((area) => parseLoadManifest(area, readFileSync(join(REPO, FOLDER, area + ".json"), "utf8")));
  validateManifestCoverage(manifests, listRepoFiles(REPO) as readonly string[]);
  return manifests;
}
