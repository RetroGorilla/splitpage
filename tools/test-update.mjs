#!/usr/bin/env node
/* Tests for update.mjs — where the update check looks, and how it compares
 * versions.
 *
 *   node tools/test-update.mjs
 *
 * No external dependencies. Tests:
 *   - updateApiUrl() precedence: env, then the built-in default — the
 *     local manifest gets no say (#64)
 *   - compareVersions(), which is what start.mjs uses to decide whether the
 *     release it found is actually newer than this copy
 *   - that the in-place self-update surface is gone and stays gone (#75)
 *
 * This file used to be mostly apply() tests: staging a fake release under
 * .update/, hard-killing the copy loop, and checking that the next run
 * restored from the backup. #75 deleted that whole path — a portable copy no
 * longer replaces its own files — so those cases went with the code they
 * covered. The checks below are the ones that still have something to check.
 *
 * Exits non-zero on the first failure.
 */

import { mkdtempSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const REAL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_API = "https://api.github.com/repos/RetroGorilla/splitpage/releases/latest";
const MIRROR_API = "https://api.github.com/repos/RetroGorilla/splitpage-releases/releases/latest";

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ---------- test updateApiUrl() ---------- */

console.log("\nupdateApiUrl() resolution:\n");

const updateModulePath = join(REAL_ROOT, "update.mjs");
const mod = await import(pathToFileURL(updateModulePath).href);
const { updateApiUrl, compareVersions } = mod;

/* Test 1: default when nothing is set */
delete process.env.SPLITPAGE_UPDATE_API;
eq("default URL (no override, no manifest)", updateApiUrl(), DEFAULT_API);

/* Test 2: env override takes precedence */
process.env.SPLITPAGE_UPDATE_API = "https://custom.api/releases/latest";
eq("env override wins", updateApiUrl(), "https://custom.api/releases/latest");

delete process.env.SPLITPAGE_UPDATE_API;
check("updateApiUrl() is exported and callable", typeof updateApiUrl === "function", null);

/* ---------- where the next update is looked for (#64) ----------

   The manifest beside update.mjs arrived with the last release this copy
   downloaded, so letting it name the update API meant one bad release could
   redirect every future check, permanently. It is ignored now: the env var,
   then the hard-coded default, and nothing in between.

   This drives the REAL update.mjs, copied into a temp root with a hostile
   manifest beside it — an older version of this test re-implemented the
   function in a string and then asserted against its own copy, which could
   not have caught the change either way. */

console.log("\nupdateApiUrl() ignores the manifest:\n");

const testAppRoot = mkdtempSync(join(tmpdir(), "splitpage-manifest-test-"));
copyFileSync(new URL("../update.mjs", import.meta.url), join(testAppRoot, "update.mjs"));
writeFileSync(join(testAppRoot, "VERSION"), "1.0.0\n");
writeFileSync(join(testAppRoot, ".splitpage-release.json"), JSON.stringify({
  name: "Splitpage",
  version: "1.0.0",
  updateApi: MIRROR_API,
  files: {}
}));

const testMod = await import(pathToFileURL(join(testAppRoot, "update.mjs")).href);
const testUpdateApiUrl = testMod.updateApiUrl;
delete process.env.SPLITPAGE_UPDATE_API;
check("a manifest naming another update API is ignored", testUpdateApiUrl() !== MIRROR_API,
  "got " + testUpdateApiUrl());
check("...and the built-in default is used instead",
  testUpdateApiUrl().startsWith("https://api.github.com/repos/"), "got " + testUpdateApiUrl());
process.env.SPLITPAGE_UPDATE_API = MIRROR_API;
eq("...while the env var still overrides it", testUpdateApiUrl(), MIRROR_API);
delete process.env.SPLITPAGE_UPDATE_API;

rmSync(testAppRoot, { recursive: true, force: true });

/* ---------- compareVersions() ----------
   start.mjs imports this to decide whether the release it just found is
   newer than the copy that is running, which is the only thing the update
   bar is driven by now. */

console.log("\ncompareVersions():\n");

check("compareVersions() is exported and callable", typeof compareVersions === "function", null);
eq("a newer patch is newer", compareVersions("2.1.1", "2.1.0"), 1);
eq("an older minor is older", compareVersions("2.0.9", "2.1.0"), -1);
eq("the same version is neither", compareVersions("2.1.0", "2.1.0"), 0);
eq("a longer version beats its own prefix", compareVersions("2.1.0.1", "2.1.0"), 1);
eq("a pre-release tag never reads as newer than the release", compareVersions("1.2.0-beta", "1.2.0"), 0);
eq("10 sorts above 9, not below it", compareVersions("1.10.0", "1.9.0"), 1);

/* ---------- the self-update path is gone (#75) ----------
   Not a formality: an HTTP route or a launcher that finds apply() back on
   this module would start swapping the app's files out from under a running
   browser again, and the point of deleting it was that nothing can. */

console.log("\nthe in-place self-update surface stays deleted:\n");

for (const name of ["apply", "stage", "pending", "readZip"]) {
  check(`update.mjs no longer exports ${name}()`, mod[name] === undefined,
    `it exports a ${typeof mod[name]}`);
}

/* ---------- summary ---------- */

console.log(`\n${passed} passed`);
if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log("All tests passed!\n");
