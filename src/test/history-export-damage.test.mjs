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
import { createHistoryBackendProbe, createIdbHistoryTestBackend } from "../adapters/storage/history-backend-testing.ts";
import { createHistoryBackends } from "../adapters/storage/history-backends.ts";
import { createHistoryOwner } from "../application/recovery/history.ts";
import { createHistoryStore } from "../../shared/history-store.ts";

const { createHistoryFsBackend } = createRequire(import.meta.url)("../../desktop/history-fs-backend.ts");
const docId = "d" + "a".repeat(32), image = "b".repeat(64);
const stateJson = JSON.stringify({ docId, title: "Intact", rows: [{ id: "r1", imageRef: { sha256: image, mime: "image/png", width: 1, height: 1 } }] });
const sha = crypto.createHash("sha256").update(stateJson).digest("hex");
const good = { id: "intact", atMs: 1000, sha, sizeBytes: stateJson.length, label: "Intact" };
const bad = { ...good, id: "damaged", atMs: 1e100 };

async function harness(t, kind, snapshots = [good, bad], fields = {}) {
  const buckets = { [docId]: { title: "Intact", lastOpenedAt: 1, snapshots, ...fields }, _older: { snapshots: [bad], expiresAt: 100000 } };
  let bridge = null, inspect;
  const probe = createHistoryBackendProbe();
  probe.idb = (options) => createIdbHistoryTestBackend({ ...options, indexedDB: new IDBFactory() });
  if (kind === "filesystem") {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "splitpage-history-export-"));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const backend = createHistoryFsBackend({ dir, fs, fsp, path, crypto });
    await backend.exclusive(async (tx) => { await tx.put(sha, stateJson); await tx.commit(buckets, []); });
    const store = createHistoryStore({ backend, now: () => 2000, hashText: (body) => crypto.createHash("sha256").update(body).digest("hex") });
    bridge = {
      historyListDocs: () => store.listDocs(),
      historyList: (id) => store.list(id),
      historyGet: (query, id) => store.get(query.older ? "_older" : query.docId, id),
      historyPut: async () => ({ ok: false })
    };
    inspect = () => fsp.readFile(path.join(dir, "index.json"), "utf8");
  }
  const storage = createHistoryBackends({ now: () => 2000, holds: () => [], desktop: () => bridge, runningOnDesktop: () => !!bridge }, probe);
  if (!bridge) await storage.controls.forceBackend(kind);
  const backend = await storage.resolveHistoryBackend();
  if (!bridge) {
    await backend.store.backend.seed(buckets, { [sha]: stateJson });
    inspect = () => backend.store.backend.inspect();
  }
  const owner = createHistoryOwner();
  const stop = owner.startHistory({
    document: { current: () => ({ docId, title: "Current", rows: [] }) },
    location: { home: () => ({ kind: "none" }) }, preferences: { editorName: () => "Adam" },
    saving: { changes: () => 0, unsaved: () => false }, recovery: { readRaw: () => null, remove: () => true },
    effects: { show() {} },
    pictures: { intern: () => null, persist: async () => [], ensureBytes: async () => [], recordFor: () => ({ mime: "image/png" }), dataUrlFor: () => "data:image/png;base64,aW1hZ2U=" },
    inlinePictures: (json) => json, ids: { id: () => "snapshot", docId: () => docId }, seed: { passes: () => true },
    logger: { error() {}, warn() {} }, now: () => 2000, decodeBase64: atob, yield: async () => {},
    desktop: { history: () => bridge, running: () => !!bridge }, storage: () => storage
  });
  t.after(async () => { await stop(); await storage.close(); });
  return { owner, backend, bridge, inspect };
}

for (const kind of ["memory", "idb", "filesystem"]) {
  test(`[${kind}] export keeps intact history and its images beside damaged metadata`, async (t) => {
    const h = await harness(t, kind);
    const before = await h.inspect();
    const out = await h.owner.exportHistoryAll();
    assert.equal(out.docs.length, 1);
    assert.deepEqual(out.docs[0].snapshots.map((s) => s.stateJson), [stateJson]);
    assert.deepEqual(out.older, []);
    assert.equal(out.omittedSnapshots, 2);
    assert.deepEqual(out.blobs[image], { mime: "image/png", b64: "aW1hZ2U=" });
    assert.deepEqual(await h.inspect(), before);
  });

  test(`[${kind}] missing bodies are counted instead of silently omitted`, async (t) => {
    const h = await harness(t, kind, [good]);
    h.backend.get = async () => null;
    const out = await h.owner.exportHistoryAll();
    assert.equal(out.docs[0].snapshots.length, 0);
    assert.equal(out.omittedSnapshots, 2);
  });

  test(`[${kind}] quarantined and opaque entries remain reported during export`, async (t) => {
    const h = await harness(t, kind, [good, null, { ...good, sha: "" }], { damagedSnapshots: { untouched: ["raw", null] } });
    const before = await h.inspect();
    const out = await h.owner.exportHistoryAll();
    assert.equal(out.docs[0].snapshots.length, 1);
    assert.equal(out.omittedSnapshots, 4);
    assert.deepEqual(await h.inspect(), before);
  });
}

test("desktop export rejects an unavailable list instead of treating it as empty history", async (t) => {
  const h = await harness(t, "filesystem");
  h.bridge.historyList = async () => { throw new Error("unavailable"); };
  await assert.rejects(h.owner.exportHistoryAll(), /history|export/i);
});
