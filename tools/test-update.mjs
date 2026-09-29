import { mkdtempSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const REAL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_API = "https://api.github.com/repos/RetroGorilla/splitpage-releases/releases/latest";
const OTHER_API = "https://api.github.com/repos/someone-else/splitpage-fork/releases/latest";

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

console.log("\nupdateApiUrl() resolution:\n");

const updateModulePath = join(REAL_ROOT, "update.mjs");
const mod = await import(pathToFileURL(updateModulePath).href);
const { updateApiUrl, compareVersions } = mod;

delete process.env.SPLITPAGE_UPDATE_API;
eq("default URL (no override, no manifest)", updateApiUrl(), DEFAULT_API);

process.env.SPLITPAGE_UPDATE_API = "https://custom.api/releases/latest";
eq("env override wins", updateApiUrl(), "https://custom.api/releases/latest");

delete process.env.SPLITPAGE_UPDATE_API;
check("updateApiUrl() is exported and callable", typeof updateApiUrl === "function", null);

console.log("\nupdateApiUrl() ignores the manifest:\n");

const testAppRoot = mkdtempSync(join(tmpdir(), "splitpage-manifest-test-"));
copyFileSync(new URL("../update.mjs", import.meta.url), join(testAppRoot, "update.mjs"));
writeFileSync(join(testAppRoot, "VERSION"), "1.0.0\n");
writeFileSync(join(testAppRoot, ".splitpage-release.json"), JSON.stringify({
  name: "Splitpage",
  version: "1.0.0",
  updateApi: OTHER_API,
  files: {}
}));

const testMod = await import(pathToFileURL(join(testAppRoot, "update.mjs")).href);
const testUpdateApiUrl = testMod.updateApiUrl;
delete process.env.SPLITPAGE_UPDATE_API;
check("a manifest naming another update API is ignored", testUpdateApiUrl() !== OTHER_API,
  "got " + testUpdateApiUrl());
eq("...and the built-in default is used instead", testUpdateApiUrl(), DEFAULT_API);
process.env.SPLITPAGE_UPDATE_API = OTHER_API;
eq("...while the env var still overrides it", testUpdateApiUrl(), OTHER_API);
delete process.env.SPLITPAGE_UPDATE_API;

rmSync(testAppRoot, { recursive: true, force: true });

console.log("\ncompareVersions():\n");

check("compareVersions() is exported and callable", typeof compareVersions === "function", null);
eq("a newer patch is newer", compareVersions("2.1.1", "2.1.0"), 1);
eq("an older minor is older", compareVersions("2.0.9", "2.1.0"), -1);
eq("the same version is neither", compareVersions("2.1.0", "2.1.0"), 0);
eq("a longer version beats its own prefix", compareVersions("2.1.0.1", "2.1.0"), 1);
eq("a pre-release is older than its release", compareVersions("1.2.0-beta", "1.2.0"), -1);
eq("a numbered pre-release is older than its release too", compareVersions("3.0.0-beta.1", "3.0.0"), -1);
eq("a release is newer than its pre-release", compareVersions("3.0.0", "3.0.0-beta.2"), 1);
eq("beta.10 is newer than beta.9", compareVersions("3.0.0-beta.10", "3.0.0-beta.9"), 1);
eq("a pre-release of 3.0 is newer than 2.1", compareVersions("3.0.0-beta.1", "2.1.0"), 1);
eq("rc is newer than beta", compareVersions("3.0.0-rc.1", "3.0.0-beta.3"), 1);
eq("beta.1 is newer than plain beta", compareVersions("3.0.0-beta.1", "3.0.0-beta"), 1);
eq("10 sorts above 9, not below it", compareVersions("1.10.0", "1.9.0"), 1);

console.log("\nthe in-place self-update surface stays deleted:\n");

for (const name of ["apply", "stage", "pending", "readZip"]) {
  check(`update.mjs no longer exports ${name}()`, mod[name] === undefined,
    `it exports a ${typeof mod[name]}`);
}

console.log(`\n${passed} passed`);
if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log("All tests passed!\n");
