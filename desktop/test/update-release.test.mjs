import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import vm from "node:vm";
import crypto from "node:crypto";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { compileFixtures } from "../../tools/ts-fixtures.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  DEFAULT_UPDATE_API, hasReleaseAssets, compareVersions, isAllowedDownloadHost, isAllowedReleaseUrl, pickUpdateAsset, findChecksumsAsset, checksumFor
} = require(path.join(here, "..", "update-release.ts"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const API = DEFAULT_UPDATE_API;
const LOCAL_API = "http://127.0.0.1:4567/releases/latest";
const gh = (name) => "https://github.com/RetroGorilla/splitpage/releases/download/v9.9.9/" + name;
const asset = (name, url, size) => ({ name, browser_download_url: url === undefined ? gh(name) : url, size });
const HASH = "ab".repeat(32);

function updateFlow(body, platform = "win32") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-update-test-"));
  const main = fs.readFileSync(path.join(here, "..", "main.ts"), "utf8");
  const source = stripTypeScriptTypes(main.slice(main.indexOf("function readAppVersion()"), main.indexOf("async function pickChromiumBrowser()")));
  const requests = [], launches = [];
  const payload = Buffer.from("test installer");
  const digest = crypto.createHash("sha256").update(payload).digest("hex");
  let finishQuit;
  const context = {
    ...require(path.join(here, "..", "update-release.ts")),
    fs, fsp: fs.promises, path, crypto, Buffer, URL, Date,
    APP_ROOT: dir, TEST_MODE: false, SKIP_UPDATE_CHECK: false,
    process: { platform, arch: "x64", env: { SPLITPAGE_UPDATE_API: LOCAL_API } },
    app: { getVersion: () => "0", getPath: () => dir }, tabs: new Map(),
    net: { fetch: async (url) => {
      requests.push(url);
      if (url === API) return Response.json(body);
      if (url === gh("setup-x64.exe")) return new Response(payload);
      if (url === gh("SHA256SUMS.txt")) return new Response(digest + "  setup-x64.exe\n");
      throw new Error("unexpected fetch " + JSON.stringify(url));
    } },
    spawn: (...args) => { launches.push(args); return { unref() {} }; },
    shell: { openPath: (...args) => { launches.push(args); } },
    quitToInstall: () => new Promise((resolve) => { finishQuit = () => resolve(context.startInstallerNow()); })
  };
  vm.createContext(context);
  vm.runInContext(source + "\nfunction status() { return updateStatus; }", context);
  return { context, requests, launches, finishQuit: () => finishQuit(),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const releaseBody = () => ({
  url: "https://api.github.com/repos/RetroGorilla/splitpage/releases/123",
  html_url: "https://github.com/RetroGorilla/splitpage/releases/tag/test-release",
  tag_name: "v99.0.0", draft: false, prerelease: false,
  assets: [asset("setup-x64.exe"), asset("SHA256SUMS.txt")]
});

test("the default update API is the releases repository's latest release", () => {
  assert.equal(API, "https://api.github.com/repos/RetroGorilla/splitpage/releases/latest");
});

test("a release needs assets before it can be announced", () => {
  assert.equal(hasReleaseAssets([]), false);
  assert.equal(hasReleaseAssets(null), false);
  assert.equal(hasReleaseAssets({ length: 1 }), false);
  assert.equal(hasReleaseAssets([asset("Splitpage.exe")]), true);
});

test("versions order by their numbers, with missing parts as zero", () => {
  assert.equal(compareVersions("4.1.0", "4.0.9"), 1);
  assert.equal(compareVersions("4.0.9", "4.1.0"), -1);
  assert.equal(compareVersions("4.10.0", "4.9.0"), 1);
  assert.equal(compareVersions("4.1", "4.1.0"), 0);
  assert.equal(compareVersions(" 4.1.0 ", "4.1.0"), 0);
  assert.equal(compareVersions("4.1.0+build.7", "4.1.0"), 0);
  assert.equal(compareVersions("4.x.1", "4.0.1"), 0);
});

test("a prerelease comes before its release and prerelease parts order by semver rules", () => {
  assert.equal(compareVersions("4.0.0-beta.1", "4.0.0"), -1);
  assert.equal(compareVersions("4.0.0", "4.0.0-beta.1"), 1);
  assert.equal(compareVersions("4.0.0-beta.2", "4.0.0-beta.10"), -1);
  assert.equal(compareVersions("4.0.0-1", "4.0.0-beta"), -1);
  assert.equal(compareVersions("4.0.0-alpha", "4.0.0-beta"), -1);
  assert.equal(compareVersions("4.0.0-beta", "4.0.0-beta.1"), -1);
  assert.equal(compareVersions("4.0.0-beta.1", "4.0.0-beta.1"), 0);
});

test("feed downloads must name this repository's HTTPS release assets", () => {
  assert.equal(isAllowedDownloadHost(gh("setup.exe"), API), true);
  assert.equal(isAllowedDownloadHost(gh("SHA256SUMS.txt"), API), true);
  for (const url of [
    "https://github.com/a/b/releases/download/tag/setup.exe",
    "https://github.com/RetroGorilla/splitpage-fork/releases/download/tag/setup.exe",
    "https://github.com/RetroGorilla/splitpage/blob/main/setup.exe",
    "https://api.github.com/repos/RetroGorilla/splitpage/releases/assets/123",
    "https://objects.githubusercontent.com/x",
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/setup.exe",
    "https://github.com.evil.test/RetroGorilla/splitpage/releases/download/tag/setup.exe",
    gh("setup.exe").replace("https:", "http:"),
    gh("setup.exe").replace("github.com", "user:pass@github.com"),
    gh("setup.exe").replace("github.com", "github.com:444"),
    gh("setup.exe") + "?redirect=https://evil.test",
    gh("setup.exe") + "#fragment",
    "https://github.com/RetroGorilla/splitpage/releases/download/tag/",
    "not a url", [gh("setup.exe")], null, 123
  ]) assert.equal(isAllowedDownloadHost(url, API), false, JSON.stringify(url));
});

test("local feed URLs require the explicit test switch and the feed's own origin", () => {
  const url = "http://127.0.0.1:4567/files/a.exe";
  assert.equal(isAllowedDownloadHost(url, LOCAL_API), false);
  assert.equal(isAllowedDownloadHost(url, LOCAL_API, true), true);
  assert.equal(isAllowedDownloadHost(url, API, true), false);
  assert.equal(isAllowedDownloadHost(url, "not a url", true), false);
  assert.equal(isAllowedDownloadHost("http://127.0.0.1:4568/files/a.exe", LOCAL_API, true), false);
  assert.equal(isAllowedDownloadHost("https://api.github.com/a", API, true), false);
});

test("release links must name this repository's release page before being exposed", () => {
  const url = "https://github.com/RetroGorilla/splitpage/releases/tag/test-release";
  assert.equal(isAllowedReleaseUrl(url, API), true);
  for (const bad of [
    "javascript:alert(1)", "https://evil.test/r", [url], null,
    url.replace("splitpage/", "splitpage-fork/"),
    url.replace("github.com", "github.com.evil.test"),
    url.replace("github.com", "user@github.com"),
    url.replace("https:", "http:"), url + "?next=evil", url + "#fragment",
    "https://github.com/RetroGorilla/splitpage/releases/tag/"
  ]) assert.equal(isAllowedReleaseUrl(bad, API), false, JSON.stringify(bad));
  assert.equal(isAllowedReleaseUrl("http://127.0.0.1:4567/r", LOCAL_API), false);
  assert.equal(isAllowedReleaseUrl("http://127.0.0.1:4567/r", LOCAL_API, true), true);
});

test("the installer for this platform is picked, and its name, url and size are described", () => {
  const picked = pickUpdateAsset([asset("Splitpage-Setup-9.9.9.exe", undefined, 123), asset("Splitpage-9.9.9.dmg")], { platform: "win32", arch: "x64", apiUrl: API });
  assert.deepEqual(picked, { name: "Splitpage-Setup-9.9.9.exe", url: gh("Splitpage-Setup-9.9.9.exe"), size: 123 });
  assert.deepEqual(pickUpdateAsset([asset("Splitpage-9.9.9.dmg")], { platform: "darwin", arch: "arm64", apiUrl: API }).name, "Splitpage-9.9.9.dmg");
  assert.equal(pickUpdateAsset([asset("Splitpage-9.9.9.AppImage")], { platform: "linux", arch: "x64", apiUrl: API }).name, "Splitpage-9.9.9.AppImage");
  assert.equal(pickUpdateAsset([asset("Splitpage-Setup-9.9.9.exe", undefined, Number.NaN)], { platform: "win32", arch: "x64", apiUrl: API }).size, 0);
});

test("no installer is picked for an unknown platform or when none is safe", () => {
  assert.equal(pickUpdateAsset([asset("Splitpage.exe")], { platform: "aix", arch: "x64", apiUrl: API }), null);
  assert.equal(pickUpdateAsset(null, { platform: "win32", arch: "x64", apiUrl: API }), null);
  assert.equal(pickUpdateAsset([asset("../evil.exe"), asset(".hidden.exe"), asset("Splitpage.exe", "http://github.com/x.exe"), null], { platform: "win32", arch: "x64", apiUrl: API }), null);
  assert.equal(pickUpdateAsset([asset("Splitpage.zip")], { platform: "win32", arch: "x64", apiUrl: API }), null);
});

test("an installer naming this architecture wins, and two of them pick nothing", () => {
  const both = [asset("Splitpage-Setup-x64.exe"), asset("Splitpage-Setup-arm64.exe")];
  assert.equal(pickUpdateAsset(both, { platform: "win32", arch: "arm64", apiUrl: API }).name, "Splitpage-Setup-arm64.exe");
  assert.equal(pickUpdateAsset(both, { platform: "win32", arch: "x64", apiUrl: API }).name, "Splitpage-Setup-x64.exe");
  assert.equal(pickUpdateAsset([asset("Splitpage-x64.exe"), asset("Splitpage-x64-portable.exe")], { platform: "win32", arch: "x64", apiUrl: API }), null);
});

test("without one for this architecture, a single neutral installer is picked and another architecture's never is", () => {
  assert.equal(pickUpdateAsset([asset("Splitpage-Setup.exe"), asset("Splitpage-Setup-x64.exe")], { platform: "win32", arch: "arm64", apiUrl: API }).name, "Splitpage-Setup.exe");
  assert.equal(pickUpdateAsset([asset("Splitpage-Setup-x64.exe")], { platform: "win32", arch: "arm64", apiUrl: API }), null);
  assert.equal(pickUpdateAsset([asset("Splitpage-a.exe"), asset("Splitpage-b.exe")], { platform: "win32", arch: "arm64", apiUrl: API }), null);
  assert.equal(pickUpdateAsset([asset("Splitpagex64.exe")], { platform: "win32", arch: "arm64", apiUrl: API }).name, "Splitpagex64.exe");
});

test("the checksums file is found by name on an allowed host", () => {
  const sums = asset("SHA256SUMS.txt");
  assert.equal(findChecksumsAsset([asset("a.exe"), sums], API), sums);
  assert.equal(findChecksumsAsset([asset("sha256sums")], API).name, "sha256sums");
  assert.equal(findChecksumsAsset([asset("SHA256SUMS.txt", "http://evil.test/SHA256SUMS.txt")], API), null);
  assert.equal(findChecksumsAsset([asset("SHA256SUMS.md")], API), null);
  assert.equal(findChecksumsAsset(null, API), null);
});

test("the checksum for an asset is read from its line, by base name, in lower case", () => {
  const text = [
    "0".repeat(64) + "  other.exe",
    HASH.toUpperCase() + " *dist/Splitpage-Setup.exe",
    "not a line"
  ].join("\r\n");
  assert.equal(checksumFor(text, "Splitpage-Setup.exe"), HASH);
  assert.equal(checksumFor(text, "missing.exe"), null);
  assert.equal(checksumFor(HASH + "  Splitpage-Setup.exe   ", "Splitpage-Setup.exe"), HASH);
  assert.equal(checksumFor("ab".repeat(31) + "  Splitpage-Setup.exe", "Splitpage-Setup.exe"), null);
});

test("an oversized checksums file gives no checksum", () => {
  const line = HASH + "  Splitpage-Setup.exe\n";
  assert.equal(checksumFor(line + "x".repeat(200000 - line.length), "Splitpage-Setup.exe"), HASH);
  assert.equal(checksumFor(line + "x".repeat(200001 - line.length), "Splitpage-Setup.exe"), null);
});

test("malformed release assets are rejected rather than coerced into download URLs", () => {
  const options = { platform: "win32", arch: "x64", apiUrl: API };
  for (const bad of [null, 1, "x", { name: ["setup-x64.exe"], browser_download_url: gh("setup-x64.exe") },
    asset("setup-x64.exe", [gh("setup-x64.exe")]), asset("setup-x64.exe", { url: gh("setup-x64.exe") })]) {
    assert.equal(pickUpdateAsset([bad], options), null);
    assert.equal(hasReleaseAssets([bad], API), false);
  }
  for (const url of [[gh("SHA256SUMS.txt")], { url: gh("SHA256SUMS.txt") }, null, 1]) {
    const checksum = asset("SHA256SUMS.txt", url);
    assert.equal(findChecksumsAsset([checksum], API), null);
    assert.equal(hasReleaseAssets([asset("setup-x64.exe"), checksum], API), false);
  }
  const release = {
    url: "https://api.github.com/repos/RetroGorilla/splitpage/releases/123",
    html_url: "https://github.com/RetroGorilla/splitpage/releases/tag/test-release",
    tag_name: "test-release", draft: false, prerelease: false,
    assets: [asset("setup-x64.exe"), asset("SHA256SUMS.txt")]
  };
  assert.equal(hasReleaseAssets(release.assets, API), true);
  assert.equal(hasReleaseAssets([asset("notes.txt", "https://evil.test/notes.txt")], API), false);
});

test("release input compiles as unknown and a raw checksum result requires narrowing", () => {
  const fixture = "desktop/update-release-input-check.ts";
  const source = `import type { pickUpdateAsset as PickAsset, findChecksumsAsset as FindAsset } from "./update-release.ts";
declare const pick: typeof PickAsset;
declare const find: typeof FindAsset;
const assets: unknown[] = [null, 1, "x", { name: ["setup-x64.exe"], browser_download_url: ["https://github.com/a"], size: "10" }];
const picked = pick(assets, { platform: "win32", arch: "x64", apiUrl: "https://api.github.com" });
if (picked) { const name: string = picked.name; const url: string = picked.url; const size: number = picked.size; }
const raw = find(assets, "https://api.github.com");
`;
  const diagnostics = (text) => ts.getPreEmitDiagnostics(compileFixtures({ [fixture]: text }, { config: "tsconfig.desktop.json" }).program);
  assert.deepEqual(diagnostics(source).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
  const broken = source + "raw.browser_download_url;";
  const errors = diagnostics(broken);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 18046);
  assert.ok(errors[0].file.fileName.replaceAll("\\", "/").endsWith("/" + fixture));
  assert.equal(errors[0].start, source.length);
  assert.equal(errors[0].length, 3);
});

test("unsafe release JSON follows the failed-check status path without fetching assets", async () => {
  for (const patch of [
    { html_url: "javascript:alert(1)" },
    { html_url: [releaseBody().html_url] },
    { html_url: "https://github.com/another/repo/releases/tag/test-release" },
    { assets: [asset("setup-x64.exe"), asset("SHA256SUMS.txt", [gh("SHA256SUMS.txt")])] },
    { assets: [asset("setup-x64.exe", "https://github.com/another/repo/releases/download/tag/setup.exe")] }
  ]) {
    const flow = updateFlow({ ...releaseBody(), ...patch });
    try {
      await flow.context.checkForUpdate();
      const status = flow.context.status();
      assert.equal(status.checking, false);
      assert.equal(status.updateAvailable, false);
      assert.equal(status.canInstall, false);
      assert.equal(status.releaseUrl, null);
      assert.ok(status.error);
      assert.equal((await flow.context.downloadUpdate()).ok, false);
      assert.deepEqual(flow.requests, [API]);
    } finally { flow.cleanup(); }
  }
});

test("a cleared installer slot during quit never invokes a native installer", async () => {
  for (const platform of ["win32", "darwin"]) {
    const flow = updateFlow(releaseBody(), platform);
    try {
      vm.runInContext('updateFile = "installer"; updateStatus.download.state = "ready";', flow.context);
      flow.context.fs = { ...fs, existsSync: () => true };
      const installing = flow.context.runUpdateInstaller();
      vm.runInContext("updateFile = null;", flow.context);
      flow.finishQuit();
      const result = await installing;
      assert.equal(result.ok, false);
      assert.equal(result.error, "not-downloaded");
      assert.deepEqual(flow.launches, []);
    } finally { flow.cleanup(); }
  }
});

test("a valid repository release downloads and launches its verified installer after quit", async () => {
  const flow = updateFlow(releaseBody());
  try {
    await flow.context.checkForUpdate();
    assert.equal(flow.context.status().canInstall, true);
    assert.equal((await flow.context.downloadUpdate()).ok, true);
    assert.equal(flow.context.status().download.verified, true);
    const installing = flow.context.runUpdateInstaller();
    assert.equal(flow.launches.length, 0);
    flow.finishQuit();
    assert.equal((await installing).ok, true);
    assert.equal(flow.launches.length, 1);
    assert.equal(path.basename(flow.launches[0][0]), "setup-x64.exe");
    assert.deepEqual(flow.requests, [API, gh("setup-x64.exe"), gh("SHA256SUMS.txt")]);
  } finally { flow.cleanup(); }
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
