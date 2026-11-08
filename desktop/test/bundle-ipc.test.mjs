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
const { ATTACHABLE_FILE, openableVideoPath } = bundleFiles;

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

function relinked(text, links) {
  const to = new Map(links.map((l) => [l.name, l.path]));
  const swap = (v) => {
    if (!v || typeof v !== "object") return;
    if (v.location && v.location.kind === "bundled" && to.has(v.location.name)) v.location = { kind: "path", path: to.get(v.location.name) };
    Object.values(v).forEach(swap);
  };
  const block = /^([\s\S]*?~{4}splitpage\n)([\s\S]*?)(\n~{4}\n?)$/.exec(text);
  const record = JSON.parse(block ? block[2] : text);
  swap(record);
  const json = JSON.stringify(record, null, 2);
  return block ? block[1] + json + block[3] : json;
}

function junction(target, at) {
  try { fs.symlinkSync(target, at, "junction"); return true; } catch { return false; }
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

const SHARE = process.platform === "win32" ? "\\\\nas\\share\\" : "//nas/share/";

function harness({ source = null, grants = [], testMode = false, holdCopy = null, holdCarry = null, copierOptions = {}, shareOf = null, quitGraceMs } = {}) {
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
  let carriesEnded = 0;
  const copier = {
    ...real,
    copyIn: async (...args) => { if (holdCopy) await holdCopy; return real.copyIn(...args); },
    carry: async (...args) => {
      if (holdCarry) await holdCarry;
      try { return await real.carry(...args); } finally { carriesEnded++; }
    },
    resolveIn: (script, name, allow) => real.resolveIn(shareOf && script.startsWith(SHARE) ? path.join(shareOf, script.slice(SHARE.length)) : script, name, allow)
  };
  const bundleJobs = createBundleJobs({
    copier, allow: ATTACHABLE_FILE,
    scriptOfTab: (tabId) => {
      const t = tabs.get(tabId);
      return t && t.source.kind === "file" ? t.source.absPath : null;
    },
    pathOf: (fileId) => fileIds.pathOf(fileId) || null,
    namesInProject: bundleFiles.bundledNamesInProject, quitGraceMs
  });
  const tabOf = (event) => (event.tab === undefined ? (tabs.get(tab.id) || null) : event.tab);
  const { registerShellIpc } = createShellIpc({
    tabOf,
    shell: { openPath: async (p) => { openedPaths.push(p); return ""; }, openExternal: async () => {} },
    testMode, testVideoOpens, videoFileGrants, ATTACHABLE_FILE, openableVideoPath,
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
  async function saveAs(to, options = { script: true }, body = "{}", choice = null) {
    answers.push(to);
    const picked = await call("splitpage:save-file-dialog", { suggestedName: path.basename(to), ...options });
    const plan = choice ? await call("splitpage:bundle-save-plan", picked.id, bundleFiles.bundledNamesInProject(body)) : null;
    const chosen = choice ? await call("splitpage:bundle-save-choice", picked.id, choice) : null;
    const bytes = chosen && chosen.ok && chosen.links.length ? relinked(body, chosen.links) : body;
    const written = await call("splitpage:write-file", picked.id, new TextEncoder().encode(bytes));
    return { ...picked, plan, chosen, written };
  }
  const notes = (channel) => main.sent.filter(([c]) => c === channel).map(([, p]) => p);
  const moveTab = (to) => {
    tab.source = { kind: "file", absPath: to };
    bundleJobs.noteScript(tab.id, to);
  };
  return {
    tab, tabs, main, call, send, sendAs, callAs, as, saveAs, notes, moveTab, bundleJobs, fileIds, openedPaths, testVideoOpens, answers, videoFileGrants,
    carriesEnded: () => carriesEnded
  };
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

test("a copy queued in A writes only into A's folder, and the Save As script is written only after its carry's checks", async () => {
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
    await ipc.bundleJobs.idle();
    assert.deepEqual(fs.readdirSync(s.folder), ["take one.mp4"], "the copy landed where it was accepted");
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["take one.mp4"], "the carry put it beside the new script once the script was written");
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
    await ipc.bundleJobs.idle();
    assert.deepEqual(fs.readdirSync(s.folder).sort(), ["kept.mp4", "other take.mp4", "take one.mp4"]);
    assert.deepEqual(fs.readdirSync(s.copyFolder).sort(), ["kept.mp4", "other take.mp4"], "the undone drop, queued behind a running copy, is not carried");
  } finally { s.done(); }
});

test("a cancelled copy holds the queue until it settles, so a later Save As carry runs only after it", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "kept.mp4"), "kkkk");
    const held = gate();
    const ipc = harness({ source: s.script, grants: [["tok", s.clip]], holdCopy: held.shut });
    let answered = false;
    const stalled = ipc.call("splitpage:bundle-file", "tok", "bundle1").then((r) => { answered = true; return r; });
    const saving = ipc.saveAs(s.copyScript, { script: true }, project("kept.mp4"));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fs.existsSync(s.copyScript), false, "the save waits while the copy runs");
    ipc.send("splitpage:bundle-cancel", "bundle1");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(answered, false, "Cancel signals the copy and waits for it");
    assert.equal(fs.existsSync(s.copyScript), false, "the later carry has not started");
    held.open();
    assert.deepEqual(await stalled, { ok: false, code: "CANCELLED" }, "the copy answers once it has settled");
    const saved = await saving;
    assert.equal(saved.written.bundleRefused, undefined);
    await ipc.bundleJobs.idle();
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["kept.mp4"]);
    assert.equal(fs.existsSync(s.copyScript), true, "the later save's carry and write went ahead");
    assert.equal(ipc.bundleJobs.busy(), false);
    assert.equal(fs.existsSync(path.join(s.folder, "take one.mp4")), false, "the stalled copy published nothing");
  } finally { s.done(); }
});

test("Quit anyway is not held open by a copy stalled on a lost drive", async () => {
  const s = scratch();
  try {
    const ipc = harness({ source: s.script, grants: [["tok", s.clip]], holdCopy: new Promise(() => {}) });
    void ipc.call("splitpage:bundle-file", "tok", "bundle1");
    assert.equal(ipc.bundleJobs.busy(), true);
    const started = Date.now();
    await ipc.bundleJobs.abortAll(50);
    assert.ok(Date.now() - started < 2000, "the quit goes ahead after its grace");
  } finally { s.done(); }
});

test("a cancelled copy stalled inside its publish settles before a later carry publishes into that folder, and never replaces its file", async () => {
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
        openTarget: async (p) => {
          if (stall && path.basename(p) === "take.mp4") {
            assert.equal(fs.existsSync(p), false, "setup: the stale job reaches its create while the name is free");
            stall = false;
            reached.open();
            await released.shut;
          }
          return fs.promises.open(p, "wx");
        }
      }
    });
    const copying = ipc.call("splitpage:bundle-file", "tok", "bundle1");
    await reached.shut;
    ipc.send("splitpage:bundle-cancel", "bundle1");
    ipc.tab.source = { kind: "file", absPath: other };
    const saving = ipc.saveAs(path.join(s.dir, "Episode 12.md"), { script: true }, markdownProject("take.mp4"));
    await new Promise((r) => setTimeout(r, 30));
    released.open();
    assert.deepEqual(await copying, { ok: false, code: "CANCELLED" });
    const saved = await saving;
    assert.equal(saved.written.bundleRefused, undefined, JSON.stringify(saved.written));
    await ipc.bundleJobs.idle();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fs.readFileSync(path.join(s.folder, "take.mp4"), "utf8"), "right", "the saved script's video is the one the carry published");
    assert.deepEqual(fs.readdirSync(s.folder), ["take.mp4"], "the stale job removed its temporary and published nothing");
  } finally { s.done(); }
});

test("a background copy cancelled during its second file keeps the one it already copied and counts the one left", async () => {
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
    const saved = await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4", "big.mp4"));
    assert.equal(saved.written.bundleRefused, undefined, "the script is written before the bulk copy");
    assert.equal(fs.existsSync(s.copyScript), true);
    await ipc.bundleJobs.idle();
    const last = ipc.notes("splitpage:bundle-carry").pop();
    assert.deepEqual(last.result, { ok: false, code: "CANCELLED", name: "", copied: 1, left: 1 }, "the first file was published before the cancel");
    assert.ok(await until(() => fs.readdirSync(s.copyFolder).length === 1), "the stopped copy removes its temporary: " + fs.readdirSync(s.copyFolder));
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["a.mp4"]);
    assert.deepEqual(fs.readdirSync(s.folder).sort(), ["a.mp4", "big.mp4"], "nothing is deleted from the old folder");
  } finally { s.done(); }
});

test("a background copy cancelled while it removes the temporary of a file it just published counts that file", async () => {
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
    const saved = await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4"));
    assert.equal(saved.written.bundleRefused, undefined, JSON.stringify(saved.written));
    assert.equal(fs.existsSync(s.copyScript), true);
    await ipc.bundleJobs.idle();
    assert.deepEqual(ipc.notes("splitpage:bundle-carry").pop().result, { ok: false, code: "CANCELLED", name: "", copied: 1, left: 0 },
      "the file was published before the cancel");
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

test("a background copy that cannot copy a file keeps the script and what it copied, and counts what is left", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    fs.writeFileSync(path.join(s.folder, "b.mp4"), "bbbb");
    let links = 0;
    const no = Object.assign(new Error("no"), { code: "EIO" });
    const ipc = harness({ source: s.script, copierOptions: { link: async (from, to) => { if (++links > 1) throw no; return fs.promises.link(from, to); }, openTarget: async () => { throw no; } } });
    const saved = await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4", "b.mp4"));
    assert.equal(saved.written.bundleRefused, undefined);
    assert.equal(fs.existsSync(s.copyScript), true, "the script was written first");
    await ipc.bundleJobs.idle();
    assert.deepEqual(ipc.notes("splitpage:bundle-carry").pop().result, { ok: false, code: "FAILED", name: "b.mp4", copied: 1, left: 1 },
      "the note says how many files are left");
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["a.mp4"], "nothing is deleted, and no temporary is left");
    assert.deepEqual(fs.readdirSync(s.folder).sort(), ["a.mp4", "b.mp4"]);
  } finally { s.done(); }
});

test("main carries what the written bytes link, by itself, even once the tab and its renderer are gone", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    fs.writeFileSync(path.join(s.folder, "b.mp4"), "bbbb");
    fs.writeFileSync(path.join(s.folder, "notes.txt"), "a document");
    fs.writeFileSync(path.join(s.folder, "planted.exe"), "MZ");
    const first = harness({ source: s.script });
    const blocked = await first.saveAs(s.copyScript, { script: true }, project("a.mp4", "notes.txt", "planted.exe", "..\\b.mp4"));
    assert.deepEqual(blocked.written, { size: 0, bundleRefused: { reason: "missing", folder: "Episode 12 files", name: "..\\b.mp4", copied: 0, count: 2 } },
      "a program or a name outside the folder never resolves, so the save stops before anything is written");
    assert.equal(fs.existsSync(s.copyScript), false);
    assert.equal(fs.existsSync(s.copyFolder), false, "and nothing is copied");
    const ipc = harness({ source: s.script });
    const answered = ipc.saveAs(s.copyScript, { script: true }, project("a.mp4", "notes.txt"));
    ipc.main.sender.destroyed = true;
    ipc.tabs.clear();
    await answered;
    await ipc.bundleJobs.idle();
    assert.deepEqual(fs.readdirSync(s.copyFolder).sort(), ["a.mp4", "notes.txt"], "a linked video and a linked document are carried (#256)");
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
    assert.ok(carries.every((n) => Object.keys(n).every((k) => ["job", "from", "to", "done", "total", "waiting", "result"].includes(k))), "carry notes name folders, never paths");
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

function quitWorld(bundleJobs, picks, { unsaved = false } = {}) {
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
  const tab = { id: "t1", windowId: "w1", title: "Draft", dirty: true, view: { webContents: { isDestroyed: () => false } } };
  const rec = { id: "w1", win, tabIds: unsaved ? ["t1"] : [] };
  const { registerQuitHandlers, attachWindowClose } = createCloseQuit({
    app, testMode: false, tabs: new Map(unsaved ? [["t1", tab]] : []), windowsById: new Map(unsaved ? [["w1", rec]] : []), liveWindows: () => [{ win }],
    tabHasFile: () => false, tabIsUnsaved: (t) => unsaved && t === tab, draftsHasDraft: () => false,
    requestDraftFlush: async () => ({}), draftFlushBudgetMs: 10, draftStore: () => null, draftsList: () => [],
    draftsDiscardForUserDecision: () => {}, draftsDiscardClean: () => {}, consumeTestDialogAnswer: () => answers.shift(),
    activateTab: () => {}, focusWindow: () => {}, destroyTabView: () => {}, startInstallerNow: () => ({ ok: true }),
    prompterShare: () => null, voiceHelper: () => null, bundleCopies: () => bundleJobs,
    dialog: { showMessageBoxSync: (_parent, options) => { asked.push(options); return clicks.length ? clicks.shift() : 0; } }
  });
  registerQuitHandlers();
  attachWindowClose(win, rec);
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
    assert.equal(waiting.asked[0].detail,
      "Wait finishes the copies, then quits. Quit anyway stops copying. Completed copies stay; some files may not open from the saved script.");
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

test("Quit anyway is final: a copy still stalled after the grace does not ask again, and the app quits", async () => {
  const s = scratch();
  try {
    const ipc = harness({ source: s.script, grants: [["tok", s.clip]], holdCopy: new Promise(() => {}), quitGraceMs: 30 });
    const q = quitWorld(ipc.bundleJobs, [1]);
    void ipc.call("splitpage:bundle-file", "tok", "bundle1");
    assert.equal(q.quit().prevented, true, "the quit asks first");
    assert.ok(await until(() => q.quits.length === 1), "the app quits after the grace");
    assert.equal(ipc.bundleJobs.busy(), true, "setup: the stalled copy has still not settled");
    assert.equal(q.asked.length, 1, "Quit anyway is not asked again");
    assert.deepEqual(q.prevented[q.prevented.length - 1], ["before-quit", false], "the resumed quit goes through");
  } finally { s.done(); }
});

test("a Quit anyway whose unsaved-changes question is cancelled does not carry over: a later quit asks about new copies again", async () => {
  const s = scratch();
  try {
    let current = gate();
    const hold = { then: (resolve, reject) => current.shut.then(resolve, reject) };
    const ipc = harness({ source: s.script, grants: [["tok", s.clip]], holdCopy: hold, quitGraceMs: 30 });
    const q = quitWorld(ipc.bundleJobs, ["quit-anyway", "cancel"], { unsaved: true });
    const first = ipc.call("splitpage:bundle-file", "tok", "bundle1");
    assert.equal(q.quit().prevented, true, "the quit asks about the copy");
    assert.ok(await until(() => q.quits.length === 1), "Quit anyway resumes the quit");
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(q.prevented[q.prevented.length - 1], ["before-quit", true], "setup: the unsaved-changes question was cancelled, so the app stays");
    current.open();
    assert.deepEqual(await first, { ok: false, code: "CANCELLED" });
    await ipc.bundleJobs.idle();
    current = gate();
    void ipc.call("splitpage:bundle-file", "tok", "bundle2");
    assert.equal(ipc.bundleJobs.busy(), true);
    assert.equal(q.quit().prevented, true, "the later quit is held");
    assert.deepEqual(q.asked.map((o) => o.message), ["Splitpage is still copying files."], "and asks about the new copy");
    current.open();
  } finally { s.done(); }
});

test("a Save As carry queued behind a stalled copy is announced at once, and Cancel on it refuses the save straight away", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "kept.mp4"), "kkkk");
    const held = gate();
    const ipc = harness({ source: s.script, grants: [["tok", s.clip]], holdCopy: held.shut });
    const stalled = ipc.call("splitpage:bundle-file", "tok", "bundle1");
    const saving = ipc.saveAs(s.copyScript, { script: true }, project("kept.mp4"), "copy");
    assert.ok(await until(() => ipc.notes("splitpage:bundle-carry").length > 0), "the carry is announced while it waits");
    assert.deepEqual(ipc.notes("splitpage:bundle-carry"),
      [{ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 0, total: 1, waiting: true }]);
    ipc.send("splitpage:bundle-cancel", "carry1");
    const saved = await saving;
    assert.deepEqual(saved.written, { size: 0, bundleRefused: { reason: "cancelled", folder: "Episode 12 v2 files", name: "", copied: 0 } });
    assert.deepEqual(ipc.notes("splitpage:bundle-carry").pop().result, { ok: false, code: "CANCELLED", name: "", copied: 0 }, "the renderer hears it ended");
    assert.equal(ipc.bundleJobs.busy(), true, "the stalled copy still holds the queue");
    held.open();
    assert.deepEqual(await stalled, { ok: true, name: "take one.mp4" });
    await ipc.bundleJobs.idle();
    assert.equal(ipc.carriesEnded(), 0, "the cancelled carry never ran");
    assert.equal(fs.existsSync(s.copyScript), false);
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

function linksIn(file) {
  const out = {};
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (v.location && typeof v.name === "string") out[v.name] = v.location;
    Object.values(v).forEach(walk);
  };
  const text = fs.readFileSync(file, "utf8");
  let record;
  try { record = JSON.parse(text); } catch { record = JSON.parse(/~{4,}splitpage\n([\s\S]*?)\n~{4,}\n?$/.exec(text)[1]); }
  walk(record);
  return out;
}

function heldLink() {
  const held = gate();
  let first = true;
  return {
    held,
    link: async (from, to) => { if (first) { first = false; await held.shut; } return fs.promises.link(from, to); }
  };
}

test("Copy files writes the script first, then copies the files in the background", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take.mp4"), "mine");
    const { held, link } = heldLink();
    const ipc = harness({ source: s.script, copierOptions: { link } });
    const saved = await ipc.saveAs(s.copyScript, { script: true }, project("take.mp4"), "copy");
    assert.deepEqual(saved.chosen, { ok: true, links: [] });
    assert.equal(saved.written.bundleRefused, undefined);
    assert.equal(fs.existsSync(s.copyScript), true, "the script is on disk while the copy is still running");
    assert.equal(fs.existsSync(path.join(s.copyFolder, "take.mp4")), false, "the bulk copy has not landed yet");
    assert.equal(ipc.bundleJobs.busy(), true, "the copy is still a job, so quitting asks first");
    held.open();
    await ipc.bundleJobs.idle();
    assert.equal(fs.readFileSync(path.join(s.copyFolder, "take.mp4"), "utf8"), "mine");
    assert.deepEqual(ipc.notes("splitpage:bundle-carry").pop().result, { ok: true, copied: 1, kept: 0, missing: 0 });
    assert.deepEqual(linksIn(s.copyScript)["take.mp4"], { kind: "bundled", name: "take.mp4" }, "the link stays bundled");
  } finally { s.done(); }
});

test("while the copy runs, the new script's bundled opens fall back to the old folder, only for the job's names and tab, until the job ends", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take.mp4"), "mine");
    fs.writeFileSync(path.join(s.folder, "other.mp4"), "not linked");
    const { held, link } = heldLink();
    const ipc = harness({ source: s.script, testMode: true, copierOptions: { link } });
    await ipc.saveAs(s.copyScript, { script: true }, project("take.mp4"), "copy");
    ipc.tab.source = { kind: "file", absPath: s.copyScript };
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "take.mp4"), { ok: true });
    assert.deepEqual(ipc.testVideoOpens, [fs.realpathSync.native(path.join(s.folder, "take.mp4"))], "the not-yet-copied file opens from the old folder");
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "other.mp4"), { ok: false, code: "GONE" }, "a name the job does not list does not fall back");
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "..\\Episode 12 files\\take.mp4"), { ok: false, code: "REFUSED" });
    const other = { id: "tab-b", windowId: "w1", source: { kind: "file", absPath: s.copyScript } };
    assert.deepEqual(await ipc.callAs(other, "splitpage:bundled-file-open", "take.mp4"), { ok: false, code: "GONE" }, "another tab gets no fallback");
    held.open();
    await ipc.bundleJobs.idle();
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "take.mp4"), { ok: true });
    assert.equal(ipc.testVideoOpens[1], fs.realpathSync.native(path.join(s.copyFolder, "take.mp4")), "once copied it opens from the new folder");
    fs.rmSync(path.join(s.copyFolder, "take.mp4"));
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "take.mp4"), { ok: false, code: "GONE" }, "the fallback ended with the job");
  } finally { s.done(); }
});

test("without hard links, an open while the empty placeholder stands reaches the old folder's file, never the placeholder", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take.mp4"), "mine");
    const reached = gate();
    const released = gate();
    const ipc = harness({
      source: s.script, testMode: true,
      copierOptions: {
        link: async () => { throw Object.assign(new Error("no hard links here"), { code: "EPERM" }); },
        lstat: async (p) => { reached.open(); await released.shut; return fs.promises.lstat(p, { bigint: true }); }
      }
    });
    await ipc.saveAs(s.copyScript, { script: true }, project("take.mp4"), "copy");
    ipc.tab.source = { kind: "file", absPath: s.copyScript };
    await reached.shut;
    assert.equal(fs.statSync(path.join(s.copyFolder, "take.mp4")).size, 0, "setup: the placeholder stands under the final name");
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "take.mp4"), { ok: true });
    assert.deepEqual(ipc.testVideoOpens, [fs.realpathSync.native(path.join(s.folder, "take.mp4"))], "the open reaches the original");
    released.open();
    await ipc.bundleJobs.idle();
    assert.equal(fs.readFileSync(path.join(s.copyFolder, "take.mp4"), "utf8"), "mine");
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "take.mp4"), { ok: true });
    assert.equal(ipc.testVideoOpens[1], fs.realpathSync.native(path.join(s.copyFolder, "take.mp4")), "once renamed it opens from the new folder");
  } finally { s.done(); }
});

test("a cancelled background copy ends the fallback, keeps what it copied, and leaves the old folder alone", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    fs.writeFileSync(path.join(s.folder, "b.mp4"), Buffer.alloc(32 * 1024 * 1024, 4));
    const reached = gate();
    const ipc = harness({
      source: s.script, testMode: true,
      copierOptions: { link: async (from, to) => { await fs.promises.link(from, to); reached.open(); } }
    });
    await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4", "b.mp4"), "copy");
    ipc.tab.source = { kind: "file", absPath: s.copyScript };
    await reached.shut;
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "b.mp4"), { ok: true }, "while the job runs, the file not copied yet opens from the old folder");
    ipc.send("splitpage:bundle-cancel", "carry1");
    await until(() => !ipc.bundleJobs.busy());
    assert.deepEqual(ipc.notes("splitpage:bundle-carry").pop().result, { ok: false, code: "CANCELLED", name: "", copied: 1, left: 1 });
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "b.mp4"), { ok: false, code: "GONE" }, "after the job, a file not copied is gone from the new script");
    assert.ok(await until(() => fs.readdirSync(s.copyFolder).length === 1), "the stopped copy removes its temporary");
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["a.mp4"]);
    assert.deepEqual(fs.readdirSync(s.folder).sort(), ["a.mp4", "b.mp4"]);
    assert.equal(fs.existsSync(s.copyScript), true);
  } finally { s.done(); }
});

test("the plan counts linked files and the bytes still to copy, refuses a clash before anything is written, and names no path", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), Buffer.alloc(3000, 1));
    fs.writeFileSync(path.join(s.folder, "same.mp4"), Buffer.alloc(500, 2));
    fs.writeFileSync(path.join(s.folder, "planted.exe"), "MZ");
    fs.mkdirSync(s.copyFolder);
    fs.writeFileSync(path.join(s.copyFolder, "same.mp4"), Buffer.alloc(500, 2));
    const ipc = harness({ source: s.script });
    ipc.answers.push(s.copyScript);
    const picked = await ipc.call("splitpage:save-file-dialog", { suggestedName: "Episode 12 v2.splitpage", script: true });
    const plan = await ipc.call("splitpage:bundle-save-plan", picked.id, ["a.mp4", "same.mp4", "a.mp4", 7]);
    assert.deepEqual(plan, { ok: true, plan: { from: "Episode 12 files", to: "Episode 12 v2 files", files: 2, bytes: 3500, copyBytes: 3000, linkable: true } },
      "a file already there with the same name and size is not counted");
    const unresolved = await ipc.call("splitpage:bundle-save-plan", picked.id, ["a.mp4", "missing.mp4", "planted.exe", "..\\drops\\take one.mp4", s.clip]);
    assert.deepEqual(unresolved, { ok: false, code: "MISSING", refused: { reason: "missing", folder: "Episode 12 files", name: "missing.mp4", copied: 0, count: 4 } },
      "missing, blocked and path names stop the save before the prompt");
    fs.writeFileSync(path.join(s.copyFolder, "a.mp4"), "different");
    assert.deepEqual(await ipc.call("splitpage:bundle-save-plan", picked.id, ["a.mp4"]),
      { ok: false, code: "CLASH", refused: { reason: "clash", folder: "Episode 12 v2 files", name: "a.mp4", copied: 0 } });
    assert.deepEqual(await ipc.call("splitpage:bundle-save-plan", picked.id, []), { ok: true, plan: null }, "nothing linked, nothing to ask");
    const refused = await ipc.call("splitpage:write-file", picked.id, new TextEncoder().encode(project("a.mp4")));
    assert.deepEqual(refused, { size: 0, bundleRefused: { reason: "clash", folder: "Episode 12 v2 files", name: "a.mp4", copied: 0 } }, "the write still refuses the clash");
    assert.equal(fs.existsSync(s.copyScript), false);
    assert.equal(JSON.stringify([plan, unresolved]).includes(s.dir), false, "no path crosses to the renderer");
  } finally { s.done(); }
});

test("a linked file missing from the old folder stops the save before anything is written, for both choices, even when the new folder has that name", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    fs.mkdirSync(s.copyFolder);
    fs.writeFileSync(path.join(s.copyFolder, "gone.mp4"), "an unrelated file");
    const missing = { reason: "missing", folder: "Episode 12 files", name: "gone.mp4", copied: 0, count: 1 };
    for (const choice of ["copy", "link"]) {
      const ipc = harness({ source: s.script });
      const saved = await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4", "gone.mp4"), choice);
      assert.deepEqual(saved.plan, { ok: false, code: "MISSING", refused: missing }, choice + ": the plan refuses");
      if (choice === "link") assert.deepEqual(saved.chosen, { ok: false, code: "MISSING", refused: missing }, "Don't copy is refused too");
      assert.deepEqual(saved.written, { size: 0, bundleRefused: missing }, choice + ": the write refuses, so nothing can open the unrelated gone.mp4");
      await ipc.bundleJobs.idle();
      assert.equal(fs.existsSync(s.copyScript), false, choice + ": no script is written");
      assert.deepEqual(fs.readdirSync(s.copyFolder), ["gone.mp4"], choice + ": nothing is copied");
    }
  } finally { s.done(); }
});

test("a cancel during the preflight, before the script is handed back, registers no fallback, sends no progress, and lets the carry end", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    const held = gate();
    const ipc = harness({ source: s.script, testMode: true, holdCarry: held.shut });
    const saving = ipc.saveAs(s.copyScript, { script: true }, project("a.mp4"), "copy");
    assert.ok(await until(() => ipc.bundleJobs.busy()), "setup: the carry is queued");
    await new Promise((r) => setTimeout(r, 20));
    ipc.send("splitpage:bundle-cancel", "carry1");
    const saved = await saving;
    assert.deepEqual(saved.written, { size: 0, bundleRefused: { reason: "cancelled", folder: "Episode 12 v2 files", name: "", copied: 0 } });
    held.open();
    assert.ok(await until(() => ipc.carriesEnded() === 1), "the cancelled carry finishes instead of waiting on a hand-back no one answers");
    await ipc.bundleJobs.idle();
    const notesAtEnd = ipc.notes("splitpage:bundle-carry").length;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ipc.notes("splitpage:bundle-carry").length, notesAtEnd, "nothing is sent after the job ended");
    ipc.tab.source = { kind: "file", absPath: s.copyScript };
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "a.mp4"), { ok: false, code: "GONE" }, "no fallback was registered");
    assert.equal(fs.existsSync(s.copyScript), false);
    assert.equal(fs.existsSync(s.copyFolder), false);
  } finally { s.done(); }
});

test("the fallback goes when its tab closes or opens another script, even when it comes back to the copy without opening a file", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take.mp4"), "mine");
    const other = path.join(s.dir, "Other.splitpage");
    fs.writeFileSync(other, "{}");
    for (const leave of ["close", "replace", "return"]) {
      const { held, link } = heldLink();
      const ipc = harness({ source: s.script, testMode: true, copierOptions: { link } });
      await ipc.saveAs(s.copyScript, { script: true }, project("take.mp4"), "copy");
      ipc.moveTab(s.copyScript);
      assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "take.mp4"), { ok: true }, leave + ": setup: the fallback works");
      if (leave === "close") ipc.bundleJobs.forgetTab(ipc.tab.id);
      else ipc.moveTab(other);
      if (leave === "replace") assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "take.mp4"), { ok: false, code: "GONE" });
      ipc.moveTab(s.copyScript);
      assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "take.mp4"), { ok: false, code: "GONE" }, leave + ": the record is gone, not just unused");
      held.open();
      await ipc.bundleJobs.idle();
      fs.rmSync(s.copyFolder, { recursive: true, force: true });
      fs.rmSync(s.copyScript, { force: true });
    }
  } finally { s.done(); }
});

test("the fallback also goes when its tab opens another script while the Save As is still writing, so landing later revives nothing", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take.mp4"), "mine");
    const other = path.join(s.dir, "Other.splitpage");
    fs.writeFileSync(other, "{}");
    for (const detour of [false, true]) {
      const { held, link } = heldLink();
      const ipc = harness({ source: s.script, testMode: true, copierOptions: { link } });
      ipc.answers.push(s.copyScript);
      const picked = await ipc.call("splitpage:save-file-dialog", { suggestedName: path.basename(s.copyScript), script: true });
      await ipc.call("splitpage:bundle-save-plan", picked.id, ["take.mp4"]);
      await ipc.call("splitpage:bundle-save-choice", picked.id, "copy");
      const body = project("take.mp4");
      const prepared = await ipc.bundleJobs.prepareWrite(picked.id, () => body, ipc.main.sender);
      assert.equal(prepared.refused, null, "setup: the write may go ahead");
      if (detour) { ipc.moveTab(other); ipc.moveTab(s.script); }
      fs.writeFileSync(s.copyScript, body);
      prepared.landed(true);
      ipc.moveTab(s.copyScript);
      assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "take.mp4"), detour ? { ok: false, code: "GONE" } : { ok: true },
        detour ? "a tab that left before the landing has no fallback" : "setup: without the detour the fallback works");
      held.open();
      await ipc.bundleJobs.idle();
      fs.rmSync(s.copyFolder, { recursive: true, force: true });
      fs.rmSync(s.copyScript, { force: true });
    }
  } finally { s.done(); }
});

test("the plan and choice channels refuse forged ids, other tabs, a dialog that was not a script save, and a choice that is not copy or link", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    const ipc = harness({ source: s.script });
    ipc.answers.push(s.copyScript);
    const picked = await ipc.call("splitpage:save-file-dialog", { suggestedName: "x.splitpage", script: true });
    const other = { id: "tab-b", windowId: "w1", source: { kind: "file", absPath: s.script } };
    for (const [why, id] of Object.entries({ "a forged id": "0".repeat(32), "a path": s.copyScript, "not a string": 5, "nothing": "" })) {
      assert.deepEqual(await ipc.call("splitpage:bundle-save-plan", id, ["a.mp4"]), { ok: false, code: "UNKNOWN" }, why);
      assert.deepEqual(await ipc.call("splitpage:bundle-save-choice", id, "link"), { ok: false, code: "UNKNOWN" }, why);
    }
    assert.deepEqual(await ipc.callAs(other, "splitpage:bundle-save-plan", picked.id, ["a.mp4"]), { ok: false, code: "UNKNOWN" }, "another tab's save");
    assert.deepEqual(await ipc.callAs(other, "splitpage:bundle-save-choice", picked.id, "link"), { ok: false, code: "UNKNOWN" });
    assert.deepEqual(await ipc.callAs(null, "splitpage:bundle-save-choice", picked.id, "link"), { ok: false, code: "UNKNOWN" });
    for (const bad of ["move", "LINK", "", null, { kind: "link" }]) {
      assert.deepEqual(await ipc.call("splitpage:bundle-save-choice", picked.id, bad), { ok: false, code: "REFUSED" }, JSON.stringify(bad));
    }
    ipc.answers.push(path.join(s.dir, "export.txt"));
    const exported = await ipc.call("splitpage:save-file-dialog", { suggestedName: "export.txt" });
    assert.deepEqual(await ipc.call("splitpage:bundle-save-plan", exported.id, ["a.mp4"]), { ok: false, code: "UNKNOWN" }, "an export dialog has no plan");
    await ipc.call("splitpage:write-file", picked.id, new TextEncoder().encode(project("a.mp4")));
    await ipc.bundleJobs.idle();
    assert.deepEqual(linksIn(s.copyScript)["a.mp4"], { kind: "bundled", name: "a.mp4" }, "a refused choice leaves the default, Copy files");
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["a.mp4"]);
  } finally { s.done(); }
});

test("Don't copy answers the path links for the planned names only, copies nothing, and main writes the renderer's bytes as they are", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    fs.writeFileSync(path.join(s.folder, "notes.txt"), "a note");
    fs.writeFileSync(path.join(s.folder, "unlisted.mp4"), "not in the plan");
    const ipc = harness({ source: s.script, testMode: true });
    const saved = await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4", "notes.txt"), "link");
    assert.deepEqual(saved.chosen, { ok: true, links: [
      { name: "a.mp4", path: path.join(s.folder, "a.mp4") }, { name: "notes.txt", path: path.join(s.folder, "notes.txt") }
    ] }, "the only answer that carries paths: one per planned name, each one main checked");
    assert.equal(saved.written.bundleRefused, undefined);
    await ipc.bundleJobs.idle();
    assert.equal(fs.existsSync(s.copyFolder), false, "nothing is copied and no folder is made");
    const links = linksIn(s.copyScript);
    assert.deepEqual(links["a.mp4"], { kind: "path", path: path.join(s.folder, "a.mp4") });
    assert.deepEqual(links["notes.txt"], { kind: "path", path: path.join(s.folder, "notes.txt") });
    assert.deepEqual(links["far.mp4"], { kind: "path", path: "C:\\far.mp4" }, "other links are untouched");
    assert.equal(fs.readFileSync(s.script, "utf8"), "{}", "the old script is left as it is");
    assert.deepEqual(ipc.notes("splitpage:bundle-carry"), [], "no copy ran");
    ipc.tab.source = { kind: "file", absPath: s.copyScript };
    const later = project("a.mp4");
    await ipc.call("splitpage:write-file", saved.id, new TextEncoder().encode(later));
    assert.equal(fs.readFileSync(s.copyScript, "utf8"), later, "a later save is written byte for byte; main keeps no map to rewrite it with");
  } finally { s.done(); }
});

test("a Don't copy write that still links a bundled name is refused, so the new script never links the new folder by accident", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    const ipc = harness({ source: s.script });
    ipc.answers.push(s.copyScript);
    const picked = await ipc.call("splitpage:save-file-dialog", { suggestedName: "Episode 12 v2.splitpage", script: true });
    assert.deepEqual(await ipc.call("splitpage:bundle-save-choice", picked.id, "link"), { ok: false, code: "REFUSED" }, "Don't copy needs a plan first");
    assert.equal((await ipc.call("splitpage:bundle-save-plan", picked.id, ["a.mp4"])).ok, true);
    assert.equal((await ipc.call("splitpage:bundle-save-choice", picked.id, "link")).ok, true);
    const refused = await ipc.call("splitpage:write-file", picked.id, new TextEncoder().encode(project("a.mp4")));
    assert.deepEqual(refused, { size: 0, bundleRefused: { reason: "missing", folder: "Episode 12 files", name: "a.mp4", copied: 0, count: 1 } });
    assert.equal(fs.existsSync(s.copyScript), false);
    assert.equal(fs.existsSync(s.copyFolder), false);
  } finally { s.done(); }
});

test("after Don't copy, a Save As to the same name in another format keeps the links (same folder, nothing to plan)", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    const ipc = harness({ source: s.script });
    const first = await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4"), "link");
    assert.equal(first.written.bundleRefused, undefined);
    const adopted = relinked(project("a.mp4"), first.chosen.links);
    ipc.tab.source = { kind: "file", absPath: s.copyScript };
    const md = s.copyScript.replace(/\.splitpage$/, ".md");
    ipc.answers.push(md);
    const picked = await ipc.call("splitpage:save-file-dialog", { suggestedName: path.basename(md), script: true });
    assert.deepEqual(await ipc.call("splitpage:bundle-save-plan", picked.id, bundleFiles.bundledNamesInProject(adopted)), { ok: true, plan: null });
    const text = "| Visual | Audio |\n| --- | --- |\n| a | b |\n\n~~~~splitpage\n" + adopted + "\n~~~~\n";
    assert.equal((await ipc.call("splitpage:write-file", picked.id, new TextEncoder().encode(text))).bundleRefused, undefined);
    assert.deepEqual(linksIn(md)["a.mp4"], { kind: "path", path: path.join(s.folder, "a.mp4") }, "B.md links the files where they are, as B.splitpage does");
  } finally { s.done(); }
});

test("Don't copy from a script on a network share is unavailable: the plan says so, the choice is refused, and Copy files still works", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    const ipc = harness({ source: SHARE + "Episode 12.splitpage", shareOf: s.dir });
    ipc.answers.push(s.copyScript);
    const picked = await ipc.call("splitpage:save-file-dialog", { suggestedName: "Episode 12 v2.splitpage", script: true });
    const plan = await ipc.call("splitpage:bundle-save-plan", picked.id, ["a.mp4"]);
    assert.equal(plan.ok && plan.plan && plan.plan.linkable, false, JSON.stringify(plan));
    assert.deepEqual(await ipc.call("splitpage:bundle-save-choice", picked.id, "link"),
      { ok: false, code: "UNLINKABLE", refused: { reason: "unlinkable", folder: "Episode 12 files", name: "a.mp4", copied: 0 } }, "no UNC path is ever handed out");
    assert.equal(fs.existsSync(s.copyScript), false);
    assert.deepEqual(await ipc.call("splitpage:bundle-save-choice", picked.id, "copy"), { ok: true, links: [] });
    const written = await ipc.call("splitpage:write-file", picked.id, new TextEncoder().encode(project("a.mp4")));
    assert.equal(written.bundleRefused, undefined);
    await ipc.bundleJobs.idle();
    assert.deepEqual(fs.readdirSync(s.copyFolder), ["a.mp4"]);
  } finally { s.done(); }
});

test("Don't copy through a junctioned old folder hands out no path, and the save stops with nothing written", async () => {
  const s = scratch();
  try {
    const real = path.join(s.dir, "elsewhere");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "a.mp4"), "aaaa");
    if (!junction(real, s.folder)) { console.log("  (junctions unavailable here)"); return; }
    const ipc = harness({ source: s.script });
    const saved = await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4"), "link");
    const missing = { reason: "missing", folder: "Episode 12 files", name: "a.mp4", copied: 0, count: 1 };
    assert.deepEqual(saved.plan, { ok: false, code: "MISSING", refused: missing }, "a junctioned folder resolves nothing");
    assert.deepEqual(saved.chosen, { ok: false, code: "MISSING", refused: missing });
    assert.deepEqual(saved.written, { size: 0, bundleRefused: missing });
    assert.equal(fs.existsSync(s.copyScript), false);
    assert.equal(JSON.stringify(saved).includes(real.replace(/\\/g, "\\\\")), false);
  } finally { s.done(); }
});

test("a second Save As from the new script waits in main's queue for the first copy", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    const { held, link } = heldLink();
    const ipc = harness({ source: s.script, copierOptions: { link } });
    await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4"), "copy");
    ipc.tab.source = { kind: "file", absPath: s.copyScript };
    const c = path.join(s.dir, "C.splitpage");
    const toC = ipc.saveAs(c, { script: true }, project("a.mp4"));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fs.existsSync(c), false, "C waits for B's copy");
    held.open();
    assert.equal((await toC).written.bundleRefused, undefined);
    await ipc.bundleJobs.idle();
    assert.equal(fs.readFileSync(path.join(s.dir, "C files", "a.mp4"), "utf8"), "aaaa", "C is carried from what B's copy left");
  } finally { s.done(); }
});

test("quitting during the background copy asks Wait or Quit anyway, and the copy goes on after the tab is gone", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "aaaa");
    const { held, link } = heldLink();
    const ipc = harness({ source: s.script, copierOptions: { link } });
    await ipc.saveAs(s.copyScript, { script: true }, project("a.mp4"), "copy");
    ipc.main.sender.destroyed = true;
    ipc.tabs.clear();
    const waiting = quitWorld(ipc.bundleJobs, [0]);
    assert.equal(waiting.quit().prevented, true);
    assert.deepEqual(waiting.asked.map((o) => [o.message, o.buttons]), [["Splitpage is still copying files.", ["Wait", "Quit anyway"]]]);
    held.open();
    assert.ok(await until(() => waiting.quits.length === 1), "Wait lets the copy finish, then quits");
    assert.equal(fs.readFileSync(path.join(s.copyFolder, "a.mp4"), "utf8"), "aaaa", "the copy finished though the tab and its renderer were gone");
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
