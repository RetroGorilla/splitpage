import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createBundleCopier } = require(path.join(here, "..", "bundle-copy.ts"));
const { createBundleJobs } = require(path.join(here, "..", "bundle-jobs.ts"));
const { createShellIpc } = require(path.join(here, "..", "ipc-shell.ts"));
const bundleFiles = require(path.join(here, "..", "..", "shared", "video-embed.ts"));
const { ATTACHABLE_FILE, openableVideoPath } = bundleFiles;

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const live = () => new AbortController().signal;
const SIZE = 64 * 1024;

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-bundle-move-"));
  const script = path.join(dir, "Episode 12.splitpage");
  const folder = path.join(dir, "Episode 12 files");
  const drops = path.join(dir, "drops");
  fs.mkdirSync(drops);
  fs.writeFileSync(script, "{}");
  const clip = path.join(drops, "take one.mp4");
  const bytes = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) bytes[i] = i % 251;
  fs.writeFileSync(clip, bytes);
  return { dir, script, folder, drops, clip, bytes, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const exdev = async () => { const e = new Error("cross-device"); e.code = "EXDEV"; throw e; };
const busy = async () => { const e = new Error("in use"); e.code = "EBUSY"; throw e; };
const copierWith = (options = {}) => createBundleCopier({ bundleFiles, progressEveryMs: 0, ...options });
const crossDrive = (options = {}) => copierWith({ moveFile: exdev, ...options });
const ino = (p) => fs.statSync(p, { bigint: true }).ino;
const leftovers = (folder) => (fs.existsSync(folder) ? fs.readdirSync(folder).filter((n) => /\.part$/.test(n)) : []);
const touch = (p) => { const t = new Date(Date.now() + 60000); fs.utimesSync(p, t, t); };
const move = async (copier, source, script, onProgress = () => {}, signal = live()) =>
  copier.moveIn(source, script, ATTACHABLE_FILE, onProgress, signal, await copier.moveGrantOf(source));

function junction(target, at) {
  try { fs.symlinkSync(target, at, "junction"); return true; } catch { return false; }
}

test("on the same drive a move is one rename into the folder: the same file, never two copies and never none", async () => {
  const s = scratch();
  try {
    const before = ino(s.clip);
    const seen = [];
    const got = await move(copierWith(), s.clip, s.script, (done, total) => seen.push([done, total]));
    assert.equal(got.ok, true);
    assert.equal(got.outcome, "moved");
    assert.equal(got.name, "take one.mp4");
    const moved = path.join(s.folder, "take one.mp4");
    assert.equal(fs.existsSync(s.clip), false, "the original is gone");
    assert.deepEqual(fs.readFileSync(moved), s.bytes);
    assert.equal(ino(moved), before, "a rename, not a copy");
    assert.deepEqual(seen.at(-1), [SIZE, SIZE]);
    assert.deepEqual(leftovers(s.folder), []);
  } finally { s.done(); }
});

test("a name taken in the folder gets a numbered name, and nothing there is overwritten", async () => {
  for (const [label, copier] of [["same drive", copierWith()], ["other drive", crossDrive()]]) {
    const s = scratch();
    try {
      fs.mkdirSync(s.folder);
      fs.writeFileSync(path.join(s.folder, "take one.mp4"), "someone else's");
      const got = await move(copier, s.clip, s.script);
      assert.equal(got.ok && got.name, "take one (2).mp4", label);
      assert.equal(fs.readFileSync(path.join(s.folder, "take one.mp4"), "utf8"), "someone else's", label);
      assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one (2).mp4")), s.bytes, label);
      assert.equal(fs.existsSync(s.clip), false, label);
    } finally { s.done(); }
  }
});

test("a file already in the folder with the same bytes is linked, and the original then goes", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take one.mp4"), s.bytes);
    const got = await move(crossDrive(), s.clip, s.script);
    assert.deepEqual([got.ok, got.name, got.outcome], [true, "take one.mp4", "moved"]);
    assert.deepEqual(fs.readdirSync(s.folder), ["take one.mp4"]);
    assert.equal(fs.existsSync(s.clip), false);
  } finally { s.done(); }
});

test("on another drive a move copies to a temporary, checks it byte for byte, publishes it, and only then deletes the original", async () => {
  const s = scratch();
  try {
    const order = [];
    let target = "";
    const copier = crossDrive({
      link: async (part, to) => {
        assert.deepEqual(fs.readFileSync(part), s.bytes, "the temporary is whole before it is published");
        assert.equal(fs.existsSync(to), false, "nothing stood under the final name before the publish");
        order.push("publish");
        target = to;
        return fsp.link(part, to);
      },
      removeOriginal: async (p) => {
        assert.equal(p, s.clip, "only the granted original is ever deleted");
        assert.deepEqual(fs.readFileSync(target), s.bytes, "deleting is safe: the published copy is whole and checked");
        order.push("delete");
        return fsp.unlink(p);
      }
    });
    const seen = [];
    const got = await move(copier, s.clip, s.script, (done, total) => seen.push([done, total]));
    assert.deepEqual([got.ok, got.outcome], [true, "moved"]);
    assert.deepEqual(order, ["publish", "delete"]);
    assert.equal(fs.existsSync(s.clip), false);
    assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one.mp4")), s.bytes);
    assert.deepEqual(seen.at(-1), [2 * SIZE, 2 * SIZE], "progress counts the copy and the check");
    assert.deepEqual(leftovers(s.folder), []);
  } finally { s.done(); }
});

test("a copy that does not match byte for byte is never published, and the original stays", async () => {
  const s = scratch();
  try {
    let edited = false;
    const copier = crossDrive({ removeOriginal: async () => { throw new Error("must not delete"); } });
    const got = await move(copier, s.clip, s.script, (done) => {
      if (edited || done !== SIZE) return;
      edited = true;
      const fd = fs.openSync(s.clip, "r+");
      try { fs.writeSync(fd, Buffer.from([255]), 0, 1, 0); } finally { fs.closeSync(fd); }
    });
    assert.ok(edited, "the original was edited after it was copied");
    assert.deepEqual(got, { ok: false, code: "FAILED" });
    assert.equal(fs.readFileSync(s.clip)[0], 255, "the original is left as it is now");
    assert.ok(!fs.existsSync(path.join(s.folder, "take one.mp4")), "nothing was published");
    assert.deepEqual(leftovers(s.folder), []);
  } finally { s.done(); }
});

test("deleting needs the original unchanged since the grant: a newer modified time keeps both, during the copy or after the check", async () => {
  for (const when of ["during the copy", "after the check"]) {
    const s = scratch();
    try {
      let touched = false;
      const once = () => { if (!touched) { touched = true; touch(s.clip); } };
      const copier = crossDrive({
        link: async (part, to) => { if (when === "after the check") once(); return fsp.link(part, to); },
        removeOriginal: async () => { throw new Error("must not delete a changed original"); }
      });
      const got = await move(copier, s.clip, s.script, () => { if (when === "during the copy") once(); });
      assert.deepEqual([got.ok, got.outcome, got.name], [true, "changed", "take one.mp4"], when);
      assert.deepEqual(fs.readFileSync(s.clip), s.bytes, when + ": the original stays");
      assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one.mp4")), s.bytes, when + ": and the checked copy stays");
    } finally { s.done(); }
  }
});

test("on the same drive the rename needs the original unchanged since the grant: one changed while the folder was made keeps both", async () => {
  const s = scratch();
  try {
    const before = ino(s.clip);
    const grant = await copierWith().moveGrantOf(s.clip);
    let renamed = false;
    const copier = copierWith({
      openTarget: async (target) => { touch(s.clip); return fsp.open(target, "wx"); },
      moveFile: async (from, to) => { renamed = true; return fsp.rename(from, to); }
    });
    const got = await copier.moveIn(s.clip, s.script, ATTACHABLE_FILE, () => {}, live(), grant);
    assert.equal(renamed, false, "a changed original is never renamed away");
    assert.deepEqual([got.ok, got.outcome, got.name], [true, "changed", "take one.mp4"]);
    assert.equal(ino(s.clip), before, "the original stays where it was");
    assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one.mp4")), s.bytes, "and a checked copy is in the folder");
    assert.notEqual(ino(path.join(s.folder, "take one.mp4")), before);
    assert.deepEqual(leftovers(s.folder), []);
  } finally { s.done(); }
});

test("deleting needs the original's folder to be the one granted: a folder link retargeted after the grant keeps both", async () => {
  const s = scratch();
  try {
    const via = path.join(s.dir, "via");
    const elsewhere = path.join(s.dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.linkSync(s.clip, path.join(elsewhere, "take one.mp4"));
    if (!junction(s.drops, via)) { console.log("  (folder links are not available here; the retarget case runs where they are)"); return; }
    const source = path.join(via, "take one.mp4");
    const copier = crossDrive({
      link: async (part, to) => {
        await fsp.link(part, to);
        fs.unlinkSync(via);
        assert.ok(junction(elsewhere, via), "the folder link now leads elsewhere, to the same file id, size and time");
      },
      removeOriginal: async () => { throw new Error("must not delete through a retargeted folder"); }
    });
    const got = await move(copier, source, s.script);
    assert.deepEqual([got.ok, got.outcome], [true, "changed"]);
    assert.deepEqual(fs.readFileSync(s.clip), s.bytes);
    assert.deepEqual(fs.readFileSync(path.join(elsewhere, "take one.mp4")), s.bytes);
    assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one.mp4")), s.bytes);
  } finally {
    try { fs.unlinkSync(path.join(s.dir, "via")); } catch { }
    s.done();
  }
});

test("deleting needs the original not in use: a file another program holds keeps both", async () => {
  const s = scratch();
  try {
    const got = await move(copierWith({ moveFile: busy, removeOriginal: busy }), s.clip, s.script);
    assert.deepEqual([got.ok, got.outcome], [true, "kept"], "a rename refused for a file in use falls back to copy, check and delete");
    assert.deepEqual(fs.readFileSync(s.clip), s.bytes);
    assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one.mp4")), s.bytes);
    assert.deepEqual(leftovers(s.folder), []);
  } finally { s.done(); }
});

test("an original on a read-only drive stays, with the copy in the folder", async () => {
  const s = scratch();
  try {
    const readOnly = async () => { const e = new Error("read-only file system"); e.code = "EROFS"; throw e; };
    const got = await move(crossDrive({ removeOriginal: readOnly }), s.clip, s.script);
    assert.deepEqual([got.ok, got.outcome], [true, "kept"]);
    assert.deepEqual(fs.readFileSync(s.clip), s.bytes);
    assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one.mp4")), s.bytes);
  } finally { s.done(); }
  if (process.platform === "win32") return;
  const p = scratch();
  try {
    fs.chmodSync(p.drops, 0o555);
    if (process.getuid && process.getuid() === 0) { console.log("  (running as root: a read-only folder does not stop root; the real-folder case runs elsewhere)"); return; }
    const got = await move(crossDrive(), p.clip, p.script);
    assert.deepEqual([got.ok, got.outcome], [true, "kept"], "a real folder the original cannot leave");
    assert.deepEqual(fs.readFileSync(p.clip), p.bytes);
  } finally { fs.chmodSync(p.drops, 0o755); p.done(); }
});

test("Cancel before the publish leaves the original where it was and nothing in the folder", async () => {
  for (const [label, copier] of [["same drive", copierWith()], ["other drive", crossDrive()]]) {
    const s = scratch();
    try {
      const ctl = new AbortController();
      if (label === "same drive") ctl.abort();
      const got = await move(copier, s.clip, s.script, () => ctl.abort(), ctl.signal);
      assert.deepEqual(got, { ok: false, code: "CANCELLED" }, label);
      assert.deepEqual(fs.readFileSync(s.clip), s.bytes, label);
      assert.deepEqual(fs.existsSync(s.folder) ? fs.readdirSync(s.folder) : [], [], label + ": no temporary, placeholder or copy");
    } finally { s.done(); }
  }
});

test("a Cancel while the rename's placeholder is checked stops the rename, so the original stays and the placeholder goes", async () => {
  const s = scratch();
  try {
    const before = ino(s.clip);
    const ctl = new AbortController();
    const copier = copierWith({ lstat: async (target) => { ctl.abort(); return fsp.lstat(target, { bigint: true }); } });
    const got = await move(copier, s.clip, s.script, () => {}, ctl.signal);
    assert.deepEqual(got, { ok: false, code: "CANCELLED" });
    assert.equal(ino(s.clip), before);
    assert.deepEqual(fs.readdirSync(s.folder), []);
  } finally { s.done(); }
});

test("a Cancel while the publish's placeholder is checked publishes nothing, and the original stays", async () => {
  const s = scratch();
  try {
    const ctl = new AbortController();
    let armed = false;
    const copier = crossDrive({
      link: async () => { armed = true; const e = new Error("no hard links here"); e.code = "EPERM"; throw e; },
      lstat: async (target) => { if (armed) ctl.abort(); return fsp.lstat(target, { bigint: true }); },
      removeOriginal: async () => { throw new Error("must not delete"); }
    });
    const got = await move(copier, s.clip, s.script, () => {}, ctl.signal);
    assert.ok(armed, "the publish fell back to the placeholder");
    assert.deepEqual(got, { ok: false, code: "CANCELLED" });
    assert.deepEqual(fs.readFileSync(s.clip), s.bytes);
    assert.deepEqual(fs.readdirSync(s.folder), [], "no temporary, placeholder or copy");
  } finally { s.done(); }
});

test("a Cancel during the check removes the temporary and keeps the original", async () => {
  const s = scratch();
  try {
    const ctl = new AbortController();
    const got = await move(crossDrive(), s.clip, s.script, (done) => { if (done > SIZE) ctl.abort(); }, ctl.signal);
    assert.deepEqual(got, { ok: false, code: "CANCELLED" });
    assert.deepEqual(fs.readFileSync(s.clip), s.bytes);
    assert.deepEqual(fs.readdirSync(s.folder), []);
  } finally { s.done(); }
});

test("a Cancel after the publish stops the delete: both stay, and the link names the checked copy", async () => {
  const s = scratch();
  try {
    const ctl = new AbortController();
    const copier = crossDrive({
      link: async (part, to) => { await fsp.link(part, to); ctl.abort(); },
      removeOriginal: async () => { throw new Error("must not delete after a Cancel"); }
    });
    const got = await move(copier, s.clip, s.script, () => {}, ctl.signal);
    assert.deepEqual([got.ok, got.outcome, got.name], [true, "kept", "take one.mp4"]);
    assert.deepEqual(fs.readFileSync(s.clip), s.bytes);
    assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one.mp4")), s.bytes);
  } finally { s.done(); }
});

test("a move that stops at any step before the delete leaves the original whole, so a crash never loses both", async () => {
  for (const step of ["copy", "check", "publish"]) {
    const s = scratch();
    try {
      const crash = () => { const e = new Error("killed at " + step); e.code = "EIO"; throw e; };
      let reads = 0;
      const copier = crossDrive({
        link: step === "publish" ? async () => crash() : undefined,
        removeOriginal: async () => { throw new Error("must not delete"); }
      });
      const got = await move(copier, s.clip, s.script, (done) => {
        reads = done;
        if (step === "copy" && done > 0 && done < SIZE) crash();
        if (step === "check" && done > SIZE) crash();
      }).catch((e) => ({ thrown: e.message }));
      assert.ok(reads > 0 || step === "publish", step);
      assert.deepEqual(fs.readFileSync(s.clip), s.bytes, step + ": the original is whole");
      assert.ok(!got.ok || got.outcome !== "moved", step + ": nothing reports a move");
    } finally { s.done(); }
  }
});

test("a move refuses a link, a folder, a blocked type and a file that is gone, before anything is written", async () => {
  const s = scratch();
  try {
    const copier = copierWith();
    const tool = path.join(s.drops, "tool.exe");
    fs.writeFileSync(tool, "MZ");
    assert.deepEqual(await move(copier, tool, s.script), { ok: false, code: "REFUSED" });
    const dir = path.join(s.drops, "folder.mp4");
    fs.mkdirSync(dir);
    assert.equal(await copier.moveGrantOf(dir), null, "a folder has no move grant");
    assert.deepEqual(await move(copier, dir, s.script), { ok: false, code: "REFUSED" });
    assert.deepEqual(await move(copier, path.join(s.drops, "gone.mp4"), s.script), { ok: false, code: "GONE" });
    const alias = path.join(s.drops, "alias.mp4");
    let linked = true;
    try { fs.symlinkSync(s.clip, alias, "file"); } catch { linked = false; }
    if (linked) {
      assert.deepEqual(await move(copier, alias, s.script), { ok: false, code: "REFUSED" }, "a link is never moved in place of its target");
      assert.deepEqual(fs.readFileSync(s.clip), s.bytes);
    } else console.log("  (file symlinks need a privilege this account lacks; the link case runs where they don't)");
    assert.ok(!fs.existsSync(s.folder) || fs.readdirSync(s.folder).length === 0, "nothing was written");
  } finally { s.done(); }
});

test("the missing-file fallback opens a file of the same name and size in the script's folder, and nothing else", async () => {
  const s = scratch();
  try {
    const copier = copierWith();
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take one.mp4"), s.bytes);
    const real = fs.realpathSync.native(path.join(s.folder, "take one.mp4"));
    assert.deepEqual(await copier.besideScript(s.script, path.join(s.dir, "gone", "take one.mp4"), SIZE, ATTACHABLE_FILE), { ok: true, path: real });
    assert.deepEqual(await copier.besideScript(s.script, path.join(s.dir, "gone", "take one.mp4"), SIZE + 1, ATTACHABLE_FILE), { ok: false, code: "GONE" }, "another size");
    assert.deepEqual(await copier.besideScript(s.script, path.join(s.dir, "gone", "take one.mp4"), undefined, ATTACHABLE_FILE), { ok: false, code: "GONE" }, "no size");
    assert.deepEqual(await copier.besideScript(s.script, path.join(s.dir, "gone", "other.mp4"), SIZE, ATTACHABLE_FILE), { ok: false, code: "GONE" }, "another name");
    fs.writeFileSync(path.join(s.folder, "empty.mp4"), "");
    assert.deepEqual(await copier.besideScript(s.script, path.join(s.dir, "gone", "empty.mp4"), 0, ATTACHABLE_FILE), { ok: false, code: "GONE" }, "an empty file may be a crashed copy's placeholder");
    fs.writeFileSync(path.join(s.folder, "tool.exe"), "MZ");
    assert.deepEqual(await copier.besideScript(s.script, path.join(s.dir, "gone", "tool.exe"), 2, ATTACHABLE_FILE), { ok: false, code: "GONE" }, "a blocked type");
  } finally { s.done(); }
});

const MAIN = 7;

function makeSender(id) {
  const sent = [];
  return { sent, sender: { id, isDestroyed: () => false, send: (channel, payload) => { sent.push([channel, payload]); } } };
}

function grantSync(p) {
  const st = fs.lstatSync(p, { bigint: true });
  const stamp = { size: st.size, mtime: st.mtimeNs, ctime: st.ctimeNs, ino: st.ino, dev: st.dev };
  return { path: p, sender: MAIN, move: { stamp, parent: fs.realpathSync.native(path.dirname(p)) } };
}

function harness({ script = null, grants = [], copierOptions = {}, holdMove = null } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const testVideoOpens = [];
  const tab = { id: "tab-a", windowId: "w1", source: script ? { kind: "file", absPath: script } : { kind: "blank" } };
  const videoFileGrants = new Map(grants.map(([token, p]) => [token, grantSync(p)]));
  const real = copierWith(copierOptions);
  const copier = { ...real, moveIn: async (...args) => { if (holdMove) await holdMove; return real.moveIn(...args); } };
  const bundleJobs = createBundleJobs({
    copier, allow: ATTACHABLE_FILE, scriptOfTab: (id) => (id === tab.id && tab.source.kind === "file" ? tab.source.absPath : null),
    pathOf: () => null, namesInProject: bundleFiles.bundledNamesInProject, quitGraceMs: 200
  });
  const { registerShellIpc } = createShellIpc({
    tabOf: (event) => (event.tab === undefined ? tab : event.tab),
    shell: { openPath: async () => "", openExternal: async () => {} },
    testMode: true, testVideoOpens, videoFileGrants, ATTACHABLE_FILE, openableVideoPath, bundleJobs
  });
  registerShellIpc({ ipcHandle: (n, fn) => handlers.set(n, fn), ipcOn: (n, fn) => listeners.set(n, fn), ipcOnSync: () => {} });
  const main = makeSender(MAIN);
  const call = (name, ...args) => handlers.get(name)({ sender: main.sender }, ...args);
  const callAs = (other, name, ...args) => handlers.get(name)({ sender: main.sender, tab: other }, ...args);
  const callFrom = (from, other, name, ...args) => handlers.get(name)({ sender: from.sender, tab: other }, ...args);
  const send = (name, ...args) => listeners.get(name)({ sender: main.sender }, ...args);
  return { tab, call, callAs, callFrom, send, main, bundleJobs, videoFileGrants, testVideoOpens };
}

test("main moves only a file it granted this session, by token, into the tab's own script folder", async () => {
  const s = scratch();
  try {
    const ipc = harness({ script: s.script, grants: [["tok", s.clip]] });
    assert.deepEqual(await ipc.call("splitpage:bundle-move", "0".repeat(32), "bundle1"), { ok: false, code: "UNKNOWN" }, "a token main never gave");
    assert.deepEqual(await ipc.call("splitpage:bundle-move", s.clip, "bundle1"), { ok: false, code: "UNKNOWN" }, "a path is never a grant");
    assert.deepEqual(await ipc.call("splitpage:bundle-move", "tok", "../x"), { ok: false, code: "REFUSED" });
    assert.deepEqual(await ipc.callAs({ id: "tab-a", source: { kind: "blank" } }, "splitpage:bundle-move", "tok", "bundle1"), { ok: false, code: "NO_FOLDER" });
    assert.deepEqual(fs.readFileSync(s.clip), s.bytes, "nothing moved yet");
    assert.deepEqual(await ipc.call("splitpage:bundle-move", "tok", "bundle1"), { ok: true, name: "take one.mp4", outcome: "moved" });
    assert.equal(fs.existsSync(s.clip), false);
    assert.equal(ipc.videoFileGrants.has("tok"), false, "the grant goes with the original");
    assert.deepEqual(await ipc.call("splitpage:bundle-move", "tok", "bundle2"), { ok: false, code: "UNKNOWN" }, "a moved file is never moved again by that grant");
    const progress = ipc.main.sent.filter(([c]) => c === "splitpage:bundle-progress").map(([, p]) => p);
    assert.ok(progress.length >= 1 && progress.every((p) => Object.keys(p).sort().join() === "done,job,total"), "progress names no path");
  } finally { s.done(); }
});

test("a grant belongs to the tab it was given to: another saved tab's move, copy or open with that token is refused", async () => {
  const s = scratch();
  try {
    const ipc = harness({ script: s.script, grants: [["tok", s.clip]] });
    const other = makeSender(MAIN + 1);
    const otherScript = path.join(s.dir, "Other.splitpage");
    fs.writeFileSync(otherScript, "{}");
    const otherTab = { id: "tab-b", windowId: "w1", source: { kind: "file", absPath: otherScript } };
    assert.deepEqual(await ipc.callFrom(other, otherTab, "splitpage:bundle-move", "tok", "bundle1"), { ok: false, code: "UNKNOWN" });
    assert.deepEqual(await ipc.callFrom(other, otherTab, "splitpage:bundle-file", "tok", "bundle2"), { ok: false, code: "UNKNOWN" });
    assert.deepEqual(await ipc.callFrom(other, otherTab, "splitpage:video-file-open", "tok"), { ok: false, code: "UNKNOWN" });
    assert.deepEqual(fs.readFileSync(s.clip), s.bytes, "the original never moved");
    assert.equal(fs.existsSync(path.join(s.dir, "Other files")), false, "and nothing reached the other tab's folder");
    assert.deepEqual(ipc.testVideoOpens, []);
    const own = await ipc.callFrom(other, otherTab, "splitpage:video-file-grant", s.clip);
    assert.match(own, /^[0-9a-f]{32}$/);
    assert.notEqual(own, "tok", "the same file dropped in another tab gets that tab's own grant");
    assert.deepEqual(await ipc.call("splitpage:bundle-move", "tok", "bundle3"), { ok: true, name: "take one.mp4", outcome: "moved" });
    assert.equal(ipc.videoFileGrants.has(own), false, "a moved original leaves no grant in any tab");
  } finally { s.done(); }
});

test("a grant names one file: one put in its place at the same path is never moved away, and both are kept", async () => {
  const s = scratch();
  try {
    const ipc = harness({ script: s.script });
    const at = new Date(Math.floor(Date.now() / 1000) * 1000 - 3600000);
    fs.utimesSync(s.clip, at, at);
    const token = await ipc.call("splitpage:video-file-grant", s.clip);
    assert.match(token, /^[0-9a-f]{32}$/);
    const replacement = Buffer.alloc(SIZE, 7);
    fs.unlinkSync(s.clip);
    fs.writeFileSync(s.clip, replacement);
    fs.utimesSync(s.clip, at, at);
    assert.equal(fs.statSync(s.clip).size, SIZE, "the same size");
    assert.equal(fs.statSync(s.clip).mtimeMs, at.getTime(), "and the same modified time; Linux may even reuse the file id, so only the change time differs");
    assert.deepEqual(await ipc.call("splitpage:bundle-move", token, "bundle1"), { ok: true, name: "take one.mp4", outcome: "changed" });
    assert.deepEqual(fs.readFileSync(s.clip), replacement, "the file now at the path stays");
    assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one.mp4")), replacement);
    assert.notEqual(await ipc.call("splitpage:video-file-grant", s.clip), token, "a new grant for the new file");
  } finally { s.done(); }
});

test("a move that kept the original keeps its grant", async () => {
  const s = scratch();
  try {
    const ipc = harness({ script: s.script, grants: [["tok", s.clip]], copierOptions: { moveFile: busy, removeOriginal: busy } });
    assert.deepEqual(await ipc.call("splitpage:bundle-move", "tok", "bundle1"), { ok: true, name: "take one.mp4", outcome: "kept" });
    assert.equal(ipc.videoFileGrants.get("tok").path, s.clip);
  } finally { s.done(); }
});

test("after a Move, the script's old path link opens the file from its folder, by name and size, until the script is saved", async () => {
  const s = scratch();
  try {
    const ipc = harness({ script: s.script, grants: [["tok", s.clip]] });
    assert.deepEqual(await ipc.call("splitpage:bundle-move", "tok", "bundle1"), { ok: true, name: "take one.mp4", outcome: "moved" });
    assert.deepEqual(await ipc.call("splitpage:video-path-open", s.clip, SIZE), { ok: true });
    assert.deepEqual(ipc.testVideoOpens, [fs.realpathSync.native(path.join(s.folder, "take one.mp4"))]);
    assert.deepEqual(await ipc.call("splitpage:video-path-open", s.clip, SIZE - 1), { ok: false, code: "GONE" }, "another size is another file");
    assert.deepEqual(await ipc.call("splitpage:video-path-open", s.clip), { ok: false, code: "GONE" }, "no size, no fallback");
    const other = path.join(s.dir, "Other.splitpage");
    assert.deepEqual(await ipc.callAs({ id: "tab-b", source: { kind: "file", absPath: other } }, "splitpage:video-path-open", s.clip, SIZE), { ok: false, code: "GONE" },
      "another script's folder is not looked in");
    assert.deepEqual(await ipc.callAs({ id: "tab-c", source: { kind: "blank" } }, "splitpage:video-path-open", s.clip, SIZE), { ok: false, code: "GONE" });
    assert.equal(ipc.testVideoOpens.length, 1);
    fs.writeFileSync(path.join(s.drops, "tool.exe"), "MZ");
    assert.deepEqual(await ipc.call("splitpage:video-path-open", path.join(s.drops, "tool.exe"), 2), { ok: false, code: "REFUSED" }, "a refused path never falls back");
  } finally { s.done(); }
});

test("a move queued in one script is dropped once the tab has opened another, and a running one stays bound to its own script", async () => {
  const s = scratch();
  try {
    const second = path.join(s.drops, "second.mp4");
    fs.writeFileSync(second, s.bytes);
    let open = () => {};
    const ipc = harness({ script: s.script, grants: [["tok", s.clip], ["two", second]], holdMove: new Promise((resolve) => { open = resolve; }) });
    const first = ipc.call("splitpage:bundle-move", "tok", "bundle1");
    const queued = ipc.call("splitpage:bundle-move", "two", "bundle2");
    await new Promise((resolve) => setImmediate(resolve));
    const other = path.join(s.dir, "Other.splitpage");
    ipc.tab.source = { kind: "file", absPath: other };
    open();
    assert.deepEqual(await queued, { ok: false, code: "DROPPED" });
    assert.deepEqual(fs.readFileSync(second), s.bytes, "the dropped move left its original alone");
    assert.deepEqual(await first, { ok: true, name: "take one.mp4", outcome: "moved" });
    assert.ok(fs.existsSync(path.join(s.folder, "take one.mp4")), "the running move went into the script it was accepted for");
    assert.equal(fs.existsSync(path.join(s.dir, "Other files")), false, "and never into the other script's folder");
  } finally { s.done(); }
});

test("Cancel and Quit anyway stop a move before its publish, so the original is where it was", async () => {
  for (const how of ["cancel", "quit"]) {
    const s = scratch();
    try {
      let open = () => {};
      const ipc = harness({ script: s.script, grants: [["tok", s.clip]], copierOptions: { moveFile: exdev }, holdMove: new Promise((resolve) => { open = resolve; }) });
      const moving = ipc.call("splitpage:bundle-move", "tok", "bundle1");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(ipc.bundleJobs.busy(), true, how + ": a move counts as a running copy for the quit question");
      const stopping = how === "cancel" ? (ipc.send("splitpage:bundle-cancel", "bundle1"), Promise.resolve()) : ipc.bundleJobs.abortAll();
      open();
      await stopping;
      assert.deepEqual(await moving, { ok: false, code: "CANCELLED" }, how);
      assert.deepEqual(fs.readFileSync(s.clip), s.bytes, how);
      assert.equal(ipc.videoFileGrants.get("tok").path, s.clip, how + ": the grant stays with the original");
      assert.deepEqual(fs.existsSync(s.folder) ? fs.readdirSync(s.folder) : [], [], how);
    } finally { s.done(); }
  }
});

let failed = 0;
for (const { name, fn } of cases) {
  try { await fn(); console.log("ok   " + name); } catch (e) { failed++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); }
}
console.log((cases.length - failed) + "/" + cases.length + " passed");
if (failed) process.exit(1);
