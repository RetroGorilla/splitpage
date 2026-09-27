/* desktop/test/history-fs-backend.test.mjs: unit tests for
 * desktop/history-fs-backend.js (issue #83, step 2a).
 *
 * Two halves. The first runs shared/history-store.js — the real store, the
 * one main will run — over this backend on a temp folder: the store's
 * contract (put/get/list/copy/evict/Older/read-only/self-healing) has to
 * hold on disk, across a relaunch, exactly as it does over the memory
 * backend in src/test/history-store.test.mjs. The second drives the backend
 * directly: the two-generation index write, torn index → prev, both torn →
 * .corrupt + empty, the deferred unlink through `trash`, and kills (test
 * hooks that throw) between a body and its index and inside the index write.
 *
 * Node built-ins only, no Electron. Every case works in its own folder under
 * os.tmpdir(); the temp root is removed at the end. Prints ALL PASS and exits
 * 0, or lists the failures and exits 1.
 *
 * Run: node desktop/test/history-fs-backend.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createHistoryFsBackend, FORMAT_VERSION } = require(path.join(here, "..", "history-fs-backend.js"));
const { createHistoryStore } = require(path.join(here, "..", "..", "shared", "history-store.js"));
const { HISTORY_OLDER_KEY, HISTORY_OLDER_TTL_MS, historyUtf8Length } = require(path.join(here, "..", "..", "shared", "history-policy.js"));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-history-fs-test-"));
let caseCounter = 0;
function freshDir() {
  return path.join(ROOT, `case-${++caseCounter}`, "history");
}

const DOC_A = "d" + "a".repeat(32);
const DOC_B = "d" + "b".repeat(32);
const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const meta = (id, atMs, over = {}) => ({ id, atMs, label: "L " + id, title: "T", ...over });
const body = (tag, pad = 0) => JSON.stringify({ rows: [], tag, pad: "x".repeat(pad) });

function killer(label) {
  return () => { throw Object.assign(new Error("killed at " + label), { killed: true }); };
}

/* fsp with injectable faults: fault(method, predicate(firstArg), code, times) */
function faultyFsp() {
  const faults = [];
  const wrapped = new Proxy(fsp, {
    get(target, prop) {
      const orig = target[prop];
      if (typeof orig !== "function") return orig;
      return (...args) => {
        const i = faults.findIndex((f) => f.method === prop && f.when(String(args[0])));
        if (i !== -1) {
          const f = faults[i];
          if (--f.times <= 0) faults.splice(i, 1);
          return Promise.reject(Object.assign(new Error(`injected ${f.code} in ${prop}`), { code: f.code }));
        }
        return orig.apply(target, args);
      };
    }
  });
  return {
    fsp: wrapped,
    fault(method, when, code, times = 1) { faults.push({ method, when, code, times }); },
    clear() { faults.length = 0; }
  };
}

function makeBackend(dir, clock, extra = {}) {
  return createHistoryFsBackend({ dir, fs, fsp, path, crypto, now: () => clock.t, ...extra });
}

function makeStore(backend, clock, extra = {}) {
  return createHistoryStore({
    backend,
    now: () => clock.t,
    hashText: sha,
    maxBodyBytes: 256 * 1024 * 1024,
    ...extra
  });
}

/* A store over a fresh backend on `dir` (a relaunch when dir is reused). */
function launch(dir, opts = {}) {
  const clock = opts.clock || { t: 1_000_000 };
  const backend = makeBackend(dir, clock, opts.backend);
  const store = makeStore(backend, clock, opts.store);
  return { clock, backend, store };
}

async function ids(store, docId) {
  return (await store.list(docId)).entries.map((m) => m.id);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const bodyFile = (backend, text) => backend.bodies.pathFor(sha(text));
const hasBody = (backend, text) => fs.existsSync(bodyFile(backend, text));

function walk(dir) {
  const out = [];
  (function go(d) {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      out.push(path.relative(dir, p));
      if (fs.statSync(p).isDirectory()) go(p);
    }
  })(dir);
  return out.sort();
}

/* Raw backend helpers for the generation tests. */
const entry = (id, atMs, text) => ({ id, atMs, sizeBytes: historyUtf8Length(text), sha: sha(text) });
const rec = (...entries) => ({ title: "", lastOpenedAt: 1, snapshots: entries });
async function commit(backend, puts, changes, dropped = []) {
  return backend.exclusive(async (tx) => {
    for (const text of puts) await tx.put(sha(text), text);
    await tx.commit(changes, dropped);
  });
}

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

/* ================= the store's contract, on disk ================= */

test("store: put / get / list over the fs backend — the layout on disk and 03a's shapes", async () => {
  const dir = freshDir();
  const { store, backend } = launch(dir);
  const r = await store.put(DOC_A, meta("s01", 500), body("one"));
  assert.deepEqual(r, { stored: true, evicted: 0, overCap: false });
  assert.equal(fs.readFileSync(path.join(dir, "FORMAT"), "utf8").trim(), String(FORMAT_VERSION));
  assert.equal(FORMAT_VERSION, 2);
  const idx = readJson(path.join(dir, "index.json"));
  assert.equal(idx.formatVersion, 2);
  assert.deepEqual(idx.trash, []);
  assert.deepEqual(Object.keys(idx.buckets), [DOC_A]);
  assert.equal(idx.buckets[DOC_A].snapshots[0].sha, sha(body("one")));
  assert.equal(fs.readFileSync(bodyFile(backend, body("one")), "utf8"), body("one"),
    "the body is the raw state JSON under bodies/sha256/<aa>/<sha>");
  assert.ok(bodyFile(backend, body("one")).startsWith(path.join(dir, "bodies", "sha256") + path.sep));
  assert.equal(fs.readFileSync(path.join(dir, "bodies", "FORMAT"), "utf8").trim(), "1", "bodies/ is a blob store of its own");
  assert.ok(!fs.existsSync(path.join(dir, "..", "blobs")), "never the image folder");

  const listed = await store.list(DOC_A);
  assert.deepEqual(listed.entries.map((m) => [m.id, m.docId, m.sizeBytes, m.sha]),
    [["s01", DOC_A, historyUtf8Length(body("one")), undefined]]);
  assert.deepEqual(await store.get(DOC_A, "s01").then((g) => g.stateJson), body("one"));
  assert.equal(await store.get(DOC_A, "nope"), null);
  assert.equal(backend.persistent, true);
  assert.equal(backend.readOnly, false);
  assert.equal(store.name, "desktop");
});

test("store: a relaunch reads what the last one wrote", async () => {
  const dir = freshDir();
  const a = launch(dir);
  await a.store.put(DOC_A, meta("s01", 1), body("one"));
  await a.store.put(DOC_A, meta("s02", 2), body("two"));
  await a.store.put(DOC_B, meta("s03", 3), body("three"));
  const b = launch(dir);
  assert.deepEqual(await ids(b.store, DOC_A), ["s02", "s01"]);
  assert.equal((await b.store.get(DOC_B, "s03")).stateJson, body("three"));
  assert.deepEqual((await b.store.listDocs()).map((d) => d.docId), [DOC_A, DOC_B]);
  assert.equal(b.backend.inspect().loadedFrom, "current");
});

test("store: put-if-absent by id, and identical captures share one body file", async () => {
  const { store, backend } = launch(freshDir());
  await store.put(DOC_A, meta("s01", 1), body("same"));
  const commits = backend.counts.commit;
  assert.deepEqual(await store.put(DOC_A, meta("s01", 9), body("other")), { stored: true, evicted: 0, overCap: false, duplicate: true });
  assert.equal(backend.counts.commit, commits, "a duplicate writes nothing");
  await store.put(DOC_A, meta("s02", 2), body("same"));
  await store.put(DOC_B, meta("s03", 3), body("same"));
  assert.deepEqual(await ids(store, DOC_A), ["s02", "s01"]);
  assert.equal((await backend.bodies.list()).length, 1);
  assert.equal((await store.usage()).totalBytes, 3 * historyUtf8Length(body("same")));
});

test("store: trim to 50 — a trimmed body is on disk until the NEXT generation is durable", async () => {
  const { store, backend } = launch(freshDir());
  for (let i = 1; i <= 51; i++) await store.put(DOC_A, meta("s" + String(i).padStart(3, "0"), i), body("n" + i));
  const list = await ids(store, DOC_A);
  assert.equal(list.length, 50);
  assert.equal(list[49], "s002");
  assert.equal(await store.get(DOC_A, "s001"), null);
  assert.ok(hasBody(backend, body("n1")), "dropped in generation N: index.prev.json still names it");
  assert.deepEqual(backend.inspect().index.trash, [sha(body("n1"))]);
  await store.touch(DOC_A, "x");
  assert.ok(!hasBody(backend, body("n1")), "gone once N+1 is durable");
  assert.equal((await backend.bodies.list()).length, 50);
});

test("store: cap eviction, least recently opened first; the evicted bodies go after the next write", async () => {
  const size = historyUtf8Length(body("x0", 100));
  const clock = { t: 1000 };
  const { store, backend } = launch(freshDir(), { clock, store: { capBytes: () => 4 * size } });
  for (let i = 0; i < 3; i++) { clock.t = 1000 + i; await store.put(DOC_A, meta("a0" + i, 100 + i), body("a" + i, 100)); }
  for (let i = 0; i < 2; i++) { clock.t = 5000 + i; await store.put(DOC_B, meta("b0" + i, 100 + i), body("b" + i, 100)); }
  assert.deepEqual(await ids(store, DOC_A), ["a02", "a01"]);
  assert.deepEqual(await ids(store, DOC_B), ["b01", "b00"]);
  assert.ok(hasBody(backend, body("a0", 100)), "still there: index.prev.json names it");
  const ev = await store.evict(3 * size);
  assert.equal(ev.evicted, 1);
  assert.ok(!hasBody(backend, body("a0", 100)), "unlinked once a later generation landed");
  assert.ok(hasBody(backend, body("a1", 100)), "just dropped: waits for the next generation");
  assert.deepEqual(await ids(store, DOC_A), ["a02"]);
});

test("store: copy is index-only; a shared body stays until its last entry goes", async () => {
  const { store, backend, clock } = launch(freshDir());
  await store.put(DOC_A, meta("s01", 10), body("one"));
  await store.put(DOC_A, meta("s02", 20), body("two"));
  const files = walk(path.join(backend.paths.bodies));
  clock.t = 2_000_000;
  assert.deepEqual(await store.copy(DOC_A, DOC_B), { ok: true, copied: 2 });
  assert.deepEqual(walk(backend.paths.bodies), files, "no body written");
  assert.deepEqual(await ids(store, DOC_B), ["s02", "s01"]);
  assert.equal((await store.get(DOC_B, "s01")).stateJson, body("one"));
  await store.evict(historyUtf8Length(body("one")) * 3);
  assert.deepEqual(await ids(store, DOC_A), ["s02"]);
  await store.touch(DOC_A, "t");
  assert.ok(hasBody(backend, body("one")), "B still names it");
  await store.evict(0);
  await store.touch(DOC_A, "t");
  assert.ok(!hasBody(backend, body("one")), "last entry gone, then one more generation: unlinked");
});

test("store: importOlder and put {older:true}; Older round-trips a relaunch", async () => {
  const dir = freshDir();
  const { store } = launch(dir, { clock: { t: 50_000 } });
  assert.deepEqual(await store.importOlder([
    { meta: meta("l01", 300, { kind: "legacy" }), stateJson: body("l1") },
    { meta: meta("l02", 100, { kind: "legacy" }), stateJson: body("l2") }
  ]), { ok: true, count: 2, added: 2 });
  assert.deepEqual(await store.put(null, meta("o01", 5), body("o"), { older: true }), { stored: true, evicted: 0, overCap: false });
  const b = launch(dir, { clock: { t: 60_000 } });
  const listed = await b.store.list(null);
  assert.deepEqual(listed.older.map((m) => m.id), ["l01", "l02", "o01"]);
  assert.equal(listed.olderExpiresAt, 50_000 + HISTORY_OLDER_TTL_MS);
  assert.equal((await b.store.get(HISTORY_OLDER_KEY, "l02")).stateJson, body("l2"));
});

test("store: a body deleted behind the store's back → get null, the entry drops out (no fsck)", async () => {
  const dir = freshDir();
  const { store, backend } = launch(dir);
  await store.put(DOC_A, meta("s01", 1), body("one"));
  await store.put(DOC_A, meta("s02", 2), body("two"));
  fs.unlinkSync(bodyFile(backend, body("one")));
  assert.equal(await store.get(DOC_A, "s01"), null);
  assert.deepEqual(await ids(store, DOC_A), ["s02"]);
  assert.deepEqual(readJson(path.join(dir, "index.json")).buckets[DOC_A].snapshots.map((s) => s.id), ["s02"]);
});

test("store: a body that is there but unreadable is an error, never 'missing' — a lock must not delete history", async () => {
  const dir = freshDir();
  const f = faultyFsp();
  const { store, backend } = launch(dir, { backend: { fsp: f.fsp } });
  await store.put(DOC_A, meta("s01", 1), body("one"));
  const file = bodyFile(backend, body("one"));
  f.fault("readFile", (p) => p === file, "EBUSY");
  await assert.rejects(store.get(DOC_A, "s01"), (e) => e.code === "io");
  assert.deepEqual(await ids(store, DOC_A), ["s01"], "still listed");
  assert.equal((await store.get(DOC_A, "s01")).stateJson, body("one"));
});

test("store: a full disk on the body answers 'enospc', the index is untouched", async () => {
  const dir = freshDir();
  const f = faultyFsp();
  const { store, backend } = launch(dir, { backend: { fsp: f.fsp } });
  await store.put(DOC_A, meta("s01", 1), body("one"));
  const before = fs.readFileSync(path.join(dir, "index.json"), "utf8");
  f.fault("open", (p) => p.includes(path.join("bodies", "sha256")), "ENOSPC", Infinity);
  const r = await store.put(DOC_A, meta("s02", 2), body("two"));
  assert.equal(r.stored, false);
  assert.equal(r.code, "enospc");
  assert.equal(fs.readFileSync(path.join(dir, "index.json"), "utf8"), before);
  assert.ok(!hasBody(backend, body("two")));
  f.clear();
});

test("store: FORMAT 3 → read-only: reads work, every write answers 'read-only', nothing is written", async () => {
  const dir = freshDir();
  const a = launch(dir);
  await a.store.put(DOC_A, meta("s01", 1), body("one"));
  fs.writeFileSync(path.join(dir, "FORMAT"), "3\n");
  const before = walk(dir);
  const indexText = fs.readFileSync(path.join(dir, "index.json"), "utf8");
  const b = launch(dir);
  assert.equal((await b.store.get(DOC_A, "s01")).stateJson, body("one"));
  assert.equal(b.store.readOnly, true);
  assert.deepEqual(await b.store.put(DOC_A, meta("s02", 2), body("two")), { stored: false, code: "read-only" });
  assert.deepEqual(await b.store.copy(DOC_A, DOC_B), { ok: false, copied: 0, code: "read-only" });
  await b.store.touch(DOC_A, "renamed");
  assert.equal((await b.store.usage()).readOnly, true);
  assert.deepEqual(walk(dir), before);
  assert.equal(fs.readFileSync(path.join(dir, "index.json"), "utf8"), indexText);
  assert.equal(fs.readFileSync(path.join(dir, "FORMAT"), "utf8"), "3\n");
});

test("store: an index.json whose formatVersion is newer is read-only too", async () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "FORMAT"), "2\n");
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ formatVersion: 3, buckets: {}, trash: [] }));
  const { store } = launch(dir);
  assert.deepEqual(await store.put(DOC_A, meta("s01", 1), body("one")), { stored: false, code: "read-only" });
});

/* ================= the backend itself ================= */

test("FORMAT: written \"2\" on a fresh folder; an unreadable one is treated as ours", async () => {
  const dir = freshDir();
  const b = launch(dir).backend;
  await b.open();
  assert.equal(fs.readFileSync(path.join(dir, "FORMAT"), "utf8"), "2\n");
  assert.deepEqual(walk(dir), ["FORMAT", "bodies", path.join("bodies", "FORMAT"), path.join("bodies", "sha256")],
    "no index.json until the first commit, no temp files");
  const dir2 = freshDir();
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, "FORMAT"), "garbage");
  const r = await launch(dir2).backend.open();
  assert.equal(r.readOnly, false);
  assert.equal(fs.readFileSync(path.join(dir2, "FORMAT"), "utf8"), "2\n");
});

test("two generations: each commit rotates index.json into index.prev.json", async () => {
  const dir = freshDir();
  const { backend } = launch(dir);
  await commit(backend, ["g1"], { [DOC_A]: rec(entry("s01", 1, "g1")) });
  assert.ok(!fs.existsSync(path.join(dir, "index.prev.json")), "first generation: nothing to rotate");
  const g1 = fs.readFileSync(path.join(dir, "index.json"), "utf8");
  await commit(backend, ["g2"], { [DOC_A]: rec(entry("s01", 1, "g1"), entry("s02", 2, "g2")) });
  assert.equal(fs.readFileSync(path.join(dir, "index.prev.json"), "utf8"), g1);
  const g2 = fs.readFileSync(path.join(dir, "index.json"), "utf8");
  await commit(backend, [], { [DOC_B]: rec(entry("s03", 3, "g1")) });
  assert.equal(fs.readFileSync(path.join(dir, "index.prev.json"), "utf8"), g2);
  assert.deepEqual(Object.keys(readJson(path.join(dir, "index.json")).buckets).sort(), [DOC_A, DOC_B]);
  assert.deepEqual(walk(dir).filter((n) => n.startsWith(".tmp-")), [], "no temp file survives a commit");
});

test("torn index.json → the previous generation is loaded, the torn one moved aside (never deleted)", async () => {
  const dir = freshDir();
  const clock = { t: 77_000 };
  const a = launch(dir, { clock });
  await a.store.put(DOC_A, meta("s01", 1), body("one"));
  await a.store.put(DOC_A, meta("s02", 2), body("two"));
  const current = fs.readFileSync(path.join(dir, "index.json"), "utf8");
  fs.writeFileSync(path.join(dir, "index.json"), current.slice(0, Math.floor(current.length / 2)));

  const b = launch(dir, { clock });
  assert.deepEqual(await ids(b.store, DOC_A), ["s01"], "the generation before the torn one");
  assert.equal(b.backend.inspect().loadedFrom, "prev");
  assert.equal((await b.store.get(DOC_A, "s01")).stateJson, body("one"));
  assert.equal(fs.readFileSync(path.join(dir, "index.json.corrupt-77000"), "utf8"), current.slice(0, Math.floor(current.length / 2)));
  assert.ok(!fs.existsSync(path.join(dir, "index.json")));
  const prev = fs.readFileSync(path.join(dir, "index.prev.json"), "utf8");
  /* the next commit must not rotate anything torn over the good prev */
  await b.store.put(DOC_A, meta("s03", 3), body("three"));
  assert.equal(fs.readFileSync(path.join(dir, "index.prev.json"), "utf8"), prev);
  assert.deepEqual(await ids(launch(dir, { clock }).store, DOC_A), ["s03", "s01"]);
});

test("both generations torn → both moved to *.corrupt-<ts>, history starts empty and works", async () => {
  const dir = freshDir();
  const clock = { t: 88_000 };
  const a = launch(dir, { clock });
  await a.store.put(DOC_A, meta("s01", 1), body("one"));
  await a.store.put(DOC_A, meta("s02", 2), body("two"));
  fs.writeFileSync(path.join(dir, "index.json"), "{\"formatVersion\":2,\"buck");
  fs.writeFileSync(path.join(dir, "index.prev.json"), "null");
  const b = launch(dir, { clock });
  assert.deepEqual(await b.store.list(DOC_A), { entries: [], older: [], olderExpiresAt: null });
  assert.equal(b.backend.inspect().loadedFrom, "empty");
  assert.ok(fs.existsSync(path.join(dir, "index.json.corrupt-88000")));
  assert.ok(fs.existsSync(path.join(dir, "index.prev.json.corrupt-88000")));
  assert.equal(await b.store.put(DOC_B, meta("s09", 9), body("nine")).then((r) => r.stored), true);
  assert.deepEqual(await ids(launch(dir, { clock }).store, DOC_B), ["s09"]);
});

test("a kill between a body and its index: the prior generation is readable, no error, and the next put works", async () => {
  const dir = freshDir();
  const a = launch(dir);
  await a.store.put(DOC_A, meta("s01", 1), body("one"));
  const indexText = fs.readFileSync(path.join(dir, "index.json"), "utf8");
  const k = launch(dir, { backend: { testHooks: { afterBodyPut: killer("afterBodyPut") } } });
  const r = await k.store.put(DOC_A, meta("s02", 2), body("two"));
  assert.equal(r.stored, false, "the killed write did not report success");
  assert.equal(k.backend.state, "dead");
  assert.ok(hasBody(k.backend, body("two")), "the body is on disk");
  assert.equal(fs.readFileSync(path.join(dir, "index.json"), "utf8"), indexText, "the index is not");

  const b = launch(dir);
  assert.deepEqual(await ids(b.store, DOC_A), ["s01"]);
  assert.equal((await b.store.get(DOC_A, "s01")).stateJson, body("one"));
  assert.equal(b.backend.openError, null);
  /* the same capture retried after the relaunch lands, reusing the body */
  assert.equal((await b.store.put(DOC_A, meta("s02", 2), body("two"))).stored, true);
  assert.equal((await b.store.get(DOC_A, "s02")).stateJson, body("two"));
});

test("a kill after the index temp file is fsynced: the old index.json stands, the temp is swept", async () => {
  const dir = freshDir();
  const a = launch(dir);
  await a.store.put(DOC_A, meta("s01", 1), body("one"));
  const k = launch(dir, { backend: { testHooks: { afterIndexTmp: killer("afterIndexTmp") } } });
  await k.store.put(DOC_A, meta("s02", 2), body("two"));
  assert.equal(walk(dir).filter((n) => n.startsWith(".tmp-")).length, 1, "a kill leaves its temp file");
  const b = launch(dir);
  assert.deepEqual(await ids(b.store, DOC_A), ["s01"]);
  assert.equal(b.backend.inspect().loadedFrom, "current");
  assert.deepEqual(walk(dir).filter((n) => n.startsWith(".tmp-")), [], "swept by open()");
});

test("a kill between the two renames: no index.json, index.prev.json is loaded", async () => {
  const dir = freshDir();
  const a = launch(dir);
  await a.store.put(DOC_A, meta("s01", 1), body("one"));
  const k = launch(dir, { backend: { testHooks: { afterIndexRotate: killer("afterIndexRotate") } } });
  await k.store.put(DOC_A, meta("s02", 2), body("two"));
  assert.ok(!fs.existsSync(path.join(dir, "index.json")));
  const b = launch(dir);
  assert.deepEqual(await ids(b.store, DOC_A), ["s01"]);
  assert.equal(b.backend.inspect().loadedFrom, "prev");
  await b.store.put(DOC_A, meta("s03", 3), body("three"));
  assert.deepEqual(await ids(launch(dir).store, DOC_A), ["s03", "s01"]);
});

test("trash: a body dropped in generation N survives until N+1 is durable (prev still names it)", async () => {
  const dir = freshDir();
  const { backend } = launch(dir);
  const eX = entry("s01", 1, "X"), eY = entry("s02", 2, "Y");
  await commit(backend, ["X", "Y"], { [DOC_A]: rec(eX, eY) });                 /* N-1 */
  await commit(backend, [], { [DOC_A]: rec(eY) }, [sha("X")]);                 /* N: drops X */
  assert.deepEqual(readJson(path.join(dir, "index.json")).trash, [sha("X")]);
  assert.ok(hasBody(backend, "X"), "N is durable but N-1 (prev) names X");

  /* the reason: tear N now, and N-1 comes back — with X readable */
  const copy = path.join(path.dirname(dir), "copy");
  fs.cpSync(dir, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, "index.json"), "{");
  const c = launch(copy);
  assert.deepEqual(await ids(c.store, DOC_A), ["s02", "s01"]);
  assert.equal((await c.store.get(DOC_A, "s01")).stateJson, "X");

  await commit(backend, [], { [DOC_B]: rec(eY) });                              /* N+1 */
  assert.ok(!hasBody(backend, "X"), "N+1 is durable and does not name X: unlinked");
  assert.deepEqual(readJson(path.join(dir, "index.json")).trash, [sha("X")],
    "listed once more until the unlink is known to have happened");
  await commit(backend, [], { [DOC_B]: null });                                 /* N+2 */
  assert.deepEqual(readJson(path.join(dir, "index.json")).trash, []);
  assert.ok(hasBody(backend, "Y"));
  assert.equal(backend.counts.unlinked, 1);
});

test("trash: a body named again in N+1 is not unlinked", async () => {
  const { backend } = launch(freshDir());
  await commit(backend, ["X"], { [DOC_A]: rec(entry("s01", 1, "X")) });
  await commit(backend, [], { [DOC_A]: null }, [sha("X")]);
  await commit(backend, ["X"], { [DOC_B]: rec(entry("s05", 5, "X")) });        /* the same content came back */
  await commit(backend, [], { [DOC_B]: rec(entry("s05", 5, "X"), entry("s06", 6, "X")) });
  assert.ok(hasBody(backend, "X"));
  assert.deepEqual(backend.inspect().index.trash, []);
});

test("trash: a kill after the index and before the unlink leaves X listed; the next commit finishes it", async () => {
  const dir = freshDir();
  const a = launch(dir);
  await commit(a.backend, ["X", "Y"], { [DOC_A]: rec(entry("s01", 1, "X"), entry("s02", 2, "Y")) });
  await commit(a.backend, [], { [DOC_A]: rec(entry("s02", 2, "Y")) }, [sha("X")]);
  const k = launch(dir, { backend: { testHooks: { beforeUnlink: killer("beforeUnlink") } } });
  await assert.rejects(commit(k.backend, [], { [DOC_B]: rec(entry("s02", 2, "Y")) }), /killed/);
  assert.ok(hasBody(k.backend, "X"));
  assert.deepEqual(readJson(path.join(dir, "index.json")).trash, [sha("X")]);
  const b = launch(dir);
  await commit(b.backend, [], { [DOC_B]: null });
  assert.ok(!hasBody(b.backend, "X"));
});

test("trash: a body a failed job wrote (never named) joins the next commit's trash and goes after the one after", async () => {
  const dir = freshDir();
  const f = faultyFsp();
  const { backend } = launch(dir, { backend: { fsp: f.fsp } });
  await commit(backend, ["Y"], { [DOC_A]: rec(entry("s02", 2, "Y")) });
  f.fault("open", (p) => path.basename(p).startsWith(".tmp-") && p.endsWith("index.json"), "EIO");
  await assert.rejects(commit(backend, ["Z"], { [DOC_A]: rec(entry("s02", 2, "Y"), entry("s03", 3, "Z")) }), (e) => e.code === "EIO");
  assert.ok(hasBody(backend, "Z"), "the body stays until it is safe to go");
  assert.deepEqual(backend.inspect().orphans, [sha("Z")]);
  await commit(backend, [], { [DOC_B]: rec(entry("s02", 2, "Y")) });
  assert.deepEqual(backend.inspect().index.trash, [sha("Z")]);
  assert.ok(hasBody(backend, "Z"));
  await commit(backend, [], { [DOC_B]: null });
  assert.ok(!hasBody(backend, "Z"));
});

test("exclusive: jobs never interleave; a read job cannot write; a tx dies with its job", async () => {
  const { backend } = launch(freshDir());
  const order = [];
  const slow = backend.exclusive(async (tx) => { order.push("a1"); await tx.list(); await tx.list(); order.push("a2"); });
  const fast = backend.exclusive(async (tx) => { order.push("b1"); await tx.list(); order.push("b2"); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["a1", "a2", "b1", "b2"]);
  await assert.rejects(backend.exclusive((tx) => tx.put(sha("X"), "X"), { write: false }), /read-only job/);
  await assert.rejects(backend.exclusive((tx) => tx.commit({}, []), { write: false }), /read-only job/);
  let leaked;
  await backend.exclusive(async (tx) => { leaked = tx; });
  await assert.rejects(leaked.list(), /after its job finished/);
  await assert.rejects(backend.exclusive(async (tx) => { await tx.commit({}, []); await tx.commit({}, []); }), /twice/);
});

/* #100: the v1 migrator is gone. A folder still in the v1 layout (someone
   who skipped 3.0.0) opens as an empty history and v1's docs/ and older/
   stay exactly as they were — through puts, an eviction that unlinks
   bodies, a relaunch and a torn index — even a v1 file named like one of
   this backend's temp files. */
test("a raw v1 tree: opened as an empty history; docs/ and older/ never touched", async () => {
  const dir = freshDir();
  const v1 = {
    [`docs/d-${DOC_A.slice(1)}/index.json`]: JSON.stringify({ formatVersion: 1, title: "Alpha", snapshots: [] }),
    [`docs/d-${DOC_A.slice(1)}/s-a01.snap`]: "splitpage-snapshot 1\n{\"id\":\"a01\",\"atMs\":1}\n{\"rows\":[]}",
    [`docs/d-${DOC_A.slice(1)}/.tmp-left-by-v1`]: "not ours",
    "older/index.json": JSON.stringify({ formatVersion: 1, expiresAt: 0, snapshots: [] }),
    "older/s-o01.snap": "splitpage-snapshot 1\n{\"id\":\"o01\",\"atMs\":2}\n{}"
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "FORMAT"), "1\n");
  for (const [rel, text] of Object.entries(v1)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const v1Tree = () => {
    const out = {};
    for (const top of ["docs", "older"]) {
      for (const rel of walk(path.join(dir, top))) {
        const p = path.join(dir, top, rel);
        out[top + "/" + rel.split(path.sep).join("/")] = fs.statSync(p).isDirectory() ? "<dir>" : fs.readFileSync(p, "utf8");
      }
    }
    return out;
  };
  const before = v1Tree();
  assert.equal(Object.values(before).filter((v) => v !== "<dir>").length, 5);

  const cap = { bytes: 1e9 };
  const a = launch(dir, { store: { capBytes: () => cap.bytes } });
  assert.deepEqual(await a.store.list(DOC_A), { entries: [], older: [], olderExpiresAt: null });
  assert.equal(a.backend.inspect().loadedFrom, "empty");
  assert.equal(a.backend.readOnly, false);
  assert.equal(fs.readFileSync(path.join(dir, "FORMAT"), "utf8").trim(), String(FORMAT_VERSION));
  for (let i = 1; i <= 4; i++) {
    a.clock.t += 1000;
    assert.equal((await a.store.put(DOC_A, meta("s0" + i, a.clock.t), body("v" + i, 400))).stored, true);
  }
  /* an eviction: shas go into trash and are unlinked a generation later */
  cap.bytes = 1000;
  a.clock.t += 1000;
  const r = await a.store.put(DOC_B, meta("b01", a.clock.t), body("b", 400));
  assert.ok(r.evicted > 0, JSON.stringify(r));
  await a.store.put(DOC_B, meta("b02", a.clock.t + 1), body("b2", 10));
  assert.ok(a.backend.counts.unlinked > 0);
  assert.deepEqual(v1Tree(), before);

  /* relaunch over a torn index.json: it is moved aside, prev loads */
  fs.writeFileSync(path.join(dir, "index.json"), "{\"formatVersion\":2,\"buck");
  const b = launch(dir, { store: { capBytes: () => cap.bytes } });
  assert.ok((await ids(b.store, DOC_B)).length > 0);
  assert.equal(b.backend.inspect().loadedFrom, "prev");
  assert.deepEqual(v1Tree(), before);
  const idx = readJson(path.join(dir, "index.prev.json"));
  assert.equal(idx.migratedFrom, undefined, "no migration happened, so none is recorded");
  assert.ok(fs.readdirSync(dir).includes("docs") && fs.readdirSync(dir).includes("older"));
});

/* ------------------------------------------------------------------ */

const failures = [];
for (const c of cases) {
  try {
    await c.fn();
    console.log(`ok   - ${c.name}`);
  } catch (err) {
    failures.push(c.name);
    console.log(`FAIL - ${c.name}\n       ${String((err && err.stack) || err).split("\n").slice(0, 8).join("\n       ")}`);
  }
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }

if (failures.length) {
  console.log(`\n${failures.length} FAILED of ${cases.length}`);
  process.exit(1);
}
console.log(`\nALL PASS (${cases.length} cases)`);
