import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { compileFixtures } from "../../tools/ts-fixtures.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  DEFAULT_UPDATE_API, hasReleaseAssets, compareVersions, isAllowedDownloadHost, pickUpdateAsset, findChecksumsAsset, checksumFor
} = require(path.join(here, "..", "update-release.ts"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const API = DEFAULT_UPDATE_API;
const LOCAL_API = "http://127.0.0.1:4567/releases/latest";
const gh = (name) => "https://github.com/RetroGorilla/splitpage/releases/download/v9.9.9/" + name;
const asset = (name, url, size) => ({ name, browser_download_url: url === undefined ? gh(name) : url, size });
const HASH = "ab".repeat(32);

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

test("downloads may come from GitHub over https or from the update API's own origin", () => {
  assert.equal(isAllowedDownloadHost("https://github.com/a/b", API), true);
  assert.equal(isAllowedDownloadHost("https://api.github.com/a", API), true);
  assert.equal(isAllowedDownloadHost("https://objects.githubusercontent.com/x", API), true);
  assert.equal(isAllowedDownloadHost("https://GitHub.com/a", API), true);
  assert.equal(isAllowedDownloadHost("http://github.com/a", API), false);
  assert.equal(isAllowedDownloadHost("https://github.com.evil.test/a", API), false);
  assert.equal(isAllowedDownloadHost("https://evilgithubusercontent.com/a", API), false);
  assert.equal(isAllowedDownloadHost("not a url", API), false);
  assert.equal(isAllowedDownloadHost("http://127.0.0.1:4567/files/a.exe", LOCAL_API), true);
  assert.equal(isAllowedDownloadHost("http://127.0.0.1:4568/files/a.exe", LOCAL_API), false);
  assert.equal(isAllowedDownloadHost("https://github.com/a", "not a url"), true);
  assert.equal(isAllowedDownloadHost("http://127.0.0.1:4567/a", "not a url"), false);
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

test("release JSON keeps raw fields unknown while existing coercions normalize an installer", () => {
  const apiUrl = "https://api.github.com/releases";
  const url = "https://github.com/example/setup-x64.exe";
  assert.deepEqual(pickUpdateAsset([null, 1, "x", { name: ["setup-x64.exe"], browser_download_url: [url], size: "10" }], {
    platform: "win32", arch: "x64", apiUrl
  }), { name: "setup-x64.exe", url, size: 0 });
  const checksum = { name: ["SHA256SUMS.txt"], browser_download_url: [url] };
  assert.equal(findChecksumsAsset([null, 1, "x", checksum], apiUrl), checksum);
  assert.equal(isAllowedDownloadHost([url], apiUrl), true);
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
  assert.deepEqual(diagnostics(source), []);
  const broken = source + "raw.browser_download_url;";
  const errors = diagnostics(broken);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 18046);
  assert.ok(errors[0].file.fileName.replaceAll("\\", "/").endsWith("/" + fixture));
  assert.equal(errors[0].start, source.length);
  assert.equal(errors[0].length, 3);
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
