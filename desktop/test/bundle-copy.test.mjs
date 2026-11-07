import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createBundleCopier } = require(path.join(here, "..", "bundle-copy.ts"));
const bundleFiles = require(path.join(here, "..", "..", "shared", "video-embed.ts"));
const { VIDEO_FILE_EXT } = require(path.join(here, "..", "..", "shared", "video-path.ts"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const copier = createBundleCopier({ bundleFiles, progressEveryMs: 0 });
const live = () => new AbortController().signal;

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-bundle-copy-"));
  const script = path.join(dir, "Episode 12.splitpage");
  const folder = path.join(dir, "Episode 12 files");
  const drops = path.join(dir, "drops");
  fs.mkdirSync(drops);
  fs.writeFileSync(script, "{}");
  const clip = path.join(drops, "take one.mp4");
  fs.writeFileSync(clip, Buffer.alloc(4096, 7));
  return { dir, script, folder, drops, clip, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function tryLink(target, at, type) {
  try { fs.symlinkSync(target, at, type); return true; } catch { return false; }
}

test("a dropped file is copied into a folder beside the script, named after it, with progress up to its size", async () => {
  const s = scratch();
  try {
    const seen = [];
    const got = await copier.copyIn(s.clip, s.script, VIDEO_FILE_EXT, (done, total) => seen.push([done, total]), live());
    assert.deepEqual(got, { ok: true, name: "take one.mp4" });
    assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one.mp4")), fs.readFileSync(s.clip));
    assert.ok(seen.length >= 1, "progress was reported");
    assert.deepEqual(seen[seen.length - 1], [4096, 4096]);
    assert.ok(fs.existsSync(s.clip), "the original stays where it was");
  } finally { s.done(); }
});

test("a different file with a taken name gets a numbered name, and nothing is overwritten", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "take one.mp4"), "other");
    fs.writeFileSync(path.join(s.folder, "take one (2).mp4"), "other too");
    assert.deepEqual(await copier.copyIn(s.clip, s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: true, name: "take one (3).mp4" });
    assert.equal(fs.readFileSync(path.join(s.folder, "take one.mp4"), "utf8"), "other");
    assert.equal(fs.readFileSync(path.join(s.folder, "take one (2).mp4"), "utf8"), "other too");
    assert.equal(fs.statSync(path.join(s.folder, "take one (3).mp4")).size, 4096);
  } finally { s.done(); }
});

test("the same file dropped again, or a file already in the folder, links to the copy that is there", async () => {
  const s = scratch();
  try {
    assert.deepEqual(await copier.copyIn(s.clip, s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: true, name: "take one.mp4" });
    assert.deepEqual(await copier.copyIn(s.clip, s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: true, name: "take one.mp4" }, "same name and size");
    assert.deepEqual(fs.readdirSync(s.folder), ["take one.mp4"]);
    const inside = path.join(s.folder, "already here.mp4");
    fs.writeFileSync(inside, "x");
    assert.deepEqual(await copier.copyIn(inside, s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: true, name: "already here.mp4" });
    assert.deepEqual(fs.readdirSync(s.folder).sort(), ["already here.mp4", "take one.mp4"]);
  } finally { s.done(); }
});

test("a different video of the same name and size is never taken for the dropped one", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    const lookalike = Buffer.alloc(4096, 7);
    lookalike[4095] = 8;
    fs.writeFileSync(path.join(s.folder, "take one.mp4"), lookalike);
    assert.deepEqual(await copier.copyIn(s.clip, s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: true, name: "take one (2).mp4" });
    assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one.mp4")), lookalike, "the other video is untouched");
    assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one (2).mp4")), fs.readFileSync(s.clip));
    const to = path.join(s.dir, "copy", "Episode 12 v2.splitpage");
    fs.mkdirSync(path.join(s.dir, "copy", "Episode 12 v2 files"), { recursive: true });
    fs.writeFileSync(path.join(s.dir, "copy", "Episode 12 v2 files", "take one (2).mp4"), lookalike);
    assert.deepEqual(await copier.carry(s.script, to, ["take one (2).mp4"], VIDEO_FILE_EXT, () => {}, live()), { ok: true, copied: 0, kept: 0, failed: 1 },
      "a carry keeps a different file of the same size and counts the name as not copied");
    assert.deepEqual(fs.readFileSync(path.join(s.dir, "copy", "Episode 12 v2 files", "take one (2).mp4")), lookalike);
  } finally { s.done(); }
});

test("a file that is not on the allowlist, gone, or a directory is refused before anything is written", async () => {
  const s = scratch();
  try {
    const tool = path.join(s.drops, "tool.exe");
    fs.writeFileSync(tool, "MZ");
    fs.mkdirSync(path.join(s.drops, "folder.mp4"));
    assert.deepEqual(await copier.copyIn(tool, s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: false, code: "REFUSED" });
    assert.deepEqual(await copier.copyIn(path.join(s.drops, "folder.mp4"), s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: false, code: "REFUSED" });
    assert.deepEqual(await copier.copyIn(path.join(s.drops, "missing.mp4"), s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: false, code: "GONE" });
    assert.equal(fs.existsSync(s.folder), false, "no folder was made");
    assert.equal((await copier.copyIn(tool, s.script, /\.exe$/i, () => {}, live())).ok, true, "the allowlist is the caller's");
  } finally { s.done(); }
});

test("a video name that is a link to a file off the allowlist is refused, and one to a video copies the real file", async () => {
  const s = scratch();
  try {
    const tool = path.join(s.drops, "tool.exe");
    fs.writeFileSync(tool, "MZ");
    const alias = path.join(s.drops, "alias.mp4");
    if (!tryLink(tool, alias, "file")) {
      console.log("  (file symlinks need a privilege this account lacks; the link case runs where they don't)");
      return;
    }
    assert.deepEqual(await copier.copyIn(alias, s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: false, code: "REFUSED" });
    assert.equal(fs.existsSync(s.folder), false, "nothing was written");
    const toVideo = path.join(s.drops, "shortcut.mp4");
    assert.ok(tryLink(s.clip, toVideo, "file"));
    assert.deepEqual(await copier.copyIn(toVideo, s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: true, name: "shortcut.mp4" });
    const copied = path.join(s.folder, "shortcut.mp4");
    assert.equal(fs.lstatSync(copied).isSymbolicLink(), false, "the copy is the video's bytes, not another link");
    assert.deepEqual(fs.readFileSync(copied), fs.readFileSync(s.clip));
  } finally { s.done(); }
});

test("a bundle folder that is a link or junction is never written through", async () => {
  const s = scratch();
  try {
    const elsewhere = path.join(s.dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    assert.ok(tryLink(elsewhere, s.folder, process.platform === "win32" ? "junction" : "dir"), "a junction or directory link can be made");
    assert.deepEqual(await copier.copyIn(s.clip, s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: false, code: "REFUSED" });
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally { s.done(); }
});

test("cancelling stops the copy and removes the part written", async () => {
  const s = scratch();
  try {
    const big = path.join(s.drops, "big.mp4");
    fs.writeFileSync(big, Buffer.alloc(32 * 1024 * 1024, 3));
    const ctl = new AbortController();
    const got = await copier.copyIn(big, s.script, VIDEO_FILE_EXT, () => ctl.abort(), ctl.signal);
    assert.deepEqual(got, { ok: false, code: "CANCELLED" });
    assert.deepEqual(fs.readdirSync(s.folder), [], "the partial copy is gone");
    const early = new AbortController();
    early.abort();
    assert.deepEqual(await copier.copyIn(big, s.script, VIDEO_FILE_EXT, () => {}, early.signal), { ok: false, code: "CANCELLED" });
    assert.deepEqual(fs.readdirSync(s.folder), []);
  } finally { s.done(); }
});

test("Save As carries the named bundled files to the new script's folder, never overwriting", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), Buffer.alloc(100, 1));
    fs.writeFileSync(path.join(s.folder, "b.mov"), Buffer.alloc(200, 2));
    fs.writeFileSync(path.join(s.folder, "unlinked.mp4"), Buffer.alloc(50, 3));
    const other = path.join(s.dir, "copy");
    fs.mkdirSync(other);
    const to = path.join(other, "Episode 12 v2.splitpage");
    const toFolder = path.join(other, "Episode 12 v2 files");
    fs.mkdirSync(toFolder);
    fs.writeFileSync(path.join(toFolder, "b.mov"), "someone else's");
    const seen = [];
    const got = await copier.carry(s.script, to, ["a.mp4", "b.mov", "a.mp4", "missing.mp4", "..\\Episode 12.splitpage", "tool.exe"], VIDEO_FILE_EXT, (d, t) => seen.push([d, t]), live());
    assert.deepEqual(got, { ok: true, copied: 1, kept: 0, failed: 4 });
    assert.deepEqual(fs.readdirSync(toFolder).sort(), ["a.mp4", "b.mov"]);
    assert.equal(fs.readFileSync(path.join(toFolder, "b.mov"), "utf8"), "someone else's", "a different file of that name is left alone");
    assert.deepEqual(seen[seen.length - 1], [100, 300]);
    const again = await copier.carry(s.script, to, ["a.mp4"], VIDEO_FILE_EXT, () => {}, live());
    assert.deepEqual(again, { ok: true, copied: 0, kept: 1, failed: 0 }, "a copy already there is kept");
    assert.deepEqual(await copier.carry(s.script, s.script, ["a.mp4"], VIDEO_FILE_EXT, () => {}, live()), { ok: true, copied: 0, kept: 0, failed: 0 }, "same script");
    assert.deepEqual(await copier.carry(null, to, ["a.mp4"], VIDEO_FILE_EXT, () => {}, live()), { ok: true, copied: 0, kept: 0, failed: 0 }, "no earlier script");
  } finally { s.done(); }
});

test("carrying refuses a source that leads out of the old bundle folder", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    const to = path.join(s.dir, "New.splitpage");
    if (tryLink(s.clip, path.join(s.folder, "escape.mp4"), "file")) {
      assert.deepEqual(await copier.carry(s.script, to, ["escape.mp4"], VIDEO_FILE_EXT, () => {}, live()), { ok: true, copied: 0, kept: 0, failed: 1 });
      assert.equal(fs.existsSync(path.join(s.dir, "New files", "escape.mp4")), false);
    } else {
      console.log("  (file symlinks need a privilege this account lacks; the escaping-link case runs where they don't)");
    }
    const elsewhere = path.join(s.dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "a");
    assert.ok(tryLink(elsewhere, path.join(s.dir, "New files"), process.platform === "win32" ? "junction" : "dir"));
    assert.deepEqual(await copier.carry(s.script, to, ["a.mp4"], VIDEO_FILE_EXT, () => {}, live()), { ok: true, copied: 0, kept: 0, failed: 1 });
    assert.deepEqual(fs.readdirSync(elsewhere), [], "a destination folder that is a junction is not written through");
  } finally { s.done(); }
});

test("cancelling a carry stops it", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "big.mp4"), Buffer.alloc(32 * 1024 * 1024, 4));
    const ctl = new AbortController();
    const to = path.join(s.dir, "New.splitpage");
    const got = await copier.carry(s.script, to, ["big.mp4"], VIDEO_FILE_EXT, () => ctl.abort(), ctl.signal);
    assert.deepEqual(got, { ok: false, code: "CANCELLED", copied: 0 });
    assert.deepEqual(fs.readdirSync(path.join(s.dir, "New files")), []);
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
