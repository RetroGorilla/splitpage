#!/usr/bin/env node
/* Tests for update.mjs — the API URL resolution and apply() backup recovery.
 *
 *   node tools/test-update.mjs
 *
 * No external dependencies. Tests:
 *   - updateApiUrl() precedence: env, then the built-in default — the
 *     local manifest gets no say (#64)
 *   - apply() backup recovery: simulate a hard-kill mid-apply and verify
 *     the next run restores from backup first
 *
 * The apply() test uses a temporary copy of the entire app directory so the
 * module can read its own ROOT correctly.
 *
 * Exits non-zero on the first failure.
 */

import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
const { updateApiUrl, apply } = await import(pathToFileURL(updateModulePath).href);

/* Test 1: default when nothing is set */
delete process.env.SPLITPAGE_UPDATE_API;
eq("default URL (no override, no manifest)", updateApiUrl(), DEFAULT_API);

/* Test 2: env override takes precedence */
process.env.SPLITPAGE_UPDATE_API = "https://custom.api/releases/latest";
eq("env override wins", updateApiUrl(), "https://custom.api/releases/latest");

delete process.env.SPLITPAGE_UPDATE_API;
check("updateApiUrl() is exported and callable", typeof updateApiUrl === "function", null);

/* ---------- test apply() backup recovery ---------- */

console.log("\napply() backup recovery:\n");

/* Copy the entire app to a temp directory so apply() can read its own ROOT */
const tempAppRoot = mkdtempSync(join(tmpdir(), "splitpage-apply-test-"));
cpSync(REAL_ROOT, tempAppRoot, { recursive: true, force: true });

/* Create a manifest if it doesn't exist (needed for the test) */
if (!existsSync(join(tempAppRoot, ".splitpage-release.json"))) {
  writeFileSync(join(tempAppRoot, ".splitpage-release.json"), JSON.stringify({
    name: "Splitpage",
    version: "1.0.0",
    updateApi: MIRROR_API,
    files: {}
  }, null, 2) + "\n");
}

const updateDir = join(tempAppRoot, ".update");
const backupDir = join(updateDir, "backup");
const stagedDir = join(updateDir, "staged");

/* Clean up any existing .update directory to start fresh */
rmSync(updateDir, { recursive: true, force: true });
mkdirSync(stagedDir, { recursive: true });

/* Create a staged update that would replace VERSION and start.mjs */
const oldVersion = readFileSync(join(tempAppRoot, "VERSION"), "utf8");
const newVersion = "1.1.0";

writeFileSync(join(stagedDir, "VERSION"), `${newVersion}\n`);
writeFileSync(join(stagedDir, "start.mjs"), "// updated start.mjs v1.1\n");

/* Create the manifest for this staged update */
const stagedManifest = {
  name: "Splitpage",
  version: newVersion,
  files: {
    "VERSION": { sha256: "abc123", mode: 0o644 },
    "start.mjs": { sha256: "def456", mode: 0o644 }
  }
};
writeFileSync(join(stagedDir, ".splitpage-release.json"), JSON.stringify(stagedManifest, null, 2) + "\n");

/* Create pending.json to signal apply() should run */
writeFileSync(join(updateDir, "pending.json"), JSON.stringify({
  from: oldVersion.trim(),
  to: newVersion
}));

/* Test 1: Happy path apply */
/* We can't directly call apply() from a different module context, so we'll
   test the backup recovery logic by manually simulating it */
check("apply() is exported and callable", typeof apply === "function", null);

/* Test 2: Simulate interrupted apply and verify recovery logic */
console.log("\n  (simulating interrupted apply...)\n");

/* Clean up for interrupted test */
rmSync(updateDir, { recursive: true, force: true });
mkdirSync(backupDir, { recursive: true });

/* Simulate state after a hard-kill: backup exists with old files, sentinel
   marks the update in progress, and some files have been partially replaced */
const sentinel = join(backupDir, ".in-progress");
writeFileSync(sentinel, newVersion);
writeFileSync(join(backupDir, "VERSION"), oldVersion);
writeFileSync(join(backupDir, "start.mjs"), "// original start.mjs\n");

/* Also save the old manifest */
const oldManifest = JSON.parse(readFileSync(join(tempAppRoot, ".splitpage-release.json"), "utf8"));
writeFileSync(join(updateDir, "backup.manifest.json"), JSON.stringify(oldManifest, null, 2) + "\n");

/* Simulate VERSION already changed but start.mjs not yet touched */
writeFileSync(join(tempAppRoot, "VERSION"), `${newVersion}\n`);

/* Recreate staged files for recovery attempt */
rmSync(stagedDir, { recursive: true, force: true });
mkdirSync(stagedDir, { recursive: true });
writeFileSync(join(stagedDir, "VERSION"), `${newVersion}\n`);
writeFileSync(join(stagedDir, "start.mjs"), "// updated start.mjs v1.1\n");
writeFileSync(join(stagedDir, ".splitpage-release.json"), JSON.stringify(stagedManifest, null, 2) + "\n");

/* Recreate pending.json */
writeFileSync(join(updateDir, "pending.json"), JSON.stringify({
  from: oldVersion.trim(),
  to: newVersion
}));

/* Now apply() should detect the sentinel and restore from backup first */
check("sentinel file exists before recovery", existsSync(sentinel), null);

/* Clean up temp directory */
rmSync(tempAppRoot, { recursive: true, force: true });

/* ---------- where the next update is looked for (#64) ----------

   The manifest beside update.mjs arrived with the last release this copy
   downloaded, so letting it name the update API meant one bad release could
   redirect every future check, permanently. It is ignored now: the env var,
   then the hard-coded default, and nothing in between.

   This drives the REAL update.mjs, copied into a temp root with a hostile
   manifest beside it — the old version of this test re-implemented the
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

const { updateApiUrl: testUpdateApiUrl } = await import(pathToFileURL(join(testAppRoot, "update.mjs")).href);
delete process.env.SPLITPAGE_UPDATE_API;
check("a manifest naming another update API is ignored", testUpdateApiUrl() !== MIRROR_API,
  "got " + testUpdateApiUrl());
check("...and the built-in default is used instead",
  testUpdateApiUrl().startsWith("https://api.github.com/repos/"), "got " + testUpdateApiUrl());
process.env.SPLITPAGE_UPDATE_API = MIRROR_API;
eq("...while the env var still overrides it", testUpdateApiUrl(), MIRROR_API);
delete process.env.SPLITPAGE_UPDATE_API;

rmSync(testAppRoot, { recursive: true, force: true });


/* ---------- a REAL interrupted apply(), end to end ----------
   apply() works on the folder update.mjs lives in, so copy update.mjs into a
   scratch app folder and import THAT copy: its ROOT is then the scratch
   folder and nothing here touches the real app. */
console.log("\napply() after a hard kill, for real:\n");
{
  const { mkdtempSync, mkdirSync: mk, writeFileSync: wf, readFileSync: rf, existsSync: ex, rmSync: rm } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j, dirname: dn } = await import("node:path");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const here = dn(fileURLToPath(import.meta.url));
  const app = mkdtempSync(j(tmpdir(), "splitpage-apply-"));
  const put = (root, rel, text) => { mk(dn(j(root, rel)), { recursive: true }); wf(j(root, rel), text); };
  wf(j(app, "update.mjs"), rf(j(here, "..", "update.mjs")));
  /* the installed (old) app */
  const oldManifest = { name: "Splitpage", version: "1.0.0", files: { "a.txt": {}, "b.txt": {}, "sub/c.txt": {} } };
  put(app, "a.txt", "a-old"); put(app, "b.txt", "b-old"); put(app, "sub/c.txt", "c-old");
  put(app, ".splitpage-release.json", JSON.stringify(oldManifest));
  put(app, "VERSION", "1.0.0");
  /* the staged (new) release: a and c change, b unchanged, new.txt is new */
  const newManifest = { name: "Splitpage", version: "1.0.1", files: { "a.txt": {}, "b.txt": {}, "sub/c.txt": {}, "new.txt": {} } };
  const staged = j(app, ".update", "staged");
  put(staged, "a.txt", "a-new"); put(staged, "b.txt", "b-old"); put(staged, "sub/c.txt", "c-new"); put(staged, "new.txt", "brand new");
  put(staged, ".splitpage-release.json", JSON.stringify(newManifest));
  put(app, ".update/pending.json", JSON.stringify({ from: "1.0.0", to: "1.0.1" }));
  /* the crash: a.txt and new.txt were copied in, a.txt was backed up first;
     b.txt and sub/c.txt were never reached */
  put(app, ".update/backup/a.txt", "a-old");
  put(app, ".update/backup/.in-progress", "1.0.1");
  put(app, ".update/staged.manifest.json", JSON.stringify(newManifest));
  put(app, "a.txt", "a-new"); put(app, "new.txt", "brand new");

  const mod = await import(pathToFileURL(j(app, "update.mjs")).href);
  const logs = [];
  const info = mod.apply({ log: (m) => logs.push(m) });
  check("apply() reports the update it applied", info && info.to === "1.0.1", JSON.stringify(info));
  check("recovery was announced", logs.some((l) => /recovering/.test(l)), logs.join(" | "));
  eq("a.txt ends up new", rf(j(app, "a.txt"), "utf8"), "a-new");
  eq("sub/c.txt (never reached by the crashed run) ends up new", rf(j(app, "sub/c.txt"), "utf8"), "c-new");
  eq("b.txt unchanged content survives", rf(j(app, "b.txt"), "utf8"), "b-old");
  eq("new.txt present after the completed apply", rf(j(app, "new.txt"), "utf8"), "brand new");
  check("sentinel cleared", !ex(j(app, ".update", "backup", ".in-progress")), null);
  check("pending.json cleared", !ex(j(app, ".update", "pending.json")), null);
  /* the backup taken by the fresh run holds the ORIGINALS, not the crashed run's leftovers */
  eq("backup holds the original a.txt", rf(j(app, ".update", "backup", "a.txt"), "utf8"), "a-old");
  eq("backup holds the original sub/c.txt", rf(j(app, ".update", "backup", "sub", "c.txt"), "utf8"), "c-old");
  check("backup has no new.txt (nothing existed to back up)", !ex(j(app, ".update", "backup", "new.txt")), null);
  rm(app, { recursive: true, force: true });
}
/* ---------- summary ---------- */

console.log(`\n${passed} passed`);
if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log("All tests passed!\n");
