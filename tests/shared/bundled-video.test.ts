import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundleFolderOf, bundledNamesInProject, linkBundledInProject, numberedName, resolveBundledFile } from "../../shared/video-embed.ts";
import { BUNDLED_NAME_MAX, VIDEO_FILE_EXT, bundleFolderName, bundledNameProblem } from "../../shared/video-path.ts";

const FOLD_CASE = process.platform === "win32";

test("a bundled name is one plain file name that means the same on every system", () => {
  for (const ok of ["take one.mp4", "Take 2 (final).MOV", "clip.webm", "a.b.c.mkv", ".hidden.mp4", "été.mp4"]) {
    assert.equal(bundledNameProblem(ok), null, ok);
  }
  const refused: Record<string, unknown> = {
    "a backslash": "..\\take.mp4",
    "a slash": "../take.mp4",
    "a nested folder": "sub/take.mp4",
    "an absolute Windows path": "C:\\take.mp4",
    "a drive letter": "C:take.mp4",
    "a UNC path": "\\\\server\\share\\take.mp4",
    "an absolute POSIX path": "/etc/take.mp4",
    "dot": ".",
    "dot dot": "..",
    "a trailing dot": "take.mp4.",
    "a trailing space": "take.mp4 ",
    "an alternate data stream": "take.mp4:secret",
    "a wildcard": "*.mp4",
    "a reserved device name": "CON.mp4",
    "a COM port": "com1.mp4",
    "a control character": "a\u0007.mp4",
    "too long": "x".repeat(BUNDLED_NAME_MAX) + ".mp4",
    "empty": "",
    "not a string": 5,
    "null": null,
    "an array": ["take.mp4"]
  };
  for (const [why, name] of Object.entries(refused)) assert.notEqual(bundledNameProblem(name), null, why);
});

test("the bundle folder sits beside the script and is named after it", () => {
  assert.equal(bundleFolderName("Episode 12.splitpage"), "Episode 12 files");
  assert.equal(bundleFolderName("notes.v2.md"), "notes.v2 files");
  assert.equal(bundleFolderName("plain"), "plain files");
  assert.equal(bundleFolderName(".splitpage"), ".splitpage files");
  assert.equal(bundleFolderName("trailing. .splitpage"), "trailing files");
  assert.equal(bundleFolderName(""), "Script files");
  assert.equal(bundleFolderOf(path.join("work", "Episode 12.splitpage"), path), path.join("work", "Episode 12 files"));
});

test("a taken name gets the next free number before its extension", () => {
  assert.equal(numberedName("take one.mp4", 1), "take one.mp4");
  assert.equal(numberedName("take one.mp4", 2), "take one (2).mp4");
  assert.equal(numberedName("a.b.mkv", 3), "a.b (3).mkv");
  assert.equal(numberedName("noext", 2), "noext (2)");
  assert.equal(numberedName(".hidden", 2), ".hidden (2)");
});

function scratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "splitpage-bundle-"));
  const script = path.join(dir, "Episode 12.splitpage");
  const folder = path.join(dir, "Episode 12 files");
  writeFileSync(script, "{}");
  mkdirSync(folder);
  writeFileSync(path.join(folder, "take one.mp4"), Buffer.alloc(16, 1));
  writeFileSync(path.join(folder, "tool.exe"), "MZ");
  mkdirSync(path.join(folder, "folder.mp4"));
  writeFileSync(path.join(dir, "outside.mp4"), Buffer.alloc(16, 2));
  return { dir, script, folder, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a bundled name resolves inside the script's bundle folder, to a regular video file", async (t) => {
  const s = scratch();
  t.after(s.done);
  const resolve = (name: unknown) => resolveBundledFile(s.script, name, VIDEO_FILE_EXT, fsp, path, FOLD_CASE);
  assert.deepEqual(await resolve("take one.mp4"), { ok: true, path: await fsp.realpath(path.join(s.folder, "take one.mp4")) });
  assert.deepEqual(await resolve("missing.mp4"), { ok: false, code: "GONE" });
  assert.deepEqual(await resolve("folder.mp4"), { ok: false, code: "REFUSED" }, "a directory");
  assert.deepEqual(await resolve("tool.exe"), { ok: false, code: "REFUSED" }, "not on the allowlist");
  assert.deepEqual(await resolve("..\\outside.mp4"), { ok: false, code: "REFUSED" }, "Windows traversal");
  assert.deepEqual(await resolve("../outside.mp4"), { ok: false, code: "REFUSED" }, "POSIX traversal");
  assert.deepEqual(await resolve(path.join(s.dir, "outside.mp4")), { ok: false, code: "REFUSED" }, "absolute");
  assert.deepEqual(await resolve("\\\\localhost\\c$\\outside.mp4"), { ok: false, code: "REFUSED" }, "UNC");
  rmSync(s.folder, { recursive: true, force: true });
  assert.deepEqual(await resolve("take one.mp4"), { ok: false, code: "GONE" }, "no bundle folder");
});

test("a link inside the bundle folder may not lead out of it", async (t) => {
  const s = scratch();
  t.after(s.done);
  const resolve = (name: unknown) => resolveBundledFile(s.script, name, VIDEO_FILE_EXT, fsp, path, FOLD_CASE);
  let linked = false;
  try { symlinkSync(path.join(s.dir, "outside.mp4"), path.join(s.folder, "escape.mp4"), "file"); linked = true; } catch { }
  if (linked) {
    assert.deepEqual(await resolve("escape.mp4"), { ok: false, code: "REFUSED" }, "a file link to a video outside the folder");
    symlinkSync(path.join(s.folder, "tool.exe"), path.join(s.folder, "disguised.mp4"), "file");
    assert.deepEqual(await resolve("disguised.mp4"), { ok: false, code: "REFUSED" }, "a .mp4 link to an executable");
  } else {
    t.diagnostic("file symlinks need a privilege this account lacks; the file-link cases are unchecked here");
  }
  const elsewhere = path.join(s.dir, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(path.join(elsewhere, "take one.mp4"), Buffer.alloc(16, 3));
  rmSync(s.folder, { recursive: true, force: true });
  symlinkSync(elsewhere, s.folder, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await resolve("take one.mp4"), { ok: false, code: "REFUSED" }, "a bundle folder that is a junction or link");
});

test("no disk access happens for a name the rules refuse", async () => {
  const touched: string[] = [];
  const fs = {
    realpath: async (p: string) => { touched.push(p); return p; },
    stat: async (p: string) => { touched.push(p); return { isFile: () => true }; },
    lstat: async (p: string) => { touched.push(p); return { isDirectory: () => true, isSymbolicLink: () => false }; }
  };
  for (const name of ["..\\x.mp4", "x.exe", "C:\\x.mp4", "/x.mp4", "", "CON.mp4"]) {
    assert.deepEqual(await resolveBundledFile("C:\\w\\s.splitpage", name, VIDEO_FILE_EXT, fs, path.win32, true), { ok: false, code: "REFUSED" }, name);
  }
  assert.deepEqual(touched, []);
});

test("where the file really is decides, with case folded only where the system folds it", async () => {
  const at = (real: string) => ({
    realpath: async (p: string) => p.endsWith("files") ? "C:\\W\\S files" : real,
    stat: async () => ({ isFile: () => true }),
    lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false })
  });
  assert.deepEqual(await resolveBundledFile("C:\\w\\S.splitpage", "a.mp4", VIDEO_FILE_EXT, at("c:\\w\\s files\\A.mp4"), path.win32, true), { ok: true, path: "c:\\w\\s files\\A.mp4" });
  assert.deepEqual(await resolveBundledFile("C:\\w\\S.splitpage", "a.mp4", VIDEO_FILE_EXT, at("C:\\W\\other\\a.mp4"), path.win32, true), { ok: false, code: "REFUSED" });
  assert.deepEqual(await resolveBundledFile("C:\\w\\S.splitpage", "a.mp4", VIDEO_FILE_EXT, at("C:\\W\\S files\\a.exe"), path.win32, true), { ok: false, code: "REFUSED" });
  const posix = {
    realpath: async (p: string) => p.endsWith("files") ? "/w/S files" : "/w/s files/a.mp4",
    stat: async () => ({ isFile: () => true }),
    lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false })
  };
  assert.deepEqual(await resolveBundledFile("/w/S.splitpage", "a.mp4", VIDEO_FILE_EXT, posix, path.posix, false), { ok: false, code: "REFUSED" }, "case matters on POSIX");
  const denied = {
    realpath: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    stat: async () => ({ isFile: () => true }),
    lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false })
  };
  assert.deepEqual(await resolveBundledFile("C:\\w\\S.splitpage", "a.mp4", VIDEO_FILE_EXT, denied, path.win32, true), { ok: false, code: "REFUSED" }, "unreadable is not gone");
});

test("the rules take any allowlist, so other kinds of file can be bundled the same way", async (t) => {
  const s = scratch();
  t.after(s.done);
  writeFileSync(path.join(s.folder, "brief.pdf"), "%PDF");
  assert.deepEqual(await resolveBundledFile(s.script, "brief.pdf", VIDEO_FILE_EXT, fsp, path, FOLD_CASE), { ok: false, code: "REFUSED" });
  assert.equal((await resolveBundledFile(s.script, "brief.pdf", /\.pdf$/i, fsp, path, FOLD_CASE)).ok, true);
});

test("linking bundled names to paths rewrites only those locations, in the same layout the writers use", () => {
  const record = { title: "T", rows: [{ id: "r1", imageLinks: [
    { name: "a.mp4", size: 4, location: { kind: "bundled", name: "a.mp4" } },
    { name: "b.mp4", size: 4, location: { kind: "bundled", name: "b.mp4" } },
    { name: "c.mp4", size: 4, location: { kind: "path", path: "C:\\c.mp4" } }
  ] }] };
  const json = JSON.stringify(record, null, 2);
  const paths = new Map([["a.mp4", "D:\\Episode 12 files\\a.mp4"]]);
  const out = linkBundledInProject(json, paths);
  const expected = { ...record, rows: [{ ...record.rows[0], imageLinks: [
    { name: "a.mp4", size: 4, location: { kind: "path", path: "D:\\Episode 12 files\\a.mp4" } },
    ...(record.rows[0] as { imageLinks: unknown[] }).imageLinks.slice(1)
  ] }] };
  assert.equal(out, JSON.stringify(expected, null, 2), "a .splitpage file changes only in the rewritten location");
  assert.deepEqual(bundledNamesInProject(out as string), ["b.mp4"]);
  assert.equal(linkBundledInProject(json, new Map()), null, "nothing to link changes nothing");
  assert.equal(linkBundledInProject(json, new Map([["gone.mp4", "D:\\gone.mp4"]])), null);
  const table = "| Visual | Audio |\n| --- | --- |\n| a | ~~~~splitpage |\n";
  const md = table + "\n<!-- note -->\n~~~~splitpage\n" + json + "\n~~~~\n";
  const linked = linkBundledInProject(md, paths) as string;
  assert.ok(linked.startsWith(table + "\n<!-- note -->\n~~~~splitpage\n"), "the table and note above the block are kept");
  assert.ok(linked.endsWith("\n~~~~\n"));
  assert.deepEqual(bundledNamesInProject(linked), ["b.mp4"], "the reader finds the rewritten block");
  const tilde = linkBundledInProject(md, new Map([["a.mp4", "D:\\odd~~~~~~folder\\a.mp4"]])) as string;
  assert.ok(tilde.includes("\n~~~~~~~splitpage\n") && tilde.endsWith("\n~~~~~~~\n"), "the fence grows past a run of tildes in a path");
  assert.equal(linkBundledInProject("not a project", paths), null);
});
