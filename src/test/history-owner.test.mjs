import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHistoryOwner } from "../application/recovery/history.ts";
import { createHistoryBackends } from "../adapters/storage/history-backends.ts";

const docId = "d" + "1".repeat(32);
const otherId = "d" + "2".repeat(32);
const document = (title = "Original") => ({ docId, title, rows: [{ id: "r1", audioText: title }] });
const deferred = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};

async function harness(options = {}) {
  let serial = 0;
  let live = document();
  let raw = options.raw ?? null;
  let closed = 0;
  let removed = 0;
  const messages = [];
  let holds = () => [];
  const storage = createHistoryBackends({ now: () => 1000, holds: () => holds(), desktop: () => null, runningOnDesktop: () => false });
  await storage.controls.forceBackend("memory");
  const backend = await storage.resolveHistoryBackend();
  if (options.persistent) backend.name = "idb";
  const owner = createHistoryOwner();
  const ports = {
    document: { current: () => live },
    location: { home: () => ({ kind: "none" }) },
    preferences: { editorName: () => "Adam" },
    saving: { changes: () => 0, unsaved: () => false },
    recovery: { readRaw: () => raw, remove: () => { removed++; raw = null; return true; } },
    effects: { show: (...args) => { messages.push(args); } },
    pictures: { intern: () => null, persist: async () => [], recordFor: () => null, ensureBytes: async () => [], dataUrlFor: () => null },
    inlinePictures: (json) => json,
    ids: { id: (prefix) => prefix + String(++serial).padStart(8, "0"), docId: () => otherId },
    seed: { passes: () => true },
    logger: { error() {}, warn() {} },
    now: () => 1000,
    decodeBase64: atob,
    yield: async () => {},
    desktop: { history: () => null, running: () => false },
    storage: (options) => {
      holds = options.holds;
      return { ...storage, resolveHistoryBackend: async () => backend, close: async () => { closed++; } };
    }
  };
  const stop = owner.startHistory(ports);
  return { owner, stop, backend, ports, storage, messages, closed: () => closed, removed: () => removed, replace: (doc) => { live = doc; } };
}

test("history owner refuses every public operation before start and after stop", async () => {
  const fresh = createHistoryOwner();
  const calls = [
    (owner) => owner.captureSnapshot("Keep", document()),
    (owner) => owner.listDocHistory(docId),
    (owner) => owner.getHistorySnapshot({ docId, id: "snapshot01" }),
    (owner) => owner.protectHistorySnapshot({ docId, id: "snapshot01" }),
    (owner) => owner.historyDocumentChanged(),
    (owner) => owner.copyHistory(docId, otherId),
    (owner) => owner.exportHistoryAll(),
    (owner) => owner.importHistoryBundle({}),
    (owner) => owner.normalizeLegacySnapshots("[]"),
    (owner) => owner.startHistoryMigration(),
    (owner) => owner.onHistoryChange(() => {}),
    (owner) => owner.isPristineSeedDocument(),
    (owner) => owner.testControls()
  ];
  for (const call of calls) assert.throws(() => call(fresh), /not started yet/);
  const h = await harness();
  const hooks = h.owner.testControls();
  assert.throws(() => h.owner.startHistory(h.ports), /already started/);
  await h.stop();
  for (const call of calls) assert.throws(() => call(h.owner), /not started yet/);
  assert.throws(() => hooks.setNow(1), /not started yet/);
  assert.equal(h.closed(), 1);
  assert.equal(h.stop(), undefined);
});

test("history capture freezes content and keeps list, read, copy and bundle round trips on the memory backend", async () => {
  const h = await harness();
  let changes = 0;
  const unsubscribe = h.owner.onHistoryChange(() => { changes++; });
  const original = document();
  const captured = h.owner.captureSnapshot("Keep", original);
  original.title = "Changed later";
  assert.equal((await captured.done).stored, true);
  assert.equal(changes, 2);
  const listed = await h.owner.listDocHistory(docId);
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].label, "Keep");
  assert.equal(listed.entries[0].by, "Adam");
  const stored = await h.owner.getHistorySnapshot({ docId, id: captured.id });
  assert.equal(JSON.parse(stored.stateJson).title, "Original");
  assert.deepEqual(await h.owner.copyHistory(docId, otherId), { ok: true, copied: 1 });
  assert.equal((await h.owner.listDocHistory(otherId)).entries.length, 1);
  const bundle = await h.owner.exportHistoryAll();
  assert.equal(bundle.docs.length, 2);
  const target = await harness();
  const imported = await target.owner.importHistoryBundle(bundle);
  assert.equal(imported.added, 2);
  assert.equal(imported.failed, 0);
  assert.equal((await target.owner.getHistorySnapshot({ docId, id: captured.id })).stateJson, stored.stateJson);
  unsubscribe();
  h.owner.historyDocumentChanged();
  assert.equal(changes, 3);
  await h.stop();
  await target.stop();
});

test("a stopped owner's accepted capture drains to its own backend without notifying a replacement", async () => {
  const h = await harness();
  const gate = deferred();
  const reached = deferred();
  const put = h.backend.put;
  h.backend.put = (...args) => { reached.release(); return gate.promise.then(() => put(...args)); };
  let oldChanges = 0;
  h.owner.onHistoryChange(() => { oldChanges++; });
  const capture = h.owner.captureSnapshot("Accepted", document());
  await reached.promise;
  const drained = h.stop();
  assert.equal(h.closed(), 0);
  const replacement = await harness();
  let replacementChanges = 0;
  replacement.owner.onHistoryChange(() => { replacementChanges++; });
  gate.release();
  assert.equal((await capture.done).stored, true);
  await drained;
  assert.equal(h.closed(), 1);
  assert.equal(oldChanges, 1);
  assert.equal(replacementChanges, 0);
  assert.equal((await h.backend.list(docId)).entries.length, 1);
  assert.equal((await replacement.owner.listDocHistory(docId)).entries.length, 0);
  await replacement.stop();
});

test("an accepted multi-batch import finishes after stop and never touches a replacement owner's records", async () => {
  const h = await harness();
  const source = await harness();
  for (let i = 0; i < 26; i++) await source.owner.captureSnapshot("Import", document("Version " + i)).done;
  const bundle = await source.owner.exportHistoryAll();
  const gate = deferred();
  const reached = deferred();
  let yielded = 0;
  h.ports.yield = () => { yielded++; reached.release(); return gate.promise; };
  const importing = h.owner.importHistoryBundle(bundle);
  await reached.promise;
  const drained = h.stop();
  const replacement = await harness();
  gate.release();
  assert.equal((await importing).added, 26);
  await drained;
  assert.equal(yielded, 1);
  assert.equal((await h.backend.list(docId)).entries.length, 26);
  assert.equal((await replacement.owner.listDocHistory(docId)).entries.length, 0);
  await source.stop();
  await replacement.stop();
});

test("migration confirms durable Older entries before removing its captured legacy store across stop and restart", async () => {
  const raw = JSON.stringify([{ id: "old", label: "Legacy", at: "2026-01-01T00:00:00Z", state: document() }]);
  const h = await harness({ persistent: true, raw });
  const gate = deferred();
  const reached = deferred();
  const importOlder = h.backend.importOlder;
  h.backend.importOlder = (entries) => { reached.release(); return gate.promise.then(() => importOlder(entries)); };
  let announcements = 0;
  h.owner.onHistoryChange(() => { announcements++; });
  const migrating = h.owner.startHistoryMigration();
  assert.equal(h.owner.startHistoryMigration(), migrating);
  await reached.promise;
  const drained = h.stop();
  const replacement = await harness({ persistent: true, raw });
  assert.equal(h.removed(), 0);
  gate.release();
  assert.deepEqual(await migrating, { migrated: 1, removedKey: true });
  await drained;
  assert.equal(h.removed(), 1);
  assert.equal(replacement.removed(), 0);
  assert.equal(announcements, 0);
  assert.equal((await h.backend.list(null)).older.length, 1);
  await replacement.stop();
});

test("a failed capture stays pending and retries with its original bytes", async () => {
  const h = await harness();
  h.owner.testControls().injectFault("io-always");
  const capture = h.owner.captureSnapshot("Retry", document());
  assert.equal((await capture.done).stored, false);
  assert.equal(h.owner.testControls().pending(docId).length, 1);
  assert.equal(h.messages.length, 1);
  h.replace(document("Replacement"));
  h.owner.testControls().injectFault(null);
  await h.owner.testControls().idle();
  assert.equal(h.owner.testControls().pending(docId).length, 0);
  const stored = await h.owner.getHistorySnapshot({ docId, id: capture.id });
  assert.equal(JSON.parse(stored.stateJson).title, "Original");
  await h.stop();
});

test("protection holds survive nested release and prevent eviction until the last release", async () => {
  const h = await harness();
  const capture = h.owner.captureSnapshot("Protected", document());
  await capture.done;
  const query = { docId, id: capture.id };
  const releaseFirst = h.owner.protectHistorySnapshot(query);
  const releaseLast = h.owner.protectHistorySnapshot(query);
  const newest = h.owner.captureSnapshot("Newest", document("Newest"));
  await newest.done;
  await h.backend.evict(0);
  assert.equal((await h.backend.list(docId)).entries.length, 2);
  releaseFirst();
  releaseFirst();
  await h.backend.evict(0);
  assert.equal((await h.backend.list(docId)).entries.length, 2);
  releaseLast();
  await h.backend.evict(0);
  assert.deepEqual((await h.backend.list(docId)).entries.map((entry) => entry.id), [newest.id]);
  await h.stop();
});

test("reset waits for accepted writes with their armed backend failures before replacing storage", async () => {
  const h = await harness();
  h.owner.testControls().injectFault("io-always");
  const gate = deferred();
  const reached = deferred();
  const put = h.backend.put;
  h.backend.put = (...args) => { reached.release(); return gate.promise.then(() => put(...args)); };
  const capture = h.owner.captureSnapshot("Accepted before reset", document());
  await reached.promise;
  const resetting = h.owner.testControls().resetForTest();
  gate.release();
  assert.equal((await capture.done).stored, false);
  await resetting;
  await h.stop();
});
