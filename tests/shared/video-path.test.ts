import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VIDEO_PATH_MAX, isStoredVideoPath, videoPathProblem } from "../../shared/video-path.ts";
import { openableVideoPath } from "../../shared/video-embed.ts";

test("a Windows path must be a local drive path to a video file, with nothing Windows would reinterpret", () => {
  for (const ok of ["C:\\Videos\\take one.mp4", "z:\\a\\b\\c.MOV", "D:\\x.webm"]) assert.equal(videoPathProblem(ok, "win32"), null, ok);
  const refused: Record<string, string> = {
    "UNC share": "\\\\server\\share\\take.mp4",
    "device namespace": "\\\\?\\C:\\take.mp4",
    "device": "\\\\.\\PhysicalDrive0\\x.mp4",
    "root-relative": "\\Videos\\take.mp4",
    "relative": "Videos\\take.mp4",
    "drive-relative": "C:take.mp4",
    "forward slashes": "C:/Videos/take.mp4",
    "traversal": "C:\\Videos\\..\\Windows\\take.mp4",
    "a dot segment": "C:\\.\\take.mp4",
    "an empty segment": "C:\\Videos\\\\take.mp4",
    "an executable": "C:\\Windows\\System32\\calc.exe",
    "a script": "C:\\x\\run.ps1",
    "a batch file": "C:\\x\\run.bat",
    "a shortcut": "C:\\x\\take.lnk",
    "a URL shortcut": "C:\\x\\take.url",
    "a video name hiding a shortcut": "C:\\x\\take.mp4.lnk",
    "an alternate data stream": "C:\\x\\run.exe:take.mp4",
    "a reserved device name": "C:\\x\\CON.mp4",
    "a COM port": "C:\\x\\com1.mp4",
    "a trailing dot": "C:\\x.\\take.mp4",
    "a trailing space": "C:\\x \\take.mp4",
    "a wildcard": "C:\\x\\*.mp4",
    "a control character": "C:\\x\\a\u0007.mp4",
    "too long": "C:\\" + "x".repeat(VIDEO_PATH_MAX) + ".mp4",
    "empty": ""
  };
  for (const [why, p] of Object.entries(refused)) assert.notEqual(videoPathProblem(p, "win32"), null, why);
  for (const bad of [null, undefined, 5, {}, ["C:\\a.mp4"]]) assert.notEqual(videoPathProblem(bad, "win32"), null, String(bad));
});

test("a POSIX path must be absolute and local, with no . or .. part", () => {
  assert.equal(videoPathProblem("/Users/adam/Movies/take one.mov", "posix"), null);
  for (const p of ["Movies/take.mov", "./take.mov", "//server/share/take.mov", "/a/../take.mov", "/a/./take.mov", "/a//take.mov", "/a/take.sh", "/a/take.desktop", "/a/b\u0000.mov", "C:\\take.mp4"]) {
    assert.notEqual(videoPathProblem(p, "posix"), null, p);
  }
});

test("a document may store either platform's path, so a script moved between computers keeps it", () => {
  assert.equal(isStoredVideoPath("C:\\Videos\\take.mp4"), true);
  assert.equal(isStoredVideoPath("/Users/adam/take.mov"), true);
  assert.equal(isStoredVideoPath("\\\\server\\share\\take.mp4"), false);
  assert.equal(isStoredVideoPath("take.mp4"), false);
});

const STYLE = process.platform === "win32" ? "win32" : "posix";

test("opening checks the disk: it must be there, be a regular file, and stay a video file once links are followed", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "splitpage-video-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clip = path.join(dir, "take one.mp4");
  writeFileSync(clip, Buffer.alloc(16, 1));
  writeFileSync(path.join(dir, "tool.exe"), "MZ");
  mkdirSync(path.join(dir, "folder.mp4"));
  const real = await fsp.realpath(clip);
  assert.deepEqual(await openableVideoPath(clip, STYLE, fsp), { ok: true, path: real });
  assert.deepEqual(await openableVideoPath(path.join(dir, "missing.mp4"), STYLE, fsp), { ok: false, code: "GONE" });
  assert.deepEqual(await openableVideoPath(path.join(dir, "folder.mp4"), STYLE, fsp), { ok: false, code: "REFUSED" }, "a directory");
  assert.deepEqual(await openableVideoPath(path.join(dir, "tool.exe"), STYLE, fsp), { ok: false, code: "REFUSED" }, "an executable that exists");
  assert.deepEqual(await openableVideoPath([dir, "..", path.basename(dir), "take one.mp4"].join(path.sep), STYLE, fsp), { ok: false, code: "REFUSED" }, "traversal");
  assert.deepEqual(await openableVideoPath("take one.mp4", STYLE, fsp), { ok: false, code: "REFUSED" }, "relative");
  assert.deepEqual(await openableVideoPath(STYLE === "win32" ? "\\\\localhost\\c$\\take.mp4" : "//localhost/take.mp4", STYLE, fsp), { ok: false, code: "REFUSED" }, "network");
  let linked = false;
  try { symlinkSync(path.join(dir, "tool.exe"), path.join(dir, "disguised.mp4"), "file"); linked = true; } catch { }
  if (!linked) { t.diagnostic("symlinks need a privilege this account lacks; the disguised-link case is unchecked here"); return; }
  assert.deepEqual(await openableVideoPath(path.join(dir, "disguised.mp4"), STYLE, fsp), { ok: false, code: "REFUSED" }, "a .mp4 link to an executable");
  symlinkSync(clip, path.join(dir, "alias.mp4"), "file");
  assert.deepEqual(await openableVideoPath(path.join(dir, "alias.mp4"), STYLE, fsp), { ok: true, path: real }, "a link to a video opens the video it points at");
});

test("no disk access happens for a path the rules refuse", async () => {
  const touched: string[] = [];
  const fs = {
    realpath: async (p: string) => { touched.push(p); return p; },
    stat: async (p: string) => { touched.push(p); return { isFile: () => true }; }
  };
  for (const p of ["\\\\attacker\\share\\x.mp4", "C:\\x\\a.exe", "x.mp4", "/a/../b.mp4"]) {
    assert.deepEqual(await openableVideoPath(p, p.charAt(0) === "/" ? "posix" : "win32", fs), { ok: false, code: "REFUSED" }, p);
  }
  assert.deepEqual(touched, []);
});

test("where a link leads decides: a link to an executable is refused, a mapped drive's share opens", async () => {
  const leadsTo = (target: string) => ({ realpath: async () => target, stat: async () => ({ isFile: () => true }) });
  assert.deepEqual(await openableVideoPath("C:\\x\\disguised.mp4", "win32", leadsTo("C:\\x\\tool.exe")), { ok: false, code: "REFUSED" });
  assert.deepEqual(await openableVideoPath("/x/disguised.mp4", "posix", leadsTo("/x/tool.sh")), { ok: false, code: "REFUSED" });
  assert.deepEqual(await openableVideoPath("Z:\\Clips\\take.mp4", "win32", leadsTo("\\\\nas\\clips\\take.mp4")), { ok: true, path: "\\\\nas\\clips\\take.mp4" });
  const denied = { realpath: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, stat: async () => ({ isFile: () => true }) };
  assert.deepEqual(await openableVideoPath("C:\\x\\take.mp4", "win32", denied), { ok: false, code: "REFUSED" }, "unreadable is not gone");
});
