import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  filesToOpenFrom, pathKey, createFileRegistry, readFileEntry, toBuffer, atomicWrite
} = require(path.join(here, "..", "file-service.js"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-file-service-"));

test("launch arguments open existing files with a document extension, and skip flags, folders and the rest", () => {
  for (const n of ["a.splitpage", "b.MD", "c.html", "d.htm", "e.docx", "f.txt", "g.csv", "h.pdf", "-flag.md"]) fs.writeFileSync(path.join(root, n), "x");
  fs.mkdirSync(path.join(root, "folder.md"));
  const list = ["a.splitpage", "b.MD", "c.html", "d.htm", "e.docx", "f.txt", "g.csv", "h.pdf", "-flag.md", "--inspect", "folder.md", "missing.md", path.join(root, "a.splitpage")];
  assert.deepEqual(filesToOpenFrom(list, root), [
    "a.splitpage", "b.MD", "c.html", "d.htm", "e.docx", "f.txt", "g.csv", "a.splitpage"
  ].map((n) => path.join(root, n)));
});

test("path keys resolve the path, and fold case only on Windows", () => {
  assert.equal(pathKey(path.join(root, "x", "..", "Doc.md"), "linux"), path.join(root, "Doc.md"));
  assert.equal(pathKey(path.join(root, "Doc.md"), "win32"), path.join(root, "Doc.md").toLowerCase());
  assert.equal(pathKey(path.join(root, "Doc.md"), "darwin"), path.join(root, "Doc.md"));
  assert.equal(pathKey(path.join(root, "Doc.md")), pathKey(path.join(root, "Doc.md"), process.platform));
});

test("each registration mints a fresh opaque id for its path", () => {
  const ids = createFileRegistry();
  const a = ids.register("/docs/a.md");
  const b = ids.register("/docs/a.md");
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.equal(ids.pathOf(a), "/docs/a.md");
  assert.equal(ids.pathOf(b), "/docs/a.md");
  assert.equal(ids.pathOf("unknown"), undefined);
  assert.equal(createFileRegistry().pathOf(a), undefined);
});

test("a file entry carries its id, name, whole-millisecond time, size and bytes", async () => {
  const file = path.join(root, "entry.md");
  fs.writeFileSync(file, "hello");
  const when = new Date(1700000000123.7);
  fs.utimesSync(file, when, when);
  const entry = await readFileEntry("id-1", file);
  assert.equal(entry.id, "id-1");
  assert.equal(entry.name, "entry.md");
  assert.equal(entry.lastModified, Math.floor(fs.statSync(file).mtimeMs));
  assert.equal(entry.size, 5);
  assert.ok(entry.bytes instanceof Uint8Array);
  assert.equal(Buffer.from(entry.bytes).toString("utf8"), "hello");
  await assert.rejects(readFileEntry("id-2", path.join(root, "nope.md")), { code: "ENOENT" });
});

test("strings, byte views and array buffers become buffers, and anything else throws", () => {
  assert.equal(toBuffer("hé").toString("utf8"), "hé");
  const backing = new Uint8Array([9, 1, 2, 3, 9]);
  assert.deepEqual([...toBuffer(backing.subarray(1, 4))], [1, 2, 3]);
  assert.deepEqual([...toBuffer(new Uint8Array([4, 5]).buffer)], [4, 5]);
  assert.throws(() => toBuffer(42), /writeFile: unsupported data type/);
  assert.throws(() => toBuffer(null), /writeFile: unsupported data type/);
});

test("an atomic write replaces the file and leaves no temp file", async () => {
  const dir = fs.mkdtempSync(path.join(root, "write-"));
  const file = path.join(dir, "doc.splitpage");
  fs.writeFileSync(file, "old");
  await atomicWrite(file, Buffer.from("new"));
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["doc.splitpage"]);
});

test("an atomic write whose rename fails removes its temp file and throws", async () => {
  const dir = fs.mkdtempSync(path.join(root, "fail-"));
  const target = path.join(dir, "taken");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "inside"), "x");
  await assert.rejects(atomicWrite(target, Buffer.from("new")));
  assert.deepEqual(fs.readdirSync(dir), ["taken"]);
});

function recordingIo(log, fail) {
  return {
    open: async (p, flags) => {
      const fh = await fsp.open(p, flags);
      log.push("open:" + flags);
      return {
        writeFile: async (data) => { log.push("write"); if (fail === "write") throw new Error("disk full"); return fh.writeFile(data); },
        sync: async () => { log.push("sync"); if (fail === "sync") throw new Error("sync failed"); return fh.sync(); },
        close: async () => { log.push("close"); return fh.close(); }
      };
    },
    rename: async (from, to) => { log.push("rename"); return fsp.rename(from, to); },
    unlink: async (p) => { log.push("unlink"); return fsp.unlink(p); }
  };
}

test("an atomic write flushes the temp file to disk before it renames it over the document", async () => {
  const dir = fs.mkdtempSync(path.join(root, "sync-"));
  const file = path.join(dir, "doc.splitpage");
  fs.writeFileSync(file, "old");
  const log = [];
  await atomicWrite(file, Buffer.from("new"), recordingIo(log));
  assert.deepEqual(log, ["open:wx", "write", "sync", "close", "rename"]);
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["doc.splitpage"]);
});

for (const fail of ["write", "sync"]) {
  test("an atomic write whose " + fail + " fails closes and removes its temp file, keeps the old document and throws", async () => {
    const dir = fs.mkdtempSync(path.join(root, "fail-" + fail + "-"));
    const file = path.join(dir, "doc.splitpage");
    fs.writeFileSync(file, "old");
    const log = [];
    await assert.rejects(atomicWrite(file, Buffer.from("new"), recordingIo(log, fail)));
    assert.equal(log.includes("rename"), false);
    assert.deepEqual(log.slice(-2), ["close", "unlink"]);
    assert.equal(fs.readFileSync(file, "utf8"), "old");
    assert.deepEqual(fs.readdirSync(dir), ["doc.splitpage"]);
  });
}

test("an atomic write into a missing folder throws and creates nothing", async () => {
  const dir = path.join(root, "absent");
  await assert.rejects(atomicWrite(path.join(dir, "doc.md"), Buffer.from("x")), { code: "ENOENT" });
  assert.equal(fs.existsSync(dir), false);
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
fs.rmSync(root, { recursive: true, force: true });
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
