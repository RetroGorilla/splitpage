import { mkdtempSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const REAL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_API = "https://api.github.com/repos/RetroGorilla/splitpage/releases/latest";
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
delete process.env.SPLITPAGE_TEST;
eq("production ignores the env override", updateApiUrl(), DEFAULT_API);
process.env.SPLITPAGE_TEST = "0";
eq("a disabled test switch ignores the override", updateApiUrl(), DEFAULT_API);
process.env.SPLITPAGE_TEST = "1";
eq("the explicit test switch permits the env override", updateApiUrl(), "https://custom.api/releases/latest");
delete process.env.SPLITPAGE_TEST;

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
eq("...and a production env override is also ignored", testUpdateApiUrl(), DEFAULT_API);
process.env.SPLITPAGE_TEST = "1";
eq("...while the test switch allows an override", testUpdateApiUrl(), OTHER_API);
delete process.env.SPLITPAGE_UPDATE_API;
delete process.env.SPLITPAGE_TEST;

rmSync(testAppRoot, { recursive: true, force: true });

console.log("\nrelease responses:\n");

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response("missing", { status: 404, statusText: "Not Found" });
  await mod.latestRelease().then(() => check("404 rejects", false), (err) => check("404 rejects", err.message.includes("404")));
  globalThis.fetch = async () => Response.json({ tag_name: "v9.9.9", assets: [] });
  await mod.latestRelease().then(() => check("empty release rejects", false), (err) => eq("empty release rejects", err.message, "the release has no assets"));
  const releaseUrl = "https://github.com/RetroGorilla/splitpage/releases/tag/test-release";
  const downloadUrl = "https://github.com/RetroGorilla/splitpage/releases/download/test-release/splitpage.zip";
  const release = {
    url: "https://api.github.com/repos/RetroGorilla/splitpage/releases/123",
    html_url: releaseUrl, tag_name: "v9.9.9", name: "Test release", body: "Release notes",
    draft: false, prerelease: false,
    assets: [{ name: "splitpage.zip", size: 1024, browser_download_url: downloadUrl }]
  };
  globalThis.fetch = async () => Response.json(release);
  eq("release with assets returns its version", (await mod.latestRelease()).version, "9.9.9");
  eq("release with assets returns its validated page", (await mod.latestRelease()).url, releaseUrl);
  for (const html_url of ["javascript:alert(1)", "https://evil.test/r", [releaseUrl], null,
    releaseUrl.replace("splitpage/", "splitpage-fork/"), releaseUrl + "?redirect=evil"]) {
    globalThis.fetch = async () => Response.json({ ...release, html_url });
    await mod.latestRelease().then(() => check("unsafe release page rejects " + JSON.stringify(html_url), false),
      () => check("unsafe release page rejects " + JSON.stringify(html_url), true));
  }
  for (const browser_download_url of [[downloadUrl], null, 123,
    downloadUrl.replace("splitpage/", "splitpage-fork/"),
    "https://api.github.com/repos/RetroGorilla/splitpage/releases/assets/123",
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/splitpage.zip"]) {
    globalThis.fetch = async () => Response.json({ ...release, assets: [{ ...release.assets[0], browser_download_url }] });
    await mod.latestRelease().then(() => check("unsafe release asset rejects " + JSON.stringify(browser_download_url), false),
      () => check("unsafe release asset rejects " + JSON.stringify(browser_download_url), true));
  }
  process.env.SPLITPAGE_UPDATE_API = "http://127.0.0.1:4567/latest";
  const local = { ...release, html_url: "http://127.0.0.1:4567/r",
    assets: [{ name: "splitpage.zip", browser_download_url: "http://127.0.0.1:4567/asset" }] };
  globalThis.fetch = async () => Response.json(local);
  await mod.latestRelease().then(() => check("local feed is refused without the test switch", false),
    () => check("local feed is refused without the test switch", true));
  process.env.SPLITPAGE_TEST = "1";
  eq("local fake feed works with the test switch", (await mod.latestRelease()).url, local.html_url);
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.SPLITPAGE_UPDATE_API;
  delete process.env.SPLITPAGE_TEST;
}

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
