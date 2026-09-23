/* src/js/03c-history-idb.js — the browser's IndexedDB backend for the one
 * history store (#83), and its TEMPORARY v1 → v2 migrator — over
 * fake-indexeddb (a devDependency, owner decision 5 on #83).
 *
 * fake-indexeddb keeps IndexedDB's auto-commit rule: a transaction with no
 * request pending when a macrotask ends commits, and the next request
 * throws TransactionInactiveError. So the store's contract cases below run
 * against the same kind of strictness the memory backend's strict mode
 * imitates, and they run over BOTH backends: whatever the store promises
 * over memory it must promise over IndexedDB.
 *
 * Every case gets its own IDBFactory, so no case sees another's database.
 * _dom.mjs first: 03c imports 02b-doc-id.js (sha256Bytes), whose module
 * graph expects the globals it installs.
 */
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
  hashText,
  seedV1HistoryDb
} from "../js/03c-history-idb.js";

const DOC_A = "d" + "a".repeat(32);
const DOC_B = "d" + "b".repeat(32);
const DOC_C = "d" + "c".repeat(32);
const DOC_D = "d" + "d".repeat(32);

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

/* ---- fixtures ---- */

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

/* ================= the store's contract, over both backends ================= */

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
    await store.evict(Infinity);   /* queued behind the heal */
    assert.deepEqual(await ids(store, DOC_A), ["s02"]);
  });
}

/* ================= this backend's own transaction rules ================= */

function idbFixture(opts = {}) {
  const factory = opts.factory || new IDBFactory();
  const clock = { t: opts.t ?? 1_000_000 };
  const backend = createIdbHistoryBackend({ indexedDB: factory, now: () => clock.t, ...(opts.backend || {}) });
  return { factory, ...storeOver(backend, { ...opts, clock }) };
}

test("hashText is SHA-256 of the UTF-8, synchronously", () => {
  for (const s of ["", "abc", "héllo — ✓ 😀", body("x", 70_000)]) assert.equal(hashText(s), sha(s));
});

test("schema: v2 creates only index and bodies (no v1 stores on a fresh profile)", async () => {
  const { factory, backend } = idbFixture();
  await backend.open();
  await backend.close();
  const db = await req(factory.open(HISTORY_IDB_NAME));
  assert.equal(db.version, HISTORY_IDB_VERSION);
  assert.deepEqual([...db.objectStoreNames].sort(), ["bodies", "index"]);
  const t = db.transaction(["index", "bodies"], "readonly");
  assert.equal(t.objectStore("index").keyPath, "bucket");
  assert.equal(t.objectStore("bodies").keyPath, "sha");
  db.close();
  assert.equal(backend.migration.state, "none");
});

test("strict tx: a non-tx await inside exclusive() fails the job, as the rule says it must", async () => {
  const { backend } = idbFixture();
  await backend.open();
  const r = backend.exclusive(async (tx) => {
    await tx.list();
    await new Promise((resolve) => setTimeout(resolve, 5));   /* a timer: the transaction commits here */
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
    await tx.put("h1", "SECOND");          /* same sha: already there, not rewritten */
    assert.equal(await tx.get("h1"), "first");
  });
  assert.equal((await backend.inspect()).bodies.h1, "first");

  /* the index change and the drop fail together */
  backend.failNext("commit", "io", 1);
  await assert.rejects(backend.exclusive(async (tx) => {
    await tx.put("h2", "other");
    await tx.commit({ [DOC_A]: rec("h2") }, ["h1"]);
  }));
  assert.deepEqual(Object.keys((await backend.inspect()).bodies), ["h1"]);
  /* …and land together */
  await backend.exclusive(async (tx) => {
    await tx.put("h2", "other");
    await tx.commit({ [DOC_A]: rec("h2"), [DOC_B]: null }, ["h1"]);
  });
  const after = await backend.inspect();
  assert.deepEqual(Object.keys(after.bodies), ["h2"]);
  assert.equal(after.index[DOC_A].snapshots[0].sha, "h2");
  assert.equal(after.index[DOC_A].bucket, undefined, "the key field is not part of the DocRecord");
});

/* ---- quota: both ways a browser reports it ---- */

function patchBodiesPut(how, times = 1) {
  const orig = IDBObjectStore.prototype.put;
  let left = times;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name !== "bodies" || left <= 0) return orig.apply(this, args);
    left--;
    if (how === "request") {
      /* Firefox-like: the request itself fails with QuotaExceededError */
      throw new DOMException("Injected quota", "QuotaExceededError");
    }
    /* Chromium-like: the request is queued, then the TRANSACTION aborts
       with QuotaExceededError and the request only sees AbortError */
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

/* ---- other tabs, other versions ---- */

/* A v1 connection as 03a's openHistoryDb holds it: onversionchange closes. */
async function openV1(factory, { closes = true } = {}) {
  await seedV1HistoryDb(factory, {});
  const db = await req(factory.open(HISTORY_IDB_NAME, 1));
  const seen = { versionchange: 0 };
  db.onversionchange = () => { seen.versionchange++; if (closes) db.close(); };
  return { db, seen };
}

test("an old-build (v1) connection gets versionchange, closes, and the v2 upgrade goes through", async () => {
  const factory = new IDBFactory();
  const old = await openV1(factory);
  const { backend } = idbFixture({ factory });
  await backend.open();
  assert.equal(old.seen.versionchange, 1);
  assert.equal(backend.readOnly, false);
  /* the old build's next open fails with a VersionError — 03a then falls back to memory */
  await assert.rejects(req(factory.open(HISTORY_IDB_NAME, 1)), (e) => e.name === "VersionError");
});

test("an old connection that will NOT close: this open fails at once with 'io', and a late success is not adopted", async () => {
  const factory = new IDBFactory();
  const old = await openV1(factory, { closes: false });
  /* the factory as the backend sees it, keeping every open request */
  const opened = [];
  const spy = {
    open: (...args) => { const r = factory.open(...args); opened.push(r); return r; },
    deleteDatabase: (name) => factory.deleteDatabase(name)
  };
  const backend = createIdbHistoryBackend({ indexedDB: spy });
  await assert.rejects(backend.open(), (e) => e.code === "io" && /blocked/.test(e.message));
  assert.equal(old.seen.versionchange, 1);
  old.db.close();                                  /* the upgrade now completes behind our back */
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].readyState, "done");
  assert.equal(opened[0].result._closePending, true, "the late connection was closed, not adopted");
  /* a later job opens afresh, at v2 */
  await backend.open();
  assert.equal(opened.length, 2);
  assert.equal(opened[1].result.version, HISTORY_IDB_VERSION);
  assert.equal(opened[1].result._closePending, false);
});

test("this connection closes on versionchange; a NEWER database is then served read-only", async () => {
  const { factory, backend, store } = idbFixture();
  await store.put(DOC_A, meta("s01", 1), body("a"));
  /* a newer build upgrades to v3, keeping index + bodies */
  const v3req = factory.open(HISTORY_IDB_NAME, 3);
  v3req.onupgradeneeded = () => { /* a v3 might drop the v1 stores; ours has none */ };
  const v3 = await req(v3req);
  v3.close();
  assert.equal(backend.readOnly, false, "not known until the next job reopens");
  assert.deepEqual(await ids(store, DOC_A), ["s01"], "reads still work");
  assert.equal(backend.readOnly, true);
  assert.equal(store.readOnly, true);
  assert.equal((await store.get(DOC_A, "s01")).stateJson, body("a"));
  assert.deepEqual(await store.put(DOC_A, meta("s02", 2), body("b")), { stored: false, code: "read-only" });
  assert.equal((await store.usage()).readOnly, true);
  /* a raw write job is refused too, and nothing changed */
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

test("deleteDatabase (resetForTest) is not blocked; the next job starts a fresh v2", async () => {
  const { factory, store } = idbFixture();
  await store.put(DOC_A, meta("s01", 1), body("a"));
  await req(factory.deleteDatabase(HISTORY_IDB_NAME));
  assert.deepEqual(await ids(store, DOC_A), []);
  assert.equal((await store.put(DOC_A, meta("s02", 2), body("b"))).stored, true);
});

/* ================= TEMPORARY: the v1 → v2 migration ================= */

const T0 = 1_700_000_000_000;
/* A pre-#82 profile: bodies with an inline image (2 MB of base64 in the
   state, as documents carried images before the blob store). */
const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA" + "QUJD".repeat(512 * 1024);
const bigBody = JSON.stringify({ rows: [{ id: "r1", image: IMAGE, text: "héllo ✓" }], title: "Big" });

function v1Meta(bucket, id, atMs, extra = {}) {
  return { docId: bucket, id, label: "L " + id, at: new Date(atMs).toISOString(), atMs, by: "Ann", rows: 3, title: "Doc " + bucket.slice(1, 3), kind: "snapshot", formatVersion: 1, ...extra };
}

function v1Spec() {
  return {
    docs: [
      { docId: DOC_A, title: "Alpha", lastOpenedAt: T0 - 5000 },
      { docId: DOC_B, title: "Beta", lastOpenedAt: T0 - 9000 },
      { docId: DOC_D, title: "Delta, no history", lastOpenedAt: T0 - 1 },   /* an empty record: dropped */
      { docId: HISTORY_OLDER_KEY, title: "", lastOpenedAt: 0, migratedAt: T0 - 86_400_000, expiresAt: T0 - 86_400_000 + HISTORY_OLDER_TTL_MS }
    ],
    snaps: [
      { meta: v1Meta(DOC_A, "a01", T0 - 300), stateJson: body("a1") },
      { meta: v1Meta(DOC_A, "a02", T0 - 200), stateJson: bigBody },
      { meta: v1Meta(DOC_A, "a03", T0 - 100), stateJson: body("a3") },
      { meta: v1Meta(DOC_B, "b01", T0 - 900), stateJson: body("same") },
      { meta: v1Meta(DOC_B, "b02", T0 - 800), stateJson: body("same") },   /* same bytes: one body */
      { meta: v1Meta(DOC_B, "b03", T0 - 700), stateJson: bigBody },        /* same as A's: one body */
      { meta: v1Meta(DOC_B, "b04", T0 - 600), stateJson: null },           /* body lost in v1: unreachable there, dropped */
      { meta: v1Meta(DOC_C, "c01", T0 - 50), stateJson: body("c1") },      /* no docs row */
      { meta: v1Meta(HISTORY_OLDER_KEY, "leg-1", 1000, { kind: "legacy", legacyId: "x1" }), stateJson: body("o1") },
      { meta: v1Meta(HISTORY_OLDER_KEY, "leg-2", 2000, { kind: "legacy", legacyId: "x2" }), stateJson: body("o2") }
    ]
  };
}
const V1_ROWS = v1Spec().snaps.length;
const V1_READABLE = v1Spec().snaps.filter((s) => s.stateJson != null);

async function seeded(opts = {}) {
  const factory = opts.factory || new IDBFactory();
  await seedV1HistoryDb(factory, v1Spec());
  return idbFixture({ factory, t: T0, backend: opts.backend });
}

/* The v2 state an uninterrupted migration of v1Spec() ends in. */
async function referenceState() {
  const { backend } = await seeded();
  await backend.open();
  return backend.inspect();
}

test("migration: every readable v1 snapshot moves to v2, bodies deduped, docs records carried, v1 emptied", async () => {
  const { factory, backend, store } = await seeded();
  await backend.open();
  assert.deepEqual(backend.migration, { state: "done", migrated: V1_READABLE.length, skipped: 1, code: null });
  assert.deepEqual(await backend.v1Counts(), { docs: 0, snapMeta: 0, snapBody: 0 }, "v1 emptied, its stores kept");

  /* every snapshot reads back byte for byte, with its meta */
  for (const s of V1_READABLE) {
    const got = await store.get(s.meta.docId, s.meta.id);
    assert.ok(got, s.meta.id);
    assert.equal(got.stateJson, s.stateJson);
    assert.equal(got.meta.atMs, s.meta.atMs, "migration does not re-stamp");
    assert.equal(got.meta.label, s.meta.label);
    assert.equal(got.meta.sizeBytes, historyUtf8Length(s.stateJson));
  }
  assert.equal((await store.get(DOC_A, "a02")).stateJson.length, bigBody.length);
  assert.equal(await store.get(DOC_B, "b04"), null);
  assert.deepEqual(await ids(store, DOC_A), ["a03", "a02", "a01"]);
  assert.deepEqual(await ids(store, DOC_B), ["b03", "b02", "b01"]);
  const older = await store.list(null);
  assert.deepEqual(older.older.map((m) => [m.id, m.kind, m.legacyId]), [["leg-2", "legacy", "x2"], ["leg-1", "legacy", "x1"]]);
  assert.equal(older.olderExpiresAt, T0 - 86_400_000 + HISTORY_OLDER_TTL_MS, "the Older bucket keeps its 90 days");

  /* the docs records came across; the empty one did not */
  const { index, bodies } = await backend.inspect();
  assert.deepEqual(Object.keys(index).sort(), [HISTORY_OLDER_KEY, DOC_A, DOC_B, DOC_C].sort());
  assert.deepEqual([index[DOC_A].title, index[DOC_A].lastOpenedAt], ["Alpha", T0 - 5000]);
  assert.deepEqual([index[DOC_B].title, index[DOC_B].lastOpenedAt], ["Beta", T0 - 9000]);
  assert.deepEqual([index[DOC_C].title, index[DOC_C].lastOpenedAt], ["Doc cc", T0 - 50], "no docs row: from the entry");
  assert.equal(index[HISTORY_OLDER_KEY].migratedAt, T0 - 86_400_000);
  assert.equal(new Set(V1_READABLE.map((s) => s.stateJson)).size, Object.keys(bodies).length, "one body per distinct text");
  assert.equal(await backend.bodyCount(), 7);
  assert.equal(index[DOC_A].snapshots[1].sha, index[DOC_B].snapshots[2].sha, "the image body is shared across buckets");

  /* writes work afterwards, and the listing is the store's */
  assert.equal((await store.put(DOC_A, meta("a04", T0), body("a4"))).stored, true);
  assert.deepEqual((await store.listDocs()).map((d) => d.docId), [DOC_A, DOC_B, DOC_C]);

  /* a reload finds nothing left to move */
  await backend.close();
  const again = idbFixture({ factory, t: T0 });
  await again.backend.open();
  assert.deepEqual(again.backend.migration, { state: "done", migrated: 0, skipped: 0, code: null });
  assert.deepEqual(await ids(again.store, DOC_A), ["a04", "a03", "a02", "a01"]);
});

test("migration: an Older bucket without an expiry gets a fresh 90 days", async () => {
  const factory = new IDBFactory();
  await seedV1HistoryDb(factory, {
    snaps: [{ meta: v1Meta(HISTORY_OLDER_KEY, "leg-1", 1000, { kind: "legacy" }), stateJson: body("o1") }]
  });
  const { store, backend } = idbFixture({ factory, t: T0 });
  const listed = await store.list(null);
  assert.deepEqual(listed.older.map((m) => m.id), ["leg-1"]);
  assert.equal(listed.olderExpiresAt, T0 + HISTORY_OLDER_TTL_MS);
  assert.equal((await backend.inspect()).index[HISTORY_OLDER_KEY].migratedAt, T0);
});

/* ---- interruption: stopped between snapshots (a closed tab, a crash) ---- */

for (const n of [0, 1, 3, 6, V1_ROWS - 1, V1_ROWS]) {
  test(`migration interrupted after ${n} snapshot(s): nothing disappears meanwhile, and a reopen resumes to the same end`, async () => {
    const reference = await referenceState();
    const factory = new IDBFactory();
    const { backend, store } = await seeded({ factory, backend: { fault: "migrate-stop-after:" + n } });
    await backend.open();
    const m = backend.migration;
    assert.equal(m.migrated + m.skipped, n);
    assert.equal(m.state, "incomplete");
    assert.equal(m.code, "stopped");
    assert.equal((await backend.v1Counts()).snapMeta, V1_ROWS - n);

    /* reads: v2 plus the read-only v1 reader — every readable snapshot is there */
    for (const s of V1_READABLE) {
      const got = await store.get(s.meta.docId, s.meta.id);
      assert.ok(got, `${s.meta.id} readable after ${n}`);
      assert.equal(got.stateJson, s.stateJson);
    }
    assert.deepEqual(await ids(store, DOC_A), ["a03", "a02", "a01"]);
    assert.deepEqual((await store.list(null)).older.map((x) => x.id), ["leg-2", "leg-1"]);
    assert.deepEqual((await store.listDocs()).map((d) => [d.docId, d.title]), [[DOC_A, "Alpha"], [DOC_B, "Beta"], [DOC_C, "Doc cc"]]);

    /* writes answer io (03a keeps them pending) and change nothing */
    assert.deepEqual(await store.put(DOC_A, meta("new", T0), body("new")), { stored: false, code: "io" });
    assert.equal((await store.copy(DOC_A, DOC_D)).code, "io");

    /* the reload: a fresh backend over the same database resumes */
    await backend.close();
    const next = idbFixture({ factory, t: T0 });
    await next.backend.open();
    assert.equal(next.backend.migration.state, "done");
    assert.equal(next.backend.migration.migrated + next.backend.migration.skipped, V1_ROWS - n);
    assert.deepEqual(await next.backend.inspect(), reference, "ends identical to an uninterrupted migration");
    assert.deepEqual(await next.backend.v1Counts(), { docs: 0, snapMeta: 0, snapBody: 0 });
  });
}

/* ---- interruption: a step that fails half way (quota at its body put) ---- */

test("migration: a step aborted mid-way lands nothing, and the retry on the next write finishes it", async (t) => {
  const reference = await referenceState();
  const { backend, store } = await seeded();
  const restore = patchBodiesPut("transaction", 1);
  t.after(() => restore());
  await backend.open();
  restore();
  assert.deepEqual(backend.migration, { state: "incomplete", migrated: 0, skipped: 0, code: "quota" });
  assert.equal((await backend.v1Counts()).snapMeta, V1_ROWS, "the first step's deletes rolled back with its body");
  assert.deepEqual((await backend.inspect()).index, {});
  assert.deepEqual(await ids(store, DOC_A), ["a03", "a02", "a01"], "the v1 reader still shows it all");

  /* space came back: the next write job retries the migration first */
  const r = await store.put(DOC_D, meta("d01", T0), body("d1"));
  assert.equal(r.stored, true);
  assert.equal(backend.migration.state, "done");
  const now = await backend.inspect();
  delete now.index[DOC_D];
  delete now.bodies[sha(body("d1"))];
  assert.deepEqual(now, reference);
});

/* ---- two tabs of this build migrating at once ---- */

test("two connections racing over the same v1 rows: each row moves exactly once", async () => {
  const reference = await referenceState();
  const factory = new IDBFactory();
  await seedV1HistoryDb(factory, v1Spec());
  const a = idbFixture({ factory, t: T0 });
  const b = idbFixture({ factory, t: T0 });
  await Promise.all([a.backend.open(), b.backend.open()]);
  const ma = a.backend.migration, mb = b.backend.migration;
  assert.equal(ma.state, "done");
  assert.equal(mb.state, "done");
  assert.equal(ma.migrated + mb.migrated, V1_READABLE.length, "no row moved twice, none lost");
  assert.equal(ma.skipped + mb.skipped, 1);
  assert.ok(ma.migrated > 0 && mb.migrated > 0, "they really did interleave");
  assert.deepEqual(await a.backend.inspect(), reference);
  for (const f of [a, b]) {
    for (const bucket of [DOC_A, DOC_B, DOC_C]) {
      const list = await ids(f.store, bucket);
      assert.equal(new Set(list).size, list.length, "no duplicate ids");
    }
  }
});

test("one tab stopped mid-way, another finishes: the first sees it all and can write again", async () => {
  const factory = new IDBFactory();
  await seedV1HistoryDb(factory, v1Spec());
  const a = idbFixture({ factory, t: T0, backend: { fault: "migrate-stop-after:2" } });
  await a.backend.open();
  assert.equal(a.backend.migration.state, "incomplete");
  const b = idbFixture({ factory, t: T0 });
  await b.backend.open();
  assert.equal(b.backend.migration.state, "done");
  assert.deepEqual(await ids(a.store, DOC_B), ["b03", "b02", "b01"]);
  /* a test-fault stop is final for its backend (like a crash), so a stays incomplete */
  assert.equal((await a.store.put(DOC_A, meta("x01", T0), body("x"))).code, "io");
  a.backend.injectFault(null);
  assert.equal((await a.store.put(DOC_A, meta("x01", T0), body("x"))).stored, true, "cleared: the retry finds v1 empty");
  assert.equal(a.backend.migration.state, "done");
});
