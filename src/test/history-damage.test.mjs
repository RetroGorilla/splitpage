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
import { createHistoryStore, projectHistoryBucket } from "../../shared/history-store.ts";

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
  async function fixture(t, snapshots, options = {}) {
    let backend, inspect;
    const buckets = index(snapshots);
    Object.assign(buckets[DOC], options.fields);
    if (options.older === false) delete buckets._older;
    if (options.olderOnly) delete buckets[DOC];
    const bodies = { [sha]: text, ...options.bodies };
    if (kind === "filesystem") {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "splitpage-history-damage-"));
      t.after(() => fsp.rm(dir, { recursive: true, force: true }));
      backend = createHistoryFsBackend({ dir, fs, fsp, path, crypto, projectHistoryBucket });
      await backend.exclusive(async (tx) => {
        for (const [hash, body] of Object.entries(bodies)) await tx.put(hash, body);
        await tx.commit(index([good]), []);
      });
      await fsp.writeFile(path.join(dir, "index.json"), JSON.stringify({ formatVersion: 2, buckets, trash: [] }));
      backend = createHistoryFsBackend({ dir, fs, fsp, path, crypto, projectHistoryBucket });
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
      await backend.seed(buckets, bodies);
      inspect = () => backend.inspect();
      if (kind === "idb") t.after(() => backend.close());
    }
    const clock = { t: 2000 };
    const store = createHistoryStore({ backend, now: () => clock.t, hashText: (body) => crypto.createHash("sha256").update(body).digest("hex"), capBytes: options.capBytes });
    const hasBody = (hash) => kind === "filesystem" ? fs.existsSync(backend.bodies.pathFor(hash)) : backend.hasBody(hash);
    const dropBody = (hash) => kind === "filesystem" ? fsp.unlink(backend.bodies.pathFor(hash)) : backend.dropBody(hash);
    return { store, inspect, hasBody, dropBody, backend, clock };
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

  test(`[${kind}] damaged future entries do not consume the fifty-version allowance`, async (t) => {
    const intact = Array.from({ length: 50 }, (_, i) => ({ ...good, id: "intact" + i, atMs: 1000 + i }));
    const { store } = await fixture(t, [...intact, damaged], { older: false });
    const result = await store.put(DOC, { id: "backup", atMs: 2000 }, text);
    assert.equal(result.stored, true);
    assert.equal(result.evicted, 1);
    const listed = await store.list(DOC);
    assert.equal(listed.entries.length, 50);
    assert.ok(listed.entries.some((entry) => entry.id === "backup"));
    assert.deepEqual((await store.rawIndex())[DOC].snapshots.find((entry) => entry?.id === "bad"), damaged);
  });

  test(`[${kind}] pruning never removes opaque metadata or its body`, async (t) => {
    const opaqueBody = "opaque history body";
    const opaqueSha = crypto.createHash("sha256").update(opaqueBody).digest("hex");
    const opaque = { ...good, id: "opaque", sha: opaqueSha, atMs: 1, label: { toString: null }, sizeBytes: 5000000 };
    const { store, hasBody } = await fixture(t, [opaque, good], { older: false, bodies: { [opaqueSha]: opaqueBody } });
    await store.evict(0);
    await store.touch(DOC, "Opened again");
    assert.equal(await hasBody(opaqueSha), true);
    assert.equal(JSON.stringify((await store.rawIndex())[DOC].snapshots.find((entry) => entry?.id === "opaque")), JSON.stringify(opaque));
    assert.equal((await store.usage()).totalBytes, text.length);
  });

  test(`[${kind}] a successful backup survives a damaged cap-sized future entry and a protected restore target`, async (t) => {
    const cap = 5 * 1024 * 1024;
    const opaque = { ...damaged, sizeBytes: cap };
    const { store } = await fixture(t, [good, opaque], { older: false, capBytes: cap });
    const result = await store.put(DOC, { id: "backup", atMs: 2000 }, text, { protect: [{ docId: DOC, id: "good" }] });
    assert.equal(result.stored, true);
    assert.equal((await store.get(DOC, "backup"))?.stateJson, text);
    assert.equal((await store.get(DOC, "good"))?.stateJson, text);
    assert.equal((await store.list(DOC)).damaged, 1);
  });

  test(`[${kind}] malformed snapshot payload survives touch, save and prune byte for byte`, async (t) => {
    const payload = { original: ["  raw text  ", null, { title: "unparsed", atMs: 1e100 }] };
    const { store } = await fixture(t, payload, { older: false });
    await store.touch(DOC, "Opened");
    const afterTouch = (await store.rawIndex())[DOC];
    assert.equal(JSON.stringify(afterTouch.damagedSnapshots), JSON.stringify(payload));
    assert.deepEqual(afterTouch.snapshots, []);
    assert.equal((await store.list(DOC)).damaged, 1);
    assert.equal((await store.put(DOC, { id: "backup", atMs: 2000 }, text)).stored, true);
    await store.evict(0);
    await store.touch(DOC, "Opened once more");
    assert.equal(JSON.stringify((await store.rawIndex())[DOC].damagedSnapshots), JSON.stringify(payload));
    assert.equal((await store.list(DOC)).damaged, 1);
    assert.equal((await store.get(DOC, "backup"))?.stateJson, text);
  });

  test(`[${kind}] retained null entries cannot block the next snapshot`, async (t) => {
    const { store } = await fixture(t, [good, null], { older: false });
    assert.equal((await store.put(DOC, { id: "backup", atMs: 2000 }, text)).stored, true);
    assert.deepEqual((await store.list(DOC)).entries.map((entry) => entry.id), ["backup", "good"]);
    assert.equal((await store.rawIndex())[DOC].snapshots.filter((entry) => entry === null).length, 1);
    assert.equal((await store.get(DOC, "backup"))?.stateJson, text);
  });

  test(`[${kind}] copying into opaque entries preserves them without sorting them`, async (t) => {
    const { store } = await fixture(t, [good, null], { older: false });
    assert.deepEqual(await store.copy(DOC, COPY), { ok: true, copied: 1 });
    assert.deepEqual(await store.copy(COPY, DOC), { ok: true, copied: 0 });
    assert.deepEqual((await store.rawIndex())[DOC].snapshots, [good, null]);
  });

  test(`[${kind}] a later malformed payload never replaces the existing quarantine`, async (t) => {
    const first = { first: "  keep this  " }, second = { second: [null, "keep this too"] };
    const { store } = await fixture(t, second, { older: false, fields: { damagedSnapshots: first } });
    await store.touch(DOC, "Opened");
    assert.equal((await store.put(DOC, { id: "backup", atMs: 2000 }, text)).stored, true);
    await store.evict(0);
    const rec = (await store.rawIndex())[DOC];
    assert.equal(JSON.stringify(rec.damagedSnapshots), JSON.stringify(first));
    assert.equal(JSON.stringify(rec.snapshots.find((entry) => entry?.damagedSnapshots)?.damagedSnapshots), JSON.stringify(second));
    assert.equal((await store.list(DOC)).damaged, 2);
    assert.equal((await store.get(DOC, "backup"))?.stateJson, text);
  });

  test(`[${kind}] missing-body repair only removes readable entries`, async (t) => {
    const { store, dropBody } = await fixture(t, [good, damaged], { older: false });
    await dropBody(sha);
    assert.equal(await store.get(DOC, "good"), null);
    const rec = (await store.rawIndex())[DOC];
    assert.deepEqual(rec.snapshots, [damaged]);
    assert.equal((await store.list(DOC)).damaged, 1);
  });

  test(`[${kind}] Older expiry and reimport retain opaque entries`, async (t) => {
    const { store, clock, hasBody } = await fixture(t, [good, damaged], { olderOnly: true });
    clock.t = 100001;
    assert.equal((await store.list(null)).olderDamaged, 1);
    assert.deepEqual((await store.rawIndex())._older.snapshots, [damaged]);
    assert.equal((await store.importOlder([{ meta: { id: "imported", atMs: 2000 }, stateJson: text }])).ok, true);
    await store.evict(0);
    assert.deepEqual((await store.rawIndex())._older.snapshots, [damaged]);
    assert.equal(await hasBody(sha), true);
    assert.equal((await store.list(null)).olderDamaged, 1);
  });

  test(`[${kind}] an unrepresentable new stamp is refused instead of reporting a lost backup`, async (t) => {
    const { store } = await fixture(t, [{ ...good, atMs: 8640000000000000 }], { older: false });
    assert.equal((await store.put(DOC, { id: "backup", atMs: 2000 }, text)).stored, false);
    assert.equal((await store.get(DOC, "good"))?.stateJson, text);
    assert.equal(await store.get(DOC, "backup"), null);
  });
}
