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
    assert.deepEqual(await copier.carry(s.script, to, ["take one (2).mp4"], VIDEO_FILE_EXT, () => {}, live()), { ok: false, code: "CLASH", name: "take one (2).mp4", copied: 0 },
      "a carry keeps a different file of the same size and refuses the name");
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

test("Save As refuses the carry before writing anything when the new folder holds a different file of a linked name", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), Buffer.alloc(100, 1));
    fs.writeFileSync(path.join(s.folder, "b.mov"), Buffer.alloc(200, 2));
    const to = path.join(s.dir, "copy", "Episode 12 v2.splitpage");
    const toFolder = path.join(s.dir, "copy", "Episode 12 v2 files");
    fs.mkdirSync(toFolder, { recursive: true });
    fs.writeFileSync(path.join(toFolder, "b.mov"), "someone else's");
    assert.deepEqual(await copier.carry(s.script, to, ["a.mp4", "b.mov"], VIDEO_FILE_EXT, () => {}, live()), { ok: false, code: "CLASH", name: "b.mov", copied: 0 });
    assert.deepEqual(fs.readdirSync(toFolder), ["b.mov"], "nothing was copied before the clash was found");
    assert.equal(fs.readFileSync(path.join(toFolder, "b.mov"), "utf8"), "someone else's", "a different file of that name is left alone");
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
    const seen = [];
    const got = await copier.carry(s.script, to, ["a.mp4", "b.mov", "a.mp4", "missing.mp4", "..\\Episode 12.splitpage", "tool.exe"], VIDEO_FILE_EXT, (d, t) => seen.push([d, t]), live());
    assert.deepEqual(got, { ok: true, copied: 2, kept: 0, missing: 3 });
    assert.deepEqual(fs.readdirSync(toFolder).sort(), ["a.mp4", "b.mov"]);
    assert.deepEqual(fs.readFileSync(path.join(toFolder, "b.mov")), fs.readFileSync(path.join(s.folder, "b.mov")));
    assert.deepEqual(seen[seen.length - 1], [300, 300]);
    const again = await copier.carry(s.script, to, ["a.mp4"], VIDEO_FILE_EXT, () => {}, live());
    assert.deepEqual(again, { ok: true, copied: 0, kept: 1, missing: 0 }, "a copy already there is kept");
    assert.deepEqual(await copier.carry(s.script, s.script, ["a.mp4"], VIDEO_FILE_EXT, () => {}, live()), { ok: true, copied: 0, kept: 0, missing: 0 }, "same script");
    assert.deepEqual(await copier.carry(null, to, ["a.mp4"], VIDEO_FILE_EXT, () => {}, live()), { ok: true, copied: 0, kept: 0, missing: 0 }, "no earlier script");
  } finally { s.done(); }
});

test("carrying refuses a source that leads out of the old bundle folder", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    const to = path.join(s.dir, "New.splitpage");
    if (tryLink(s.clip, path.join(s.folder, "escape.mp4"), "file")) {
      assert.deepEqual(await copier.carry(s.script, to, ["escape.mp4"], VIDEO_FILE_EXT, () => {}, live()), { ok: true, copied: 0, kept: 0, missing: 1 });
      assert.equal(fs.existsSync(path.join(s.dir, "New files", "escape.mp4")), false);
    } else {
      console.log("  (file symlinks need a privilege this account lacks; the escaping-link case runs where they don't)");
    }
    const elsewhere = path.join(s.dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(s.folder, "a.mp4"), "a");
    assert.ok(tryLink(elsewhere, path.join(s.dir, "New files"), process.platform === "win32" ? "junction" : "dir"));
    assert.deepEqual(await copier.carry(s.script, to, ["a.mp4"], VIDEO_FILE_EXT, () => {}, live()), { ok: false, code: "FAILED", name: "a.mp4", copied: 0 });
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
    assert.deepEqual(got, { ok: false, code: "CANCELLED", name: "big.mp4", copied: 0 });
    assert.deepEqual(fs.readdirSync(path.join(s.dir, "New files")), []);
  } finally { s.done(); }
});

test("a copy is written under a temporary name and appears under its own name only once it is whole", async () => {
  const s = scratch();
  try {
    const big = path.join(s.drops, "big.mp4");
    fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024, 6));
    const during = [];
    const got = await copier.copyIn(big, s.script, VIDEO_FILE_EXT, (done, total) => {
      if (done < total) during.push(fs.readdirSync(s.folder));
    }, live());
    assert.deepEqual(got, { ok: true, name: "big.mp4" });
    assert.ok(during.length >= 1, "progress was seen while the copy ran");
    assert.ok(during.every((names) => !names.includes("big.mp4") && names.length === 1 && /^~splitpage-[0-9a-f]{16}\.part$/.test(names[0])),
      "while copying, only the temporary exists: " + JSON.stringify(during[0]));
    assert.deepEqual(fs.readdirSync(s.folder), ["big.mp4"], "the temporary is gone once the copy is published");
    assert.deepEqual(fs.readFileSync(path.join(s.folder, "big.mp4")), fs.readFileSync(big));
  } finally { s.done(); }
});

test("a temporary left by a copy that never finished is swept by the next copy into that folder, and nothing else is", async () => {
  const s = scratch();
  try {
    const stale = (at) => { fs.writeFileSync(at, "half"); const then = new Date(Date.now() - 3600 * 1000); fs.utimesSync(at, then, then); };
    fs.mkdirSync(s.folder);
    stale(path.join(s.folder, "~splitpage-0123456789abcdef.part"));
    const newer = path.join(s.folder, "~splitpage-aaaaaaaaaaaaaaaa.part");
    fs.writeFileSync(newer, "another job's");
    const later = new Date(Date.now() + 3600 * 1000);
    fs.utimesSync(newer, later, later);
    fs.writeFileSync(path.join(s.folder, "~splitpage-notes.part"), "someone's own file");
    fs.writeFileSync(path.join(s.folder, "kept.mp4"), "kept");
    assert.deepEqual(await copier.copyIn(s.clip, s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: true, name: "take one.mp4" });
    assert.deepEqual(fs.readdirSync(s.folder).sort(), ["kept.mp4", "take one.mp4", "~splitpage-aaaaaaaaaaaaaaaa.part", "~splitpage-notes.part"],
      "only a temporary older than this job is swept");
    fs.rmSync(newer);
    stale(path.join(s.folder, "~splitpage-fedcba9876543210.part"));
    const to = path.join(s.dir, "New.splitpage");
    fs.mkdirSync(path.join(s.dir, "New files"));
    stale(path.join(s.dir, "New files", "~splitpage-00000000ffffffff.part"));
    assert.deepEqual(await copier.carry(s.script, to, ["kept.mp4"], VIDEO_FILE_EXT, () => {}, live()), { ok: true, copied: 1, kept: 0, missing: 0 });
    assert.deepEqual(fs.readdirSync(path.join(s.dir, "New files")), ["kept.mp4"], "a carry sweeps the folder it writes into");
    assert.ok(fs.existsSync(path.join(s.folder, "~splitpage-fedcba9876543210.part")), "the folder it only reads from is left alone");
  } finally { s.done(); }
});

test("a cancelled carry leaves no temporary and nothing under the final name", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "big.mp4"), Buffer.alloc(32 * 1024 * 1024, 4));
    const ctl = new AbortController();
    let seen = null;
    const to = path.join(s.dir, "New.splitpage");
    const got = await copier.carry(s.script, to, ["big.mp4"], VIDEO_FILE_EXT, (done) => {
      if (done > 0 && !seen) { seen = fs.readdirSync(path.join(s.dir, "New files")); ctl.abort(); }
    }, ctl.signal);
    assert.deepEqual(got, { ok: false, code: "CANCELLED", name: "big.mp4", copied: 0 });
    assert.ok(seen && seen.length === 1 && seen[0] !== "big.mp4", "mid-copy the final name did not exist");
    assert.deepEqual(fs.readdirSync(path.join(s.dir, "New files")), []);
  } finally { s.done(); }
});

test("where hard links fail, the whole temporary is renamed onto an empty placeholder this job created, so no other file is ever replaced", async () => {
  const s = scratch();
  try {
    const eperm = async () => { throw Object.assign(new Error("no links here"), { code: "EPERM" }); };
    const before = [];
    const created = [];
    const renaming = createBundleCopier({
      bundleFiles, progressEveryMs: 0, link: eperm,
      openTarget: async (to) => { created.push(fs.existsSync(to)); return fs.promises.open(to, "wx"); },
      rename: async (from, to) => {
        before.push({ names: fs.readdirSync(path.dirname(to)).sort(), final: fs.statSync(to).size, part: fs.statSync(from).size });
        return fs.promises.rename(from, to);
      }
    });
    assert.deepEqual(await renaming.copyIn(s.clip, s.script, VIDEO_FILE_EXT, () => {}, live()), { ok: true, name: "take one.mp4" });
    assert.deepEqual(created, [false], "the final name is absent until the placeholder is created");
    assert.equal(before.length, 1);
    assert.equal(before[0].final, 0, "the final name holds only the empty placeholder, never part of the file");
    assert.equal(before[0].part, fs.statSync(s.clip).size, "the temporary is whole before the rename");
    assert.ok(before[0].names.length === 2 && before[0].names.includes("take one.mp4") && before[0].names.some((n) => /^~splitpage-[0-9a-f]{16}\.part$/.test(n)));
    assert.deepEqual(fs.readFileSync(path.join(s.folder, "take one.mp4")), fs.readFileSync(s.clip));
    assert.deepEqual(fs.readdirSync(s.folder), ["take one.mp4"], "the temporary is gone");
    const crashing = createBundleCopier({ bundleFiles, progressEveryMs: 0, link: eperm, rename: async () => { throw new Error("gone mid-rename"); } });
    const to = path.join(s.dir, "New.splitpage");
    assert.deepEqual(await crashing.carry(s.script, to, ["take one.mp4"], VIDEO_FILE_EXT, () => {}, live()), { ok: false, code: "FAILED", name: "take one.mp4", copied: 0 });
    assert.deepEqual(fs.readdirSync(path.join(s.dir, "New files")), [], "a failed rename removes its own placeholder and leaves no temporary");
    for (const [label, theirs] of [["a file with bytes", "another program's"], ["another empty file", ""]]) {
      const folder = path.join(s.dir, "Swap " + theirs.length + " files");
      const swapping = createBundleCopier({
        bundleFiles, progressEveryMs: 0, link: eperm,
        lstat: async (p) => { fs.renameSync(p, p + ".moved"); fs.writeFileSync(p, theirs); return fs.promises.lstat(p, { bigint: true }); }
      });
      assert.deepEqual(await swapping.carry(s.script, path.join(s.dir, "Swap " + theirs.length + ".splitpage"), ["take one.mp4"], VIDEO_FILE_EXT, () => {}, live()),
        { ok: false, code: "CLASH", name: "take one.mp4", copied: 0 }, label);
      assert.deepEqual(fs.readdirSync(folder).sort(), ["take one.mp4", "take one.mp4.moved"], label + ": only our temporary is deleted");
      assert.equal(fs.readFileSync(path.join(folder, "take one.mp4"), "utf8"), theirs, label + ": a placeholder swapped for another file is never overwritten");
    }
    fs.mkdirSync(path.join(s.dir, "Their files"));
    const appearing = createBundleCopier({
      bundleFiles, progressEveryMs: 0,
      link: async (_from, at) => { fs.writeFileSync(at, "another program's"); throw Object.assign(new Error("no links here"), { code: "EPERM" }); }
    });
    assert.deepEqual(await appearing.carry(s.script, path.join(s.dir, "Their.splitpage"), ["take one.mp4"], VIDEO_FILE_EXT, () => {}, live()),
      { ok: false, code: "CLASH", name: "take one.mp4", copied: 0 });
    assert.deepEqual(fs.readdirSync(path.join(s.dir, "Their files")), ["take one.mp4"]);
    assert.equal(fs.readFileSync(path.join(s.dir, "Their files", "take one.mp4"), "utf8"), "another program's", "a file that appeared before the create is untouched");
    fs.mkdirSync(path.join(s.dir, "Late files"));
    const racing = createBundleCopier({
      bundleFiles, progressEveryMs: 0,
      link: async (_from, at) => { fs.writeFileSync(at, "another program's"); throw Object.assign(new Error("exists"), { code: "EEXIST" }); }
    });
    assert.deepEqual(await racing.carry(s.script, path.join(s.dir, "Late.splitpage"), ["take one.mp4"], VIDEO_FILE_EXT, () => {}, live()),
      { ok: false, code: "CLASH", name: "take one.mp4", copied: 0 });
    assert.deepEqual(fs.readdirSync(path.join(s.dir, "Late files")), ["take one.mp4"], "the link never replaces a file that appeared meanwhile");
    assert.equal(fs.readFileSync(path.join(s.dir, "Late files", "take one.mp4"), "utf8"), "another program's");
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
