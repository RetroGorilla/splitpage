import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createShellIpc } = require(path.join(here, "..", "ipc-shell.ts"));
const { VIDEO_FILE_EXT } = require(path.join(here, "..", "..", "shared", "video-path.ts"));
const { openableVideoPath } = require(path.join(here, "..", "..", "shared", "video-embed.ts"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function shellIpc(testMode) {
  const handlers = new Map();
  const openedPaths = [];
  const testVideoOpens = [];
  const { registerShellIpc } = createShellIpc({
    shell: { openPath: async (p) => { openedPaths.push(p); return ""; }, openExternal: async () => {} },
    testMode, testVideoOpens, videoFileGrants: new Map(), VIDEO_FILE_EXT, openableVideoPath
  });
  registerShellIpc({ ipcHandle: (name, fn) => { handlers.set(name, fn); }, ipcOn: () => {}, ipcOnSync: () => {} });
  const open = handlers.get("splitpage:video-path-open");
  assert.equal(typeof open, "function", "the shell group registers the stored-path channel");
  return { open: (p) => open({}, p), openedPaths, testVideoOpens };
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-video-path-open-"));
  const clip = path.join(dir, "take one.mp4");
  fs.writeFileSync(clip, Buffer.alloc(32, 1));
  fs.writeFileSync(path.join(dir, "tool.exe"), "MZ");
  fs.writeFileSync(path.join(dir, "take one.lnk"), "L");
  fs.writeFileSync(path.join(dir, "run.ps1"), "Write-Host");
  fs.mkdirSync(path.join(dir, "folder.mp4"));
  return { dir, clip, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a stored path to a video file opens with the system's player, at the file's real path", async () => {
  const s = scratch();
  try {
    const ipc = shellIpc(false);
    assert.deepEqual(await ipc.open(s.clip), { ok: true });
    assert.deepEqual(ipc.openedPaths, [fs.realpathSync.native(s.clip)]);
  } finally { s.done(); }
});

test("every refused path answers without opening anything", async () => {
  const s = scratch();
  try {
    const ipc = shellIpc(false);
    const sep = path.sep;
    const refused = {
      "an executable": path.join(s.dir, "tool.exe"),
      "a shortcut": path.join(s.dir, "take one.lnk"),
      "a script": path.join(s.dir, "run.ps1"),
      "a directory named like a video": path.join(s.dir, "folder.mp4"),
      "a relative path": "take one.mp4",
      "a path that climbs out with ..": [s.dir, "..", path.basename(s.dir), "take one.mp4"].join(sep),
      "a network share": process.platform === "win32" ? "\\\\localhost\\c$\\take one.mp4" : "//localhost/take one.mp4",
      "a device path": process.platform === "win32" ? "\\\\?\\" + s.clip : "/dev/null.mp4",
      "not a string": 42,
      "nothing": ""
    };
    for (const [why, p] of Object.entries(refused)) {
      const got = await ipc.open(p);
      assert.equal(got.ok, false, why);
      assert.ok(got.code === "REFUSED" || got.code === "GONE", why + ": " + got.code);
    }
    assert.deepEqual(await ipc.open(path.join(s.dir, "missing.mp4")), { ok: false, code: "GONE" }, "a file no longer there");
    let linked = false;
    try { fs.symlinkSync(path.join(s.dir, "tool.exe"), path.join(s.dir, "disguised.mp4"), "file"); linked = true; } catch { }
    if (linked) assert.deepEqual(await ipc.open(path.join(s.dir, "disguised.mp4")), { ok: false, code: "REFUSED" }, "a .mp4 link to an executable");
    else console.log("  (symlinks need a privilege this account lacks; the disguised-link case runs where they don't)");
    assert.deepEqual(ipc.openedPaths, [], "the system was never asked to open anything");
  } finally { s.done(); }
});

test("in test mode the opened path is recorded instead of handed to the system", async () => {
  const s = scratch();
  try {
    const ipc = shellIpc(true);
    assert.deepEqual(await ipc.open(s.clip), { ok: true });
    assert.deepEqual(ipc.openedPaths, []);
    assert.deepEqual(ipc.testVideoOpens, [fs.realpathSync.native(s.clip)]);
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
