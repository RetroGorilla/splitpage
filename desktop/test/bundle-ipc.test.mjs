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
const { createCloseQuit } = require(path.join(here, "..", "close-quit.ts"));
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

function project(...names) {
  const links = names.map((name) => ({ name, size: 4, location: { kind: "bundled", name } }));
  return JSON.stringify({ title: "Episode 12", rows: [{ id: "r1", imageLinks: [...links, { name: "far.mp4", size: 4, location: { kind: "path", path: "C:\\far.mp4" } }] }] }, null, 2);
}

function markdownProject(...names) {
  return "| Visual | Audio |\n| --- | --- |\n| a | b |\n\n~~~~splitpage\n" + project(...names) + "\n~~~~\n";
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

function harness({ source = null, grants = [], testMode = false, holdCopy = null, holdCarry = null, copierOptions = {} } = {}) {
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
  const real = createBundleCopier({ bundleFiles, progressEveryMs: 0, ...copierOptions });
  const copier = {
    ...real,
    copyIn: async (...args) => { if (holdCopy) await holdCopy; return real.copyIn(...args); },
    carry: async (...args) => { if (holdCarry) await holdCarry; return real.carry(...args); }
  };
  const bundleJobs = createBundleJobs({
    copier, allow: VIDEO_FILE_EXT,
    scriptOfTab: (tabId) => {
      const t = tabs.get(tabId);
      return t && t.source.kind === "file" ? t.source.absPath : null;
    },
    pathOf: (fileId) => fileIds.pathOf(fileId) || null,
    namesInProject: bundleFiles.bundledNamesInProject
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
  async function saveAs(to, options = { script: true }, body = "{}") {
    answers.push(to);
    const picked = await call("splitpage:save-file-dialog", { suggestedName: path.basename(to), ...options });
    const written = await call("splitpage:write-file", picked.id, new TextEncoder().encode(body));
    return { ...picked, written };
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

test("a copy queued in A writes only into A's folder, and the Save As script is written only after its carry", async () => {
  const s = scratch();
  try {
    const held = gate();
    const ipc = harness({ source: s.script, grants: [["tok", s.clip]], holdCopy: held.shut });
    const copying = ipc.call("splitpage:bundle-file", "tok", "bundle1");
    const saving = ipc.saveAs(s.copyScript, { script: true }, project("take one.mp4"));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fs.existsSync(s.copyScript), false, "the script waits behind the copy and its own carry");
    assert.equal(fs.existsSync(s.copyFolder), false);
    held.open();
    assert.deepEqual(await copying, { ok: true, name: "take one.mp4" });
    const saved = await saving;
    assert.equal(saved.written.bundleRefused, undefined);
    assert.deepEqual(fs.readdirSync(s.folder), ["take one.mp4"], "the copy landed where it was accepted");
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["take one.mp4"], "the carry put it beside the new script before the script was written");
    assert.equal(fs.existsSync(s.copyScript), true);
    const progress = ipc.notes("splitpage:bundle-progress").filter((p) => p.job === "bundle1");
    assert.ok(progress.every((p) => Object.keys(p).sort().join() === "done,job,total"), "progress names no path");
  } finally { s.done(); }
});

test("an undone drop still queued in A never reaches the Save As folder", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "kept.mp4"), "kkkk");
    const other = path.join(path.dirname(s.clip), "other take.mp4");
    fs.writeFileSync(other, Buffer.alloc(1024, 7));
    const held = gate();
    const ipc = harness({ source: s.script, grants: [["other", other], ["tok", s.clip]], holdCopy: held.shut });
    const running = ipc.call("splitpage:bundle-file", "other", "bundle1");
    const queued = ipc.call("splitpage:bundle-file", "tok", "bundle2");
    assert.equal(ipc.bundleJobs.busy(), true);
    const saving = ipc.saveAs(s.copyScript, { script: true }, project("kept.mp4", "other take.mp4"));
    held.open();
    assert.deepEqual(await running, { ok: true, name: "other take.mp4" });
    assert.deepEqual(await queued, { ok: true, name: "take one.mp4" }, "the queued drop runs after the running one, still bound to A");
    await saving;
    assert.deepEqual(fs.readdirSync(s.folder).sort(), ["kept.mp4", "other take.mp4", "take one.mp4"]);
    assert.deepEqual(fs.readdirSync(s.copyFolder).sort(), ["kept.mp4", "other take.mp4"], "the undone drop, queued behind a running copy, is not carried");
  } finally { s.done(); }
});

test("a copy stalled on a lost drive is let go when cancelled, and a later Save As carry is not held behind it", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "kept.mp4"), "kkkk");
    const never = new Promise(() => {});
    const ipc = harness({ source: s.script, grants: [["tok", s.clip]], holdCopy: never });
    const stalled = ipc.call("splitpage:bundle-file", "tok", "bundle1");
    const saving = ipc.saveAs(s.copyScript, { script: true }, project("kept.mp4"));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fs.existsSync(s.copyScript), false, "the save waits while the copy runs");
    ipc.send("splitpage:bundle-cancel", "bundle1");
    assert.deepEqual(await stalled, { ok: false, code: "CANCELLED" }, "the cancel answers though the copy never does");
    const saved = await saving;
    assert.equal(saved.written.bundleRefused, undefined);
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["kept.mp4"]);
    assert.equal(fs.existsSync(s.copyScript), true, "the later save's carry and write went ahead");
    assert.equal(ipc.bundleJobs.busy(), false);
    assert.equal(fs.existsSync(path.join(s.folder, "take one.mp4")), false, "the stalled copy published nothing");
  } finally { s.done(); }
});

test("a cancelled copy stalled inside its publish never renames over a file a later carry published into that folder", async () => {
  const s = scratch();
  try {
    const stale = path.join(path.dirname(s.clip), "take.mp4");
    fs.writeFileSync(stale, "stale bytes");
    const other = path.join(s.dir, "Other.splitpage");
    fs.writeFileSync(other, "{}");
    fs.mkdirSync(path.join(s.dir, "Other files"));
    fs.writeFileSync(path.join(s.dir, "Other files", "take.mp4"), "right");
    const reached = gate();
    const released = gate();
    let stall = true;
    const ipc = harness({
      source: s.script, grants: [["tok", stale]],
      copierOptions: {
        link: async () => { throw Object.assign(new Error("no hard links here"), { code: "EPERM" }); },
        lstat: async (p) => {
          const seen = await fs.promises.lstat(p).then((st) => ({ st }), (error) => ({ error }));
          if (stall && path.basename(p) === "take.mp4") {
            assert.equal(seen.error && seen.error.code, "ENOENT", "setup: the stale job's check finds the name free");
            stall = false;
            reached.open();
            await released.shut;
          }
          if (seen.error) throw seen.error;
          return seen.st;
        }
      }
    });
    const copying = ipc.call("splitpage:bundle-file", "tok", "bundle1");
    await reached.shut;
    ipc.send("splitpage:bundle-cancel", "bundle1");
    assert.deepEqual(await copying, { ok: false, code: "CANCELLED" });
    ipc.tab.source = { kind: "file", absPath: other };
    const saving = ipc.saveAs(path.join(s.dir, "Episode 12.md"), { script: true }, markdownProject("take.mp4"));
    await new Promise((r) => setTimeout(r, 30));
    released.open();
    const saved = await saving;
    assert.equal(saved.written.bundleRefused, undefined, JSON.stringify(saved.written));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fs.readFileSync(path.join(s.folder, "take.mp4"), "utf8"), "right", "the saved script's video is the one the carry published");
    assert.deepEqual(fs.readdirSync(s.folder), ["take.mp4"], "the stale job removed its temporary and published nothing");
  } finally { s.done(); }
});

test("a carry cancelled during its second file reports the one it already copied", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    fs.writeFileSync(path.join(s.folder, "big.mp4"), Buffer.alloc(32 * 1024 * 1024, 4));
    let ipc = null;
    let links = 0;
    ipc = harness({
      source: s.script,
      copierOptions: {
        link: async (from, to) => {
          await fs.promises.link(from, to);
          if (++links === 1) setTimeout(() => ipc.send("splitpage:bundle-cancel", "carry1"), 0);
        }
      }
    });
    const refused = await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4", "big.mp4"));
    assert.equal(refused.written.bundleRefused && refused.written.bundleRefused.reason, "cancelled");
    assert.equal(refused.written.bundleRefused.copied, 1, "the first file was published before the cancel");
    assert.equal(fs.existsSync(s.copyScript), false);
    assert.ok(await until(() => fs.readdirSync(s.copyFolder).length === 1), "the stopped copy removes its temporary: " + fs.readdirSync(s.copyFolder));
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["a.mp4"]);
  } finally { s.done(); }
});

test("a carry cancelled while it removes the temporary of a file it just published counts that file", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    let ipc = null;
    let first = true;
    ipc = harness({
      source: s.script,
      copierOptions: {
        unlink: async (p) => {
          if (first && /\.part$/.test(p)) {
            first = false;
            ipc.send("splitpage:bundle-cancel", "carry1");
            await new Promise((r) => setTimeout(r, 30));
          }
          return fs.promises.unlink(p);
        }
      }
    });
    const refused = await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4"));
    assert.equal(refused.written.bundleRefused && refused.written.bundleRefused.reason, "cancelled", JSON.stringify(refused.written));
    assert.equal(refused.written.bundleRefused.copied, 1, "the file was published before the cancel");
    assert.equal(fs.existsSync(s.copyScript), false);
    assert.ok(await until(() => fs.readdirSync(s.copyFolder).length === 1));
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["a.mp4"]);
  } finally { s.done(); }
});

test("back-to-back Save As, A to B then B to C before B's carry lands, checks C for clashes and writes no C", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take.mp4"), "mine");
    const b = s.copyScript;
    const c = path.join(s.dir, "elsewhere", "C.splitpage");
    fs.mkdirSync(path.join(s.dir, "elsewhere", "C files"), { recursive: true });
    fs.writeFileSync(path.join(s.dir, "elsewhere", "C files", "take.mp4"), "theirs");
    const held = gate();
    const ipc = harness({ source: s.script, holdCarry: held.shut });
    ipc.answers.push(b);
    const toB = await ipc.call("splitpage:save-file-dialog", { suggestedName: "Episode 12 v2.splitpage", script: true });
    const wroteB = ipc.call("splitpage:write-file", toB.id, new TextEncoder().encode(project("take.mp4")));
    ipc.tab.source = { kind: "file", absPath: b };
    ipc.answers.push(c);
    const toC = await ipc.call("splitpage:save-file-dialog", { suggestedName: "C.splitpage", script: true });
    const wroteC = ipc.call("splitpage:write-file", toC.id, new TextEncoder().encode(project("take.mp4")));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fs.existsSync(b), false, "B is written only after its carry");
    held.open();
    assert.equal((await wroteB).bundleRefused, undefined);
    assert.deepEqual(await wroteC, { size: 0, bundleRefused: { reason: "clash", folder: "C files", name: "take.mp4", copied: 0 } });
    assert.equal(fs.readFileSync(path.join(s.copyFolder, "take.mp4"), "utf8"), "mine");
    assert.equal(fs.existsSync(c), false, "C's script is not written, so nothing links C's unrelated file");
    assert.equal(fs.readFileSync(path.join(s.dir, "elsewhere", "C files", "take.mp4"), "utf8"), "theirs");
  } finally { s.done(); }
});

test("a carry that cannot copy a file fails the save before the script is written, and what it copied stays", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    fs.writeFileSync(path.join(s.folder, "b.mp4"), "bbbb");
    let links = 0;
    const no = Object.assign(new Error("no"), { code: "EIO" });
    const ipc = harness({ source: s.script, copierOptions: { link: async (from, to) => { if (++links > 1) throw no; return fs.promises.link(from, to); }, rename: async () => { throw no; } } });
    const refused = await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4", "b.mp4"));
    assert.deepEqual(refused.written, { size: 0, bundleRefused: { reason: "failed", folder: "Episode 12 v2 files", name: "b.mp4", copied: 1 } },
      "the refusal says how many files it already copied");
    assert.equal(fs.existsSync(s.copyScript), false);
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["a.mp4"], "nothing is deleted, and no temporary is left");
  } finally { s.done(); }
});

test("main carries what the written bytes link, by itself, even once the tab and its renderer are gone", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    fs.writeFileSync(path.join(s.folder, "b.mp4"), "bbbb");
    fs.writeFileSync(path.join(s.folder, "notes.txt"), "not a video");
    const ipc = harness({ source: s.script });
    const answered = ipc.saveAs(s.copyScript, { script: true }, project("a.mp4", "notes.txt", "..\\b.mp4"));
    ipc.main.sender.destroyed = true;
    ipc.tabs.clear();
    await answered;
    await ipc.bundleJobs.idle();
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["a.mp4"], "only the linked video is carried, and no name outside the folder resolves");
    assert.equal(fs.readFileSync(path.join(s.copyFolder, "a.mp4"), "utf8"), "aaaa");
    assert.deepEqual(ipc.notes("splitpage:bundle-carry"), [], "nothing is sent to a renderer that is gone");
  } finally { s.done(); }
});

test("a dropped copy the script no longer links is never carried on to a shared folder, nor from there onwards", async () => {
  const s = scratch();
  try {
    const ipc = harness({ source: s.script, grants: [["tok", s.clip]] });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "tok", "bundle1"), { ok: true, name: "take one.mp4" });
    fs.writeFileSync(path.join(s.folder, "kept.mp4"), "kkkk");
    const shared = path.join(s.dir, "shared");
    fs.mkdirSync(shared);
    const b = path.join(shared, "B.md");
    await ipc.saveAs(b, { script: true }, markdownProject("kept.mp4"));
    await ipc.bundleJobs.idle();
    assert.deepEqual(fs.readdirSync(path.join(shared, "B files")), ["kept.mp4"], "the undone drop stays private to the folder it was copied into");
    ipc.tab.source = { kind: "file", absPath: b };
    const c = path.join(shared, "C.splitpage");
    await ipc.saveAs(c, { script: true }, project("kept.mp4"));
    await ipc.bundleJobs.idle();
    assert.deepEqual(fs.readdirSync(path.join(shared, "C files")), ["kept.mp4"]);
  } finally { s.done(); }
});

test("a linked name already taken by different bytes in the new folder fails the save before anything is written", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take.mp4"), "mine");
    fs.mkdirSync(s.copyFolder);
    fs.writeFileSync(path.join(s.copyFolder, "take.mp4"), "theirs");
    fs.writeFileSync(path.join(s.copyFolder, "same.mp4"), "same");
    fs.writeFileSync(path.join(s.folder, "same.mp4"), "same");
    const ipc = harness({ source: s.script });
    const refused = await ipc.saveAs(s.copyScript, { script: true }, project("same.mp4", "take.mp4"));
    assert.deepEqual(refused.written, { size: 0, bundleRefused: { reason: "clash", folder: "Episode 12 v2 files", name: "take.mp4", copied: 0 } });
    assert.equal(fs.existsSync(s.copyScript), false, "the script was not written");
    assert.equal(fs.readFileSync(path.join(s.copyFolder, "take.mp4"), "utf8"), "theirs", "the other file is untouched");
    await ipc.bundleJobs.idle();
    assert.deepEqual(fs.readdirSync(s.copyFolder).sort(), ["same.mp4", "take.mp4"], "a refused save copies nothing");
    fs.renameSync(path.join(s.copyFolder, "take.mp4"), path.join(s.copyFolder, "their take.mp4"));
    const saved = await ipc.saveAs(s.copyScript, { script: true }, project("same.mp4", "take.mp4"));
    assert.equal(saved.written.bundleRefused, undefined);
    assert.equal(fs.existsSync(s.copyScript), true);
    await ipc.bundleJobs.idle();
    const last = ipc.notes("splitpage:bundle-carry").pop();
    assert.deepEqual(last && last.result, { ok: true, copied: 1, kept: 1, missing: 0 }, "identical bytes are no conflict, and are kept");
    const testing = harness({ source: s.copyScript, testMode: true });
    assert.deepEqual(await testing.call("splitpage:bundled-file-open", "take.mp4"), { ok: true });
    assert.equal(fs.readFileSync(testing.testVideoOpens[0], "utf8"), "mine", "the saved link reopens this script's own video");
  } finally { s.done(); }
});

test("a carry starts only from a script save dialog this tab answered, and only once", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    const plain = harness({ source: s.script });
    await plain.saveAs(s.copyScript, {}, project("a.mp4"));
    await plain.bundleJobs.idle();
    assert.equal(fs.existsSync(s.copyFolder), false, "an export or other non-script dialog carries nothing");
    const ipc = harness({ source: s.script });
    const id = ipc.fileIds.register(s.copyScript);
    await ipc.call("splitpage:write-file", id, new TextEncoder().encode(project("a.mp4")));
    await ipc.bundleJobs.idle();
    assert.equal(fs.existsSync(s.copyFolder), false, "a file id no save dialog chose carries nothing");
    const picked = await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4"));
    await ipc.bundleJobs.idle();
    assert.equal(ipc.notes("splitpage:bundle-carry").filter((n) => n.result).length, 1);
    fs.writeFileSync(path.join(s.folder, "b.mp4"), "bbbb");
    await ipc.call("splitpage:write-file", picked.id, new TextEncoder().encode(project("a.mp4", "b.mp4")));
    await ipc.bundleJobs.idle();
    assert.equal(ipc.notes("splitpage:bundle-carry").filter((n) => n.result).length, 1, "later saves to the new file carry nothing more");
    assert.equal(fs.existsSync(path.join(s.copyFolder, "b.mp4")), false);
    const same = harness({ source: s.script });
    await same.saveAs(s.script, { script: true }, project("a.mp4"));
    await same.bundleJobs.idle();
    assert.deepEqual(same.notes("splitpage:bundle-carry"), [], "saving onto the same script carries nothing");
    const blank = harness({});
    await blank.saveAs(s.copyScript, { script: true }, project("a.mp4"));
    await blank.bundleJobs.idle();
    assert.deepEqual(blank.notes("splitpage:bundle-carry"), [], "a script never on disk has no folder to carry");
    const carries = ipc.notes("splitpage:bundle-carry");
    assert.ok(carries.every((n) => Object.keys(n).every((k) => ["job", "from", "to", "done", "total", "result"].includes(k))), "carry notes name folders, never paths");
    assert.equal(carries[0].from, "Episode 12 files");
    assert.equal(carries[0].to, "Episode 12 v2 files");
  } finally { s.done(); }
});

test("quitting can wait for the copies or stop them; a stopped copy leaves nothing under its final name", async () => {
  const s = scratch();
  try {
    const big = path.join(path.dirname(s.clip), "big.mp4");
    fs.writeFileSync(big, Buffer.alloc(32 * 1024 * 1024, 1));
    const ipc = harness({ source: s.script, grants: [["big", big], ["tok", s.clip]] });
    assert.equal(ipc.bundleJobs.busy(), false);
    const waited = ipc.call("splitpage:bundle-file", "tok", "bundle1");
    assert.equal(ipc.bundleJobs.busy(), true);
    await ipc.bundleJobs.idle();
    assert.deepEqual(await waited, { ok: true, name: "take one.mp4" });
    const stopped = ipc.call("splitpage:bundle-file", "big", "bundle2");
    const queued = ipc.call("splitpage:bundle-file", "big", "bundle3");
    await ipc.bundleJobs.abortAll();
    assert.equal(ipc.bundleJobs.busy(), false);
    assert.deepEqual(await stopped, { ok: false, code: "CANCELLED" });
    assert.deepEqual(await queued, { ok: false, code: "CANCELLED" });
    assert.deepEqual(fs.readdirSync(s.folder), ["take one.mp4"], "no partial file and no temporary is left behind");
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

function quitWorld(bundleJobs, picks) {
  const answers = picks.filter((p) => typeof p === "string");
  const clicks = picks.filter((p) => typeof p === "number");
  const on = new Map();
  const asked = [];
  const quits = [];
  const closes = [];
  const prevented = [];
  const winOn = new Map();
  const win = { isDestroyed: () => false, on: (ev, fn) => { winOn.set(ev, fn); }, close: () => { closes.push(1); fire(winOn, "close"); } };
  function fire(handlers, ev) {
    const event = { prevented: false, preventDefault() { event.prevented = true; } };
    handlers.get(ev)(event);
    prevented.push([ev, event.prevented]);
    return event;
  }
  const app = { on: (ev, fn) => { on.set(ev, fn); }, quit: () => { quits.push(1); fire(on, "before-quit"); } };
  const { registerQuitHandlers, attachWindowClose } = createCloseQuit({
    app, testMode: false, tabs: new Map(), windowsById: new Map(), liveWindows: () => [{ win }],
    tabHasFile: () => false, tabIsUnsaved: () => false, draftsHasDraft: () => false,
    requestDraftFlush: async () => ({}), draftFlushBudgetMs: 10, draftStore: () => null, draftsList: () => [],
    draftsDiscardForUserDecision: () => {}, draftsDiscardClean: () => {}, consumeTestDialogAnswer: () => answers.shift(),
    activateTab: () => {}, focusWindow: () => {}, destroyTabView: () => {}, startInstallerNow: () => ({ ok: true }),
    prompterShare: () => null, voiceHelper: () => null, bundleCopies: () => bundleJobs,
    dialog: { showMessageBoxSync: (_parent, options) => { asked.push(options); return clicks.length ? clicks.shift() : 0; } }
  });
  registerQuitHandlers();
  attachWindowClose(win, { id: "w1", tabIds: [] });
  return { asked, quits, closes, prevented, quit: () => fire(on, "before-quit"), close: () => fire(winOn, "close"), willQuit: () => on.get("will-quit")() };
}

const until = async (fn) => {
  for (let i = 0; i < 500 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  return fn();
};

test("quitting while copies run asks first: Wait finishes them and then quits, Quit anyway stops them and leaves nothing half-copied", async () => {
  const s = scratch();
  try {
    const big = path.join(path.dirname(s.clip), "big.mp4");
    fs.writeFileSync(big, Buffer.alloc(32 * 1024 * 1024, 1));
    const ipc = harness({ source: s.script, grants: [["big", big], ["tok", s.clip]] });
    const idle = quitWorld(ipc.bundleJobs, []);
    assert.equal(idle.quit().prevented, false, "with nothing copying, quitting asks nothing about copies");
    assert.deepEqual(idle.asked, []);

    const waiting = quitWorld(ipc.bundleJobs, [0]);
    const copying = ipc.call("splitpage:bundle-file", "big", "bundle1");
    assert.equal(waiting.quit().prevented, true, "the quit waits for an answer");
    assert.deepEqual(waiting.asked.map((o) => [o.title, o.message, o.buttons, o.defaultId, o.cancelId]),
      [["Splitpage", "Splitpage is still copying files.", ["Wait", "Quit anyway"], 0, 0]]);
    assert.equal(waiting.asked[0].detail, "Wait lets the copies finish, then quits. Quit anyway stops them: nothing half-copied is left behind, " +
      "and a video not copied yet still links to where it is.");
    assert.equal(waiting.quit().prevented, true, "a second quit while waiting is held, not asked again");
    assert.equal(waiting.asked.length, 1);
    assert.deepEqual(await copying, { ok: true, name: "big.mp4" }, "Wait lets the copy finish");
    assert.ok(await until(() => waiting.quits.length === 1), "then the app quits by itself");
    assert.deepEqual(fs.readdirSync(s.folder), ["big.mp4"]);

    fs.rmSync(path.join(s.folder, "big.mp4"));
    const stopping = quitWorld(ipc.bundleJobs, [1]);
    const stopped = ipc.call("splitpage:bundle-file", "big", "bundle2");
    const queued = ipc.call("splitpage:bundle-file", "tok", "bundle3");
    assert.equal(stopping.quit().prevented, true);
    assert.deepEqual(await stopped, { ok: false, code: "CANCELLED" });
    assert.deepEqual(await queued, { ok: false, code: "CANCELLED" });
    assert.ok(await until(() => stopping.quits.length === 1));
    assert.deepEqual(fs.readdirSync(s.folder), [], "no partial file and no temporary is left behind");
    assert.equal(ipc.bundleJobs.busy(), false);
  } finally { s.done(); }
});

test("closing the last window while copies run asks the same question, and the test answer can choose either button", async () => {
  const s = scratch();
  try {
    const big = path.join(path.dirname(s.clip), "big.mp4");
    fs.writeFileSync(big, Buffer.alloc(32 * 1024 * 1024, 1));
    const ipc = harness({ source: s.script, grants: [["big", big]] });
    const w = quitWorld(ipc.bundleJobs, ["wait"]);
    const copying = ipc.call("splitpage:bundle-file", "big", "bundle1");
    assert.equal(w.close().prevented, true);
    assert.deepEqual(w.asked, [], "a test answer stands in for the dialog");
    assert.deepEqual(await copying, { ok: true, name: "big.mp4" });
    assert.ok(await until(() => w.closes.length === 1), "the window closes once the copies are done");
    assert.deepEqual(w.prevented[w.prevented.length - 1], ["close", false]);
    fs.rmSync(path.join(s.folder, "big.mp4"));
    const q = quitWorld(ipc.bundleJobs, ["quit-anyway"]);
    const stopped = ipc.call("splitpage:bundle-file", "big", "bundle2");
    assert.equal(q.close().prevented, true);
    assert.deepEqual(await stopped, { ok: false, code: "CANCELLED" });
    assert.ok(await until(() => q.closes.length === 1));
    assert.deepEqual(fs.readdirSync(s.folder), []);
    const late = ipc.call("splitpage:bundle-file", "big", "bundle3");
    q.willQuit();
    assert.deepEqual(await late, { ok: false, code: "CANCELLED" }, "a copy still running when the app goes is stopped");
    assert.deepEqual(fs.readdirSync(s.folder), []);
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
