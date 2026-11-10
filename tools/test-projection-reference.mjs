import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { projectionManifestPath, checkProjectionManifest } from "./projection-reference.mjs";

const directory = mkdtempSync(join(tmpdir(), "splitpage-projection-manifest-"));
const stale = join(directory, "stale.json");
try {
  const original = readFileSync(projectionManifestPath, "utf8");
  assert.doesNotThrow(() => checkProjectionManifest(original, original));
  assert.throws(() => checkProjectionManifest(original, original + " "), /manifest is stale/);
  const command = fileURLToPath(new URL("projection-reference.mjs", import.meta.url));
  const good = spawnSync(process.execPath, [command, "--check"], { encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /manifest matches/);
  writeFileSync(stale, original + " ");
  const bad = spawnSync(process.execPath, [command, "--check", "--manifest", stale], { encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /manifest is stale/);
  assert.equal(readFileSync(projectionManifestPath, "utf8"), original);
  const experiments = spawnSync(process.execPath, [command, "--check", "--input", "prototypes/collab/test/proj/experiment-inputs.json", "--manifest", "prototypes/collab/test/proj/experiment-reference.json"], { encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.equal(experiments.status, 0, experiments.stderr);
  assert.match(experiments.stdout, /585 fixtures, manifest matches/);
  console.log("projection-reference: 9 checks passed");
} finally {
  try { unlinkSync(stale); } catch {}
  rmdirSync(directory);
}
