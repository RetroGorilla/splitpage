/* src/js/03d-drafts-idb.js — the browser's store for crash-safe drafts of
 * server documents (PR #233: an invite link's guest has no desktop app, so
 * their unsaved edits are kept in this browser's IndexedDB) — over
 * fake-indexeddb, as history-idb.test.mjs runs 03c.
 *
 * The pure half: the key (one per server base and document id), the base
 * (origin + path, nothing a key or token could ride in), and the eviction
 * plan (30 days, 20 drafts, 64 MiB, never the one being written). Then the
 * store itself: the ancestor kept only for the writer that sent it (the
 * desktop store's NEED_BASE handshake), a recovered copy keeping whatever
 * is stored, a remove that only takes the writer's own, eviction inside the
 * put, and no IndexedDB at all answering quietly instead of throwing.
 *
 * Every case gets its own IDBFactory, so no case sees another's database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  DRAFT_LIMITS,
  browserDraftKey,
  createIdbDraftStore,
  draftBaseOf,
  planDraftEviction
} from "../js/03d-drafts-idb.js";

const DAY = 24 * 60 * 60 * 1000;
const PAGE = "https://script.example.test/app/index.html?doc=d1#invite=SECRETKEY";

function rec(key, over = {}) {
  return {
    key, base: "https://s.test/", docId: "doc-1", rev: 3, title: "Pilot", writerId: "w1",
    editSeq: 7, schema: 5, docIdWrittenOut: true,
    stateJson: JSON.stringify({ rows: [{ id: "r1", audioText: "mine" }] }),
    baseJson: JSON.stringify({ rows: [{ id: "r1", audioText: "base" }] }),
    ...over
  };
}

test("the key names the base and the document, and nothing else collides", () => {
  assert.equal(browserDraftKey("https://a.test/", "doc-1"), JSON.stringify(["https://a.test/", "doc-1"]));
  assert.notEqual(browserDraftKey("https://a.test/", "doc-1"), browserDraftKey("https://b.test/", "doc-1"));
  assert.notEqual(browserDraftKey("https://a.test/", "doc-1"), browserDraftKey("https://a.test/", "doc-2"));
  /* a base and an id that would run together as plain text stay apart */
  assert.notEqual(browserDraftKey("https://a.test/x", "y"), browserDraftKey("https://a.test/", "xy"));
});

test("the base is an origin and a folder: no query, no fragment, no user name", () => {
  /* "" is the server that served the page: the page's own folder */
  assert.equal(draftBaseOf("", PAGE), "https://script.example.test/app/");
  assert.equal(draftBaseOf("", "https://script.example.test/app/"), "https://script.example.test/app/");
  assert.equal(draftBaseOf("https://collab.test/", PAGE), "https://collab.test/");
  assert.equal(draftBaseOf("https://collab.test/sub/", PAGE), "https://collab.test/sub/");
  assert.equal(draftBaseOf("https://me:pw@collab.test/sub/?t=abc#invite=k", PAGE), "https://collab.test/sub/");
  for (const s of [draftBaseOf("", PAGE), draftBaseOf("https://me:pw@collab.test/?t=abc#k", PAGE)]) {
    assert.ok(!/SECRET|invite|pw|t=abc|#/.test(s), s);
  }
  /* no server anywhere: no key */
  assert.equal(draftBaseOf("", "file:///C:/Users/me/Splitpage.html"), "");
  assert.equal(draftBaseOf("not a url at all", "file:///x.html"), "");
});

test("eviction: expired first, then the oldest past the count or the bytes, never the one written", () => {
  const now = 100 * DAY;
  const m = (key, ageDays, bytes = 10) => ({ key, writtenAt: now - ageDays * DAY, bytes });
  assert.deepEqual(planDraftEviction([m("a", 31), m("b", 29), m("c", 1)], now), ["a"]);
  /* the one being written is never dropped, even if its clock says old */
  assert.deepEqual(planDraftEviction([m("a", 31)], now, DRAFT_LIMITS, "a"), []);
  const many = Array.from({ length: 23 }, (_, i) => m("k" + i, 23 - i));
  assert.deepEqual(planDraftEviction(many, now), ["k0", "k1", "k2"]);
  /* the oldest is the one being written: the next three go instead */
  assert.deepEqual(planDraftEviction(many, now, DRAFT_LIMITS, "k0"), ["k1", "k2", "k3"]);
  const limits = { maxAgeMs: 30 * DAY, maxCount: 20, maxBytes: 100 };
  assert.deepEqual(planDraftEviction([m("x", 3, 60), m("y", 2, 60), m("z", 1, 30)], now, limits, "z"), ["x"]);
  /* garbage in, nothing thrown */
  assert.deepEqual(planDraftEviction(null, now), []);
  assert.deepEqual(planDraftEviction([null, { key: 5 }, m("ok", 1)], now), []);
});

test("put and get: the draft comes back whole, with its scalars and its ancestor", async () => {
  const store = createIdbDraftStore({ indexedDB: new IDBFactory() });
  assert.equal(await store.available(), true);
  const key = browserDraftKey("https://s.test/", "doc-1");
  assert.deepEqual(await store.put(rec(key)), { ok: true, evicted: 0 });
  const got = await store.get(key);
  assert.equal(got.docId, "doc-1");
  assert.equal(got.rev, 3);
  assert.equal(got.writerId, "w1");
  assert.equal(JSON.parse(got.stateJson).rows[0].audioText, "mine");
  assert.equal(JSON.parse(got.baseJson).rows[0].audioText, "base");
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.get(browserDraftKey("https://s.test/", "doc-2")), null);
});

test("a null ancestor is the writer's own last one, else NEED_BASE", async () => {
  const store = createIdbDraftStore({ indexedDB: new IDBFactory() });
  const key = browserDraftKey("https://s.test/", "doc-1");
  /* nothing stored yet: the writer has to send it */
  assert.deepEqual(await store.put(rec(key, { baseJson: null })), { ok: false, code: "NEED_BASE" });
  assert.equal(await store.get(key), null);
  await store.put(rec(key));
  /* the same writer, a new edit, the ancestor unchanged */
  assert.equal((await store.put(rec(key, { baseJson: null, stateJson: '{"rows":[],"v":2}' }))).ok, true);
  let got = await store.get(key);
  assert.equal(got.stateJson, '{"rows":[],"v":2}');
  assert.equal(JSON.parse(got.baseJson).rows[0].audioText, "base");
  /* another page's writer may not lean on this one's ancestor */
  assert.deepEqual(await store.put(rec(key, { writerId: "w2", baseJson: null })), { ok: false, code: "NEED_BASE" });
  /* a recovered copy keeps what is stored, whoever wrote it */
  assert.equal((await store.put(rec(key, { writerId: "w2", baseJson: null, stateJson: '{"rows":[],"c":1}' }), { keepBase: true })).ok, true);
  got = await store.get(key);
  assert.equal(got.writerId, "w2");
  assert.equal(JSON.parse(got.baseJson).rows[0].audioText, "base");
  /* and with nothing stored at all, it keeps none rather than asking */
  const other = browserDraftKey("https://s.test/", "doc-9");
  assert.equal((await store.put(rec(other, { baseJson: null }), { keepBase: true })).ok, true);
  assert.equal((await store.get(other)).baseJson, null);
});

test("remove takes only the writer's own draft; claim hands it over", async () => {
  const store = createIdbDraftStore({ indexedDB: new IDBFactory() });
  const key = browserDraftKey("https://s.test/", "doc-1");
  await store.put(rec(key));
  assert.equal(await store.remove(key, "w2"), false);
  assert.ok(await store.get(key));
  assert.equal(await store.claim(key, "w2"), true);
  assert.equal(await store.remove(key, "w1"), false);
  assert.equal(await store.remove(key, "w2"), true);
  assert.equal(await store.get(key), null);
  assert.equal(await store.remove(key, "w2"), false);
  assert.equal(await store.claim(key, "w3"), false);
});

test("eviction runs inside the put; an expired draft is neither read nor listed", async () => {
  let clock = 1000 * DAY;
  const store = createIdbDraftStore({ indexedDB: new IDBFactory(), now: () => clock,
    limits: { maxAgeMs: 30 * DAY, maxCount: 3, maxBytes: 64 * 1024 * 1024 } });
  const keys = ["a", "b", "c", "d"].map((d) => browserDraftKey("https://s.test/", d));
  for (const k of keys) { await store.put(rec(k)); clock += 1000; }
  const listed = (await store.list()).map((m) => m.key);
  assert.deepEqual(listed.sort(), keys.slice(1).sort());
  clock += 31 * DAY;
  assert.equal(await store.get(keys[1]), null);
  assert.deepEqual(await store.list(), []);
  /* the next write sweeps them out for good */
  const e = browserDraftKey("https://s.test/", "e");
  assert.deepEqual(await store.put(rec(e)), { ok: true, evicted: 3 });
  assert.deepEqual((await store.list()).map((m) => m.key), [e]);
});

test("no IndexedDB: every call answers quietly, nothing throws", async () => {
  const none = createIdbDraftStore({ indexedDB: null });
  assert.equal(await none.available(), false);
  assert.deepEqual(await none.put(rec("k")), { ok: false, code: "UNAVAILABLE" });
  assert.equal(await none.get("k"), null);
  assert.deepEqual(await none.list(), []);
  assert.equal(await none.remove("k", "w1"), false);
  const throwing = createIdbDraftStore({ indexedDB: { open() { throw new Error("SecurityError"); } } });
  assert.equal(await throwing.available(), false);
  assert.deepEqual(await throwing.put(rec("k")), { ok: false, code: "UNAVAILABLE" });
  /* an open that errors (Firefox's old private mode) */
  const erroring = createIdbDraftStore({ indexedDB: { open() {
    const req = {};
    setTimeout(() => { req.error = new Error("InvalidStateError"); req.onerror && req.onerror({ preventDefault() {} }); }, 0);
    return req;
  } } });
  assert.deepEqual(await erroring.put(rec("k")), { ok: false, code: "UNAVAILABLE" });
});

test("nothing credential-shaped is added on the way in", async () => {
  const store = createIdbDraftStore({ indexedDB: new IDBFactory() });
  const key = browserDraftKey(draftBaseOf("", PAGE), "doc-1");
  await store.put(rec(key, { base: draftBaseOf("", PAGE), token: "tok-SECRET", linkKey: "SECRETKEY" }));
  const got = await store.get(key);
  assert.ok(!("token" in got) && !("linkKey" in got));
  assert.ok(!/SECRET|invite/.test(JSON.stringify(got)));
});
