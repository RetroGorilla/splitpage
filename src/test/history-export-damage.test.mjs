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
import { createHistoryStore, projectHistoryBucket } from "../../shared/history-store.ts";
import { createBlobStore, createMemoryBlobBackend } from "../adapters/storage/blob-store.ts";
import { makeDesktopBlobBackend } from "../adapters/desktop/desktop-blobs.ts";
import { mountAppData } from "../features/settings/app-data.ts";

const { createHistoryFsBackend } = createRequire(import.meta.url)("../../desktop/history-fs-backend.ts");
const docId = "d" + "a".repeat(32), image = "b".repeat(64);
const stateJson = JSON.stringify({ docId, title: "Intact", rows: [{ id: "r1", imageRef: { sha256: image, mime: "image/png", width: 1, height: 1 } }] });
const sha = crypto.createHash("sha256").update(stateJson).digest("hex");
const good = { id: "intact", atMs: 1000, sha, sizeBytes: stateJson.length, label: "Intact" };
const bad = { ...good, id: "damaged", atMs: 1e100 };

async function harness(t, kind, snapshots = [good, bad], fields = {}, options = {}) {
  const buckets = { [docId]: { title: "Intact", lastOpenedAt: 1, snapshots, ...fields }, _older: { snapshots: [bad], expiresAt: 100000 } };
  if (options.older) buckets._older = options.older;
  let bridge = null, inspect;
  const probe = createHistoryBackendProbe();
  const factory = new IDBFactory();
  probe.idb = (options) => createIdbHistoryTestBackend({ ...options, indexedDB: factory });
  if (kind === "filesystem") {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "splitpage-history-export-"));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const backend = createHistoryFsBackend({ dir, fs, fsp, path, crypto, projectHistoryBucket });
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
    pictures: options.pictures || { intern: () => null, persist: async () => [], ensureBytes: async () => [], recordFor: () => ({ mime: "image/png" }), dataUrlFor: () => "data:image/png;base64,aW1hZ2U=" },
    inlinePictures: (json) => json, ids: { id: () => "snapshot", docId: () => docId }, seed: { passes: () => true },
    logger: { error() {}, warn() {} }, now: () => 2000, decodeBase64: atob, yield: async () => {},
    desktop: { history: () => bridge, running: () => !!bridge }, storage: () => storage
  });
  t.after(async () => { await stop(); await storage.close(); });
  return { owner, backend, bridge, inspect, storage };
}

function appHarness(t, owner) {
  document.body.innerHTML = '<input id="import-app-data-input" type="file">';
  const delivered = [], messages = [], choices = [];
  const app = mountAppData({
    notices: {
      show: (...args) => { messages.push(args); return { isConnected: false, dismiss() {}, removeEventListener() {} }; },
      showAction: (message, kind, label, action) => { messages.push([message, kind]); choices.push({ label, action }); return { isConnected: true, dismiss() {}, removeEventListener() {} }; }
    },
    fileDelivery: { deliver: (_name, text) => { delivered.push(JSON.parse(text)); return Promise.resolve(true); } },
    preferences: { appDataExport: () => ({}), appDataImport: () => [], commentsSort: () => "recent" },
    desktop: () => false, launchFacts: { appVersion: () => "" }, commentSorting: { choose: () => "recent" },
    history: { exportAll: (options) => owner.exportHistoryAll(options), normalizeSnapshots: () => [], importBundle: (bundle) => owner.importHistoryBundle(bundle) },
    writer: { size: () => 20, setSize() {} }, embeddedVersion: () => "", useBlobBackend() {}
  });
  t.after(() => app.dispose());
  return { app, delivered, messages, choices };
}

function productionHarness(t, indexedDB) {
  const previous = Object.getOwnPropertyDescriptor(window, "indexedDB");
  Object.defineProperty(window, "indexedDB", { configurable: true, value: indexedDB });
  t.after(() => { if (previous) Object.defineProperty(window, "indexedDB", previous); else Reflect.deleteProperty(window, "indexedDB"); });
  const storage = createHistoryBackends({ now: () => 2000, holds: () => [], desktop: () => null, runningOnDesktop: () => false });
  const owner = createHistoryOwner();
  const stop = owner.startHistory({
    document: { current: () => ({ docId, title: "Current", rows: [] }) },
    location: { home: () => ({ kind: "none" }) }, preferences: { editorName: () => "Adam" },
    saving: { changes: () => 0, unsaved: () => false }, recovery: { readRaw: () => null, remove: () => true },
    effects: { show() {} },
    pictures: { intern: () => null, persist: async () => [], ensureBytes: async () => [], recordFor: () => null, dataUrlFor: () => null },
    inlinePictures: (json) => json, ids: { id: () => "snapshot", docId: () => docId }, seed: { passes: () => true },
    logger: { error() {}, warn() {} }, now: () => 2000, decodeBase64: atob, yield: async () => {},
    desktop: { history: () => null, running: () => false }, storage: () => storage
  });
  t.after(async () => { await stop(); await storage.close(); });
  return { owner, storage };
}

test("production memory history exports current-session snapshots when IndexedDB is absent", async (t) => {
  const h = productionHarness(t, undefined);
  const captured = h.owner.captureSnapshot("Keep", { docId, title: "Unsaved work", rows: [] });
  assert.equal((await captured.done).stored, true);
  assert.equal((await h.owner.listDocHistory(docId)).entries.length, 1);
  const body = (await h.owner.getHistorySnapshot({ docId, id: captured.id })).stateJson;
  assert.equal(JSON.parse(body).title, "Unsaved work");
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 2);
  assert.equal(h.storage.backendName(), "memory");
  for (const bundle of a.delivered) assert.equal(bundle.history.docs[0].snapshots[0].stateJson, body);
  assert.equal(a.messages.some((m) => m[1] === "warn" || m[1] === "error"), false);
});

test("production export can select an empty memory store before the first snapshot", async (t) => {
  const h = productionHarness(t, null);
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 1);
  assert.deepEqual(a.delivered[0].history.docs, []);
  assert.equal((await h.owner.captureSnapshot("Keep", { docId, title: "First", rows: [] }).done).stored, true);
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 2);
  assert.equal(JSON.parse(a.delivered[1].history.docs[0].snapshots[0].stateJson).title, "First");
  assert.equal(h.storage.backendName(), "memory");
});

test("production persistent open failure stays distinct from an absent IndexedDB API", async (t) => {
  const h = productionHarness(t, { open() { throw new Error("locked"); } });
  assert.equal((await h.owner.captureSnapshot("Keep", { docId, title: "Fallback", rows: [] }).done).stored, true);
  assert.equal(h.storage.backendName(), "memory");
  Object.defineProperty(window, "indexedDB", { configurable: true, value: undefined });
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 0);
  assert.match(a.messages.at(-1)[0], /Export cancelled/);
});

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

  test(`[${kind}] expired intact Older entries export as ordinary empty history`, async (t) => {
    const h = await harness(t, kind, [], {}, { older: { snapshots: [good], expiresAt: 1000 } });
    const a = appHarness(t, h.owner);
    await a.app.exportAppData();
    assert.equal(a.delivered.length, 1);
    assert.deepEqual(a.delivered[0].history.older, []);
    assert.equal(a.delivered[0].history.omittedSnapshots, undefined);
    assert.equal(a.messages.some((m) => m[1] === "warn" || m[1] === "error"), false);
  });
}

for (const resolveFirst of [false, true]) test(`persistent reopen failure cancels export after fallback ${resolveFirst}`, async (t) => {
  const h = await harness(t, "idb");
  assert.equal((await h.backend.store.rawIndex())[docId].snapshots.length, 2);
  h.storage.controls.injectFault("idb-open-fail");
  if (resolveFirst) assert.equal((await h.storage.resolveHistoryBackend()).name, "memory");
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 0);
  assert.equal(a.choices.length, 0);
  assert.match(a.messages.at(-1)[0], /Export cancelled/);
  h.storage.controls.injectFault(null);
  await h.storage.controls.forceBackend("idb");
  assert.equal((await h.owner.exportHistoryAll()).docs[0].snapshots.length, 1);
});

for (const failure of ["reject", "timeout"]) test(`desktop body ${failure} cancels rather than delivering partial history`, async (t) => {
  const h = await harness(t, "filesystem", [good, { ...good, id: "other" }]);
  const get = h.bridge.historyGet;
  if (failure === "timeout") h.storage.controls.setDesktopTimeout(5);
  h.bridge.historyGet = (query, id) => id === "intact" ? (failure === "reject" ? Promise.reject(new Error("locked")) : new Promise(() => {})) : get(query, id);
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 0);
  assert.match(a.messages.at(-1)[0], /Export cancelled/);
  assert.equal(a.choices.length, failure === "timeout" ? 0 : 1);
  if (failure === "timeout") {
    assert.match(a.messages.at(-1)[0], /Please try again/);
    await assert.rejects(h.owner.exportHistoryAll({ allowOmissions: true }), (error) => error.code === "temporary-read-failed");
  }
});

test("desktop image read rejection cancels delivery through the actual image fallback", async (t) => {
  const pictures = createBlobStore({ preferred: null, fallback: createMemoryBlobBackend, objectUrl: () => "", revokeObjectUrl() {}, later() {}, warn() {} });
  pictures.setBackend(makeDesktopBlobBackend({ blobGet: async () => { throw new Error("locked"); }, blobPut: async () => ({ ok: true }), blobMissing: async () => [] }));
  const h = await harness(t, "filesystem", [good], {}, { pictures });
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 0);
  assert.equal(a.messages.at(-1)[0], "Export cancelled — history or image data could not be read. Nothing was downloaded.");
});

test("a failed body read offers only eligibility until an opt-in export counts omissions", async (t) => {
  const h = await harness(t, "filesystem", [good, { ...good, id: "other" }]);
  const get = h.bridge.historyGet;
  h.bridge.historyGet = (query, id) => id === "intact" ? Promise.reject(new Error("locked")) : get(query, id);
  const before = await h.inspect();
  await assert.rejects(h.owner.exportHistoryAll(), (error) => {
    assert.equal(error.code, "read-failed");
    assert.equal(error.canExportRest, true);
    assert.equal("partial" in error, false);
    return true;
  });
  const out = await h.owner.exportHistoryAll({ allowOmissions: true });
  assert.deepEqual(out.docs[0].snapshots.map((s) => s.meta.id), ["other"]);
  assert.equal(out.omittedSnapshots, 2);
  assert.deepEqual(out.blobs[image], { mime: "image/png", b64: "aW1hZ2U=" });
  assert.equal(await h.inspect(), before);
});

test("image read failures retain other images and count shared unreadable images once", async (t) => {
  const otherImage = "c".repeat(64);
  const otherBody = JSON.stringify({ docId, rows: [{ imageRef: { sha256: otherImage } }, { imageRef: { sha256: image } }] });
  const otherSha = crypto.createHash("sha256").update(otherBody).digest("hex");
  const pictures = { intern: () => null, persist: async () => [],
    ensureBytes: async (shas) => { if (shas.includes(image)) throw new Error("locked"); return []; },
    recordFor: () => ({ mime: "image/png" }), dataUrlFor: () => "data:image/png;base64,aW1hZ2U=" };
  const h = await harness(t, "memory", [good, { ...good, id: "other", sha: otherSha }], {}, { pictures });
  await h.backend.store.backend.seed(await h.backend.store.rawIndex(), { [sha]: stateJson, [otherSha]: otherBody });
  await assert.rejects(h.owner.exportHistoryAll(), (error) => {
    assert.equal(error.code, "read-failed");
    assert.equal(error.canExportRest, true);
    assert.equal("partial" in error, false);
    return true;
  });
  const out = await h.owner.exportHistoryAll({ allowOmissions: true });
  assert.equal(out.docs[0].snapshots.length, 2);
  assert.equal(out.omittedSnapshots, 1);
  assert.deepEqual(out.missingBlobs, [image]);
  assert.deepEqual(out.blobs, { [otherImage]: { mime: "image/png", b64: "aW1hZ2U=" } });
});

test("no readable history means no partial-export choice", async (t) => {
  const h = await harness(t, "filesystem", [good]);
  h.bridge.historyGet = async () => { throw new Error("locked"); };
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 0);
  assert.equal(a.choices.length, 0);
});

test("an unavailable persistent image store never offers a partial export", async (t) => {
  const pictures = createBlobStore({ preferred: { available: () => true, open: async () => { throw new Error("locked"); } }, fallback: createMemoryBlobBackend, objectUrl: () => "", revokeObjectUrl() {}, later() {}, warn() {} });
  const h = await harness(t, "memory", [good], {}, { pictures });
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 0);
  assert.equal(a.choices.length, 0);
});

test("choosing export rest rereads fresh history and includes recovered versions", async (t) => {
  const h = await harness(t, "memory", [good, { ...good, id: "other" }]);
  const get = h.backend.get;
  h.backend.get = (bucket, id, options) => id === "intact" ? Promise.reject(new Error("locked")) : get(bucket, id, options);
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 0);
  assert.equal(a.choices.length, 1);
  h.backend.get = get;
  const fresh = JSON.stringify({ docId, title: "Added after the prompt", rows: [] });
  assert.equal((await h.backend.store.put(docId, { id: "new", atMs: 3000 }, fresh)).stored, true);
  const before = await h.inspect();
  await a.choices[0].action();
  assert.equal(a.delivered.length, 1);
  assert.equal(a.delivered[0].history.omittedSnapshots, 1);
  assert.deepEqual(a.delivered[0].history.docs[0].snapshots.map((s) => s.meta.id).sort(), ["intact", "new", "other"]);
  assert.equal(a.delivered[0].history.docs[0].snapshots.find((s) => s.meta.id === "new").stateJson, fresh);
  assert.deepEqual(await h.inspect(), before);
});

const temporaryFailures = [
  new Error("History request timed out."),
  Object.assign(new Error("read failed"), { code: "ETIMEDOUT" }),
  Object.assign(new Error("read aborted"), { name: "AbortError" }),
  new Error("Error invoking remote method 'history-get': Error: EAGAIN: resource temporarily unavailable"),
  new Error("read failed", { cause: Object.assign(new Error("interrupted"), { code: "EINTR" }) })
];

const permanentPathFailures = [
  new Error("Error invoking remote method 'blob-get': Error: EACCES: permission denied, open 'C:\\Users\\Temporary\\ETIMEDOUT\\image.png'"),
  Object.assign(new Error("History request timed out."), { code: "EACCES" }),
  new Error("ETIMEDOUT: read failed", { cause: Object.assign(new Error("missing"), { code: "ENOENT" }) }),
  new Error("ENOENT: no such file, open 'C:\\Users\\Temporary\\image.png'"),
  new Error("Could not read 'C:\\Users\\Temporary\\EBUSY\\image.png'"),
  new Error("Could not read 'C:\\Users\\timed out\\image.png'")
];

for (const [index, failure] of permanentPathFailures.entries()) test(`permanent image failure or path marker ${index} preserves the explicit offer`, async (t) => {
  const pictures = createBlobStore({ preferred: null, fallback: createMemoryBlobBackend, objectUrl: () => "", revokeObjectUrl() {}, later() {}, warn() {} });
  pictures.setBackend(makeDesktopBlobBackend({ blobGet: async () => { throw failure; }, blobPut: async () => ({ ok: true }), blobMissing: async () => [] }));
  const h = await harness(t, "filesystem", [good], {}, { pictures });
  await assert.rejects(h.owner.exportHistoryAll(), (error) => {
    assert.equal(error.code, "read-failed");
    assert.equal(error.canExportRest, true);
    return true;
  });
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 0);
  assert.equal(a.choices.length, 1);
  await a.choices[0].action();
  assert.equal(a.delivered.length, 1);
  assert.deepEqual(a.delivered[0].missingBlobs, [image]);
});

for (const [index, failure] of temporaryFailures.entries()) {
  test(`temporary body rejection ${index} cancels both export modes without a choice`, async (t) => {
    const h = await harness(t, "filesystem", [good, { ...good, id: "other" }]);
    const get = h.bridge.historyGet;
    h.bridge.historyGet = (query, id) => id === "intact" ? Promise.reject(failure) : get(query, id);
    for (const allowOmissions of [false, true]) await assert.rejects(h.owner.exportHistoryAll({ allowOmissions }), (error) => {
      assert.equal(error.code, "temporary-read-failed");
      assert.equal(error.canExportRest, undefined);
      assert.equal("partial" in error, false);
      return true;
    });
    const a = appHarness(t, h.owner);
    await a.app.exportAppData();
    assert.equal(a.delivered.length, 0);
    assert.equal(a.choices.length, 0);
    assert.match(a.messages.at(-1)[0], /Please try again/);
  });

  test(`temporary image rejection ${index} cancels both export modes without a choice`, async (t) => {
    const pictures = createBlobStore({ preferred: null, fallback: createMemoryBlobBackend, objectUrl: () => "", revokeObjectUrl() {}, later() {}, warn() {} });
    pictures.setBackend(makeDesktopBlobBackend({ blobGet: async () => { throw failure; }, blobPut: async () => ({ ok: true }), blobMissing: async () => [] }));
    const h = await harness(t, "filesystem", [good], {}, { pictures });
    for (const allowOmissions of [false, true]) await assert.rejects(h.owner.exportHistoryAll({ allowOmissions }), (error) => error.code === "temporary-read-failed");
    const a = appHarness(t, h.owner);
    await a.app.exportAppData();
    assert.equal(a.delivered.length, 0);
    assert.equal(a.choices.length, 0);
    assert.match(a.messages.at(-1)[0], /Please try again/);
  });
}

test("recovered image reads are included by the opt-in rerun", async (t) => {
  let blocked = true, reads = 0;
  const pictures = { intern: () => null, persist: async () => [], ensureBytes: async () => { reads++; if (blocked) throw new Error("locked"); return []; }, recordFor: () => ({ mime: "image/png" }), dataUrlFor: () => "data:image/png;base64,aW1hZ2U=" };
  const h = await harness(t, "filesystem", [good], {}, { pictures });
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  assert.equal(a.choices.length, 1);
  blocked = false;
  await a.choices[0].action();
  assert.equal(reads, 2);
  assert.equal(a.delivered.length, 1);
  assert.deepEqual(a.delivered[0].missingBlobs, []);
  assert.deepEqual(a.delivered[0].blobs[image], { mime: "image/png", b64: "aW1hZ2U=" });
});

test("an enumeration timeout asks for a retry and never offers partial export", async (t) => {
  const h = await harness(t, "filesystem");
  h.storage.controls.setDesktopTimeout(5);
  h.bridge.historyListDocs = () => new Promise(() => {});
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 0);
  assert.equal(a.choices.length, 0);
  assert.match(a.messages.at(-1)[0], /Please try again/);
});

test("an unreadable large version cannot consume the readable remainder's export budget", async (t) => {
  const h = await harness(t, "filesystem", [{ ...good, id: "blocked", atMs: 2000, sizeBytes: 250 * 1024 * 1024 }, { ...good, id: "other" }]);
  const get = h.bridge.historyGet;
  h.bridge.historyGet = (query, id) => id === "blocked" ? Promise.reject(new Error("locked")) : get(query, id);
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  assert.equal(a.choices.length, 1);
  await a.choices[0].action();
  assert.deepEqual(a.delivered[0].history.docs[0].snapshots.map((s) => s.meta.id), ["other"]);
  assert.equal(a.delivered[0].history.omittedSnapshots, 2);
  assert.equal(a.delivered[0].history.truncated, false);
});

test("strict image reads preserve confirmed absence while ordinary reads tolerate errors", async () => {
  const pictures = createBlobStore({ preferred: null, fallback: createMemoryBlobBackend, objectUrl: () => "", revokeObjectUrl() {}, later() {}, warn() {} });
  let rejectRead = false;
  pictures.setBackend(makeDesktopBlobBackend({ blobGet: async () => { if (rejectRead) throw new Error("locked"); return null; }, blobPut: async () => ({ ok: true }), blobMissing: async () => [] }));
  assert.deepEqual(await pictures.ensureBytes([image], { strict: true }), [image]);
  rejectRead = true;
  assert.deepEqual(await pictures.ensureBytes([image]), [image]);
  await assert.rejects(pictures.ensureBytes([image], { strict: true }), /locked/);
});

test("a concurrent ordinary image load cannot hide its read error from export", async () => {
  let rejectRead;
  const reading = new Promise((_resolve, reject) => { rejectRead = reject; });
  const pictures = createBlobStore({ preferred: null, fallback: createMemoryBlobBackend, objectUrl: () => "", revokeObjectUrl() {}, later() {}, warn() {} });
  pictures.setBackend(makeDesktopBlobBackend({ blobGet: () => reading, blobPut: async () => ({ ok: true }), blobMissing: async () => [] }));
  const ordinary = pictures.ensureBytes([image]);
  const strict = pictures.ensureBytes([image], { strict: true });
  const rejected = assert.rejects(strict, /locked/);
  rejectRead(new Error("locked"));
  assert.deepEqual(await ordinary, [image]);
  await rejected;
});

test("strict image export refuses both newly selected and cached persistence fallback", async () => {
  const pictures = createBlobStore({ preferred: { available: () => true, open: async () => { throw new Error("unavailable"); } }, fallback: createMemoryBlobBackend, objectUrl: () => "", revokeObjectUrl() {}, later() {}, warn() {} });
  await assert.rejects(pictures.ensureBytes([image], { strict: true }), /unavailable/);
  assert.deepEqual(await pictures.ensureBytes([image]), [image]);
  await assert.rejects(pictures.ensureBytes([image], { strict: true }), /unavailable/);
});

test("an obsolete image open failure cannot mark a replacement backend unavailable", async () => {
  let rejectOpen;
  const opening = new Promise((_resolve, reject) => { rejectOpen = reject; });
  const pictures = createBlobStore({ preferred: { available: () => true, open: () => opening }, fallback: createMemoryBlobBackend, objectUrl: () => "", revokeObjectUrl() {}, later() {}, warn() {} });
  const reading = pictures.ensureBytes([image], { strict: true });
  pictures.setBackend(createMemoryBlobBackend());
  rejectOpen(new Error("obsolete"));
  assert.deepEqual(await reading, [image]);
});

test("strict reads support an intentionally memory-only image store", async () => {
  const pictures = createBlobStore({ preferred: null, fallback: createMemoryBlobBackend, objectUrl: () => "", revokeObjectUrl() {}, later() {}, warn() {} });
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const record = pictures.intern(bytes);
  assert.deepEqual(await pictures.persist([record.sha256]), []);
  pictures.forgetMemory();
  assert.deepEqual(await pictures.ensureBytes([record.sha256, image], { strict: true }), [image]);
  assert.equal(pictures.dataUrlFor(record.sha256), "data:image/png;base64," + bytes.toString("base64"));
});

test("resetting an opening image backend cannot erase its persistent read failure", async () => {
  let rejectOpen;
  const opening = new Promise((_resolve, reject) => { rejectOpen = reject; });
  const pictures = createBlobStore({ preferred: { available: () => true, open: () => opening }, fallback: createMemoryBlobBackend, objectUrl: () => "", revokeObjectUrl() {}, later() {}, warn() {} });
  const reading = pictures.ensureBytes([image], { strict: true });
  const rejected = assert.rejects(reading, /unavailable/);
  pictures.setBackend(null);
  rejectOpen(new Error("unavailable"));
  await rejected;
});

test("confirmed desktop body absence still permits a partial export", async (t) => {
  const h = await harness(t, "filesystem", [good, { ...good, id: "other" }]);
  const get = h.bridge.historyGet;
  h.bridge.historyGet = (query, id) => id === "intact" ? Promise.resolve(null) : get(query, id);
  const a = appHarness(t, h.owner);
  await a.app.exportAppData();
  assert.equal(a.delivered.length, 1);
  assert.deepEqual(a.delivered[0].history.docs[0].snapshots.map((s) => s.meta.id), ["other"]);
  assert.equal(a.delivered[0].history.omittedSnapshots, 2);
});

test("desktop export rejects an unavailable list instead of treating it as empty history", async (t) => {
  const h = await harness(t, "filesystem");
  h.bridge.historyList = async () => { throw new Error("unavailable"); };
  await assert.rejects(h.owner.exportHistoryAll(), /history|export/i);
});
