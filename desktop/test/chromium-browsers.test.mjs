/* desktop/test/chromium-browsers.test.mjs: unit tests for
 * desktop/chromium-browsers.js, which finds an installed Chromium browser for
 * "Use Chromium Speech Recognition" (issue #123).
 *
 * Node built-ins only, no Electron, and no real registry or file system:
 * every lookup goes through the fakes passed in. What this cannot cover is
 * main.js starting the browser on the prompter's URL — that is
 * desktop/test/smoke.mjs's "present in chromium" group.
 *
 * Prints ALL PASS and exits 0, or lists the failures and exits 1.
 *
 * Run: node desktop/test/chromium-browsers.test.mjs
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { findChromiumBrowsers, launchChromiumBrowser, chromiumBrowserName } = require(path.join(here, "..", "chromium-browsers.js"));

const WIN_ENV = {
  "ProgramFiles": "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  "LOCALAPPDATA": "C:\\Users\\me\\AppData\\Local"
};
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BRAVE_USER = "C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";

function win(files, reg) {
  const set = new Set(files);
  const asked = [];
  return {
    asked,
    opts: {
      platform: "win32",
      env: WIN_ENV,
      exists: (p) => set.has(p),
      regQuery: async (key, name) => { asked.push([key, name]); return (reg || {})[key + (name ? "|" + name : "")] || null; }
    }
  };
}

const USER_CHOICE = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice|ProgId";

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("Windows: Edge is found in its install folder, and leads when the default is not Chromium", async () => {
  const w = win([EDGE, CHROME], { [USER_CHOICE]: "FirefoxURL-308046B0AF4A39CB" });
  const found = await findChromiumBrowsers(w.opts);
  assert.deepEqual(found.map((b) => b.id), ["edge", "chrome"]);
  assert.equal(found[0].path, EDGE);
  assert.equal(found[0].name, "Microsoft Edge");
});

test("Windows: a Chromium default browser comes first", async () => {
  const w = win([EDGE, CHROME, BRAVE_USER], { [USER_CHOICE]: "BraveHTML" });
  assert.deepEqual((await findChromiumBrowsers(w.opts)).map((b) => b.id), ["brave", "edge", "chrome"]);
  const c = win([EDGE, CHROME], { [USER_CHOICE]: "ChromeHTML" });
  assert.deepEqual((await findChromiumBrowsers(c.opts)).map((b) => b.id), ["chrome", "edge"]);
});

test("Windows: App Paths is read (HKCU before HKLM), quoted and with %vars% expanded", async () => {
  const custom = "D:\\Apps\\Chrome\\chrome.exe";
  const w = win([custom, EDGE], {
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe": "\"" + custom + "\"",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe": "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"
  });
  const found = await findChromiumBrowsers(w.opts);
  assert.deepEqual(found.map((b) => [b.id, b.path]), [["edge", EDGE], ["chrome", custom]]);
});

test("Windows: an App Paths entry pointing at nothing is not a browser", async () => {
  const w = win([], { "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe": "C:\\gone\\chrome.exe" });
  assert.deepEqual(await findChromiumBrowsers(w.opts), []);
});

test("Windows: a registry that throws is the same as an empty one", async () => {
  const opts = Object.assign(win([EDGE]).opts, { regQuery: async () => { throw new Error("no reg.exe"); } });
  assert.deepEqual((await findChromiumBrowsers(opts)).map((b) => b.id), ["edge"]);
});

test("macOS and Linux look in their own places", async () => {
  const mac = await findChromiumBrowsers({ platform: "darwin", env: {}, exists: (p) => p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  assert.deepEqual(mac.map((b) => b.id), ["chrome"]);
  const linux = await findChromiumBrowsers({ platform: "linux", env: { PATH: "/usr/local/bin:/usr/bin" }, exists: (p) => p === "/usr/bin/chromium-browser" || p === "/usr/bin/brave-browser" });
  assert.deepEqual(linux.map((b) => [b.id, b.path]), [["brave", "/usr/bin/brave-browser"], ["chromium", "/usr/bin/chromium-browser"]]);
  assert.deepEqual(await findChromiumBrowsers({ platform: "linux", env: { PATH: "" }, exists: () => true }), []);
});

test("names come from the table, and only for its own ids", () => {
  assert.equal(chromiumBrowserName("edge"), "Microsoft Edge");
  assert.equal(chromiumBrowserName("firefox"), null);
  assert.equal(chromiumBrowserName("../x"), null);
});

test("launch starts the found path with the URL as its one argument, detached", async () => {
  const calls = [];
  const spawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    setImmediate(() => child.emit("spawn"));
    calls.child = child;
    return child;
  };
  await launchChromiumBrowser({ id: "edge", name: "Microsoft Edge", path: EDGE }, "http://127.0.0.1:8771/?teleprompter=1#script=ab", spawn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, EDGE);
  assert.deepEqual(calls[0].args, ["http://127.0.0.1:8771/?teleprompter=1#script=ab"]);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, "ignore");
  assert.equal(calls.child.unrefed, true);
  const failing = () => { const c = new EventEmitter(); setImmediate(() => c.emit("error", new Error("ENOENT"))); return c; };
  await assert.rejects(launchChromiumBrowser({ path: "C:\\nope.exe" }, "http://x/", failing), /ENOENT/);
});

const failures = [];
for (const c of cases) {
  try {
    await c.fn();
    console.log("ok   - " + c.name);
  } catch (err) {
    failures.push(c.name);
    console.log("FAIL - " + c.name + "\n       " + (err && err.stack || err));
  }
}
console.log("");
if (failures.length) {
  console.log(`FAILURES (${failures.length} of ${cases.length})`);
  process.exit(1);
}
console.log(`ALL PASS (${cases.length} cases)`);
