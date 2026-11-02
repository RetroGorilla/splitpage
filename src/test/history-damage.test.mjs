import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { createIdbHistoryTestBackend, createMemoryHistoryTestBackend } from "../adapters/storage/history-backend-testing.ts";
import { createHistoryStore } from "../../shared/history-store.ts";

const require = createRequire(import.meta.url);
const { createHistoryFsBackend } = require("../../desktop/history-fs-backend.ts");
const DOC = "d" + "a".repeat(32), COPY = "d" + "b".repeat(32);
const text = JSON.stringify({ rows: [], title: "Intact" });
const sha = crypto.createHash("sha256").update(text).digest("hex");
const good = { id: "good", atMs: 1000, label: "Intact", sha, sizeBytes: text.length };
const damaged = { id: "bad", atMs: 1e100, sha };
const index = (snapshots) => ({
  [DOC]: { title: { toString: null }, lastOpenedAt: 1, snapshots },
  _older: { title: "", lastOpenedAt: 1, snapshots, expiresAt: 100000 }
});

for (const kind of ["memory", "idb", "filesystem"]) {
  async function fixture(t, snapshots) {
    let backend, inspect;
    if (kind === "filesystem") {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "splitpage-history-damage-"));
      t.after(() => fsp.rm(dir, { recursive: true, force: true }));
      backend = createHistoryFsBackend({ dir, fs, fsp, path, crypto });
      await backend.exclusive(async (tx) => { await tx.put(sha, text); await tx.commit(index([good]), []); });
      await fsp.writeFile(path.join(dir, "index.json"), JSON.stringify({ formatVersion: 2, buckets: index(snapshots), trash: [] }));
      backend = createHistoryFsBackend({ dir, fs, fsp, path, crypto });
      inspect = async () => {
        const files = {};
        async function walk(dir, prefix = "") {
          for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
            const name = prefix + entry.name;
            if (entry.isDirectory()) await walk(path.join(dir, entry.name), name + "/");
            else files[name] = await fsp.readFile(path.join(dir, entry.name), "base64");
          }
        }
        await walk(dir);
        return files;
      };
    } else {
      backend = kind === "idb" ? createIdbHistoryTestBackend({ indexedDB: new IDBFactory() }) : createMemoryHistoryTestBackend();
      await backend.seed(index(snapshots), { [sha]: text });
      inspect = () => backend.inspect();
      if (kind === "idb") t.after(() => backend.close());
    }
    const store = createHistoryStore({ backend, now: () => 2000, hashText: () => sha });
    return { store, inspect };
  }

  test(`[${kind}] damaged metadata cannot hide intact versions or change stored bytes`, async (t) => {
    const { store, inspect } = await fixture(t, [good, damaged, null, { id: "empty", atMs: 1, sha: "" }]);
    const before = await inspect();
    const listed = await store.list(DOC);
    assert.deepEqual(listed.entries.map((m) => m.id), ["good"]);
    assert.equal(listed.damaged, 3);
    assert.deepEqual(listed.older.map((m) => m.id), ["good"]);
    assert.equal(listed.olderDamaged, 3);
    assert.equal((await store.get(DOC, "good")).stateJson, text);
    assert.equal(await store.get(DOC, "bad"), null);
    assert.equal(await store.get(DOC, "empty"), null);
    assert.equal(await store.get("_older", "bad"), null);
    assert.deepEqual(await inspect(), before);
  });

  test(`[${kind}] damage alone is reported as damage, including malformed buckets`, async (t) => {
    for (const snapshots of [[damaged], "broken"]) {
      const { store, inspect } = await fixture(t, snapshots);
      const before = await inspect();
      const listed = await store.list(DOC);
      assert.deepEqual(listed.entries, []);
      assert.equal(listed.damaged, 1);
      assert.equal(listed.olderDamaged, 1);
      assert.deepEqual(await inspect(), before);
    }
  });

  test(`[${kind}] copying skips damaged entries and uses a safe bucket title`, async (t) => {
    const { store } = await fixture(t, [good, damaged, null, { id: "empty", atMs: 1, sha: "" }]);
    assert.deepEqual(await store.copy(DOC, COPY), { ok: true, copied: 1 });
    assert.deepEqual((await store.list(COPY)).entries.map((m) => m.id), ["good"]);
    assert.equal((await store.get(COPY, "good")).stateJson, text);
    assert.equal((await store.listDocs()).find((d) => d.docId === COPY).title, "");
  });

  test(`[${kind}] malformed fields and a damaged duplicate cannot hide a readable version`, async (t) => {
    const broken = [
      { ...good, sha: "" },
      { ...good, id: "coercion", label: { toString: null } },
      { ...good, id: "size", sizeBytes: { toString: null } },
      { ...good, id: "infinity", rows: "Infinity" }
    ];
    const { store, inspect } = await fixture(t, [...broken, good]);
    const before = await inspect();
    const listed = await store.list(DOC);
    assert.deepEqual(listed.entries.map((m) => m.id), ["good"]);
    assert.equal(listed.damaged, broken.length);
    assert.equal((await store.get(DOC, "good")).stateJson, text);
    assert.deepEqual(await inspect(), before);
  });

  test(`[${kind}] damaged timestamps cannot poison a restore backup's stamp`, async (t) => {
    const { store } = await fixture(t, [good, damaged]);
    assert.equal((await store.put(DOC, { id: "backup", atMs: 2000, label: "Before restoring" }, text)).stored, true);
    const listed = await store.list(DOC);
    assert.deepEqual(listed.entries.map((m) => [m.id, m.atMs]), [["backup", 2000], ["good", 1000]]);
    assert.equal(listed.damaged, 1);
    assert.equal((await store.get(DOC, "backup")).stateJson, text);
  });
}
