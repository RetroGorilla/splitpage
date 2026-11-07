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
const { createBundleJobs } = require(path.join(here, "..", "bundle-jobs.ts"));
const bundleFiles = require(path.join(here, "..", "..", "shared", "video-embed.ts"));
const { ATTACHABLE_FILE, openableVideoPath } = bundleFiles;

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const WIN = process.platform === "win32";

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-attach-ipc-"));
  const script = path.join(dir, "Episode 12.splitpage");
  fs.writeFileSync(script, "{}");
  const drops = path.join(dir, "drops");
  fs.mkdirSync(drops);
  const put = (name, body) => { const p = path.join(drops, name); fs.writeFileSync(p, body); return p; };
  return {
    dir, script, drops, put: (name) => put(name, "x"),
    pdf: put("brief.pdf", Buffer.alloc(1024, 7)),
    doc: put("notes.docx", "PK"),
    exe: put("tool.exe", "MZ"),
    lnk: put("tool.lnk", "L"),
    ps1: put("run.ps1", "Write-Host"),
    bat: put("run.bat", "@echo"),
    bare: put("README", "no extension"),
    dotted: put("evil.exe.pdf.exe", "MZ"),
    folder: path.join(dir, "Episode 12 files"),
    done: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function junction(target, at) {
  try { fs.symlinkSync(target, at, "junction"); return true; } catch { return false; }
}

function shellIpc({ source = null, grants = [] } = {}) {
  const handlers = new Map();
  const openedPaths = [];
  const sent = [];
  const targets = new Map();
  const videoFileGrants = new Map(grants);
  const tab = { id: "tab-a", source: source ? { kind: "file", absPath: source } : { kind: "blank" } };
  const bundleJobs = createBundleJobs({
    copier: createBundleCopier({ bundleFiles, progressEveryMs: 0 }), allow: ATTACHABLE_FILE,
    scriptOfTab: (tabId) => (tabId === tab.id && tab.source.kind === "file" ? tab.source.absPath : null),
    pathOf: (fileId) => targets.get(fileId) || null,
    namesInProject: bundleFiles.bundledNamesInProject,
    linkInProject: bundleFiles.linkBundledInProject
  });
  const { registerShellIpc } = createShellIpc({
    tabOf: () => tab,
    shell: { openPath: async (p) => { openedPaths.push(p); return ""; }, openExternal: async () => {} },
    testMode: false, testVideoOpens: [], videoFileGrants, ATTACHABLE_FILE, openableVideoPath,
    resolveBundledFile: bundleFiles.resolveBundledFile, bundleJobs
  });
  registerShellIpc({ ipcHandle: (name, fn) => { handlers.set(name, fn); }, ipcOn: () => {}, ipcOnSync: () => {} });
  const sender = { id: 3, isDestroyed: () => false, send: (channel, payload) => { sent.push({ channel, payload }); } };
  const call = (name, ...args) => handlers.get(name)({ sender }, ...args);
  async function saveAs(to, names) {
    const fileId = "fid" + (targets.size + 1);
    targets.set(fileId, to);
    bundleJobs.noteSaveTarget(fileId, tab);
    const project = { rows: [{ id: "r1", imageLinks: names.map((name) => ({ name, location: { kind: "bundled", name } })) }] };
    const before = sent.length;
    const prepared = await bundleJobs.prepareWrite(fileId, () => JSON.stringify(project), sender);
    const refused = prepared.refused;
    if (!refused) prepared.landed(true);
    await bundleJobs.idle();
    tab.source = { kind: "file", absPath: to };
    const done = sent.slice(before).filter((s) => s.channel === "splitpage:bundle-carry" && s.payload.result);
    return { refused, result: done.length ? done[done.length - 1].payload.result : null };
  }
  return { call, openedPaths, videoFileGrants, saveAs };
}

test("a grant is given for a dropped document, and never for a program, script, shortcut, extensionless file or folder", async () => {
  const s = scratch();
  try {
    const ipc = shellIpc();
    const pdf = await ipc.call("splitpage:video-file-grant", s.pdf);
    assert.match(pdf, /^[0-9a-f]{32}$/);
    assert.match(await ipc.call("splitpage:video-file-grant", s.doc), /^[0-9a-f]{32}$/);
    fs.mkdirSync(path.join(s.drops, "folder.pdf"));
    const refused = {
      "a program": s.exe, "a shortcut": s.lnk, "a script": s.ps1, "a batch file": s.bat, "no extension": s.bare,
      "a program behind document-looking parts": s.dotted, "a folder named like a document": path.join(s.drops, "folder.pdf"),
      "a relative path": "brief.pdf", "a trailing dot": s.exe + ".", "a missing file": path.join(s.drops, "gone.pdf")
    };
    for (const [why, p] of Object.entries(refused)) assert.equal(await ipc.call("splitpage:video-file-grant", p), null, why);
    if (junction(s.drops, path.join(s.dir, "linked.pdf"))) {
      assert.equal(await ipc.call("splitpage:video-file-grant", path.join(s.dir, "linked.pdf")), null, "a junction named like a document");
      assert.equal(await ipc.call("splitpage:video-file-grant", path.join(s.dir, "linked.pdf", "tool.exe")), null, "a program through a junction");
    }
    assert.equal(ipc.videoFileGrants.size, 2, "only the two documents were granted");
  } finally { s.done(); }
});

test("a granted document opens through its token; a forged token, a path as a token and a grant that leads to a program do not", async () => {
  const s = scratch();
  try {
    const ipc = shellIpc({ grants: [["planted", s.exe], ["bare", s.bare]] });
    const token = await ipc.call("splitpage:video-file-grant", s.pdf);
    assert.deepEqual(await ipc.call("splitpage:video-file-open", token), { ok: true });
    assert.deepEqual(await ipc.call("splitpage:video-file-open", "0".repeat(32)), { ok: false, code: "UNKNOWN" });
    assert.deepEqual(await ipc.call("splitpage:video-file-open", s.pdf), { ok: false, code: "UNKNOWN" }, "a path is not a token");
    assert.deepEqual(await ipc.call("splitpage:video-file-open", "planted"), { ok: false, code: "REFUSED" }, "a program in the grant table");
    assert.deepEqual(await ipc.call("splitpage:video-file-open", "bare"), { ok: false, code: "REFUSED" }, "an extensionless file in the grant table");
    if (junction(s.drops, path.join(s.dir, "j"))) {
      ipc.videoFileGrants.set("through", path.join(s.dir, "j", "brief.pdf"));
      assert.deepEqual(await ipc.call("splitpage:video-file-open", "through"), { ok: true }, "a document reached through a junction");
    }
    assert.equal(ipc.openedPaths.length, ipc.videoFileGrants.has("through") ? 2 : 1);
    assert.ok(ipc.openedPaths.every((p) => /brief\.pdf$/.test(p)), "only the document reached the system");
  } finally { s.done(); }
});

test("a stored path opens a document and refuses programs, scripts, shortcuts, extensionless files, UNC, traversal and junction tricks", async () => {
  const s = scratch();
  try {
    const ipc = shellIpc();
    assert.deepEqual(await ipc.call("splitpage:video-path-open", s.pdf), { ok: true });
    assert.deepEqual(ipc.openedPaths, [fs.realpathSync.native(s.pdf)]);
    const refused = {
      "a program": s.exe, "a shortcut": s.lnk, "a script": s.ps1, "a batch file": s.bat, "no extension": s.bare,
      "a program behind document-looking parts": s.dotted, "a trailing dot": s.exe + ".",
      "UNC": WIN ? "\\\\localhost\\c$\\brief.pdf" : "//localhost/brief.pdf",
      "traversal": [s.drops, "..", "drops", "brief.pdf"].join(path.sep), "relative": "brief.pdf", "a stream": s.pdf + ":x.pdf",
      "not a string": 5
    };
    for (const [why, p] of Object.entries(refused)) {
      const got = await ipc.call("splitpage:video-path-open", p);
      assert.equal(got.ok, false, why);
    }
    if (junction(s.drops, path.join(s.dir, "j.pdf"))) {
      assert.deepEqual(await ipc.call("splitpage:video-path-open", path.join(s.dir, "j.pdf")), { ok: false, code: "REFUSED" }, "a junction named like a document");
      assert.deepEqual(await ipc.call("splitpage:video-path-open", path.join(s.dir, "j.pdf", "tool.exe")), { ok: false, code: "REFUSED" }, "a program through a junction");
      assert.deepEqual(await ipc.call("splitpage:video-path-open", path.join(s.dir, "j.pdf", "brief.pdf")), { ok: true }, "a document through a junction");
    }
    assert.ok(ipc.openedPaths.every((p) => /brief\.pdf$/.test(p)), "nothing refused reached the system");
  } finally { s.done(); }
});

test("a dropped document is copied beside the script and opens by name; programs and extensionless files are neither copied nor opened", async () => {
  const s = scratch();
  try {
    const ipc = shellIpc({ source: s.script, grants: [["pdf", s.pdf], ["exe", s.exe], ["bare", s.bare], ["ps1", s.ps1]] });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "pdf", "attach1"), { ok: true, name: "brief.pdf" });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "exe", "attach2"), { ok: false, code: "REFUSED" });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "bare", "attach3"), { ok: false, code: "REFUSED" });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "ps1", "attach4"), { ok: false, code: "REFUSED" });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "f".repeat(32), "attach5"), { ok: false, code: "UNKNOWN" }, "a forged token");
    assert.deepEqual(fs.readdirSync(s.folder), ["brief.pdf"]);
    fs.writeFileSync(path.join(s.folder, "planted.exe"), "MZ");
    fs.writeFileSync(path.join(s.folder, "README"), "x");
    fs.writeFileSync(path.join(s.folder, "run.cmd"), "x");
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "brief.pdf"), { ok: true });
    const refused = {
      "a program": "planted.exe", "no extension": "README", "a script": "run.cmd", "a trailing dot": "planted.exe.",
      "traversal": "..\\drops\\brief.pdf", "POSIX traversal": "../drops/brief.pdf", "absolute": s.pdf,
      "UNC": "\\\\localhost\\c$\\brief.pdf", "a stream": "brief.pdf:x.pdf"
    };
    for (const [why, name] of Object.entries(refused)) {
      assert.deepEqual(await ipc.call("splitpage:bundled-file-open", name), { ok: false, code: "REFUSED" }, why);
    }
    assert.equal(ipc.openedPaths.length, 1, "nothing refused reached the system");
  } finally { s.done(); }
});

test("a bundle folder that is a junction is refused for documents too", async () => {
  const s = scratch();
  try {
    if (!junction(s.drops, s.folder)) { console.log("  (junctions are not available here)"); return; }
    const ipc = shellIpc({ source: s.script, grants: [["pdf", s.pdf]] });
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "brief.pdf"), { ok: false, code: "REFUSED" });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "pdf", "attach1"), { ok: false, code: "REFUSED" });
    assert.deepEqual(ipc.openedPaths, []);
  } finally { s.done(); }
});

test("Save As carries documents along and never a program or an extensionless file", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    fs.writeFileSync(path.join(s.folder, "brief.pdf"), "pdf");
    fs.writeFileSync(path.join(s.folder, "planted.exe"), "MZ");
    fs.writeFileSync(path.join(s.folder, "README"), "x");
    const to = path.join(s.dir, "v2", "Episode 12 v2.splitpage");
    fs.mkdirSync(path.dirname(to));
    const ipc = shellIpc({ source: s.script });
    assert.deepEqual(await ipc.saveAs(to, ["brief.pdf", "planted.exe", "README"]), { refused: null, result: { ok: true, copied: 1, kept: 0, missing: 2 } });
    assert.deepEqual(fs.readdirSync(path.join(s.dir, "v2", "Episode 12 v2 files")), ["brief.pdf"]);
  } finally { s.done(); }
});

test("a PDF copied beside the script survives Save As, and a second Save As carries it on", async () => {
  const s = scratch();
  try {
    const ipc = shellIpc({ source: s.script, grants: [["pdf", s.pdf]] });
    assert.deepEqual(await ipc.call("splitpage:bundle-file", "pdf", "attach1"), { ok: true, name: "brief.pdf" });
    const v2 = path.join(s.dir, "v2", "Episode 12 v2.splitpage");
    const v3 = path.join(s.dir, "v3", "Episode 12 v3.splitpage");
    fs.mkdirSync(path.dirname(v2));
    fs.mkdirSync(path.dirname(v3));
    assert.deepEqual(await ipc.saveAs(v2, ["brief.pdf"]), { refused: null, result: { ok: true, copied: 1, kept: 0, missing: 0 } });
    assert.deepEqual(await ipc.saveAs(v3, ["brief.pdf"]), { refused: null, result: { ok: true, copied: 1, kept: 0, missing: 0 } });
    for (const folder of [path.join(s.dir, "v2", "Episode 12 v2 files"), path.join(s.dir, "v3", "Episode 12 v3 files")]) {
      assert.deepEqual(fs.readFileSync(path.join(folder, "brief.pdf")), fs.readFileSync(s.pdf), folder);
    }
    assert.deepEqual(await ipc.call("splitpage:bundled-file-open", "brief.pdf"), { ok: true }, "the carried copy opens from the new script");
    assert.ok(ipc.openedPaths[0].includes("Episode 12 v3 files"), ipc.openedPaths[0]);
  } finally { s.done(); }
});

const INTERPRETED = [
  "ahk", "au3", "a3x", "pyw", "pyz", "pyc", "pyo", "rb", "rbw", "pl", "php", "tcl", "lua", "bash", "zsh", "fish", "command",
  "applescript", "scpt", "ws", "wsc", "sct", "xll", "mht", "mhtml", "btm", "air", "PHP", "Ahk", "BTM",
  "docm", "dotm", "xlsm", "xltm", "xlam", "xlsb", "pptm", "potm", "ppam", "ppsm", "sldm", "wll", "DOCM", "Xlsm"
];

test("scripts an installed interpreter runs and macro-enabled Office files are never granted, opened, copied or carried", async () => {
  const s = scratch();
  try {
    fs.mkdirSync(s.folder);
    const names = INTERPRETED.map((ext) => "run." + ext);
    const planted = names.map((name, i) => ["t" + i, s.put(name)]);
    for (const name of names) fs.writeFileSync(path.join(s.folder, name), "x");
    const ipc = shellIpc({ source: s.script, grants: planted });
    for (const [token, p] of planted) {
      const name = path.basename(p);
      assert.equal(await ipc.call("splitpage:video-file-grant", p), null, "grant " + name);
      assert.deepEqual(await ipc.call("splitpage:video-file-open", token), { ok: false, code: "REFUSED" }, "token open " + name);
      assert.equal((await ipc.call("splitpage:video-path-open", p)).ok, false, "path open " + name);
      assert.deepEqual(await ipc.call("splitpage:bundle-file", token, "c" + token), { ok: false, code: "REFUSED" }, "copy " + name);
      assert.deepEqual(await ipc.call("splitpage:bundled-file-open", name), { ok: false, code: "REFUSED" }, "bundled open " + name);
    }
    const to = path.join(s.dir, "v2", "Episode 12 v2.splitpage");
    fs.mkdirSync(path.dirname(to));
    assert.deepEqual(await ipc.saveAs(to, names), { refused: null, result: { ok: true, copied: 0, kept: 0, missing: names.length } }, "a Save As carries none of them");
    assert.equal(fs.existsSync(path.join(s.dir, "v2", "Episode 12 v2 files")), false, "and makes no folder");
    assert.deepEqual(ipc.openedPaths, [], "nothing reached the system");
  } finally { s.done(); }
});

test("a name with an alternate data stream is never granted", async () => {
  const s = scratch();
  try {
    const ipc = shellIpc();
    if (WIN) {
      try { fs.writeFileSync(s.exe + ":stream.pdf", "x"); fs.writeFileSync(s.pdf + ":extra.pdf", "x"); } catch { console.log("  (streams are not available here)"); }
    }
    for (const p of [s.exe + ":stream.pdf", s.pdf + ":extra.pdf", s.pdf + "::$DATA"]) {
      assert.equal(await ipc.call("splitpage:video-file-grant", p), null, p);
    }
    assert.equal(ipc.videoFileGrants.size, 0);
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
