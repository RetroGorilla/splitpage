import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { createHistoryStore, createMemoryHistoryBackend } from "../../shared/history-store.js";
import { HISTORY_OLDER_KEY, HISTORY_OLDER_TTL_MS, historyUtf8Length } from "../../shared/history-policy.js";
import {
  HISTORY_IDB_NAME,
  HISTORY_IDB_VERSION,
  createIdbHistoryBackend,
  hashText
} from "../adapters/storage/03c-history-idb.js";

const DOC_A = "d" + "a".repeat(32);
const DOC_B = "d" + "b".repeat(32);
const DOC_C = "d" + "c".repeat(32);

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const meta = (id, atMs, over = {}) => ({ id, atMs, label: "L " + id, title: "T", ...over });
const body = (tag, pad = 0) => JSON.stringify({ rows: [], tag, pad: "x".repeat(pad) });

async function ids(store, docId) {
  return (await store.list(docId)).entries.map((m) => m.id);
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const BACKENDS = {
  memory: () => createMemoryHistoryBackend({ strict: true, macrotask: (cb) => setImmediate(cb) }),
  idb: () => createIdbHistoryBackend({ indexedDB: new IDBFactory() })
};

function storeOver(backend, opts = {}) {
  const clock = opts.clock || { t: opts.t ?? 1_000_000 };
  const store = createHistoryStore({
    backend,
    now: () => clock.t,
    hashText,
    capBytes: opts.capBytes,
    maxBodyBytes: opts.maxBodyBytes,
    holds: opts.holds
  });
  return { clock, backend, store };
}

for (const [kind, make] of Object.entries(BACKENDS)) {
  const fixture = (opts = {}) => storeOver(make(), opts);
  const it = (name, fn) => test(`[${kind}] ${name}`, fn);

  it("put, get and list answer 03a's shapes; one body per put", async () => {
    const { store, backend } = fixture();
    const r = await store.put(DOC_A, meta("s01", 500), body("one"));
    assert.deepEqual(r, { stored: true, evicted: 0, overCap: false });
    const got = await store.get(DOC_A, "s01");
    assert.equal(got.stateJson, body("one"));
    assert.equal(got.meta.docId, DOC_A);
    assert.equal(got.meta.sizeBytes, historyUtf8Length(body("one")));
    assert.equal(got.meta.sha, undefined, "the sha never leaves the store");
    assert.deepEqual(await ids(store, DOC_A), ["s01"]);
    assert.equal(await backend.bodyCount(), 1);
    assert.ok(await backend.hasBody(sha(body("one"))), "addressed by the SHA-256 of its UTF-8");
  });

  it("put-if-absent by id: a duplicate writes nothing", async () => {
    const { store, backend } = fixture();
    await store.put(DOC_A, meta("s01", 1), body("first"));
    const commits = backend.counts.commit;
    assert.equal((await store.put(DOC_A, meta("s01", 2), body("second"))).duplicate, true);
    assert.equal(backend.counts.commit, commits);
    assert.equal((await store.get(DOC_A, "s01")).stateJson, body("first"));
    assert.equal(await backend.bodyCount(), 1);
  });

  it("the stamp: strictly after the bucket's newest", async () => {
    const { store } = fixture();
    await store.put(DOC_A, meta("s01", 5000), body("a"));
    await store.put(DOC_A, meta("s02", 1000), body("b"));
    assert.deepEqual((await store.list(DOC_A)).entries.map((m) => [m.id, m.atMs]), [["s02", 5001], ["s01", 5000]]);
  });

  it("the trim to 50 drops the trimmed bodies in the same commit", async () => {
    const { store, backend } = fixture();
    for (let i = 1; i <= 53; i++) await store.put(DOC_A, meta("s" + String(i).padStart(3, "0"), i * 10), body("n" + i));
    const list = await ids(store, DOC_A);
    assert.equal(list.length, 50);
    assert.equal(list[49], "s004");
    assert.equal(await backend.bodyCount(), 50);
  });

  it("cap eviction: least recently opened first, a document's newest kept", async () => {
    const size = historyUtf8Length(body("x0", 100));
    const { store, clock, backend } = fixture({ capBytes: () => 5 * size });
    for (let i = 0; i < 3; i++) { clock.t = 1000 + i; await store.put(DOC_A, meta("a0" + i, 100 + i), body("a" + i, 100)); }
    for (let i = 0; i < 3; i++) { clock.t = 5000 + i; await store.put(DOC_B, meta("b0" + i, 100 + i), body("b" + i, 100)); }
    assert.deepEqual(await ids(store, DOC_A), ["a02", "a01"]);
    assert.deepEqual(await ids(store, DOC_B), ["b02", "b01", "b00"]);
    assert.equal(await backend.bodyCount(), 5);
    const ev = await store.evict(size);
    assert.deepEqual([ev.evicted, ev.overCap, ev.totalAfter], [3, true, 2 * size]);
  });

  it("a quota refusal (at put or at commit) evicts and retries once", async () => {
    const { store, backend, clock } = fixture();
    clock.t = 100; await store.put(DOC_A, meta("a01", 1), body("a1", 50));
    clock.t = 101; await store.put(DOC_A, meta("a02", 2), body("a2", 50));
    clock.t = 200; await store.put(DOC_B, meta("b01", 1), body("b1", 50));
    backend.failNext("put", "quota", 1);
    clock.t = 300;
    const r = await store.put(DOC_B, meta("b02", 2), body("b2", 50));
    assert.deepEqual([r.stored, r.evicted], [true, 1]);
    assert.deepEqual(await ids(store, DOC_A), ["a02"]);
    backend.failNext("commit", "quota", 1);
    clock.t = 400;
    const r2 = await store.put(DOC_B, meta("b03", 3), body("b3", 50));
    assert.equal(r2.stored, true);
  });

  it("a non-quota failure is 'io' and leaves no body behind", async () => {
    const { store, backend } = fixture();
    backend.failNext("commit", "io", 1);
    assert.deepEqual(await store.put(DOC_A, meta("s01", 1), body("a")), { stored: false, code: "io" });
    assert.equal(await backend.bodyCount(), 0, "the body's put was rolled back with the commit");
    assert.deepEqual(await ids(store, DOC_A), []);
  });

  it("copy is index-only; a shared body stays until its last entry goes", async () => {
    const { store, backend } = fixture();
    await store.put(DOC_A, meta("s01", 1), body("shared"));
    const puts = backend.counts.put;
    assert.deepEqual(await store.copy(DOC_A, DOC_B), { ok: true, copied: 1 });
    assert.equal(backend.counts.put, puts, "no body written");
    assert.equal(await backend.bodyCount(), 1);
    assert.equal((await store.get(DOC_B, "s01")).stateJson, body("shared"));
    for (let i = 2; i <= 51; i++) await store.put(DOC_A, meta("s" + String(i).padStart(3, "0"), i), body("a" + i));
    assert.ok(!(await ids(store, DOC_A)).includes("s01"), "trimmed from A");
    assert.ok(await backend.hasBody(sha(body("shared"))), "B still names it");
    for (let i = 2; i <= 51; i++) await store.put(DOC_B, meta("t" + String(i).padStart(3, "0"), 1000 + i), body("b" + i));
    assert.ok(!(await backend.hasBody(sha(body("shared")))), "gone with its last entry");
  });

  it("identical captures share one body; touch never creates a record", async () => {
    const { store, backend, clock } = fixture();
    await store.put(DOC_A, meta("s01", 1), body("same"));
    await store.put(DOC_A, meta("s02", 2), body("same"));
    assert.equal(await backend.bodyCount(), 1);
    assert.deepEqual(await ids(store, DOC_A), ["s02", "s01"]);
    await store.touch(DOC_C, "nothing");
    assert.deepEqual(await store.listDocs(), [{ docId: DOC_A, title: "T", lastOpenedAt: clock.t }]);
    clock.t += 5;
    await store.touch(DOC_A, "Renamed");
    assert.deepEqual(await store.listDocs(), [{ docId: DOC_A, title: "Renamed", lastOpenedAt: clock.t }]);
  });

  it("importOlder, then the Older sweep past 90 days takes its bodies with it", async () => {
    const { store, backend, clock } = fixture();
    const r = await store.importOlder([
      { meta: meta("o01", 10), stateJson: body("o1") },
      { meta: meta("o02", 20), stateJson: body("o2") }
    ]);
    assert.deepEqual(r, { ok: true, count: 2, added: 2 });
    const listed = await store.list(null);
    assert.deepEqual(listed.older.map((m) => m.id), ["o02", "o01"]);
    assert.equal(listed.olderExpiresAt, clock.t + HISTORY_OLDER_TTL_MS);
    await store.put(DOC_A, meta("s01", 1), body("keep"));
    clock.t += HISTORY_OLDER_TTL_MS + 1;
    assert.deepEqual((await store.list(null)).older, []);
    assert.equal(await store.get(HISTORY_OLDER_KEY, "o01"), null);
    await store.evict(Infinity);
    assert.ok(!(await backend.hasBody(sha(body("o1")))));
    assert.ok(await backend.hasBody(sha(body("keep"))));
  });

  it("usage is computed from the index", async () => {
    const { store } = fixture({ capBytes: 1_000_000 });
    await store.put(DOC_A, meta("s01", 1), body("a"));
    await store.put(DOC_B, meta("s01", 1), body("bb"));
    const u = await store.usage();
    assert.deepEqual(u, {
      totalBytes: historyUtf8Length(body("a")) + historyUtf8Length(body("bb")),
      capBytes: 1_000_000, overCap: false, docCount: 2, readOnly: false
    });
  });

  it("a body lost behind the store's back: get answers null and the entry heals away", async () => {
    const { store, backend } = fixture();
    await store.put(DOC_A, meta("s01", 1), body("gone"));
    await store.put(DOC_A, meta("s02", 2), body("kept"));
    await backend.dropBody(sha(body("gone")));
    assert.equal(await store.get(DOC_A, "s01"), null);
    await store.evict(Infinity);
    assert.deepEqual(await ids(store, DOC_A), ["s02"]);
  });
}

function idbFixture(opts = {}) {
  const factory = opts.factory || new IDBFactory();
  const clock = { t: opts.t ?? 1_000_000 };
  const backend = createIdbHistoryBackend({ indexedDB: factory, now: () => clock.t, ...(opts.backend || {}) });
  return { factory, ...storeOver(backend, { ...opts, clock }) };
}

test("hashText is SHA-256 of the UTF-8, synchronously", () => {
  for (const s of ["", "abc", "héllo — ✓ 😀", body("x", 70_000)]) assert.equal(hashText(s), sha(s));
});

test("schema: a fresh profile gets v3 with only index and bodies", async () => {
  const { factory, backend } = idbFixture();
  await backend.open();
  await backend.close();
  assert.equal(HISTORY_IDB_VERSION, 3);
  const db = await req(factory.open(HISTORY_IDB_NAME));
  assert.equal(db.version, 3);
  assert.deepEqual([...db.objectStoreNames].sort(), ["bodies", "index"]);
  const t = db.transaction(["index", "bodies"], "readonly");
  assert.equal(t.objectStore("index").keyPath, "bucket");
  assert.equal(t.objectStore("bodies").keyPath, "sha");
  db.close();
});

test("strict tx: a non-tx await inside exclusive() fails the job, as the rule says it must", async () => {
  const { backend } = idbFixture();
  await backend.open();
  const r = backend.exclusive(async (tx) => {
    await tx.list();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tx.commit({ [DOC_A]: { title: "", lastOpenedAt: 1, snapshots: [] } }, []);
  });
  await assert.rejects(r, (e) => e.code === "io" && /TransactionInactiveError/.test(e.message));
  assert.deepEqual((await backend.inspect()).index, {}, "the commit after the timer never happened");
});

test("strict tx: a failed job leaves nothing; a read job cannot write; commit once", async () => {
  const { backend } = idbFixture();
  await assert.rejects(backend.exclusive(async (tx) => {
    await tx.put("abc", "text");
    throw new Error("boom");
  }), (e) => e.code === "io");
  assert.equal(await backend.bodyCount(), 0, "the body was rolled back with the job");

  await assert.rejects(backend.exclusive((tx) => tx.put("abc", "text"), { write: false }), (e) => e.code === "io");
  await assert.rejects(backend.exclusive(async (tx) => {
    await tx.commit({}, []);
    await tx.commit({}, []);
  }), (e) => e.code === "io");
});

test("bodies are put only if absent, and dropped bodies go in the same transaction as the index change", async () => {
  const { backend } = idbFixture();
  const rec = (s) => ({ title: "", lastOpenedAt: 1, snapshots: [{ ...meta("s01", 1), sizeBytes: 1, sha: s }] });
  await backend.exclusive(async (tx) => {
    await tx.put("h1", "first");
    await tx.commit({ [DOC_A]: rec("h1") }, []);
  });
  await backend.exclusive(async (tx) => {
    await tx.put("h1", "SECOND");
    assert.equal(await tx.get("h1"), "first");
  });
  assert.equal((await backend.inspect()).bodies.h1, "first");

  backend.failNext("commit", "io", 1);
  await assert.rejects(backend.exclusive(async (tx) => {
    await tx.put("h2", "other");
    await tx.commit({ [DOC_A]: rec("h2") }, ["h1"]);
  }));
  assert.deepEqual(Object.keys((await backend.inspect()).bodies), ["h1"]);
  await backend.exclusive(async (tx) => {
    await tx.put("h2", "other");
    await tx.commit({ [DOC_A]: rec("h2"), [DOC_B]: null }, ["h1"]);
  });
  const after = await backend.inspect();
  assert.deepEqual(Object.keys(after.bodies), ["h2"]);
  assert.equal(after.index[DOC_A].snapshots[0].sha, "h2");
  assert.equal(after.index[DOC_A].bucket, undefined, "the key field is not part of the DocRecord");
});

function patchBodiesPut(how, times = 1) {
  const orig = IDBObjectStore.prototype.put;
  let left = times;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name !== "bodies" || left <= 0) return orig.apply(this, args);
    left--;
    if (how === "request") {
      throw new DOMException("Injected quota", "QuotaExceededError");
    }
    const r = orig.apply(this, args);
    this.transaction._abort("QuotaExceededError");
    return r;
  };
  return () => { IDBObjectStore.prototype.put = orig; };
}

for (const how of ["transaction", "request"]) {
  test(`quota reported by the ${how} → err.code 'quota', nothing lands, and the store evicts and retries`, async (t) => {
    const { backend, store, clock } = idbFixture();
    clock.t = 100; await store.put(DOC_A, meta("a01", 1), body("a1", 50));
    clock.t = 101; await store.put(DOC_A, meta("a02", 2), body("a2", 50));

    let restore = patchBodiesPut(how);
    t.after(() => restore());
    await assert.rejects(backend.exclusive(async (tx) => {
      await tx.put("zz", "x");
      await tx.commit({}, []);
    }), (e) => e.code === "quota" && e.cause && e.cause.name === "QuotaExceededError");
    restore();
    assert.ok(!(await backend.hasBody("zz")));

    restore = patchBodiesPut(how);
    clock.t = 200;
    const r = await store.put(DOC_B, meta("b01", 1), body("b1", 50));
    restore();
    assert.deepEqual([r.stored, r.evicted], [true, 1], "the retry landed after A's oldest went");
    assert.deepEqual(await ids(store, DOC_A), ["a02"]);
    assert.deepEqual(await ids(store, DOC_B), ["b01"]);
  });
}

const V1_STORES = ["docs", "meta", "snapBody", "snapMeta"];

async function seedOld(factory, version, { v1 = true, stores = {} } = {}) {
  const r = factory.open(HISTORY_IDB_NAME, version);
  r.onupgradeneeded = () => {
    const d = r.result;
    if (v1) {
      d.createObjectStore("docs", { keyPath: "docId" }).createIndex("byLastOpened", "lastOpenedAt");
      d.createObjectStore("snapMeta", { keyPath: ["docId", "id"] }).createIndex("byDocAt", ["docId", "atMs"]);
      d.createObjectStore("snapBody", { keyPath: ["docId", "id"] });
      d.createObjectStore("meta", { keyPath: "key" });
    }
    if (version >= 2) {
      d.createObjectStore("index", { keyPath: "bucket" });
      d.createObjectStore("bodies", { keyPath: "sha" });
    }
  };
  const d = await req(r);
  const names = Object.keys(stores).filter((n) => stores[n].length);
  if (names.length) {
    const t = d.transaction(names, "readwrite");
    for (const n of names) for (const row of stores[n]) t.objectStore(n).put(row);
    await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onabort = () => reject(t.error); });
  }
  d.close();
}

async function dump(factory) {
  const d = await req(factory.open(HISTORY_IDB_NAME));
  const names = [...d.objectStoreNames].sort();
  const out = { version: d.version, stores: {} };
  if (names.length) {
    const t = d.transaction(names, "readonly");
    for (const n of names) out.stores[n] = await req(t.objectStore(n).getAll());
  }
  d.close();
  return out;
}

function v1Rows(snaps, docs = []) {
  return {
    docs: docs.map((r) => ({ bytes: 0, count: 0, ...r })),
    snapMeta: snaps.map((s) => ({ docId: s.docId, ...meta(s.id, s.atMs), sizeBytes: historyUtf8Length(s.text) })),
    snapBody: snaps.map((s) => ({ docId: s.docId, id: s.id, stateJson: s.text }))
  };
}

function v2Rows(bucket, snaps) {
  return {
    index: [{
      bucket, title: "Two", lastOpenedAt: 500,
      snapshots: snaps.map((s) => ({ ...meta(s.id, s.atMs), sizeBytes: historyUtf8Length(s.text), sha: sha(s.text) }))
    }],
    bodies: snaps.map((s) => ({ sha: sha(s.text), stateJson: s.text }))
  };
}

const V1_SNAPS = [
  { docId: DOC_A, id: "a01", atMs: 100, text: body("v1-a1") },
  { docId: DOC_A, id: "a02", atMs: 200, text: body("v1-a2") },
  { docId: HISTORY_OLDER_KEY, id: "leg-1", atMs: 50, text: body("v1-o1") }
];
const V2_SNAPS = [
  { id: "b01", atMs: 300, text: body("v2-b1") },
  { id: "b02", atMs: 400, text: body("v2-b2") }
];

test("v3 from a finished 3.0.0 move (v2, v1 stores empty): the v1 stores go, v2 history is intact", async () => {
  const factory = new IDBFactory();
  await seedOld(factory, 2, { stores: v2Rows(DOC_B, V2_SNAPS) });
  const before = await dump(factory);
  const { backend, store } = idbFixture({ factory });
  await backend.open();
  const after = await dump(factory);
  assert.equal(after.version, 3);
  assert.deepEqual(Object.keys(after.stores), ["bodies", "index"], "docs, meta, snapBody, snapMeta dropped");
  assert.deepEqual(after.stores.index, before.stores.index, "index untouched");
  assert.deepEqual(after.stores.bodies, before.stores.bodies, "bodies untouched");
  assert.deepEqual(await ids(store, DOC_B), ["b02", "b01"]);
  for (const s of V2_SNAPS) assert.equal((await store.get(DOC_B, s.id)).stateJson, s.text);
  assert.equal((await store.put(DOC_B, meta("b03", 500), body("new"))).stored, true);
  assert.equal(backend.readOnly, false);
});

test("v3 from an unfinished 3.0.0 move (v2 with v1 rows left): v1 kept byte for byte, dormant; v2 works", async () => {
  const factory = new IDBFactory();
  const rows = { ...v2Rows(DOC_B, V2_SNAPS), ...v1Rows(V1_SNAPS, [{ docId: DOC_A, title: "One", lastOpenedAt: 9 }]) };
  await seedOld(factory, 2, { stores: rows });
  const before = await dump(factory);
  const { backend, store } = idbFixture({ factory });
  await backend.open();
  const after = await dump(factory);
  assert.equal(after.version, 3);
  assert.deepEqual(Object.keys(after.stores), ["bodies", "docs", "index", "meta", "snapBody", "snapMeta"]);
  for (const n of V1_STORES) assert.deepEqual(after.stores[n], before.stores[n], n + " unchanged");

  assert.deepEqual(await ids(store, DOC_B), ["b02", "b01"]);
  assert.deepEqual(await ids(store, DOC_A), [], "v1-only history is not shown");
  assert.equal((await store.put(DOC_A, meta("n01", 900), body("n1"))).stored, true);
  assert.equal((await store.put(DOC_B, meta("b03", 901), body("b3"))).stored, true);
  assert.deepEqual(await ids(store, DOC_A), ["n01"]);
  await store.evict(Infinity);

  await backend.close();
  const again = idbFixture({ factory });
  await again.backend.open();
  const later = await dump(factory);
  for (const n of V1_STORES) assert.deepEqual(later.stores[n], before.stores[n], n + " still unchanged");
});

test("v3 from a v1-only database (2.1, never ran 3.0.0): v1 kept, index and bodies created and usable", async () => {
  const factory = new IDBFactory();
  const rows = v1Rows(V1_SNAPS, [{ docId: DOC_A, title: "One", lastOpenedAt: 9 }]);
  await seedOld(factory, 1, { stores: rows });
  const before = await dump(factory);
  assert.equal(before.version, 1);
  const { backend, store } = idbFixture({ factory });
  await backend.open();
  const after = await dump(factory);
  assert.equal(after.version, 3);
  assert.deepEqual(Object.keys(after.stores), ["bodies", "docs", "index", "meta", "snapBody", "snapMeta"]);
  for (const n of V1_STORES) assert.deepEqual(after.stores[n], before.stores[n], n + " unchanged");
  assert.deepEqual([after.stores.index, after.stores.bodies], [[], []], "v2 stores start empty");
  assert.equal((await store.put(DOC_C, meta("c01", 1), body("c1"))).stored, true);
  assert.equal((await store.get(DOC_C, "c01")).stateJson, body("c1"));
  assert.deepEqual(await ids(store, DOC_A), []);
});

test("v3 from an empty v1 database (2.1, no snapshot ever taken): the v1 stores go", async () => {
  const factory = new IDBFactory();
  await seedOld(factory, 1, { stores: { docs: [{ docId: DOC_A, title: "One", lastOpenedAt: 9, bytes: 0, count: 0 }] } });
  const { backend } = idbFixture({ factory });
  await backend.open();
  const after = await dump(factory);
  assert.equal(after.version, 3);
  assert.deepEqual(Object.keys(after.stores), ["bodies", "index"], "a docs record alone is not history");
});

test("v3 keeps the v1 stores when only snapBody still holds rows", async () => {
  const factory = new IDBFactory();
  await seedOld(factory, 2, { stores: { snapBody: [{ docId: DOC_A, id: "a01", stateJson: body("orphan") }] } });
  const { backend } = idbFixture({ factory });
  await backend.open();
  const after = await dump(factory);
  assert.deepEqual(Object.keys(after.stores), ["bodies", "docs", "index", "meta", "snapBody", "snapMeta"]);
  assert.equal(after.stores.snapBody.length, 1);
});

test("v3 from a v2 database with no v1 stores at all (a 3.0.0 fresh profile): nothing to drop", async () => {
  const factory = new IDBFactory();
  await seedOld(factory, 2, { v1: false, stores: v2Rows(DOC_B, V2_SNAPS) });
  const { backend, store } = idbFixture({ factory });
  await backend.open();
  const after = await dump(factory);
  assert.equal(after.version, 3);
  assert.deepEqual(Object.keys(after.stores), ["bodies", "index"]);
  assert.deepEqual(await ids(store, DOC_B), ["b02", "b01"]);
});

async function openOld(factory, version, { closes = true } = {}) {
  await seedOld(factory, version);
  const db = await req(factory.open(HISTORY_IDB_NAME, version));
  const seen = { versionchange: 0 };
  db.onversionchange = () => { seen.versionchange++; if (closes) db.close(); };
  return { db, seen };
}

for (const version of [1, 2]) {
  test(`an old-build (v${version}) connection gets versionchange, closes, and the v3 upgrade goes through`, async () => {
    const factory = new IDBFactory();
    const old = await openOld(factory, version);
    const { backend } = idbFixture({ factory });
    await backend.open();
    assert.equal(old.seen.versionchange, 1);
    assert.equal(backend.readOnly, false);
    await assert.rejects(req(factory.open(HISTORY_IDB_NAME, version)), (e) => e.name === "VersionError");
  });
}

test("an old connection that will NOT close: this open fails at once with 'io', and a late success is not adopted", async () => {
  const factory = new IDBFactory();
  const old = await openOld(factory, 1, { closes: false });
  const opened = [];
  const spy = {
    open: (...args) => { const r = factory.open(...args); opened.push(r); return r; },
    deleteDatabase: (name) => factory.deleteDatabase(name)
  };
  const backend = createIdbHistoryBackend({ indexedDB: spy });
  await assert.rejects(backend.open(), (e) => e.code === "io" && /blocked/.test(e.message));
  assert.equal(old.seen.versionchange, 1);
  old.db.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].readyState, "done");
  assert.equal(opened[0].result._closePending, true, "the late connection was closed, not adopted");
  await backend.open();
  assert.equal(opened.length, 2);
  assert.equal(opened[1].result.version, HISTORY_IDB_VERSION);
  assert.equal(opened[1].result._closePending, false);
});

test("this connection closes on versionchange; a NEWER database is then served read-only", async () => {
  const { factory, backend, store } = idbFixture();
  await store.put(DOC_A, meta("s01", 1), body("a"));
  const v4req = factory.open(HISTORY_IDB_NAME, 4);
  v4req.onupgradeneeded = () => { v4req.result.createObjectStore("somethingNew"); };
  const v4 = await req(v4req);
  v4.close();
  assert.equal(backend.readOnly, false, "not known until the next job reopens");
  assert.deepEqual(await ids(store, DOC_A), ["s01"], "reads still work");
  assert.equal(backend.readOnly, true);
  assert.equal(store.readOnly, true);
  assert.equal((await store.get(DOC_A, "s01")).stateJson, body("a"));
  assert.deepEqual(await store.put(DOC_A, meta("s02", 2), body("b")), { stored: false, code: "read-only" });
  assert.equal((await store.usage()).readOnly, true);
  await assert.rejects(backend.exclusive((tx) => tx.commit({ [DOC_B]: null }, [])), (e) => e.code === "read-only");
});

test("a newer database this build cannot read (no index store) fails the open — the caller's cue for memory", async () => {
  const factory = new IDBFactory();
  const r = factory.open(HISTORY_IDB_NAME, 5);
  r.onupgradeneeded = () => r.result.createObjectStore("somethingElse");
  (await req(r)).close();
  const { backend } = idbFixture({ factory });
  await assert.rejects(backend.open(), (e) => e.code === "io");
});

test("deleteDatabase (resetForTest) is not blocked; the next job starts a fresh v3", async () => {
  const { factory, store } = idbFixture();
  await store.put(DOC_A, meta("s01", 1), body("a"));
  await req(factory.deleteDatabase(HISTORY_IDB_NAME));
  assert.deepEqual(await ids(store, DOC_A), []);
  assert.equal((await store.put(DOC_A, meta("s02", 2), body("b"))).stored, true);
});
