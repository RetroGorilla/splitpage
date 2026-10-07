import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createHistoryStore, createMemoryHistoryBackend } from "../../shared/history-store.js";
import {
  HISTORY_OLDER_KEY,
  HISTORY_OLDER_TTL_MS,
  historyOlderExpired,
  historyUtf8Length
} from "../../shared/history-policy.js";

const DOC_A = "d" + "a".repeat(32);
const DOC_B = "d" + "b".repeat(32);
const DOC_C = "d" + "c".repeat(32);

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const macrotask = (cb) => setImmediate(cb);

function fixture(opts = {}) {
  const clock = { t: opts.t ?? 1_000_000 };
  const backend = createMemoryHistoryBackend({ strict: true, macrotask, ...(opts.backend || {}) });
  const store = createHistoryStore({
    backend,
    now: () => clock.t,
    hashText: sha,
    capBytes: opts.capBytes,
    maxBodyBytes: opts.maxBodyBytes,
    holds: opts.holds
  });
  return { clock, backend, store };
}

const meta = (id, atMs, over = {}) => ({ id, atMs, label: "L " + id, title: "T", ...over });
const body = (tag, pad = 0) => JSON.stringify({ rows: [], tag, pad: "x".repeat(pad) });

async function ids(store, docId) {
  return (await store.list(docId)).entries.map((m) => m.id);
}

test("put stores a snapshot and answers 03a's HistoryWriteResult shape", async () => {
  const { store, backend } = fixture();
  const r = await store.put(DOC_A, meta("s01", 500), body("one"));
  assert.deepEqual(r, { stored: true, evicted: 0, overCap: false });
  const listed = await store.list(DOC_A);
  assert.equal(listed.entries.length, 1);
  const m = listed.entries[0];
  assert.equal(m.docId, DOC_A, "every listed meta carries its bucket, as 03a's backends did");
  assert.equal(m.sizeBytes, historyUtf8Length(body("one")));
  assert.equal(m.sha, undefined, "the sha never leaves the store");
  assert.deepEqual(listed.older, []);
  assert.equal(listed.olderExpiresAt, null);
  const got = await store.get(DOC_A, "s01");
  assert.equal(got.stateJson, body("one"));
  assert.equal(got.meta.docId, DOC_A);
  assert.equal(got.meta.label, "L s01");
  assert.equal(backend.bodyCount(), 1);
});

test("put-if-absent by id: the same id twice is one snapshot, and the first body wins", async () => {
  const { store, backend } = fixture();
  await store.put(DOC_A, meta("s01", 500), body("first"));
  const commitsBefore = backend.counts.commit;
  const r = await store.put(DOC_A, meta("s01", 900, { label: "other" }), body("second"));
  assert.deepEqual(r, { stored: true, evicted: 0, overCap: false, duplicate: true });
  assert.equal(backend.counts.commit, commitsBefore, "a duplicate writes nothing");
  assert.deepEqual(await ids(store, DOC_A), ["s01"]);
  assert.equal((await store.get(DOC_A, "s01")).stateJson, body("first"));
  assert.equal(backend.bodyCount(), 1);
});

test("put refuses what can never succeed with 'invalid', and the Older bucket by name", async () => {
  const { store, backend } = fixture();
  assert.deepEqual(await store.put("not-a-doc", meta("s01", 1), "{}"), { stored: false, code: "invalid" });
  assert.deepEqual(await store.put(DOC_A, meta("A/B", 1), "{}"), { stored: false, code: "invalid" });
  assert.deepEqual(await store.put(DOC_A, meta("s01", 1), 42), { stored: false, code: "invalid" });
  assert.deepEqual(await store.put(HISTORY_OLDER_KEY, meta("s01", 1), "{}"), { stored: false, code: "invalid" },
    "the Older bucket is reachable only through {older:true} (invariant #38)");
  assert.equal(backend.counts.exclusive, 0);
});

test("put over maxBodyBytes answers 'too-large' and writes nothing", async () => {
  const { store, backend } = fixture({ maxBodyBytes: 100 });
  assert.deepEqual(await store.put(DOC_A, meta("s01", 1), body("big", 200)), { stored: false, code: "too-large" });
  assert.equal(backend.counts.exclusive, 0);
});

test("a put stamps strictly after the newest snapshot in its bucket; `at` keeps the wall clock", async () => {
  const { store } = fixture();
  await store.put(DOC_A, meta("s01", 5000, { at: "2026-01-01T00:00:05.000Z" }), body("a"));
  await store.put(DOC_A, meta("s02", 1000, { at: "2026-01-01T00:00:01.000Z" }), body("b"));
  const listed = (await store.list(DOC_A)).entries;
  assert.deepEqual(listed.map((m) => [m.id, m.atMs]), [["s02", 5001], ["s01", 5000]]);
  assert.equal(listed[0].at, "2026-01-01T00:00:01.000Z");
  await store.put(DOC_B, meta("s03", 10), body("c"));
  assert.equal((await store.list(DOC_B)).entries[0].atMs, 10);
});

test("a document keeps its 50 newest; the trimmed bodies go in the same commit", async () => {
  const { store, backend } = fixture();
  let last;
  for (let i = 1; i <= 55; i++) {
    last = await store.put(DOC_A, meta("s" + String(i).padStart(3, "0"), i * 10), body("n" + i));
  }
  const list = await ids(store, DOC_A);
  assert.equal(list.length, 50);
  assert.equal(list[0], "s055", "newest first");
  assert.equal(list[49], "s006", "the five oldest went");
  assert.equal(backend.bodyCount(), 50, "no body outlives its last entry");
  assert.equal(last.evicted, 1, "each put past 50 reports the trim it did (the desktop rule)");
  assert.equal(await store.get(DOC_A, "s001"), null);
});

test("cap eviction: least recently opened document first, its newest snapshot always kept", async () => {
  const size = historyUtf8Length(body("x0", 100));
  let cap = 5 * size;
  const { store, clock, backend } = fixture({ capBytes: () => cap });
  for (let i = 0; i < 3; i++) { clock.t = 1000 + i; await store.put(DOC_A, meta("a0" + i, 100 + i), body("a" + i, 100)); }
  for (let i = 0; i < 3; i++) { clock.t = 5000 + i; await store.put(DOC_B, meta("b0" + i, 100 + i), body("b" + i, 100)); }
  assert.deepEqual(await ids(store, DOC_A), ["a02", "a01"]);
  assert.deepEqual(await ids(store, DOC_B), ["b02", "b01", "b00"]);
  assert.equal(backend.bodyCount(), 5);

  const ev = await store.evict(size);
  assert.equal(ev.overCap, true);
  assert.equal(ev.evicted, 3);
  assert.equal(ev.totalBefore, 5 * size);
  assert.equal(ev.totalAfter, 2 * size);
  assert.deepEqual(await ids(store, DOC_A), ["a02"]);
  assert.deepEqual(await ids(store, DOC_B), ["b02"]);

  cap = size;
  clock.t = 9000;
  const r = await store.put(DOC_C, meta("c00", 1), body("c", 100));
  assert.equal(r.stored, true);
  assert.equal(r.overCap, true);
  assert.equal((await store.usage()).overCap, true);
});

test("evict() with no cap reads capBytes(), which is handed the last total the store saw", async () => {
  const seen = [];
  const { store } = fixture({ capBytes: (total) => { seen.push(total); return Promise.resolve(Infinity); } });
  await store.put(DOC_A, meta("s01", 1), body("a"));
  await store.evict();
  assert.equal(seen[0], null, "nothing read yet before the first put");
  assert.equal(seen[seen.length - 1], historyUtf8Length(body("a")));
});

async function twoDocs(store, clock) {
  clock.t = 100; await store.put(DOC_A, meta("a01", 1), body("a1", 50));
  clock.t = 101; await store.put(DOC_A, meta("a02", 2), body("a2", 50));
  clock.t = 200; await store.put(DOC_B, meta("b01", 1), body("b1", 50));
}

test("a no-room refusal evicts under (total − size) and retries once", async () => {
  const { store, backend, clock } = fixture();
  await twoDocs(store, clock);
  backend.failNext("put", "quota", 1);
  clock.t = 300;
  const r = await store.put(DOC_B, meta("b02", 2), body("b2", 50));
  assert.equal(r.stored, true);
  assert.equal(r.evicted, 1, "A's oldest made room");
  assert.deepEqual(await ids(store, DOC_A), ["a02"]);
  assert.deepEqual(await ids(store, DOC_B), ["b02", "b01"]);
});

test("the same retry for a refusal at commit time (IndexedDB reports quota there) and for 'enospc'", async () => {
  const { store, backend, clock } = fixture();
  await twoDocs(store, clock);
  backend.failNext("commit", "enospc", 1);
  clock.t = 300;
  const r = await store.put(DOC_B, meta("b02", 2), body("b2", 50));
  assert.equal(r.stored, true);
  assert.equal(r.evicted, 1);
});

test("nothing evictable → no retry, the stuck flag is set, and nothing more is deleted", async () => {
  const { store, backend, clock } = fixture();
  await store.put(DOC_A, meta("a01", 1), body("a1"));
  const putsBefore = backend.counts.put;
  backend.failNext("put", "quota", 1);
  clock.t = 300;
  const r = await store.put(DOC_B, meta("b01", 1), body("b1"));
  assert.deepEqual(r, { stored: false, code: "quota", evicted: 0, overCap: true });
  assert.equal(backend.counts.put - putsBefore, 1, "no second attempt when nothing was freed");

  const exBefore = backend.counts.exclusive;
  backend.failNext("put", "quota", 1);
  assert.deepEqual(await store.put(DOC_B, meta("b02", 2), body("b2")), { stored: false, code: "quota", evicted: 0, overCap: true });
  assert.equal(backend.counts.exclusive - exBefore, 1);
  assert.deepEqual(await ids(store, DOC_A), ["a01"], "nothing was deleted on the way");
});

test("a retry refused too sets the stuck flag; later refusals evict nothing until a write lands", async () => {
  const { store, backend, clock } = fixture();
  await twoDocs(store, clock);
  backend.failNext("put", "quota", 2);
  clock.t = 300;
  const r1 = await store.put(DOC_B, meta("b02", 2), body("b2", 50));
  assert.deepEqual(r1, { stored: false, code: "quota", evicted: 1, overCap: true });
  assert.deepEqual(await ids(store, DOC_A), ["a02"]);

  const exBefore = backend.counts.exclusive;
  backend.failNext("put", "quota", 1);
  const r2 = await store.put(DOC_B, meta("b03", 3), body("b3", 50));
  assert.deepEqual(r2, { stored: false, code: "quota", evicted: 0, overCap: true });
  assert.equal(backend.counts.exclusive - exBefore, 1, "the attempt only, no eviction job");

  clock.t = 400;
  assert.equal((await store.put(DOC_C, meta("c01", 1), body("c1", 50))).stored, true);
  clock.t = 500;
  assert.equal((await store.put(DOC_C, meta("c02", 2), body("c2", 50))).stored, true);
  backend.failNext("put", "quota", 1);
  const r3 = await store.put(DOC_C, meta("c03", 3), body("c3", 50));
  assert.equal(r3.stored, true);
  assert.equal(r3.evicted, 1);
});

test("a non-quota failure is 'io', not retried, and leaves no body behind", async () => {
  const { store, backend } = fixture();
  backend.failNext("commit", "io", 1);
  const r = await store.put(DOC_A, meta("s01", 1), body("a"));
  assert.deepEqual(r, { stored: false, code: "io" });
  assert.equal(backend.bodyCount(), 0, "the transaction is all or nothing");
  assert.deepEqual(await ids(store, DOC_A), []);
});

test("holds: a held snapshot survives the trim, the cap and the Older sweep; release lets it go", async () => {
  const { store, clock } = fixture();
  await store.importOlder([{ meta: meta("o01", 1), stateJson: body("o1") }, { meta: meta("o02", 2), stateJson: body("o2") }]);
  const release = store.hold({ older: true, id: "o01" });
  const again = store.hold({ older: true, id: "o01" });
  await store.evict(0);
  assert.deepEqual((await store.list(null)).older.map((m) => m.id), ["o01"]);
  release();
  release();
  await store.evict(0);
  assert.deepEqual((await store.list(null)).older.map((m) => m.id), ["o01"], "still held once");
  again();
  await store.evict(0);
  assert.deepEqual((await store.list(null)).older, []);

  const hold1 = store.hold({ docId: DOC_A, id: "s001" });
  for (let i = 1; i <= 52; i++) { clock.t += 1; await store.put(DOC_A, meta("s" + String(i).padStart(3, "0"), i), body("n" + i)); }
  const kept = await ids(store, DOC_A);
  assert.equal(kept.length, 50);
  assert.ok(kept.includes("s001"), "held");
  assert.ok(!kept.includes("s002") && !kept.includes("s003"), "the next oldest went instead");
  hold1();
  clock.t += 1;
  await store.put(DOC_A, meta("s053", 53), body("n53"));
  assert.ok(!(await ids(store, DOC_A)).includes("s001"), "released: the next trim takes it");
  assert.equal(store.hold({ docId: "nope", id: "s001" })(), undefined, "an unusable hold holds nothing");
});

test("holds: a call's protect list and the holds() provider are honoured by every eviction", async () => {
  const external = [];
  const { store } = fixture({ holds: () => external });
  await store.importOlder([{ meta: meta("o01", 1), stateJson: body("o1") }, { meta: meta("o02", 2), stateJson: body("o2") }]);
  external.push({ docId: HISTORY_OLDER_KEY, id: "o02" });
  await store.evict(0, { protect: [{ docId: HISTORY_OLDER_KEY, id: "o01" }] });
  assert.deepEqual((await store.list(null)).older.map((m) => m.id).sort(), ["o01", "o02"]);
  await store.evict(0);
  assert.deepEqual((await store.list(null)).older.map((m) => m.id), ["o02"], "the provider still holds o02");
});

test("copy is index-only; a body shared by sha stays until its last entry goes", async () => {
  const { store, backend, clock } = fixture();
  await store.put(DOC_A, meta("s01", 10), body("one"));
  await store.put(DOC_A, meta("s02", 20), body("two"));
  const bodiesBefore = backend.bodyCount();
  const putsBefore = backend.counts.put;
  clock.t = 2_000_000;
  const r = await store.copy(DOC_A, DOC_B);
  assert.deepEqual(r, { ok: true, copied: 2 });
  assert.equal(backend.bodyCount(), bodiesBefore, "no body was duplicated");
  assert.equal(backend.counts.put, putsBefore, "and none was written");
  assert.deepEqual(await ids(store, DOC_B), ["s02", "s01"]);
  assert.equal((await store.list(DOC_B)).entries[0].atMs, 20, "a copy keeps its source's atMs");
  assert.equal((await store.get(DOC_B, "s01")).stateJson, body("one"));
  assert.deepEqual(await store.copy(DOC_A, DOC_B), { ok: true, copied: 0 }, "a second copy is a no-op");
  const docs = await store.listDocs();
  assert.equal(docs.find((d) => d.docId === DOC_B).lastOpenedAt, 2_000_000);
  assert.equal(docs.find((d) => d.docId === DOC_B).title, "T");

  const s01 = sha(body("one"));
  await store.evict(historyUtf8Length(body("one")) * 3);
  assert.deepEqual(await ids(store, DOC_A), ["s02"]);
  assert.ok(backend.hasBody(s01), "B still names it");
  assert.equal((await store.get(DOC_B, "s01")).stateJson, body("one"));
  await store.evict(0);
  assert.ok(!backend.hasBody(s01));
});

test("identical captures are one body, and every capture still gets its own entry", async () => {
  const { store, backend } = fixture();
  await store.put(DOC_A, meta("s01", 1), body("same"));
  await store.put(DOC_A, meta("s02", 2), body("same"));
  await store.put(DOC_B, meta("s03", 3), body("same"));
  assert.deepEqual(await ids(store, DOC_A), ["s02", "s01"]);
  assert.equal(backend.bodyCount(), 1);
  const u = await store.usage();
  assert.equal(u.totalBytes, 3 * historyUtf8Length(body("same")),
    "usage is the index's sum of sizeBytes — the same sum the planner caps");
});

test("copy: bad ids are 'invalid', same id is a no-op, an empty source conjures no record", async () => {
  const { store, backend } = fixture();
  assert.deepEqual(await store.copy("x", DOC_B), { ok: false, copied: 0, code: "invalid" });
  assert.deepEqual(await store.copy(DOC_A, HISTORY_OLDER_KEY), { ok: false, copied: 0, code: "invalid" });
  assert.deepEqual(await store.copy(DOC_A, DOC_A), { ok: true, copied: 0 });
  assert.deepEqual(await store.copy(DOC_A, DOC_B), { ok: true, copied: 0 });
  assert.deepEqual(await store.listDocs(), []);
  assert.equal(backend.counts.commit, 0);
});

test("touch updates lastOpenedAt and title, and never creates a record", async () => {
  const { store, clock } = fixture();
  await store.touch(DOC_A, "Nothing here");
  assert.deepEqual(await store.listDocs(), []);
  await store.put(DOC_A, meta("s01", 1, { title: "First" }), body("a"));
  clock.t = 7_000_000;
  await store.touch(DOC_A, "Renamed");
  assert.deepEqual(await store.listDocs(), [{ docId: DOC_A, title: "Renamed", lastOpenedAt: 7_000_000 }]);
  await store.touch(DOC_A, "");
  assert.equal((await store.listDocs())[0].title, "Renamed", "an empty title keeps the old one");
});

test("importOlder: put-if-absent, no stamp, 90 days from creation that a re-import never extends", async () => {
  const { store, clock, backend } = fixture({ t: 50_000 });
  const entries = [
    { meta: meta("l01", 300, { kind: "legacy" }), stateJson: body("l1") },
    { meta: meta("l02", 100, { kind: "legacy" }), stateJson: body("l2") },
    { meta: meta("BAD", 1), stateJson: body("bad") },
    { meta: meta("l03", 200), stateJson: 7 }
  ];
  assert.deepEqual(await store.importOlder(entries), { ok: true, count: 2, added: 2 });
  let listed = await store.list(null);
  assert.deepEqual(listed.entries, []);
  assert.deepEqual(listed.older.map((m) => [m.id, m.atMs, m.docId]), [["l01", 300, HISTORY_OLDER_KEY], ["l02", 100, HISTORY_OLDER_KEY]]);
  assert.equal(listed.olderExpiresAt, 50_000 + HISTORY_OLDER_TTL_MS);
  assert.equal(listed.older[0].kind, "legacy");

  clock.t = 60_000;
  assert.deepEqual(await store.importOlder(entries.slice(0, 2).concat([{ meta: meta("l04", 50), stateJson: body("l4") }])),
    { ok: true, count: 3, added: 1 });
  listed = await store.list(null);
  assert.equal(listed.olderExpiresAt, 50_000 + HISTORY_OLDER_TTL_MS, "not extended");
  const raw = await store.rawIndex();
  assert.equal(raw[HISTORY_OLDER_KEY].migratedAt, 50_000);
  assert.equal(raw[HISTORY_OLDER_KEY].lastOpenedAt, 0);
  assert.equal(backend.bodyCount(), 3);

  assert.deepEqual(await store.importOlder([]), { ok: true, count: 3, added: 0 });
  assert.equal((await store.get(HISTORY_OLDER_KEY, "l02")).stateJson, body("l2"));
  assert.deepEqual(await store.importOlder("nope"), { ok: false, count: 0, added: 0, code: "invalid" });
});

test("importOlder into nothing creates nothing", async () => {
  const { store, backend } = fixture();
  assert.deepEqual(await store.importOlder([]), { ok: true, count: 0, added: 0 });
  assert.equal(backend.counts.commit, 0);
  assert.deepEqual(await store.rawIndex(), {});
});

test("put {older:true} is a one-entry importOlder", async () => {
  const { store } = fixture();
  assert.deepEqual(await store.put(null, meta("o01", 5), body("o"), { older: true }), { stored: true, evicted: 0, overCap: false });
  assert.deepEqual(await store.put(HISTORY_OLDER_KEY, meta("o01", 5), body("o"), { older: true }),
    { stored: true, evicted: 0, overCap: false, duplicate: true });
  assert.deepEqual(await store.put(DOC_A, meta("o02", 5), body("o"), { older: true }), { stored: false, code: "invalid" });
  assert.deepEqual((await store.list(null)).older.map((m) => [m.id, m.atMs]), [["o01", 5]]);
});

test("Older expiry: past its 90 days it lists empty, gets null, and the sweep deletes it whole", async () => {
  const { store, clock, backend } = fixture({ t: 1_000 });
  await store.importOlder([{ meta: meta("o01", 1), stateJson: body("o1") }]);
  await store.put(DOC_A, meta("s01", 1), body("keep"));
  clock.t = 1_000 + HISTORY_OLDER_TTL_MS - 1;
  assert.equal((await store.list(null)).older.length, 1, "one ms before: still there");
  clock.t = 1_000 + HISTORY_OLDER_TTL_MS;
  assert.equal(await store.get(HISTORY_OLDER_KEY, "o01"), null, "a restore cannot reach what the panel stopped showing");
  const listed = await store.list(DOC_A);
  assert.deepEqual(listed.older, []);
  assert.equal(listed.olderExpiresAt, null);
  assert.deepEqual(listed.entries.map((m) => m.id), ["s01"]);
  const raw = await store.rawIndex();
  assert.equal(raw[HISTORY_OLDER_KEY], undefined);
  assert.ok(!backend.hasBody(sha(body("o1"))));
  assert.ok(backend.hasBody(sha(body("keep"))));

  assert.deepEqual(await store.importOlder([{ meta: meta("o09", 1), stateJson: body("o9") }]), { ok: true, count: 1, added: 1 });
  assert.equal((await store.list(null)).olderExpiresAt, clock.t + HISTORY_OLDER_TTL_MS);
});

test("importOlder into an expired bucket drops its unheld entries and starts a fresh 90 days", async () => {
  const { store, clock } = fixture({ t: 1_000 });
  await store.importOlder([{ meta: meta("o01", 1), stateJson: body("o1") }, { meta: meta("o02", 2), stateJson: body("o2") }]);
  const release = store.hold({ older: true, id: "o02" });
  clock.t = 1_000 + HISTORY_OLDER_TTL_MS + 5;
  const r = await store.importOlder([{ meta: meta("o03", 3), stateJson: body("o3") }]);
  assert.deepEqual(r, { ok: true, count: 2, added: 1 });
  const listed = await store.list(null);
  assert.deepEqual(listed.older.map((m) => m.id), ["o03", "o02"]);
  assert.equal(listed.olderExpiresAt, clock.t + HISTORY_OLDER_TTL_MS);
  release();
});

test("Older expiry: expiresAt ≤ 0 (or missing) is NOT STAMPED, never expired — one predicate everywhere", async () => {
  for (const expiresAt of [0, -5, null, undefined, "garbage"]) {
    assert.equal(historyOlderExpired({ expiresAt }, 10 ** 15), false, `expiresAt ${expiresAt}`);
  }
  assert.equal(historyOlderExpired({ expiresAt: 100 }, 99), false);
  assert.equal(historyOlderExpired({ expiresAt: 100 }, 100), true);
  assert.equal(historyOlderExpired(null, 100), false);

  const { store, backend } = fixture({ t: 10 ** 13 });
  const text = body("legacy");
  backend.seed({
    [HISTORY_OLDER_KEY]: {
      title: "", lastOpenedAt: 0, migratedAt: 0, expiresAt: 0,
      snapshots: [{ id: "o01", label: "", at: "1970-01-01T00:00:00.000Z", atMs: 1, by: "", rows: 0, title: "",
        sizeBytes: historyUtf8Length(text), kind: "legacy", formatVersion: 1, sha: sha(text) }]
    }
  }, { [sha(text)]: text });
  const listed = await store.list(null);
  assert.deepEqual(listed.older.map((m) => m.id), ["o01"], "listed, not hidden");
  assert.equal(listed.olderExpiresAt, null, "and no expiry is claimed for it");
  assert.equal((await store.get(HISTORY_OLDER_KEY, "o01")).stateJson, text);
  await store.evict(Infinity);
  assert.ok((await store.rawIndex())[HISTORY_OLDER_KEY], "the sweep leaves it alone too");
  const r = await store.importOlder([{ meta: meta("o02", 2), stateJson: body("o2") }]);
  assert.deepEqual(r, { ok: true, count: 2, added: 1 }, "an import joins it rather than restarting it");
});

test("usage and listDocs: 03a's shapes, computed from the index", async () => {
  const { store, clock } = fixture({ capBytes: 1_000_000 });
  clock.t = 111; await store.put(DOC_B, meta("b01", 1, { title: "Bee" }), body("b"));
  clock.t = 222; await store.put(DOC_A, meta("a01", 1, { title: "Ay" }), body("a"));
  await store.importOlder([{ meta: meta("o01", 1), stateJson: body("o") }]);
  assert.deepEqual(await store.usage(), {
    totalBytes: historyUtf8Length(body("b")) + historyUtf8Length(body("a")) + historyUtf8Length(body("o")),
    capBytes: 1_000_000,
    overCap: false,
    docCount: 2,
    readOnly: false
  });
  assert.deepEqual(await store.listDocs(), [
    { docId: DOC_A, title: "Ay", lastOpenedAt: 222 },
    { docId: DOC_B, title: "Bee", lastOpenedAt: 111 }
  ]);
  const noCap = fixture();
  assert.equal((await noCap.store.usage()).capBytes, Infinity, "no capBytes → no cap");
});

test("get validates both halves of the address and answers null for anything unknown", async () => {
  const { store } = fixture();
  await store.put(DOC_A, meta("s01", 1), body("a"));
  assert.equal(await store.get(DOC_A, "s02"), null);
  assert.equal(await store.get(DOC_B, "s01"), null);
  assert.equal(await store.get("../etc", "s01"), null);
  assert.equal(await store.get(DOC_A, "../s01"), null);
  assert.equal(await store.get(HISTORY_OLDER_KEY, "s01"), null);
});

test("a body lost behind the store's back: get answers null and the entry drops out (self-healing)", async () => {
  const { store, backend } = fixture();
  await store.put(DOC_A, meta("s01", 1), body("gone"));
  await store.put(DOC_A, meta("s02", 2), body("here"));
  await store.copy(DOC_A, DOC_B);
  backend.dropBody(sha(body("gone")));
  assert.equal(await store.get(DOC_A, "s01"), null);
  assert.deepEqual(await ids(store, DOC_A), ["s02"]);
  assert.deepEqual(await ids(store, DOC_B), ["s02"], "every entry naming the lost body goes");
});

test("a read-only backend refuses every write and still answers reads", async () => {
  const { store, backend, clock } = fixture();
  await store.put(DOC_A, meta("s01", 1), body("a"));
  await store.importOlder([{ meta: meta("o01", 1), stateJson: body("o") }]);
  backend.readOnly = true;
  const commits = backend.counts.commit, puts = backend.counts.put;
  assert.deepEqual(await store.put(DOC_A, meta("s02", 2), body("b")), { stored: false, code: "read-only" });
  assert.deepEqual(await store.put(null, meta("o02", 2), body("b"), { older: true }), { stored: false, code: "read-only" });
  assert.deepEqual(await store.copy(DOC_A, DOC_B), { ok: false, copied: 0, code: "read-only" });
  assert.deepEqual(await store.importOlder([{ meta: meta("o03", 1), stateJson: "{}" }]), { ok: false, count: 0, added: 0, code: "read-only" });
  assert.equal(await store.touch(DOC_A, "x"), undefined);
  const ev = await store.evict(0);
  assert.equal(ev.evicted, 0);
  assert.equal(ev.totalAfter, ev.totalBefore);
  clock.t += HISTORY_OLDER_TTL_MS * 2;
  await store.list(DOC_A);
  backendDelete(backend, "s01");
  assert.equal(await store.get(DOC_A, "s01"), null);
  assert.equal(backend.counts.commit, commits, "not one commit");
  assert.equal(backend.counts.put, puts, "not one body");
  assert.equal((await store.usage()).readOnly, true);
  assert.equal(store.readOnly, true);
  assert.deepEqual(await ids(store, DOC_A), ["s01"]);
});

function backendDelete(backend, id) {
  const snap = backend.inspect().index[DOC_A].snapshots.find((s) => s.id === id);
  backend.dropBody(snap.sha);
}

test("strict mode: a stray non-tx await inside exclusive() fails, as IndexedDB would", async () => {
  const backend = createMemoryHistoryBackend({ strict: true, macrotask });
  const clean = await backend.exclusive(async (tx) => {
    await tx.list();
    await Promise.resolve();
    await tx.put("abc", "text");
    await tx.commit({ [DOC_A]: { title: "", lastOpenedAt: 1, snapshots: [] } }, []);
    return "ok";
  });
  assert.equal(clean, "ok");

  await assert.rejects(backend.exclusive(async (tx) => {
    await tx.list();
    const stray = new Promise((resolve) => macrotask(resolve));
    const until = performance.now() + 8;
    while (performance.now() < until);
    await stray;
    await tx.put("def", "text");
  }), { name: "TransactionInactiveError" });
  assert.equal(backend.hasBody("def"), false);

  await assert.rejects(backend.exclusive(async (tx) => {
    await new Promise((resolve) => setImmediate(resolve));
    await tx.list();
  }), { name: "TransactionInactiveError" });
});

test("strict mode: a failed job leaves nothing, a read job cannot write, the records are frozen", async () => {
  const backend = createMemoryHistoryBackend({ strict: true, macrotask });
  await assert.rejects(backend.exclusive(async (tx) => {
    await tx.put("abc", "text");
    throw new Error("boom");
  }), /boom/);
  assert.equal(backend.bodyCount(), 0, "the staged body was discarded");

  await assert.rejects(backend.exclusive(async (tx) => { await tx.put("abc", "t"); }, { write: false }), /read-only job/);

  await backend.exclusive(async (tx) => {
    await tx.put("abc", "t");
    await tx.commit({ [DOC_A]: { title: "", lastOpenedAt: 1, snapshots: [{ id: "s01", sha: "abc" }] } }, []);
  });
  await assert.rejects(backend.exclusive(async (tx) => {
    const idx = await tx.list();
    idx[DOC_A].snapshots.push({ id: "s02" });
  }), TypeError, "a store that mutated the backend's records would throw");
  await assert.rejects(backend.exclusive(async (tx) => {
    await tx.commit({}, ["abc"]);
  }), /still names/, "dropping a body the index names is a store bug, caught");
  assert.ok(backend.hasBody("abc"));
});

test("strict mode needs a scheduler; the default memory backend is lenient", () => {
  assert.throws(() => createMemoryHistoryBackend({ strict: true }), TypeError);
  const b = createMemoryHistoryBackend();
  assert.equal(b.name, "memory");
  assert.equal(b.persistent, false);
  assert.equal(b.readOnly, false);
});

test("the store runs clean on a lenient backend too, and loads through require like main.js does", async () => {
  const require = createRequire(import.meta.url);
  const cjs = require("../../shared/history-store.js");
  const backend = cjs.createMemoryHistoryBackend();
  const store = cjs.createHistoryStore({ backend, now: () => 5, hashText: (s) => Promise.resolve(sha(s)) });
  assert.deepEqual(await store.put(DOC_A, meta("s01", 1), body("a")), { stored: true, evicted: 0, overCap: false });
  assert.equal((await store.get(DOC_A, "s01")).stateJson, body("a"));
  assert.throws(() => cjs.createHistoryStore({ backend, now: () => 5 }), TypeError, "a hash is required, never defaulted");
  assert.throws(() => cjs.createHistoryStore({ backend, hashText: sha }), TypeError, "so is a clock");
});
