import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSharedScriptCatalogueEntry, readSharedScriptIdentity } from "../../shared/shared-script.ts";

const require = createRequire(import.meta.url);
const { createSharedFileCopies } = require("../shared-file-copy.ts");
const { createDesktopStateStore } = require("../desktop-state.ts");
const { createFileRegistry, fileFingerprint, pathKey } = require("../file-service.ts");
const identity = { deployment: "test-deployment", script: "test-script" };
const key = identity.deployment + "/" + identity.script;
const docId = "d" + "a".repeat(32);
const anotherId = "d" + "b".repeat(32);

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "splitpage-shared-file-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const absPath = join(root, "Pilot.splitpage");
  const original = Buffer.from(JSON.stringify({ docId, title: "Original" }));
  await writeFile(absPath, original);
  const options = {
    filePath: () => join(root, "desktop-state.json"), pathKey,
    shared: { identity: readSharedScriptIdentity, entry: readSharedScriptCatalogueEntry }
  };
  const store = createDesktopStateStore(options);
  const files = createFileRegistry();
  const occupied = new Set();
  const reopen = () => createSharedFileCopies(createDesktopStateStore(options), files, key => occupied.has(key));
  const record = { ...identity, absPath, docId, fingerprint: fileFingerprint(original), missing: 0 };
  assert.ok(await store.write(state => { state.sharedFileCopies = [record]; }));
  const body = (title, fileId = docId) => Buffer.from(JSON.stringify({ docId: fileId, title }));
  const neverPick = () => { throw new Error("Unexpected save dialog"); };
  return { root, absPath, store, files, occupied, reopen, record, body, neverPick };
}

test("writes are checked, reserve the source path, and remember a fingerprint across restarts", async t => {
  const h = await setup(t);
  let service = h.reopen();
  assert.ok(service.reserved(h.absPath));
  assert.deepEqual(service.forPath(h.absPath), h.record);
  assert.equal(await service.matches(h.record), true);

  const body = h.body("Edited by a peer");
  const result = await service.write(key, body, 2, "check", docId, h.neverPick);
  assert.equal(result.kind, "file-copy-written");
  assert.equal(result.file.missing, 2);
  assert.equal(h.files.pathOf(result.id), h.absPath);
  assert.deepEqual(await readFile(h.absPath), body);

  service = h.reopen();
  const saved = service.forPath(h.absPath);
  assert.equal(saved.fingerprint, fileFingerprint(body));
  assert.equal(await service.matches(saved), true);
  assert.deepEqual(await service.status(key), { kind: "file-copy", file: { name: "Pilot.splitpage", docId, missing: 2 } });
  assert.deepEqual(await service.status("different/script"), { kind: "file-copy", file: null });

  const external = h.body("External edit");
  await writeFile(h.absPath, external);
  assert.equal(await service.matches(saved), false);
  assert.deepEqual(await service.write(key, body, 0, "check", docId, h.neverPick), { kind: "file-copy-problem", problem: "changed" });
  assert.deepEqual(await readFile(h.absPath), external);
  const changedAgain = h.body("Another external edit");
  await writeFile(h.absPath, changedAgain);
  assert.deepEqual(await service.write(key, body, 0, "overwrite", docId, h.neverPick), { kind: "file-copy-problem", problem: "changed" });
  assert.deepEqual(await readFile(h.absPath), changedAgain);
  assert.equal((await service.write(key, body, 0, "overwrite", docId, h.neverPick)).kind, "file-copy-written");
  assert.deepEqual(await readFile(h.absPath), body);
});

test("failed writes and cancelled or reserved destinations leave the association intact", async t => {
  const h = await setup(t);
  const service = h.reopen(), body = h.body("Current script", anotherId);
  const blocked = join(h.root, "Directory.splitpage");
  await mkdir(blocked);
  for (const choice of [null, h.absPath, blocked]) {
    assert.deepEqual(await service.write(key, body, 0, "new", anotherId, async () => choice),
      { kind: "file-copy-problem", problem: "unavailable" });
    assert.deepEqual(service.forPath(h.absPath), h.record);
  }
  const replacement = join(h.root, "New copy.splitpage");
  h.occupied.add(pathKey(replacement));
  assert.equal((await service.write(key, body, 0, "new", anotherId, async () => replacement)).kind, "file-copy-problem");
  h.occupied.clear();
  assert.equal((await service.write(key, body, 0, "export", anotherId, async () => replacement)).kind, "file-copy-written");
  assert.deepEqual(service.forPath(h.absPath), h.record);
  assert.equal(service.reserved(replacement), false);
  assert.deepEqual(await readFile(replacement), body);

  assert.equal((await service.write(key, body, 0, "new", anotherId, async () => replacement)).kind, "file-copy-written");
  assert.equal(service.reserved(h.absPath), false);
  assert.equal(service.forPath(replacement).docId, anotherId);
  assert.ok(await service.forget(key));
  assert.equal(h.reopen().reserved(replacement), false);
  assert.deepEqual(await readFile(replacement), body);
});
