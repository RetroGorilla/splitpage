import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createShellIpc } = require(path.join(here, "..", "ipc-shell.ts"));
const { createBundleCopier } = require(path.join(here, "..", "bundle-copy.ts"));
const bundleFiles = require(path.join(here, "..", "..", "shared", "video-embed.ts"));
const { VIDEO_FILE_EXT } = require(path.join(here, "..", "..", "shared", "video-path.ts"));
const { openableVideoPath } = bundleFiles;

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-bundle-ipc-"));
  const script = path.join(dir, "Episode 12.splitpage");
  fs.writeFileSync(script, "{}");
  const drops = path.join(dir, "drops");
  fs.mkdirSync(drops);
  const clip = path.join(drops, "take one.mp4");
  fs.writeFileSync(clip, Buffer.alloc(2048, 5));
  const tool = path.join(drops, "tool.exe");
  fs.writeFileSync(tool, "MZ");
  return { dir, script, clip, tool, folder: path.join(dir, "Episode 12 files"), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function shellIpc({ source = null, grants = [], saveTargets = new Map(), testMode = false } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const openedPaths = [];
  const testVideoOpens = [];
  const progress = [];
  const tab = { id: "tab-a", source: source ? { kind: "file", absPath: source } : { kind: "blank" } };
  const videoFileGrants = new Map(grants);
  const { registerShellIpc } = createShellIpc({
    tabOf: (event) => (event.tab === undefined ? tab : event.tab),
    shell: { openPath: async (p) => { openedPaths.push(p); return ""; }, openExternal: async () => {} },
    testMode, testVideoOpens, videoFileGrants, VIDEO_FILE_EXT, openableVideoPath,
    resolveBundledFile: bundleFiles.resolveBundledFile,
    bundleCopier: createBundleCopier({ bundleFiles, progressEveryMs: 0 }),
    takeSaveTarget: (fileId, tabId) => {
      const t = saveTargets.get(fileId);
      if (!t || t.tabId !== tabId) return null;
      saveTargets.delete(fileId);
      return { from: t.from, to: t.to };
    }
  });
  registerShellIpc({
    ipcHandle: (name, fn) => { handlers.set(name, fn); },
    ipcOn: (name, fn) => { listeners.set(name, fn); },
    ipcOnSync: () => {}
  });
  const sender = { id: 7, isDestroyed: () => false, send: (channel, payload) => { progress.push([channel, payload]); } };
  const call = (name, ...args) => handlers.get(name)({ sender }, ...args);
  const send = (name, ...args) => listeners.get(name)({ sender }, ...args);
  const callAs = (other, name, ...args) => handlers.get(name)({ sender, tab: other }, ...args);
  return { tab, call, send, callAs, openedPaths, testVideoOpens, progress, saveTargets };
}

test("a drop is copied only from this session's grant, and only into the bundle folder of the tab's own script", async () => {
  const s = scratch();
  try {
    const ipc = shellIpc({ source: s.script, grants: [["tok", s.clip]] });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "tok", "bundle1"), { ok: true, name: "take one.mp4" });
    assert.deepEqual(fs.readdirSync(s.folder), ["take one.mp4"]);
    assert.ok(ipc.progress.length >= 1 && ipc.progress.every(([channel, p]) => channel === "splitpage:bundle-progress" && p.job === "bundle1"));
    assert.deepEqual(ipc.progress[ipc.progress.length - 1][1], { job: "bundle1", done: 2048, total: 2048 });
    assert.ok(ipc.progress.every(([, p]) => Object.keys(p).sort().join() === "done,job,total"), "progress names no path");
  } finally { s.done(); }
});

test("bundling refuses a token main never gave, a tab with no script on disk, a bad job id, and a granted file that is not a video", async () => {
  const s = scratch();
  try {
    const ipc = shellIpc({ source: s.script, grants: [["tok", s.clip], ["exe", s.tool]] });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "0".repeat(32), "bundle1"), { ok: false, code: "UNKNOWN" });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", s.clip, "bundle1"), { ok: false, code: "UNKNOWN" }, "a path is not a token");
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "tok", "../x"), { ok: false, code: "REFUSED" });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "exe", "bundle1"), { ok: false, code: "REFUSED" });
    assert.deepEqual(await ipc.callAs({ id: "tab-b", source: { kind: "blank" } }, "splitpage:bundle-file", "tok", "bundle1"), { ok: false, code: "NO_FOLDER" });
    assert.deepEqual(await ipc.callAs(null, "splitpage:bundle-file", "tok", "bundle1"), { ok: false, code: "NO_FOLDER" });
    assert.equal(fs.existsSync(s.folder), false, "nothing was written");
  } finally { s.done(); }
});

test("Cancel stops a running copy and leaves no partial file", async () => {
  const s = scratch();
  try {
    const big = path.join(path.dirname(s.clip), "big.mp4");
    fs.writeFileSync(big, Buffer.alloc(32 * 1024 * 1024, 1));
    const ipc = shellIpc({ source: s.script, grants: [["big", big]] });
    const running = ipc.call("splitpage:bundle-file", "big", "bundle9");
    ipc.send("splitpage:bundle-cancel", "bundle9");
    assert.deepEqual(await running, { ok: false, code: "CANCELLED" });
    assert.deepEqual(fs.readdirSync(s.folder), []);
  } finally { s.done(); }
});

test("Save As carry copies only from the script the tab had when the dialog was answered, to the file that dialog chose, once", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    const to = path.join(s.dir, "v2", "Episode 12 v2.splitpage");
    fs.mkdirSync(path.dirname(to));
    const saveTargets = new Map([["fid", { tabId: "tab-a", from: s.script, to }], ["other", { tabId: "tab-b", from: s.script, to }]]);
    const ipc = shellIpc({ source: to, saveTargets });
    assert.deepEqual(await ipc.call("splitpage:bundle-carry", "nope", ["a.mp4"], "bundle1"), { ok: false, code: "UNKNOWN" }, "an id no save dialog gave");
    assert.deepEqual(await ipc.call("splitpage:bundle-carry", "other", ["a.mp4"], "bundle1"), { ok: false, code: "UNKNOWN" }, "another tab's save");
    assert.deepEqual(await ipc.call("splitpage:bundle-carry", "fid", ["a.mp4", 5], "bundle1"), { ok: false, code: "REFUSED" }, "names must be strings");
    saveTargets.set("fid", { tabId: "tab-a", from: s.script, to });
    assert.deepEqual(await ipc.call("splitpage:bundle-carry", "fid", ["a.mp4", "..\\Episode 12.splitpage"], "bundle1"), { ok: true, copied: 1, kept: 0, failed: 1 });
    assert.equal(fs.readFileSync(path.join(s.dir, "v2", "Episode 12 v2 files", "a.mp4"), "utf8"), "aaaa");
    assert.deepEqual(await ipc.call("splitpage:bundle-carry", "fid", ["a.mp4"], "bundle1"), { ok: false, code: "UNKNOWN" }, "used once");
  } finally { s.done(); }
});

test("a bundled name opens only inside the tab's script's bundle folder, and only a regular video file", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take one.mp4"), "x");
    fs.writeFileSync(path.join(s.folder, "tool.exe"), "MZ");
    fs.mkdirSync(path.join(s.folder, "dir.mp4"));
    const ipc = shellIpc({ source: s.script });
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "take one.mp4"), { ok: true });
    assert.deepEqual(ipc.openedPaths, [fs.realpathSync.native(path.join(s.folder, "take one.mp4"))]);
    const refused = {
      "traversal": "..\\drops\\take one.mp4", "POSIX traversal": "../drops/take one.mp4", "absolute": s.clip,
      "UNC": "\\\\localhost\\c$\\take one.mp4", "an executable": "tool.exe", "a directory": "dir.mp4", "a device name": "CON.mp4",
      "not a string": 7, "nothing": ""
    };
    for (const [why, name] of Object.entries(refused)) {
      const got = await ipc.call("splitpage:bundled-file-open", name);
      assert.deepEqual(got, { ok: false, code: "REFUSED" }, why);
    }
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "missing.mp4"), { ok: false, code: "GONE" });
    assert.deepEqual(await ipc.callAs({ id: "tab-b", source: { kind: "blank" } }, "splitpage:bundled-file-open", "take one.mp4"), { ok: false, code: "REFUSED" });
    let linked = false;
    try { fs.symlinkSync(s.clip, path.join(s.folder, "escape.mp4"), "file"); linked = true; } catch { }
    if (linked) assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "escape.mp4"), { ok: false, code: "REFUSED" }, "a link out of the folder");
    else console.log("  (file symlinks need a privilege this account lacks; the escaping-link case runs where they don't)");
    assert.equal(ipc.openedPaths.length, 1, "nothing refused reached the system");
  } finally { s.done(); }
});

test("in test mode a bundled open is recorded instead of handed to the system", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take one.mp4"), "x");
    const ipc = shellIpc({ source: s.script, testMode: true });
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "take one.mp4"), { ok: true });
    assert.deepEqual(ipc.openedPaths, []);
    assert.deepEqual(ipc.testVideoOpens, [fs.realpathSync.native(path.join(s.folder, "take one.mp4"))]);
  } finally { s.done(); }
});

const failures = [];
for (const c of cases) {
  try {
    await c.fn();
    console.log("ok   " + c.name);
  } catch (e) {
    failures.push(c.name);
    console.log("FAIL " + c.name + "\n     " + (e && e.stack ? e.stack : e));
  }
}
console.log("\n" + (cases.length - failures.length) + "/" + cases.length + " passed");
if (failures.length) process.exitCode = 1;
