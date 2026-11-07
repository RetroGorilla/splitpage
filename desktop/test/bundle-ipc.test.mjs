import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createShellIpc } = require(path.join(here, "..", "ipc-shell.ts"));
const { createFileIpc } = require(path.join(here, "..", "ipc-files.ts"));
const { createRecents } = require(path.join(here, "..", "recents.ts"));
const { createFileRegistry, pathKey } = require(path.join(here, "..", "file-service.ts"));
const { createBundleCopier } = require(path.join(here, "..", "bundle-copy.ts"));
const { createBundleJobs } = require(path.join(here, "..", "bundle-jobs.ts"));
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
  const v2 = path.join(dir, "v2");
  fs.mkdirSync(v2);
  return {
    dir, script, clip, tool, folder: path.join(dir, "Episode 12 files"),
    copyScript: path.join(v2, "Episode 12 v2.splitpage"), copyFolder: path.join(v2, "Episode 12 v2 files"),
    done: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function trySymlink(target, at) {
  try { fs.symlinkSync(target, at, "file"); return true; } catch { return false; }
}

const NO_SYMLINKS = "  (file symlinks need a privilege this account lacks; the link case runs where they don't)";

function gate() {
  let open = () => {};
  const shut = new Promise((resolve) => { open = resolve; });
  return { shut, open };
}

function makeSender(id) {
  const sent = [];
  const sender = { id, destroyed: false, isDestroyed: () => sender.destroyed, send: (channel, payload) => { sent.push([channel, payload]); } };
  return { sender, sent };
}

function harness({ source = null, grants = [], testMode = false, holdCopy = null } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const openedPaths = [];
  const testVideoOpens = [];
  const answers = [];
  const tab = { id: "tab-a", windowId: "w1", source: source ? { kind: "file", absPath: source } : { kind: "blank" } };
  const tabs = new Map([[tab.id, tab]]);
  const videoFileGrants = new Map(grants);
  const fileIds = createFileRegistry();
  let state = { recents: [] };
  const recents = createRecents({
    store: { read: () => structuredClone(state), write: (mutator) => { state = mutator(structuredClone(state)); return Promise.resolve(true); } },
    pathKey, fileIds
  });
  recents.load();
  const real = createBundleCopier({ bundleFiles, progressEveryMs: 0 });
  const copier = holdCopy ? { ...real, copyIn: async (...args) => { await holdCopy; return real.copyIn(...args); } } : real;
  const bundleJobs = createBundleJobs({
    copier, allow: VIDEO_FILE_EXT,
    scriptOfTab: (tabId) => {
      const t = tabs.get(tabId);
      return t && t.source.kind === "file" ? t.source.absPath : null;
    },
    pathOf: (fileId) => fileIds.pathOf(fileId) || null
  });
  const tabOf = (event) => (event.tab === undefined ? (tabs.get(tab.id) || null) : event.tab);
  const { registerShellIpc } = createShellIpc({
    tabOf,
    shell: { openPath: async (p) => { openedPaths.push(p); return ""; }, openExternal: async () => {} },
    testMode, testVideoOpens, videoFileGrants, VIDEO_FILE_EXT, openableVideoPath,
    resolveBundledFile: bundleFiles.resolveBundledFile, bundleJobs
  });
  const { registerFileIpc } = createFileIpc({
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    documentsPath: () => os.tmpdir(),
    fileIds, recents, pathToTabId: new Map(), tabs,
    tabOf, dialogParentFor: () => undefined,
    consumeTestDialogAnswer: () => answers.shift(),
    testDialogsSeen: () => 0, testMode: false, bundleJobs
  });
  const register = {
    ipcHandle: (name, fn) => { handlers.set(name, fn); },
    ipcOn: (name, fn) => { listeners.set(name, fn); },
    ipcOnSync: () => {}
  };
  registerShellIpc(register);
  registerFileIpc(register);
  const main = makeSender(7);
  const as = (from, name, ...args) => handlers.get(name)({ sender: from.sender }, ...args);
  const call = (name, ...args) => as(main, name, ...args);
  const send = (name, ...args) => listeners.get(name)({ sender: main.sender }, ...args);
  const sendAs = (from, name, ...args) => listeners.get(name)({ sender: from.sender }, ...args);
  const callAs = (other, name, ...args) => handlers.get(name)({ sender: main.sender, tab: other }, ...args);
  async function saveAs(to, options = { script: true }) {
    answers.push(to);
    const picked = await call("splitpage:save-file-dialog", { suggestedName: path.basename(to), ...options });
    await call("splitpage:write-file", picked.id, new TextEncoder().encode("{}"));
    return picked;
  }
  const notes = (channel) => main.sent.filter(([c]) => c === channel).map(([, p]) => p);
  return { tab, tabs, main, call, send, sendAs, callAs, as, saveAs, notes, bundleJobs, fileIds, openedPaths, testVideoOpens, answers };
}

test("a drop is copied only from this session's grant, and only into the bundle folder of the tab's own script", async () => {
  const s = scratch();
  try {
    const ipc = harness({ source: s.script, grants: [["tok", s.clip]] });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "tok", "bundle1"), { ok: true, name: "take one.mp4" });
    assert.deepEqual(fs.readdirSync(s.folder), ["take one.mp4"]);
    const progress = ipc.notes("splitpage:bundle-progress");
    assert.ok(progress.length >= 1 && progress.every((p) => p.job === "bundle1"));
    assert.deepEqual(progress[progress.length - 1], { job: "bundle1", done: 2048, total: 2048 });
    assert.ok(progress.every((p) => Object.keys(p).sort().join() === "done,job,total"), "progress names no path");
  } finally { s.done(); }
});

test("bundling refuses a token main never gave, a tab with no script on disk, a bad job id, and a granted file that is not a video", async () => {
  const s = scratch();
  try {
    const ipc = harness({ source: s.script, grants: [["tok", s.clip], ["exe", s.tool]] });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "0".repeat(32), "bundle1"), { ok: false, code: "UNKNOWN" });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", s.clip, "bundle1"), { ok: false, code: "UNKNOWN" }, "a path is not a token");
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "tok", "../x"), { ok: false, code: "REFUSED" });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "tok", 5), { ok: false, code: "REFUSED" });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "exe", "bundle1"), { ok: false, code: "REFUSED" });
    assert.deepEqual(await ipc.callAs({ id: "tab-b", source: { kind: "blank" } }, "splitpage:bundle-file", "tok", "bundle1"), { ok: false, code: "NO_FOLDER" });
    assert.deepEqual(await ipc.callAs(null, "splitpage:bundle-file", "tok", "bundle1"), { ok: false, code: "NO_FOLDER" });
    assert.equal(fs.existsSync(s.folder), false, "nothing was written");
  } finally { s.done(); }
});

test("a granted video name whose real file is not a video is neither copied nor opened", async () => {
  const s = scratch();
  try {
    const alias = path.join(path.dirname(s.clip), "alias.mp4");
    if (!trySymlink(s.tool, alias)) { console.log(NO_SYMLINKS); return; }
    const ipc = harness({ source: s.script, grants: [["alias", alias]], testMode: true });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "alias", "bundle1"), { ok: false, code: "REFUSED" });
    assert.ok(!fs.existsSync(s.folder) || fs.readdirSync(s.folder).length === 0, "nothing was copied");
    assert.deepEqual(await ipc.call("splitpage:video-file-open", "alias"), { ok: false, code: "REFUSED" });
    assert.deepEqual(ipc.testVideoOpens, [], "nothing reached the system");
  } finally { s.done(); }
});

test("a token opens the real file its checks passed, not the name it was granted under", async () => {
  const s = scratch();
  try {
    const ipc = harness({ grants: [["tok", s.clip]], testMode: true });
    assert.deepEqual(await ipc.call("splitpage:video-file-open", "tok"), { ok: true });
    assert.deepEqual(ipc.testVideoOpens, [fs.realpathSync.native(s.clip)]);
    const folder = path.join(s.dir, "folder.mp4");
    fs.mkdirSync(folder);
    const gone = path.join(s.dir, "gone.mp4");
    const odd = harness({ grants: [["dir", folder], ["gone", gone]], testMode: true });
    assert.deepEqual(await odd.call("splitpage:video-file-open", "dir"), { ok: false, code: "REFUSED" }, "a directory is not a video file");
    assert.deepEqual(await odd.call("splitpage:video-file-open", "gone"), { ok: false, code: "GONE" });
    assert.deepEqual(odd.testVideoOpens, []);
    const alias = path.join(s.dir, "elsewhere.mp4");
    if (!trySymlink(s.clip, alias)) { console.log(NO_SYMLINKS); return; }
    const linked = harness({ grants: [["alias", alias]], testMode: true });
    assert.deepEqual(await linked.call("splitpage:video-file-open", "alias"), { ok: true });
    assert.deepEqual(linked.testVideoOpens, [fs.realpathSync.native(s.clip)]);
  } finally { s.done(); }
});

test("Cancel stops a running copy and leaves no partial file; another sender cannot cancel it", async () => {
  const s = scratch();
  try {
    const big = path.join(path.dirname(s.clip), "big.mp4");
    fs.writeFileSync(big, Buffer.alloc(32 * 1024 * 1024, 1));
    const ipc = harness({ source: s.script, grants: [["big", big], ["tok", s.clip]] });
    const kept = ipc.call("splitpage:bundle-file", "tok", "bundle1");
    ipc.sendAs(makeSender(8), "splitpage:bundle-cancel", "bundle1");
    assert.deepEqual(await kept, { ok: true, name: "take one.mp4" }, "a cancel from another tab's sender is not this job's");
    const running = ipc.call("splitpage:bundle-file", "big", "bundle9");
    ipc.send("splitpage:bundle-cancel", "bundle9");
    assert.deepEqual(await running, { ok: false, code: "CANCELLED" });
    assert.deepEqual(fs.readdirSync(s.folder), ["take one.mp4"]);
  } finally { s.done(); }
});

test("a copy queued in script A is dropped once the tab has opened an unrelated script, and never writes there", async () => {
  const s = scratch();
  try {
    const other = path.join(s.dir, "Other.splitpage");
    fs.writeFileSync(other, "{}");
    const held = gate();
    const ipc = harness({ source: s.script, grants: [["tok", s.clip]], holdCopy: held.shut });
    const first = ipc.call("splitpage:bundle-file", "tok", "bundle1");
    const second = ipc.call("splitpage:bundle-file", "tok", "bundle2");
    ipc.tab.source = { kind: "file", absPath: other };
    held.open();
    assert.deepEqual(await first, { ok: true, name: "take one.mp4" }, "the running copy finishes where it was bound");
    assert.deepEqual(await second, { ok: false, code: "DROPPED" });
    assert.equal(fs.existsSync(path.join(s.dir, "Other files")), false, "the unrelated script's folder is never made");
    assert.deepEqual(fs.readdirSync(s.folder), ["take one.mp4"]);
  } finally { s.done(); }
});

test("a copy still running when Save As lands is mirrored into the new script's folder, under a name valid there", async () => {
  const s = scratch();
  try {
    const held = gate();
    const ipc = harness({ source: s.script, grants: [["tok", s.clip]], holdCopy: held.shut });
    const running = ipc.call("splitpage:bundle-file", "tok", "bundle1");
    await ipc.saveAs(s.copyScript);
    ipc.tab.source = { kind: "file", absPath: s.copyScript };
    held.open();
    const got = await running;
    assert.equal(got.ok, true);
    assert.equal(fs.existsSync(path.join(s.folder, got.name)), true, "the copy is in the folder it was bound to");
    const there = await bundleFiles.resolveBundledFile(s.copyScript, got.name, VIDEO_FILE_EXT, fs.promises, path, process.platform === "win32");
    assert.equal(there.ok, true, "the name the renderer links resolves beside the new script");
    await ipc.bundleJobs.idle();
    const carries = ipc.notes("splitpage:bundle-carry");
    const last = carries[carries.length - 1];
    assert.deepEqual(last && last.result, { ok: true, copied: 0, kept: 1, failed: 0 });
    assert.equal(last.from, "Episode 12 files");
    assert.equal(last.to, "Episode 12 v2 files");
    assert.ok(carries.every((n) => Object.keys(n).every((k) => ["job", "from", "to", "done", "total", "result"].includes(k))), "carry notes name folders, never paths");
  } finally { s.done(); }
});

test("a copy queued while the Save As dialog is open still runs, though the tab already shows the new script", async () => {
  const s = scratch();
  try {
    const held = gate();
    const ipc = harness({ source: s.script, grants: [["tok", s.clip]], holdCopy: held.shut });
    const first = ipc.call("splitpage:bundle-file", "tok", "bundle1");
    const second = ipc.call("splitpage:bundle-file", "tok", "bundle2");
    ipc.answers.push(s.copyScript);
    await ipc.call("splitpage:save-file-dialog", { suggestedName: "Episode 12 v2.splitpage", script: true });
    ipc.tab.source = { kind: "file", absPath: s.copyScript };
    held.open();
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true, "a save in flight from the bound script is not an unrelated script");
    assert.equal(fs.existsSync(s.copyFolder), false, "nothing reaches the new folder before its file is written");
  } finally { s.done(); }
});

test("main carries the folder after Save As by itself, even once the tab and its renderer are gone", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    fs.writeFileSync(path.join(s.folder, "notes.txt"), "not a video");
    const ipc = harness({ source: s.script });
    const answered = ipc.saveAs(s.copyScript);
    ipc.main.sender.destroyed = true;
    ipc.tabs.clear();
    await answered;
    await ipc.bundleJobs.idle();
    assert.equal(fs.readFileSync(path.join(s.copyFolder, "a.mp4"), "utf8"), "aaaa");
    assert.equal(fs.existsSync(path.join(s.copyFolder, "notes.txt")), false, "only videos are carried");
    assert.deepEqual(ipc.notes("splitpage:bundle-carry"), [], "nothing is sent to a renderer that is gone");
  } finally { s.done(); }
});

test("a carry starts only from a script save dialog this tab answered, and only once", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    const plain = harness({ source: s.script });
    await plain.saveAs(s.copyScript, {});
    await plain.bundleJobs.idle();
    assert.equal(fs.existsSync(s.copyFolder), false, "an export or other non-script dialog carries nothing");
    const ipc = harness({ source: s.script });
    const id = ipc.fileIds.register(s.copyScript);
    await ipc.call("splitpage:write-file", id, new TextEncoder().encode("{}"));
    await ipc.bundleJobs.idle();
    assert.equal(fs.existsSync(s.copyFolder), false, "a file id no save dialog chose carries nothing");
    const picked = await ipc.saveAs(s.copyScript);
    await ipc.bundleJobs.idle();
    assert.equal(ipc.notes("splitpage:bundle-carry").filter((n) => n.result).length, 1);
    fs.writeFileSync(path.join(s.folder, "b.mp4"), "bbbb");
    await ipc.call("splitpage:write-file", picked.id, new TextEncoder().encode("{}"));
    await ipc.bundleJobs.idle();
    assert.equal(ipc.notes("splitpage:bundle-carry").filter((n) => n.result).length, 1, "later saves to the new file carry nothing more");
    assert.equal(fs.existsSync(path.join(s.copyFolder, "b.mp4")), false);
    const same = harness({ source: s.script });
    await same.saveAs(s.script);
    await same.bundleJobs.idle();
    assert.deepEqual(same.notes("splitpage:bundle-carry"), [], "saving onto the same script carries nothing");
    const blank = harness({});
    await blank.saveAs(s.copyScript);
    await blank.bundleJobs.idle();
    assert.deepEqual(blank.notes("splitpage:bundle-carry"), [], "a script never on disk has no folder to carry");
  } finally { s.done(); }
});

test("a bundled name opens only inside the tab's script's bundle folder, and only a regular video file", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take one.mp4"), "x");
    fs.writeFileSync(path.join(s.folder, "tool.exe"), "MZ");
    fs.mkdirSync(path.join(s.folder, "dir.mp4"));
    const ipc = harness({ source: s.script });
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
    if (trySymlink(s.clip, path.join(s.folder, "escape.mp4"))) {
      assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "escape.mp4"), { ok: false, code: "REFUSED" }, "a link out of the folder");
    } else console.log(NO_SYMLINKS);
    assert.equal(ipc.openedPaths.length, 1, "nothing refused reached the system");
  } finally { s.done(); }
});

test("in test mode a bundled open is recorded instead of handed to the system", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take one.mp4"), "x");
    const ipc = harness({ source: s.script, testMode: true });
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
