import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function gate() {
  let open = () => {};
  const shut = new Promise((resolve) => { open = resolve; });
  return { shut, open };
}

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

const bundled = (name, label) => link({ kind: "bundled", name }, label);

function project(links, extra = {}) {
  return JSON.stringify({ title: "Episode 12", lastEditedAt: "2026-11-01T10:20:30.000Z", rows: [{ id: "r1", visualImage: PICTURE, imageLinks: links, ...extra }] }, null, 2);
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

function harness({ source, copierOptions = {}, exporterOptions = {}, onSend, resolving = null, grants = [] } = {}) {
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
  const publisher = resolving ? { ...copier, resolveIn: resolving(copier.resolveIn) } : copier;
  const exporter = createBundleExporter({ bundleFiles, publisher, ...exporterOptions });
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
    testMode: false, testVideoOpens: [], videoFileGrants: new Map(grants), ATTACHABLE_FILE, openableVideoPath, bundleJobs
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
  const idOf = (p) => fileIds.register(p);
  const scriptId = source ? idOf(source) : "";
  const call = (name, ...args) => handlers.get(name)({ sender: main.sender }, ...args);
  const callFrom = (from, other, name, ...args) => handlers.get(name)({ sender: from.sender, ...(other === undefined ? {} : { tab: other }) }, ...args);
  const send = (name, ...args) => listeners.get(name)({ sender: main.sender }, ...args);
  const plan = (body, job = "export1", scriptName = "Episode 12.splitpage", script = scriptId) =>
    call("splitpage:bundle-export-plan", job, scriptName, new TextEncoder().encode(body), script);
  const pick = (to, options = { bundleExport: true }) => { answers.push(to); return call("splitpage:save-file-dialog", { suggestedName: path.basename(to), ...options }); };
  async function exportTo(to, body, job = "export1") {
    const planned = await plan(body, job);
    const picked = await pick(to);
    const result = await call("splitpage:bundle-export", job, picked.id);
    return { planned, picked, result };
  }
  const notes = (channel) => main.sent.filter(([c]) => c === channel).map(([, p]) => p);
  return { tab, tabs, main, call, callFrom, send, plan, pick, exportTo, notes, bundleJobs, makeSender, idOf, scriptId };
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
    assert.equal(buf.readUInt32LE(offset + 14), crc, name + ": the local header's CRC matches the directory");
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
    if (holder.location.kind !== "bundled") { out[holder.name] = { ...holder.location }; continue; }
    const found = await bundleFiles.resolveBundledFile(scriptPath, holder.location.name, ATTACHABLE_FILE, fsp, path, FOLD);
    out[holder.name] = found.ok ? { kind: "bundled", name: holder.location.name, bytes: fs.readFileSync(found.path, "utf8") } : { kind: "bundled", name: holder.location.name, gone: found.code };
  }
  return { record, links: out };
}

const leftovers = (folder) => fs.readdirSync(folder).filter((n) => /\.part$/.test(n));

function resolverWith(map) {
  return (resolveIn) => async (script, name, allow) => (name in map
    ? (map[name] === null ? { ok: false, code: "GONE" } : { ok: true, path: map[name] })
    : resolveIn(script, name, allow));
}

test("a zip round trip: unzipped anywhere, the script opens beside its files folder and every bundled link reaches the right bytes", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take one.mp4"), "take");
    s.put(path.join(s.folder, "brief.pdf"), "brief");
    s.put(path.join(s.folder, "unlinked.mp4"), "nope");
    const body = project([bundled("take one.mp4"), bundled("brief.pdf")]);
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
      }, label + ": both links open from the unzipped folder");
      assert.equal(opened.record.rows[0].visualImage, PICTURE, label + ": an embedded picture stays embedded");
    }
    assert.equal(fs.readFileSync(s.script, "utf8"), body, "the script on disk is not changed");
    assert.deepEqual(fs.readdirSync(s.out), ["Episode 12 (with files).zip"], "nothing else is left beside the zip");
    const progress = ipc.notes("splitpage:bundle-progress");
    assert.ok(progress.length >= 1 && progress.every((p) => p.job === "export1" && Object.keys(p).sort().join() === "done,job,total"), "progress names no path");
  } finally { s.done(); }
});

test("a script's path links never authorize a read: they are left out and counted, stay paths, and no byte of them is in the zip", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "take");
    const secret = s.put(path.join(s.drops, "private.json"), "PRIVATE-TOKEN-1");
    const linkedDir = path.join(s.dir, "linked");
    const behind = s.put(path.join(s.dir, "elsewhere", "notes.txt"), "PRIVATE-TOKEN-2");
    const viaJunction = junction(path.dirname(behind), linkedDir) ? path.join(linkedDir, "notes.txt") : behind;
    const links = [bundled("take.mp4"), link({ kind: "path", path: secret }), link({ kind: "path", path: viaJunction })];
    const ipc = harness({ source: s.script });
    const zip = path.join(s.out, "Share.zip");
    const { planned, result } = await ipc.exportTo(zip, project(links));
    assert.deepEqual(planned, { ok: true, plan: { files: 1, bytes: 4, left: 2 } });
    assert.deepEqual(result, { ok: true, files: 1, left: 2 });
    const { entries } = readZip(zip);
    assert.deepEqual([...entries.keys()], ["Episode 12.splitpage", "Episode 12 files/", "Episode 12 files/take.mp4"]);
    const raw = fs.readFileSync(zip);
    for (const token of ["PRIVATE-TOKEN-1", "PRIVATE-TOKEN-2"]) assert.equal(raw.includes(Buffer.from(token)), false, token + " is not in the zip");
    const zipped = JSON.parse(entries.get("Episode 12.splitpage").bytes.toString("utf8"));
    assert.deepEqual(zipped.rows[0].imageLinks.map((l) => l.location), [{ kind: "bundled", name: "take.mp4" }, links[1].location, links[2].location],
      "a path link is written as it was");
  } finally { s.done(); }
});

test("distinct files whose names differ only in case get numbered names, and one file linked twice goes in once", async () => {
  const s = scratch();
  try {
    const a = s.put(path.join(s.drops, "a", "take.mp4"), "from-a");
    const b = s.put(path.join(s.drops, "b", "TAKE.mp4"), "from-b");
    const body = project([bundled("take.mp4", "one"), bundled("TAKE.mp4", "two"), bundled("take.mp4", "three")]);
    const ipc = harness({ source: s.script, resolving: resolverWith({ "take.mp4": a, "TAKE.mp4": b }) });
    const zip = path.join(s.out, "Share.zip");
    const { result } = await ipc.exportTo(zip, body);
    assert.deepEqual(result, { ok: true, files: 2, left: 0 });
    const { entries } = readZip(zip);
    assert.deepEqual([...entries.keys()].slice(2), ["Episode 12 files/take.mp4", "Episode 12 files/TAKE (2).mp4"], "the zip may be unzipped on Windows");
    const zipped = JSON.parse(entries.get("Episode 12.splitpage").bytes.toString("utf8"));
    assert.deepEqual(zipped.rows[0].imageLinks.map((l) => l.location.name), ["take.mp4", "TAKE (2).mp4", "take.mp4"]);
    assert.equal(entries.get("Episode 12 files/TAKE (2).mp4").bytes.toString(), "from-b");
  } finally { s.done(); }
});

test("a bundled name that is left out keeps its name reserved, so no included file can take it and answer its link", async () => {
  const s = scratch();
  try {
    const real = s.put(path.join(s.drops, "MISSING.pdf"), "the other file");
    const body = project([bundled("missing.pdf", "gone"), bundled("MISSING.pdf", "here")]);
    const ipc = harness({ source: s.script, resolving: resolverWith({ "missing.pdf": null, "MISSING.pdf": real }) });
    const zip = path.join(s.out, "Share.zip");
    const { result } = await ipc.exportTo(zip, body);
    assert.deepEqual(result, { ok: true, files: 1, left: 1 });
    const { entries } = readZip(zip);
    assert.deepEqual([...entries.keys()].slice(2), ["Episode 12 files/MISSING (2).pdf"]);
    const into = path.join(s.dir, "unzipped");
    unzipWithJs(zip, into);
    const { links } = await linksOpen(path.join(into, "Episode 12.splitpage"));
    assert.equal(links.here.bytes, "the other file");
    assert.equal(links.gone.name, "missing.pdf");
    if (FOLD) assert.equal(links.gone.gone, "GONE", "the missing link still opens nothing, even where names ignore case");
  } finally { s.done(); }
});

test("blocked types, missing files and names outside the folder are left out and counted, and the export still completes", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "take");
    s.put(path.join(s.folder, "setup.exe"), "MZ");
    s.put(path.join(s.dir, "secret.mp4"), "secret");
    const links = [bundled("take.mp4"), bundled("setup.exe"), bundled("gone.mp4"), bundled("..\\secret.mp4", "up"), bundled("../secret.mp4", "up2")];
    const ipc = harness({ source: s.script });
    const zip = path.join(s.out, "Share.zip");
    const { planned, result } = await ipc.exportTo(zip, project(links));
    assert.deepEqual(planned, { ok: true, plan: { files: 1, bytes: 4, left: 4 } });
    assert.deepEqual(result, { ok: true, files: 1, left: 4 });
    const { entries } = readZip(zip);
    assert.deepEqual([...entries.keys()], ["Episode 12.splitpage", "Episode 12 files/", "Episode 12 files/take.mp4"]);
    const zipped = JSON.parse(entries.get("Episode 12.splitpage").bytes.toString("utf8"));
    assert.deepEqual(zipped.rows[0].imageLinks.map((l) => l.location), links.map((l) => l.location), "a link that could not be included is written as it was");
  } finally { s.done(); }
});

test("an unsaved script has no folder, so its export is the script alone", async () => {
  const s = scratch();
  try {
    const ipc = harness({ source: null });
    const zip = path.join(s.out, "Untitled.zip");
    const { result } = await ipc.exportTo(zip, project([bundled("take.mp4")]));
    assert.deepEqual(result, { ok: true, files: 0, left: 1 });
    assert.deepEqual([...readZip(zip).entries.keys()], ["Episode 12.splitpage"]);
  } finally { s.done(); }
});

test("the folder is the one of the script the bytes were captured from: a plan for another script, or after the tab moved on, is refused", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "brief.pdf"), "A's brief");
    const other = path.join(s.dir, "Other.splitpage");
    fs.writeFileSync(other, "{}");
    s.put(path.join(s.dir, "Other files", "brief.pdf"), "B's brief");
    const body = project([bundled("brief.pdf")]);
    const ipc = harness({ source: s.script });
    const idA = ipc.scriptId;
    const idB = ipc.idOf(other);
    assert.deepEqual(await ipc.plan(body, "export1", "Episode 12.splitpage", idB), { ok: false, code: "REFUSED" }, "another script's id");
    assert.deepEqual(await ipc.plan(body, "export1", "Episode 12.splitpage", "f".repeat(32)), { ok: false, code: "REFUSED" }, "an id main never gave");
    ipc.tab.source = { kind: "file", absPath: other };
    assert.deepEqual(await ipc.plan(body, "export1", "Episode 12.splitpage", idA), { ok: false, code: "REFUSED" },
      "bytes captured from A while the tab now holds B never read B's folder");
    ipc.tab.source = { kind: "file", absPath: s.script };
    assert.equal((await ipc.plan(body, "export1", "Episode 12.splitpage", idA)).ok, true);
    const picked = await ipc.pick(path.join(s.out, "Share.zip"));
    ipc.tab.source = { kind: "file", absPath: other };
    assert.deepEqual(await ipc.call("splitpage:bundle-export", "export1", picked.id), { ok: true, files: 1, left: 0 });
    assert.equal(readZip(path.join(s.out, "Share.zip")).entries.get("Episode 12 files/brief.pdf").bytes.toString(), "A's brief",
      "a plan made for A writes A's file, even after the tab opened B");
  } finally { s.done(); }
});

test("Cancel during a read that never answers settles the job first: no temporary is left when the result or idle arrives", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "big.mp4"), Buffer.alloc(8 * 1024 * 1024, 7));
    const body = project([bundled("big.mp4")]);
    let ipc = null;
    let cancelled = false;
    ipc = harness({
      source: s.script,
      exporterOptions: { readFile: () => { const r = new Readable({ read() {} }); r.push(Buffer.alloc(1024 * 1024, 7)); return r; } },
      onSend: (channel, payload) => {
        if (channel === "splitpage:bundle-progress" && payload.done >= 1024 * 1024 && !cancelled) { cancelled = true; setTimeout(() => ipc.send("splitpage:bundle-cancel", "export1"), 0); }
      }
    });
    const { result } = await ipc.exportTo(path.join(s.out, "Share.zip"), body);
    assert.equal(cancelled, true, "Cancel was pressed part-way");
    assert.deepEqual(result, { ok: false, code: "CANCELLED" });
    assert.deepEqual(fs.readdirSync(s.out), [], "the temporary is gone before the result is reported");
    assert.equal(ipc.bundleJobs.busy(), false, "and the queue is idle by then");
  } finally { s.done(); }
});

test("a published zip is the commit point: Cancel during the hard link keeps the whole zip, reports it, and leaves no temporary", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "take");
    let ipc = null;
    ipc = harness({
      source: s.script,
      copierOptions: { link: async (from, to) => { ipc.send("splitpage:bundle-cancel", "export1"); await sleep(50); return fs.promises.link(from, to); } }
    });
    const zip = path.join(s.out, "Share.zip");
    const { result } = await ipc.exportTo(zip, project([bundled("take.mp4")]));
    assert.deepEqual(result, { ok: true, files: 1, left: 0 });
    assert.equal(ipc.bundleJobs.busy(), false);
    assert.deepEqual(fs.readdirSync(s.out), ["Share.zip"], "the published zip stays, and no temporary is left");
    assert.equal(readZip(zip).entries.get("Episode 12 files/take.mp4").bytes.toString(), "take");
  } finally { s.done(); }
});

test("an export queued behind a cancelled copy waits until it settles, and never zips that copy's empty placeholder", async () => {
  const s = scratch();
  try {
    const dropped = s.put(path.join(s.drops, "take.mp4"), "mine");
    const reached = gate();
    const released = gate();
    const ipc = harness({
      source: s.script, grants: [["tok", dropped]],
      copierOptions: {
        link: async () => { throw Object.assign(new Error("no hard links here"), { code: "EPERM" }); },
        lstat: async (p) => { reached.open(); await released.shut; return fsp.lstat(p, { bigint: true }); }
      }
    });
    const copying = ipc.call("splitpage:bundle-file", "tok", "bundle1");
    await reached.shut;
    assert.equal(fs.statSync(path.join(s.folder, "take.mp4")).size, 0, "setup: the copy's placeholder stands");
    ipc.send("splitpage:bundle-cancel", "bundle1");
    const body = project([bundled("take.mp4")]);
    assert.deepEqual(await ipc.plan(body), { ok: true, plan: { files: 0, bytes: 0, left: 1 } }, "the plan counts the placeholder as not there yet");
    const zip = path.join(s.out, "Share.zip");
    const picked = await ipc.pick(zip);
    let answered = false;
    const exporting = ipc.call("splitpage:bundle-export", "export1", picked.id).then((r) => { answered = true; return r; });
    await sleep(50);
    assert.equal(answered, false, "the export waits while the cancelled copy has not settled");
    assert.equal(fs.existsSync(zip), false);
    released.open();
    assert.deepEqual(await copying, { ok: true, name: "take.mp4" }, "the copy committed with its rename, so it is kept");
    assert.deepEqual(await exporting, { ok: true, files: 1, left: 0 });
    assert.equal(readZip(zip).entries.get("Episode 12 files/take.mp4").bytes.toString(), "mine", "the export has the whole file, never the placeholder");
  } finally { s.done(); }
});

test("an empty bundled file, as a crashed copy's placeholder leaves, is left out and counted", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "take");
    s.put(path.join(s.folder, "crashed.mp4"), "");
    const ipc = harness({ source: s.script });
    const zip = path.join(s.out, "Share.zip");
    const { result } = await ipc.exportTo(zip, project([bundled("take.mp4"), bundled("crashed.mp4")]));
    assert.deepEqual(result, { ok: true, files: 1, left: 1 });
    assert.deepEqual([...readZip(zip).entries.keys()], ["Episode 12.splitpage", "Episode 12 files/", "Episode 12 files/take.mp4"]);
  } finally { s.done(); }
});

test("without hard links, the whole zip is renamed onto an empty placeholder: another program's file under that name is never replaced", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "take");
    const body = project([bundled("take.mp4")]);
    const eperm = async () => { throw Object.assign(new Error("no hard links here"), { code: "EPERM" }); };
    const atRename = [];
    const plain = harness({
      source: s.script,
      copierOptions: { link: eperm, rename: async (from, to) => { atRename.push(fs.statSync(to).size); readZip(from); return fs.promises.rename(from, to); } }
    });
    const zip = path.join(s.out, "Plain.zip");
    assert.deepEqual((await plain.exportTo(zip, body)).result, { ok: true, files: 1, left: 0 });
    assert.deepEqual(atRename, [0], "the final name held only the empty placeholder, and the temporary was a whole zip");
    assert.equal(readZip(zip).entries.get("Episode 12 files/take.mp4").bytes.toString(), "take", "the copied-in zip is whole");
    assert.deepEqual(leftovers(s.out), []);
    const racing = path.join(s.out, "Race.zip");
    const raced = harness({
      source: s.script,
      copierOptions: { link: async (_from, to) => { fs.writeFileSync(to, "another program's"); throw Object.assign(new Error("no hard links"), { code: "EPERM" }); } }
    });
    assert.deepEqual((await raced.exportTo(racing, body)).result, { ok: false, code: "TAKEN" });
    assert.equal(fs.readFileSync(racing, "utf8"), "another program's", "the file that appeared is untouched");
    assert.deepEqual(leftovers(s.out), []);
    const swapped = path.join(s.out, "Swapped.zip");
    const swapping = harness({
      source: s.script,
      copierOptions: { link: eperm, lstat: async (p) => { fs.renameSync(p, p + ".moved"); fs.writeFileSync(p, "swapped in"); return fsp.lstat(p, { bigint: true }); } }
    });
    assert.deepEqual((await swapping.exportTo(swapped, body)).result, { ok: false, code: "TAKEN" });
    assert.equal(fs.readFileSync(swapped, "utf8"), "swapped in", "a placeholder swapped for another file is kept as it is");
    assert.deepEqual(leftovers(s.out), []);
    const broken = harness({ source: s.script, copierOptions: { link: eperm, rename: async () => { throw new Error("disk gone"); } } });
    const failed = path.join(s.out, "Failed.zip");
    assert.deepEqual((await broken.exportTo(failed, body)).result, { ok: false, code: "FAILED" });
    assert.equal(fs.existsSync(failed), false, "a rename that fails removes its own placeholder, and only that");
    assert.deepEqual(leftovers(s.out), []);
  } finally { s.done(); }
});

test("every byte of a short write is written again until it lands, so the zip and its CRCs are whole", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), Buffer.alloc(3000, 9));
    let shortWrites = 0;
    const ipc = harness({
      source: s.script,
      exporterOptions: {
        openPart: async (p) => {
          const h = await fsp.open(p, "wx");
          return {
            write: (buf, off, len, pos) => { if (len > 7) shortWrites++; return h.write(buf, off, Math.min(len, 7), pos); },
            close: () => h.close()
          };
        }
      }
    });
    const zip = path.join(s.out, "Short.zip");
    assert.deepEqual((await ipc.exportTo(zip, project([bundled("take.mp4")]))).result, { ok: true, files: 1, left: 0 });
    assert.ok(shortWrites > 0, "setup: the file took fewer bytes than offered");
    assert.deepEqual(readZip(zip).entries.get("Episode 12 files/take.mp4").bytes, Buffer.alloc(3000, 9));
  } finally { s.done(); }
});

test("a failed publish, or a name that is taken by now, leaves nothing new and never replaces the file there", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "take");
    const body = project([bundled("take.mp4")]);
    const no = Object.assign(new Error("no"), { code: "EIO" });
    const broken = harness({ source: s.script, copierOptions: { link: async () => { throw no; }, openTarget: async () => { throw no; } } });
    assert.deepEqual((await broken.exportTo(path.join(s.out, "Share.zip"), body)).result, { ok: false, code: "FAILED" });
    assert.deepEqual(fs.readdirSync(s.out), [], "a failed export leaves no zip and no temporary");
    const there = s.put(path.join(s.out, "Taken.zip"), "the user's own file");
    const ipc = harness({ source: s.script });
    assert.deepEqual((await ipc.exportTo(there, body)).result, { ok: false, code: "TAKEN" });
    assert.equal(fs.readFileSync(there, "utf8"), "the user's own file", "an existing file is never replaced");
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

test("the same script and files give the same zip bytes: entry times come from the script's edit time and the files' own times", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "take");
    const body = project([bundled("take.mp4")]);
    const ipc = harness({ source: s.script });
    await ipc.exportTo(path.join(s.out, "One.zip"), body, "export1");
    await sleep(2100);
    await ipc.exportTo(path.join(s.out, "Two.zip"), body, "export2");
    assert.deepEqual(fs.readFileSync(path.join(s.out, "One.zip")), fs.readFileSync(path.join(s.out, "Two.zip")));
  } finally { s.done(); }
});

test("ZIP64: entries, offsets and the directory past the 32-bit limit get their ZIP64 fields, and the system's unzip reads them", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "a.mp4"), Buffer.alloc(300, 1));
    s.put(path.join(s.folder, "b.pdf"), Buffer.alloc(200, 2));
    const body = project([bundled("a.mp4"), bundled("b.pdf")]);
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
    const body = project([bundled("take.mp4")]);
    const ipc = harness({ source: s.script });
    const zip = path.join(s.out, "Share.zip");
    const picked = await ipc.pick(zip);
    assert.deepEqual(await ipc.call("splitpage:bundle-export", "never-planned", picked.id), { ok: false, code: "UNKNOWN" }, "a forged job id");
    assert.deepEqual(await ipc.call("splitpage:bundle-export", "../x", picked.id), { ok: false, code: "REFUSED" });
    assert.deepEqual(await ipc.call("splitpage:bundle-export-plan", "../x", "Episode 12.splitpage", "{}", ipc.scriptId), { ok: false, code: "REFUSED" });
    for (const name of ["..\\Episode 12.splitpage", "a/b.splitpage", "Episode 12.exe", "Episode 12.zip", "CON.splitpage", "", "x.splitpage."]) {
      assert.deepEqual(await ipc.plan(body, "export1", name), { ok: false, code: "REFUSED" }, "script name " + JSON.stringify(name));
    }
    assert.deepEqual(await ipc.plan("not a script"), { ok: false, code: "REFUSED" }, "bytes that are no script");
    assert.deepEqual(await ipc.plan(body, "export1", "Episode 12.splitpage", s.script), { ok: false, code: "REFUSED" }, "a path where an id belongs");
    assert.deepEqual(await ipc.callFrom(ipc.main, null, "splitpage:bundle-export-plan", "export1", "Episode 12.splitpage", body, ipc.scriptId),
      { ok: false, code: "REFUSED" }, "no tab");
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
    await ipc.callFrom(ipc.main, otherTab, "splitpage:bundle-export-plan", "export2", "Episode 12.splitpage", body, "");
    assert.deepEqual(await ipc.callFrom(ipc.main, otherTab, "splitpage:bundle-export", "export2", picked.id), { ok: false, code: "UNKNOWN" },
      "a destination another tab's dialog chose");
    assert.deepEqual(fs.readdirSync(s.out), [], "nothing was written by any refused call");
    assert.deepEqual(await ipc.call("splitpage:bundle-export", "export1", picked.id), { ok: true, files: 1, left: 0 });
    assert.deepEqual(await ipc.call("splitpage:bundle-export", "export1", picked.id), { ok: false, code: "UNKNOWN" }, "a plan and a destination run once");
  } finally { s.done(); }
});

test("a file added to the folder after the plan, but not linked, never goes in", async () => {
  const s = scratch();
  try {
    s.put(path.join(s.folder, "take.mp4"), "take");
    const ipc = harness({ source: s.script });
    await ipc.plan(project([bundled("take.mp4")]));
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
    const body = project([bundled("take.mp4")]);
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
