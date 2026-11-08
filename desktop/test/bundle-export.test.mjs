import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createShellIpc } = require(path.join(here, "..", "ipc-shell.ts"));
const { createFileIpc } = require(path.join(here, "..", "ipc-files.ts"));
const { createRecents } = require(path.join(here, "..", "recents.ts"));
const { createFileRegistry, pathKey } = require(path.join(here, "..", "file-service.ts"));
const { createBundleCopier } = require(path.join(here, "..", "bundle-copy.ts"));
const { createBundleExporter } = require(path.join(here, "..", "bundle-export.ts"));
const { createBundleJobs } = require(path.join(here, "..", "bundle-jobs.ts"));
const bundleFiles = require(path.join(here, "..", "..", "shared", "video-embed.ts"));
const { ATTACHABLE_FILE, openableVideoPath } = bundleFiles;

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const FOLD = process.platform === "win32";
const NO_SYMLINKS = "  (file symlinks need a privilege this account lacks; the link case runs where they don't)";
const PICTURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-bundle-export-"));
  const script = path.join(dir, "Episode 12.splitpage");
  const folder = path.join(dir, "Episode 12 files");
  fs.mkdirSync(folder);
  const drops = path.join(dir, "drops");
  fs.mkdirSync(drops);
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  return {
    dir, script, folder, drops, out,
    put: (at, bytes) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, bytes); return at; },
    done: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function link(location, name) {
  return { name: name || (location.kind === "bundled" ? location.name : path.basename(location.path)), size: 4, location };
}

function project(links, extra = {}) {
  return JSON.stringify({ title: "Episode 12", rows: [{ id: "r1", visualImage: PICTURE, imageLinks: links, ...extra }] }, null, 2);
}

function junction(target, at) {
  try { fs.symlinkSync(target, at, "junction"); return true; } catch { return false; }
}

function trySymlink(target, at) {
  try { fs.symlinkSync(target, at, "file"); return true; } catch { return false; }
}

function makeSender(id, onSend = () => {}) {
  const sent = [];
  const sender = { id, destroyed: false, isDestroyed: () => sender.destroyed, send: (channel, payload) => { sent.push([channel, payload]); onSend(channel, payload); } };
  return { sender, sent };
}

function harness({ source, copierOptions = {}, exporterOptions = {}, onSend } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const answers = [];
  const tab = { id: "tab-a", windowId: "w1", source: source ? { kind: "file", absPath: source } : { kind: "blank" } };
  const tabs = new Map([[tab.id, tab]]);
  const fileIds = createFileRegistry();
  let state = { recents: [] };
  const recents = createRecents({
    store: { read: () => structuredClone(state), write: (mutator) => { state = mutator(structuredClone(state)); return Promise.resolve(true); } },
    pathKey, fileIds
  });
  recents.load();
  const copier = createBundleCopier({ bundleFiles, progressEveryMs: 0, ...copierOptions });
  const exporter = createBundleExporter({ bundleFiles, publisher: copier, ...exporterOptions });
  const bundleJobs = createBundleJobs({
    copier, exporter, allow: ATTACHABLE_FILE,
    scriptOfTab: (tabId) => {
      const t = tabs.get(tabId);
      return t && t.source.kind === "file" ? t.source.absPath : null;
    },
    pathOf: (fileId) => fileIds.pathOf(fileId) || null,
    namesInProject: bundleFiles.bundledNamesInProject
  });
  const tabOf = (event) => (event.tab === undefined ? (tabs.get(tab.id) || null) : event.tab);
  const { registerShellIpc } = createShellIpc({
    tabOf, shell: { openPath: async () => "", openExternal: async () => {} },
    testMode: false, testVideoOpens: [], videoFileGrants: new Map(), ATTACHABLE_FILE, openableVideoPath, bundleJobs
  });
  const { registerFileIpc } = createFileIpc({
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    documentsPath: () => os.tmpdir(), fileIds, recents, pathToTabId: new Map(), tabs, tabOf, dialogParentFor: () => undefined,
    consumeTestDialogAnswer: () => answers.shift(), testDialogsSeen: () => 0, testMode: false, bundleJobs
  });
  const register = { ipcHandle: (name, fn) => { handlers.set(name, fn); }, ipcOn: (name, fn) => { listeners.set(name, fn); }, ipcOnSync: () => {} };
  registerShellIpc(register);
  registerFileIpc(register);
  const main = makeSender(7, onSend);
  const call = (name, ...args) => handlers.get(name)({ sender: main.sender }, ...args);
  const callFrom = (from, other, name, ...args) => handlers.get(name)({ sender: from.sender, ...(other === undefined ? {} : { tab: other }) }, ...args);
  const send = (name, ...args) => listeners.get(name)({ sender: main.sender }, ...args);
  const plan = (body, job = "export1", scriptName = "Episode 12.splitpage") => call("splitpage:bundle-export-plan", job, scriptName, new TextEncoder().encode(body));
  const pick = (to, options = { bundleExport: true }) => { answers.push(to); return call("splitpage:save-file-dialog", { suggestedName: path.basename(to), ...options }); };
  async function exportTo(to, body, job = "export1") {
    const planned = await plan(body, job);
    const picked = await pick(to);
    const result = await call("splitpage:bundle-export", job, picked.id);
    return { planned, picked, result };
  }
  const notes = (channel) => main.sent.filter(([c]) => c === channel).map(([, p]) => p);
  return { tab, tabs, main, call, callFrom, send, plan, pick, exportTo, notes, bundleJobs, makeSender };
}

function readZip(file) {
  const buf = fs.readFileSync(file);
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  assert.ok(e >= 0, "the zip has an end record");
  let count = buf.readUInt16LE(e + 10);
  let cdSize = buf.readUInt32LE(e + 12);
  let cdOffset = buf.readUInt32LE(e + 16);
  let zip64 = false;
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
    const locator = e - 20;
    assert.equal(buf.readUInt32LE(locator), 0x07064b50, "a ZIP64 locator sits before the end record");
    const z = Number(buf.readBigUInt64LE(locator + 8));
    assert.equal(buf.readUInt32LE(z), 0x06064b50, "the locator points at the ZIP64 end record");
    count = Number(buf.readBigUInt64LE(z + 32));
    cdSize = Number(buf.readBigUInt64LE(z + 40));
    cdOffset = Number(buf.readBigUInt64LE(z + 48));
    zip64 = true;
  }
  const entries = new Map();
  let wideEntries = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central entry " + i);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let packed = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    if (size === 0xFFFFFFFF || packed === 0xFFFFFFFF || offset === 0xFFFFFFFF) {
      wideEntries++;
      assert.equal(extra.readUInt16LE(0), 1, name + " has a ZIP64 extra field");
      let at = 4;
      if (size === 0xFFFFFFFF) { size = Number(extra.readBigUInt64LE(at)); at += 8; }
      if (packed === 0xFFFFFFFF) { packed = Number(extra.readBigUInt64LE(at)); at += 8; }
      if (offset === 0xFFFFFFFF) offset = Number(extra.readBigUInt64LE(at));
    }
    assert.ok(flags & 0x0800, name + " is flagged as a UTF-8 name");
    assert.equal(buf.readUInt32LE(offset), 0x04034b50, name + " has a local header");
    const localName = buf.readUInt16LE(offset + 26), localExtra = buf.readUInt16LE(offset + 28);
    assert.equal(buf.subarray(offset + 30, offset + 30 + localName).toString("utf8"), name);
    const data = buf.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + packed);
    const bytes = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    assert.equal(bytes.length, size, name + " has its size");
    assert.equal(zlib.crc32(bytes), crc, name + " has its CRC");
    entries.set(name, { bytes, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(p, cdOffset + cdSize, "the central directory size adds up");
  return { entries, zip64, wideEntries };
}

function unzipWithJs(file, into) {
  for (const [name, entry] of readZip(file).entries) {
    const at = path.join(into, ...name.split("/"));
    if (name.endsWith("/")) fs.mkdirSync(at, { recursive: true });
    else { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, entry.bytes); }
  }
  return true;
}

function unzipWithTool(file, into) {
  fs.mkdirSync(into, { recursive: true });
  const run = process.platform === "win32"
    ? spawnSync("tar", ["-xf", file, "-C", into], { encoding: "utf8" })
    : spawnSync("python3", ["-I", "-m", "zipfile", "-e", file, into], { encoding: "utf8" });
  if (run.error) return false;
  assert.equal(run.status, 0, "the system's unzip reads the archive: " + (run.stderr || ""));
  return true;
}

async function linksOpen(scriptPath) {
  const record = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
  const out = {};
  for (const holder of bundleFiles.fileLinksIn(record)) {
    if (holder.location.kind !== "bundled") { out[holder.name] = { kind: holder.location.kind }; continue; }
    const found = await bundleFiles.resolveBundledFile(scriptPath, holder.location.name, ATTACHABLE_FILE, fsp, path, FOLD);
    out[holder.name] = found.ok ? { kind: "bundled", name: holder.location.name, bytes: fs.readFileSync(found.path, "utf8") } : { kind: "bundled", name: holder.location.name, gone: found.code };
  }
  return { record, links: out };
}

function leftovers(folder) {
  return fs.readdirSync(folder).filter((n) => /\.part$/.test(n));
}

test("a zip round trip: unzipped anywhere, the script opens beside its files folder and every link reaches the right bytes", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take one.mp4"), "take");
    s.put(path.join(s.folder, "unlinked.mp4"), "nope");
    const brief = s.put(path.join(s.drops, "brief.pdf"), "brief");
    const body = project([link({ kind: "bundled", name: "take one.mp4" }), link({ kind: "path", path: brief })]);
    fs.writeFileSync(s.script, body);
    const ipc = harness({ source: s.script });
    const zip = path.join(s.out, "Episode 12 (with files).zip");
    const { planned, result } = await ipc.exportTo(zip, body);
    assert.deepEqual(planned, { ok: true, plan: { files: 2, bytes: 9, left: 0 } });
    assert.deepEqual(result, { ok: true, files: 2, left: 0 });
    const { entries } = readZip(zip);
    assert.deepEqual([...entries.keys()], ["Episode 12.splitpage", "Episode 12 files/", "Episode 12 files/take one.mp4", "Episode 12 files/brief.pdf"],
      "the script, its folder and only the files it links; the unlinked file stays out");
    assert.equal(entries.get("Episode 12.splitpage").method, 8, "the script is compressed");
    assert.equal(entries.get("Episode 12 files/take one.mp4").method, 0, "files are stored as they are");
    for (const [label, unzip] of [["js", unzipWithJs], ["tool", unzipWithTool]]) {
      const into = path.join(s.dir, "unzipped-" + label);
      if (!unzip(zip, into)) { console.log("  (no system unzip here; the JS reader covers the format)"); continue; }
      const opened = await linksOpen(path.join(into, "Episode 12.splitpage"));
      assert.deepEqual(opened.links, {
        "take one.mp4": { kind: "bundled", name: "take one.mp4", bytes: "take" },
        "brief.pdf": { kind: "bundled", name: "brief.pdf", bytes: "brief" }
      }, label + ": the path link became a bundled name, and both open from the unzipped folder");
      assert.equal(opened.record.rows[0].visualImage, PICTURE, label + ": an embedded picture stays embedded");
      assert.ok(!JSON.stringify(opened.record).includes(s.drops), label + ": the zipped script names no path from this computer");
    }
    assert.equal(fs.readFileSync(s.script, "utf8"), body, "the script on disk is not changed");
    assert.deepEqual(fs.readdirSync(s.out), ["Episode 12 (with files).zip"], "nothing else is left beside the zip");
    const progress = ipc.notes("splitpage:bundle-progress");
    assert.ok(progress.length >= 1 && progress.every((p) => p.job === "export1" && Object.keys(p).sort().join() === "done,job,total"), "progress names no path");
  } finally { s.done(); }
});

test("different files with the same name get numbered names, and one file linked twice goes in once", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "in-folder");
    const a = s.put(path.join(s.drops, "a", "take.mp4"), "from-a");
    const b = s.put(path.join(s.drops, "b", "Take.MP4"), "from-b");
    const body = project([
      link({ kind: "bundled", name: "take.mp4" }, "one"), link({ kind: "path", path: a }, "two"),
      link({ kind: "path", path: b }, "three"), link({ kind: "path", path: a }, "four")
    ]);
    const ipc = harness({ source: s.script });
    const zip = path.join(s.out, "Share.zip");
    const { result } = await ipc.exportTo(zip, body);
    assert.deepEqual(result, { ok: true, files: 3, left: 0 });
    assert.deepEqual([...readZip(zip).entries.keys()].slice(2), ["Episode 12 files/take.mp4", "Episode 12 files/take (2).mp4", "Episode 12 files/Take (3).MP4"],
      "names that differ only in case are a clash too, since the zip may be unzipped on Windows");
    const into = path.join(s.dir, "unzipped");
    unzipWithJs(zip, into);
    const { links } = await linksOpen(path.join(into, "Episode 12.splitpage"));
    assert.equal(links.one.bytes, "in-folder");
    assert.equal(links.two.bytes, "from-a");
    assert.equal(links.three.bytes, "from-b");
    assert.deepEqual(links.four, links.two, "the same file linked twice shares one copy");
  } finally { s.done(); }
});

test("blocked types, missing files and names outside the folder are left out and counted, and the export still completes", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "take");
    s.put(path.join(s.folder, "setup.exe"), "MZ");
    s.put(path.join(s.dir, "secret.mp4"), "secret");
    const tool = s.put(path.join(s.drops, "tool.exe"), "MZ");
    const runner = s.put(path.join(s.drops, "run.ps1"), "x");
    const unc = process.platform === "win32" ? "\\\\nas\\share\\clip.mp4" : "//nas/share/clip.mp4";
    const links = [
      link({ kind: "bundled", name: "take.mp4" }), link({ kind: "bundled", name: "setup.exe" }), link({ kind: "bundled", name: "gone.mp4" }),
      link({ kind: "bundled", name: "..\\secret.mp4" }, "up"), link({ kind: "bundled", name: "../secret.mp4" }, "up2"),
      link({ kind: "path", path: tool }), link({ kind: "path", path: runner }), link({ kind: "path", path: unc }, "unc"),
      link({ kind: "path", path: path.join(s.drops, "missing.mov") })
    ];
    const body = project(links);
    const ipc = harness({ source: s.script });
    const zip = path.join(s.out, "Share.zip");
    const { planned, result } = await ipc.exportTo(zip, body);
    assert.deepEqual(planned, { ok: true, plan: { files: 1, bytes: 4, left: 8 } });
    assert.deepEqual(result, { ok: true, files: 1, left: 8 });
    const { entries } = readZip(zip);
    assert.deepEqual([...entries.keys()], ["Episode 12.splitpage", "Episode 12 files/", "Episode 12 files/take.mp4"]);
    const zipped = JSON.parse(entries.get("Episode 12.splitpage").bytes.toString("utf8"));
    assert.deepEqual(zipped.rows[0].imageLinks.map((l) => l.location), [{ kind: "bundled", name: "take.mp4" }, ...links.slice(1).map((l) => l.location)],
      "a link that could not be included is written as it was");
  } finally { s.done(); }
});

test("an export with no linked files is a zip of the script alone", async () => {
  const s = scratch();
  try {
    const ipc = harness({ source: null });
    const zip = path.join(s.out, "Untitled.zip");
    const body = project([link({ kind: "bundled", name: "take.mp4" })]);
    const { result } = await ipc.exportTo(zip, body);
    assert.deepEqual(result, { ok: true, files: 0, left: 1 }, "an unsaved script has no folder, so its bundled names cannot be found");
    assert.deepEqual([...readZip(zip).entries.keys()], ["Episode 12.splitpage"]);
  } finally { s.done(); }
});

test("a cancelled export leaves nothing under the final name and no temporary", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "big.mp4"), Buffer.alloc(24 * 1024 * 1024, 7));
    const body = project([link({ kind: "bundled", name: "big.mp4" })]);
    let ipc = null;
    let cancelled = false;
    ipc = harness({
      source: s.script,
      onSend: (channel, payload) => {
        if (channel === "splitpage:bundle-progress" && payload.done > 1024 * 1024 && !cancelled) { cancelled = true; ipc.send("splitpage:bundle-cancel", "export1"); }
      }
    });
    const zip = path.join(s.out, "Share.zip");
    const { result } = await ipc.exportTo(zip, body);
    assert.equal(cancelled, true, "Cancel was pressed part-way");
    assert.deepEqual(result, { ok: false, code: "CANCELLED" });
    await ipc.bundleJobs.idle();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(fs.readdirSync(s.out), [], "no zip and no temporary");
  } finally { s.done(); }
});

test("a failed publish, or a name that is taken by now, leaves nothing new and never replaces the file there", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "take");
    const body = project([link({ kind: "bundled", name: "take.mp4" })]);
    const broken = harness({
      source: s.script,
      copierOptions: {
        link: async () => { const e = new Error("no links"); e.code = "EXDEV"; throw e; },
        rename: async () => { const e = new Error("disk full"); e.code = "ENOSPC"; throw e; }
      }
    });
    assert.deepEqual((await broken.exportTo(path.join(s.out, "Share.zip"), body)).result, { ok: false, code: "FAILED" });
    assert.deepEqual(fs.readdirSync(s.out), [], "a failed export leaves no zip and no temporary");
    const there = s.put(path.join(s.out, "Taken.zip"), "the user's own file");
    const ipc = harness({ source: s.script });
    assert.deepEqual((await ipc.exportTo(there, body)).result, { ok: false, code: "TAKEN" });
    assert.equal(fs.readFileSync(there, "utf8"), "the user's own file", "an existing file is never replaced");
    assert.deepEqual(leftovers(s.out), []);
    const lateHarness = harness({ source: s.script });
    const late = path.join(s.out, "Late.zip");
    await lateHarness.plan(body);
    const picked = await lateHarness.pick(late);
    fs.writeFileSync(late, "appeared meanwhile");
    assert.deepEqual(await lateHarness.call("splitpage:bundle-export", "export1", picked.id), { ok: false, code: "TAKEN" });
    assert.equal(fs.readFileSync(late, "utf8"), "appeared meanwhile");
    assert.deepEqual(leftovers(s.out), []);
  } finally { s.done(); }
});

test("ZIP64: entries, offsets and the directory past the 32-bit limit get their ZIP64 fields, and the system's unzip reads them", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "a.mp4"), Buffer.alloc(300, 1));
    s.put(path.join(s.folder, "b.pdf"), Buffer.alloc(200, 2));
    const body = project([link({ kind: "bundled", name: "a.mp4" }), link({ kind: "bundled", name: "b.pdf" })]);
    const ipc = harness({ source: s.script, exporterOptions: { zip64Above: 64 } });
    const zip = path.join(s.out, "Wide.zip");
    assert.deepEqual((await ipc.exportTo(zip, body)).result, { ok: true, files: 2, left: 0 });
    const read = readZip(zip);
    assert.equal(read.zip64, true, "the archive ends with a ZIP64 end record");
    assert.ok(read.wideEntries >= 3, "entries over the limit, and those placed past it, carry ZIP64 extra fields");
    assert.deepEqual(read.entries.get("Episode 12 files/a.mp4").bytes, Buffer.alloc(300, 1));
    const into = path.join(s.dir, "tool");
    if (unzipWithTool(zip, into)) {
      assert.deepEqual(fs.readFileSync(path.join(into, "Episode 12 files", "b.pdf")), Buffer.alloc(200, 2));
      assert.ok(fs.existsSync(path.join(into, "Episode 12.splitpage")));
    } else console.log("  (no system unzip here; the JS reader covers ZIP64)");
  } finally { s.done(); }
});

test("export negatives: a forged or reused job, a script name outside the rules, another tab or sender, and a destination no export dialog chose", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "take");
    const body = project([link({ kind: "bundled", name: "take.mp4" })]);
    const ipc = harness({ source: s.script });
    const zip = path.join(s.out, "Share.zip");
    const picked = await ipc.pick(zip);
    assert.deepEqual(await ipc.call("splitpage:bundle-export", "never-planned", picked.id), { ok: false, code: "UNKNOWN" }, "a forged job id");
    assert.deepEqual(await ipc.call("splitpage:bundle-export", "../x", picked.id), { ok: false, code: "REFUSED" });
    assert.deepEqual(await ipc.call("splitpage:bundle-export-plan", "../x", "Episode 12.splitpage", "{}"), { ok: false, code: "REFUSED" });
    for (const name of ["..\\Episode 12.splitpage", "a/b.splitpage", "Episode 12.exe", "Episode 12.zip", "CON.splitpage", "", "x.splitpage."]) {
      assert.deepEqual(await ipc.plan(body, "export1", name), { ok: false, code: "REFUSED" }, "script name " + JSON.stringify(name));
    }
    assert.deepEqual(await ipc.plan("not a script"), { ok: false, code: "REFUSED" }, "bytes that are no script");
    assert.deepEqual(await ipc.callFrom(ipc.main, null, "splitpage:bundle-export-plan", "export1", "Episode 12.splitpage", body), { ok: false, code: "REFUSED" }, "no tab");
    assert.equal((await ipc.plan(body)).ok, true);
    const other = ipc.makeSender(8);
    assert.deepEqual(await ipc.callFrom(other, undefined, "splitpage:bundle-export", "export1", picked.id), { ok: false, code: "UNKNOWN" }, "another page's plan");
    assert.deepEqual(await ipc.callFrom(ipc.main, { id: "tab-b", source: { kind: "blank" } }, "splitpage:bundle-export", "export1", picked.id),
      { ok: false, code: "UNKNOWN" }, "another tab");
    const plain = await ipc.pick(path.join(s.out, "Plain.zip"), {});
    const scriptSave = await ipc.pick(path.join(s.out, "Saved.zip"), { script: true });
    const notZip = await ipc.pick(path.join(s.out, "Share.splitpage"));
    for (const [label, id] of [["a save dialog not asked for an export", plain.id], ["a script save dialog", scriptSave.id],
      ["a dialog answer that is not a .zip", notZip.id], ["an id no dialog gave", "f".repeat(32)], ["a path", zip]]) {
      assert.deepEqual(await ipc.call("splitpage:bundle-export", "export1", id), { ok: false, code: "UNKNOWN" }, label);
    }
    const otherTab = { id: "tab-b", windowId: "w1", source: { kind: "blank" } };
    ipc.tabs.set(otherTab.id, otherTab);
    await ipc.callFrom(ipc.main, otherTab, "splitpage:bundle-export-plan", "export2", "Episode 12.splitpage", body);
    assert.deepEqual(await ipc.callFrom(ipc.main, otherTab, "splitpage:bundle-export", "export2", picked.id), { ok: false, code: "UNKNOWN" },
      "a destination another tab's dialog chose");
    assert.deepEqual(fs.readdirSync(s.out), [], "nothing was written by any refused call");
    assert.deepEqual(await ipc.call("splitpage:bundle-export", "export1", picked.id), { ok: true, files: 1, left: 0 });
    assert.deepEqual(await ipc.call("splitpage:bundle-export", "export1", picked.id), { ok: false, code: "UNKNOWN" }, "a plan and a destination run once");
  } finally { s.done(); }
});

test("a file added to the folder after the plan, but not linked, never goes in, and the job writes what the plan's bytes link", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "take");
    const body = project([link({ kind: "bundled", name: "take.mp4" })]);
    const ipc = harness({ source: s.script });
    await ipc.plan(body);
    s.put(path.join(s.folder, "added later.mp4"), "late");
    const picked = await ipc.pick(path.join(s.out, "Share.zip"));
    await ipc.call("splitpage:bundle-export", "export1", picked.id);
    assert.deepEqual([...readZip(path.join(s.out, "Share.zip")).entries.keys()], ["Episode 12.splitpage", "Episode 12 files/", "Episode 12 files/take.mp4"]);
  } finally { s.done(); }
});

test("a bundle folder that is a junction, and a bundled name that links out of the folder, are never read", async () => {
  const s = scratch();
  try {
    const elsewhere = path.join(s.dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    s.put(path.join(elsewhere, "take.mp4"), "outside");
    fs.rmSync(s.folder, { recursive: true });
    const body = project([link({ kind: "bundled", name: "take.mp4" })]);
    if (junction(elsewhere, s.folder)) {
      const ipc = harness({ source: s.script });
      const { result } = await ipc.exportTo(path.join(s.out, "Share.zip"), body);
      assert.deepEqual(result, { ok: true, files: 0, left: 1 });
      assert.deepEqual([...readZip(path.join(s.out, "Share.zip")).entries.keys()], ["Episode 12.splitpage"]);
      fs.rmSync(s.folder, { recursive: true, force: true });
    } else console.log("  (junctions are not available here)");
    fs.mkdirSync(s.folder, { recursive: true });
    if (trySymlink(path.join(elsewhere, "take.mp4"), path.join(s.folder, "take.mp4"))) {
      const ipc = harness({ source: s.script });
      const { result } = await ipc.exportTo(path.join(s.out, "Linked.zip"), body);
      assert.deepEqual(result, { ok: true, files: 0, left: 1 }, "a link inside the folder that leads out of it is refused");
    } else console.log(NO_SYMLINKS);
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
