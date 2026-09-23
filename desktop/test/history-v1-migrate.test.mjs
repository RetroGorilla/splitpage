/* desktop/test/history-v1-migrate.test.mjs: unit tests for
 * desktop/history-v1-migrate.js (issue #83, step 2a) — the one-time move of
 * desktop history from v1's docs/ + older/ folders to v2's index.json +
 * bodies/.
 *
 * The fixture is written in the REAL v1 format (desktop/main.js §8b before
 * #83: the "splitpage-snapshot 1" magic line, the meta JSON line, the state
 * JSON verbatim; per-bucket index.json files), with everything a real
 * profile can hold after years of crashes: a broken per-doc index.json, an
 * orphan .snap no index lists, an index entry whose .snap is gone, a .snap
 * truncated in its body and one truncated in its header, a *.snap.corrupt
 * left by v1's fsck, a stray temp file, a folder whose name is not a doc id,
 * and an Older bucket that was never stamped (expiresAt 0).
 *
 * The migration runs the way main will run it: as the migrate hook of
 * desktop/history-fs-backend.js, read back through shared/history-store.js.
 * Kills are test hooks that throw — the run stops there, nothing is cleaned
 * up, and a new backend on the same folder is the relaunch. After every
 * kill: nothing of v1 is lost (it is either where it was or whole in
 * v1-backup/); after the rerun: the folder is byte-for-byte the folder an
 * uninterrupted migration leaves.
 *
 * Node built-ins only, no Electron. Prints ALL PASS and exits 0, or lists
 * the failures and exits 1.
 *
 * Run: node desktop/test/history-v1-migrate.test.mjs
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
const { createHistoryFsBackend } = require(path.join(here, "..", "history-fs-backend.js"));
const { migrateHistoryV1, parseV1Snap, BACKUP_DIR } = require(path.join(here, "..", "history-v1-migrate.js"));
const { createHistoryStore } = require(path.join(here, "..", "..", "shared", "history-store.js"));
const policy = require(path.join(here, "..", "..", "shared", "history-policy.js"));
const { DOC_ID_RE } = require(path.join(here, "..", "..", "shared", "doc-id-policy.js"));
const { HISTORY_OLDER_KEY, HISTORY_OLDER_TTL_MS, sanitizeHistoryMeta } = policy;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-history-v1-test-"));
let caseCounter = 0;
function freshDir() {
  return path.join(ROOT, `case-${++caseCounter}`, "history");
}

const T0 = 1_700_000_000_000;
const DOC_A = "d" + "a".repeat(32);
const DOC_B = "d" + "b".repeat(32);
const DOC_C = "d" + "c".repeat(32);
const DOC_D = "d" + "d".repeat(32);
const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const state = (tag) => JSON.stringify({ rows: [{ id: "r1", text: "ünïcödé " + tag }], tag });

/* ---- the v1 writer, as desktop/main.js §8b wrote it ---- */

function v1Meta(id, atMs, over = {}) {
  const m = sanitizeHistoryMeta({ id, atMs, label: "L " + id, title: "", by: "me", rows: 1, ...over });
  return m;
}
function v1SnapText(meta, stateJson) {
  return "splitpage-snapshot 1\n" + JSON.stringify(meta) + "\n" + stateJson;
}
function writeSnap(folder, meta, stateJson) {
  meta.sizeBytes = Buffer.byteLength(stateJson, "utf8");
  const text = v1SnapText(meta, stateJson);
  fs.writeFileSync(path.join(folder, "s-" + meta.id + ".snap"), text);
  return Object.assign({}, meta, { diskBytes: Buffer.byteLength(text) });
}
function writeDocIndex(folder, docId, title, lastOpenedAt, listed) {
  fs.writeFileSync(path.join(folder, "index.json"), JSON.stringify({
    formatVersion: 1, docId, title, lastOpenedAt,
    bytes: listed.reduce((n, m) => n + m.sizeBytes, 0), snapshots: listed
  }));
}

/* The fixture. Returns what a correct migration must produce. */
function buildV1(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "FORMAT"), "1\n");
  const docs = path.join(dir, "docs");

  /* A: healthy, three snapshots, plus a stray v1 temp file */
  const a = path.join(docs, "d-" + DOC_A);
  fs.mkdirSync(a, { recursive: true });
  const aList = [
    writeSnap(a, v1Meta("a01", 1000, { title: "Alpha 1" }), state("a1")),
    writeSnap(a, v1Meta("a02", 2000, { title: "Alpha 2" }), state("a2")),
    writeSnap(a, v1Meta("a03", 3000, { title: "Alpha" }), state("a3"))
  ];
  writeDocIndex(a, DOC_A, "Alpha", 5000, aList);
  fs.writeFileSync(path.join(a, ".index.json.tmp-0123456789ab"), "{half");

  /* B: a broken index.json; b02's body is a01's (one body file for both) */
  const b = path.join(docs, "d-" + DOC_B);
  fs.mkdirSync(b, { recursive: true });
  writeSnap(b, v1Meta("b01", 1500, { title: "" }), state("b1"));
  writeSnap(b, v1Meta("b02", 2500, { title: "Beta" }), state("a1"));
  fs.writeFileSync(path.join(b, "index.json"), "{\"formatVersion\":1,\"docId\":\"" + DOC_B + "\",\"tit");

  /* C: index lists c01 and c03 (c03's .snap is gone); c02 is an orphan;
     c04 is truncated in its body, c05 in its header; a v1 .corrupt file */
  const c = path.join(docs, "d-" + DOC_C);
  fs.mkdirSync(c, { recursive: true });
  const c01 = writeSnap(c, v1Meta("c01", 100, { title: "Gamma" }), state("c1"));
  writeSnap(c, v1Meta("c02", 200, { title: "Gamma 2" }), state("c2"));
  const c03 = Object.assign(v1Meta("c03", 300), { sizeBytes: 10, diskBytes: 50 });
  writeDocIndex(c, DOC_C, "Gamma", 9000, [c01, c03]);
  const c04 = v1Meta("c04", 400);
  c04.sizeBytes = Buffer.byteLength(state("c4"));
  fs.writeFileSync(path.join(c, "s-c04.snap"), v1SnapText(c04, state("c4")).slice(0, -7));
  fs.writeFileSync(path.join(c, "s-c05.snap"), "splitpage-snapshot 1\n{\"id\":\"c05\",\"at");
  fs.writeFileSync(path.join(c, "s-c06.snap.corrupt"), "garbage");

  /* D: nothing readable → no bucket at all */
  const d = path.join(docs, "d-" + DOC_D);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "s-d01.snap"), "not a snapshot\n");

  /* a folder that is not a doc id: left alone (it travels into the backup) */
  const junk = path.join(docs, "d-NOT-A-DOC");
  fs.mkdirSync(junk, { recursive: true });
  writeSnap(junk, v1Meta("x01", 1), state("x1"));

  /* Older: never stamped (a v1 crash between its bodies and its index) */
  const older = path.join(dir, "older");
  fs.mkdirSync(older, { recursive: true });
  const oList = [
    writeSnap(older, v1Meta("o01", 10, { kind: "legacy", legacyId: "k1" }), state("o1")),
    writeSnap(older, v1Meta("o02", 20, { kind: "legacy", legacyId: "k2" }), state("o2"))
  ];
  fs.writeFileSync(path.join(older, "index.json"), JSON.stringify({
    formatVersion: 1, migratedAt: 0, expiresAt: 0, bytes: 0, snapshots: oList
  }));

  return {
    [DOC_A]: { title: "Alpha", lastOpenedAt: 5000, ids: ["a03", "a02", "a01"], bodies: { a01: state("a1"), a02: state("a2"), a03: state("a3") } },
    [DOC_B]: { title: "Beta", lastOpenedAt: 2500, ids: ["b02", "b01"], bodies: { b01: state("b1"), b02: state("a1") } },
    [DOC_C]: { title: "Gamma", lastOpenedAt: 9000, ids: ["c02", "c01"], bodies: { c01: state("c1"), c02: state("c2") } }
  };
}
/* distinct bodies: a1 a2 a3 b1 c1 c2 o1 o2 */
const BODY_COUNT = 8;

/* ---- folder snapshots ---- */

function tree(dir) {
  const out = {};
  (function go(d) {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      const p = path.join(d, n);
      const rel = path.relative(dir, p).split(path.sep).join("/");
      if (fs.statSync(p).isDirectory()) { out[rel + "/"] = ""; go(p); }
      else out[rel] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  })(dir);
  return out;
}

/* v1's files wherever they are now: at the root, or moved into the backup. */
function v1Files(dir) {
  const out = {};
  for (const name of ["docs", "older"]) {
    const live = path.join(dir, name);
    const backed = path.join(dir, BACKUP_DIR, name);
    const src = fs.existsSync(live) ? live : backed;
    for (const [rel, h] of Object.entries(tree(src))) out[name + "/" + rel] = h;
  }
  return out;
}

/* ---- launching ---- */

function launch(dir, opts = {}) {
  const clock = { t: opts.t ?? T0 };
  const backend = createHistoryFsBackend({
    dir, fs, fsp: opts.fsp || fsp, path, crypto, now: () => clock.t,
    testHooks: opts.backendHooks,
    migrate: (api) => migrateHistoryV1(api, { policy, DOC_ID_RE, testHooks: opts.hooks })
  });
  const store = createHistoryStore({ backend, now: () => clock.t, hashText: sha, maxBodyBytes: 256 * 1024 * 1024 });
  return { clock, backend, store };
}

function killer(label) {
  return () => { throw Object.assign(new Error("killed at " + label), { killed: true }); };
}

async function assertMigrated(dir, expected) {
  const { store, backend } = launch(dir);
  for (const [docId, want] of Object.entries(expected)) {
    const listed = await store.list(docId);
    assert.deepEqual(listed.entries.map((m) => m.id), want.ids, docId + " ids");
    for (const [id, text] of Object.entries(want.bodies)) {
      const got = await store.get(docId, id);
      assert.equal(got && got.stateJson, text, docId + "/" + id + " body");
    }
  }
  const docs = await store.listDocs();
  assert.deepEqual(docs.map((d) => [d.docId, d.title, d.lastOpenedAt]),
    Object.entries(expected).map(([id, w]) => [id, w.title, w.lastOpenedAt]));
  const older = await store.list(null);
  assert.deepEqual(older.older.map((m) => [m.id, m.kind, m.legacyId]), [["o02", "legacy", "k2"], ["o01", "legacy", "k1"]]);
  assert.equal(older.olderExpiresAt, T0 + HISTORY_OLDER_TTL_MS, "an unstamped Older bucket gets its 90 days from the migration");
  assert.equal((await store.get(HISTORY_OLDER_KEY, "o01")).stateJson, state("o1"));
  assert.equal(fs.readFileSync(path.join(dir, "FORMAT"), "utf8"), "2\n");
  assert.ok(!fs.existsSync(path.join(dir, "docs")) && !fs.existsSync(path.join(dir, "older")));
  assert.equal((await backend.bodies.list()).length, BODY_COUNT);
  return { store, backend };
}

/* The reference: one uninterrupted migration of the fixture. */
let REFERENCE = null;
async function reference() {
  if (REFERENCE) return REFERENCE;
  const dir = freshDir();
  const expected = buildV1(dir);
  const original = v1Files(dir);
  const { backend } = launch(dir);
  const r = await backend.open();
  REFERENCE = { dir, expected, original, tree: tree(dir), result: r.migrated };
  return REFERENCE;
}

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

/* ------------------------------------------------------------------ */

test("parseV1Snap: header meta, body after the second newline, truncation refused", () => {
  const m = v1Meta("s01", 5);
  m.sizeBytes = Buffer.byteLength(state("x"));
  const text = v1SnapText(m, state("x"));
  const p = parseV1Snap(text, sanitizeHistoryMeta);
  assert.equal(p.body, state("x"));
  assert.equal(p.meta.id, "s01");
  assert.equal(parseV1Snap(text.slice(0, -1), sanitizeHistoryMeta), null, "body shorter than sizeBytes");
  assert.equal(parseV1Snap("splitpage-snapshot 1\n{\"id\":\"s01\"", sanitizeHistoryMeta), null, "no second newline");
  assert.equal(parseV1Snap("splitpage-snapshot 2\n{}\n{}", sanitizeHistoryMeta), null, "not our magic");
  assert.equal(parseV1Snap("splitpage-snapshot 1\n{\"id\":\"BAD\"}\n{}", sanitizeHistoryMeta), null, "meta refused by the policy");
  const noSize = "splitpage-snapshot 1\n" + JSON.stringify({ id: "s02", atMs: 1 }) + "\n";
  assert.equal(parseV1Snap(noSize + "{\"rows\":[]}", sanitizeHistoryMeta).body, "{\"rows\":[]}", "no sizeBytes: whole JSON passes");
  assert.equal(parseV1Snap(noSize + "{\"rows\":[", sanitizeHistoryMeta), null, "no sizeBytes: torn JSON does not");
  const nl = "splitpage-snapshot 1\n" + JSON.stringify(Object.assign(v1Meta("s03", 1), { sizeBytes: 5 })) + "\na\nb\nc";
  assert.equal(parseV1Snap(nl, sanitizeHistoryMeta).body, "a\nb\nc", "newlines in the body are the body's");
});

test("migration: every readable snapshot lands, readable through the store; v1 moved whole into v1-backup/", async () => {
  const ref = await reference();
  assert.equal(ref.result.state, "migrated");
  assert.equal(ref.result.buckets, 4);
  assert.equal(ref.result.snapshots, 9);
  assert.deepEqual(ref.result.skipped.sort(), [
    "docs/d-" + DOC_C + "/s-c04.snap",
    "docs/d-" + DOC_C + "/s-c05.snap",
    "docs/d-" + DOC_D + "/s-d01.snap"
  ]);
  assert.deepEqual(ref.result.moved, ["docs", "older"]);
  await assertMigrated(ref.dir, ref.expected);
  assert.deepEqual(v1Files(ref.dir), ref.original, "every v1 file is in the backup, unchanged — skipped ones included");
  const idx = JSON.parse(fs.readFileSync(path.join(ref.dir, "index.json"), "utf8"));
  assert.equal(idx.migratedFrom, 1);
  assert.equal(idx.formatVersion, 2);
  assert.deepEqual(idx.trash, []);
  assert.equal(idx.buckets[DOC_B].snapshots.find((s) => s.id === "b02").sha,
    idx.buckets[DOC_A].snapshots.find((s) => s.id === "a01").sha, "one body for identical content");
  assert.equal(idx.buckets[HISTORY_OLDER_KEY].migratedAt, T0);
  assert.equal(idx.buckets[DOC_C].snapshots.find((s) => s.id === "c03"), undefined, "an index entry with no .snap is not migrated");
});

test("migration: a relaunch after it is a no-op, and later writes keep migratedFrom", async () => {
  const ref = await reference();
  const dir = freshDir();
  fs.cpSync(ref.dir, dir, { recursive: true });
  const { backend, store } = launch(dir);
  const r = await backend.open();
  assert.deepEqual(r.migrated, { state: "none" });
  assert.deepEqual(tree(dir), ref.tree);
  assert.equal((await store.put(DOC_A, { id: "a04", atMs: 4000, label: "new" }, state("a4"))).stored, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")).migratedFrom, 1);
});

/* ---- interruptions: a kill, then a rerun that ends identical ---- */

async function interruptedThenRerun(label, opts) {
  const ref = await reference();
  const dir = freshDir();
  buildV1(dir);
  const k = launch(dir, opts);
  await assert.rejects(k.backend.open(), /killed/, label + ": the kill happened");
  assert.deepEqual(v1Files(dir), ref.original, label + ": nothing in v1 is lost after the kill");
  const after = launch(dir);
  await after.backend.open();
  assert.deepEqual(tree(dir), ref.tree, label + ": the rerun ends byte-identical to an uninterrupted run");
  await assertMigrated(dir, ref.expected);
  return dir;
}

for (const k of [1, 4, BODY_COUNT + 1]) {
  /* afterBody counts puts, not new files: b02 re-puts a01's body, so the
     last put is number BODY_COUNT + 1 */
  test(`interrupted after body #${k}: no index.json, v1 untouched; the rerun starts over and matches`, async () => {
    const ref = await reference();
    const dir = freshDir();
    buildV1(dir);
    const before = tree(dir);
    const k1 = launch(dir, { hooks: { afterBody: (n) => { if (n === k) killer("body " + k)(); } } });
    await assert.rejects(k1.backend.open(), /killed/);
    assert.ok(!fs.existsSync(path.join(dir, "index.json")), "no index before step (3)");
    for (const [rel, h] of Object.entries(before)) assert.equal(tree(dir)[rel], h, "v1 untouched: " + rel);
    assert.deepEqual(v1Files(dir), ref.original);
    await launch(dir).backend.open();
    assert.deepEqual(tree(dir), ref.tree);
    await assertMigrated(dir, ref.expected);
  });
}

test("interrupted after verify, before the index", () =>
  interruptedThenRerun("afterVerify", { hooks: { afterVerify: killer("afterVerify") } }));

test("interrupted inside the index write (temp file fsynced, not renamed): swept, and the rerun starts over", () =>
  interruptedThenRerun("afterIndexTmp", { backendHooks: { afterIndexTmp: killer("afterIndexTmp") } }));

test("interrupted after the index write, before FORMAT: the rerun writes FORMAT and moves v1", async () => {
  const dir = await interruptedThenRerun("afterIndex", { hooks: { afterIndex: killer("afterIndex") } });
  assert.ok(fs.existsSync(path.join(dir, BACKUP_DIR, "docs")));
});

test("interrupted after FORMAT, before the move: the rerun moves v1", () =>
  interruptedThenRerun("afterFormat", { hooks: { afterFormat: killer("afterFormat") } }));

test("interrupted between moving docs/ and older/: the rerun moves the rest", () =>
  interruptedThenRerun("afterMove docs", { hooks: { afterMove: (n) => { if (n === "docs") killer("afterMove docs")(); } } }));

test("interrupted twice (a body, then after the index): still ends identical", async () => {
  const ref = await reference();
  const dir = freshDir();
  buildV1(dir);
  await assert.rejects(launch(dir, { hooks: { afterBody: (n) => { if (n === 3) killer("b3")(); } } }).backend.open(), /killed/);
  await assert.rejects(launch(dir, { hooks: { afterIndex: killer("idx") } }).backend.open(), /killed/);
  assert.deepEqual(v1Files(dir), ref.original);
  await launch(dir).backend.open();
  assert.deepEqual(tree(dir), ref.tree);
});

/* ---- a full disk ---- */

test("ENOSPC mid-migration aborts with v1 intact: the store answers 'enospc'; the next launch finishes", async () => {
  const ref = await reference();
  const dir = freshDir();
  buildV1(dir);
  const before = tree(dir);
  let bodyOpens = 0;
  const full = new Proxy(fsp, {
    get(target, prop) {
      if (prop !== "open") return target[prop];
      return (p, ...rest) => {
        if (String(p).includes(path.join("bodies", "sha256")) && ++bodyOpens > 3) {
          return Promise.reject(Object.assign(new Error("no space"), { code: "ENOSPC" }));
        }
        return target.open(p, ...rest);
      };
    }
  });
  const f = launch(dir, { fsp: full });
  assert.deepEqual(await f.store.put(DOC_A, { id: "z01", atMs: 1 }, state("z")), { stored: false, code: "enospc", evicted: 0, overCap: true });
  await assert.rejects(f.store.list(DOC_A), (e) => e.code === "enospc", "a read can tell 'could not read' from 'empty'");
  assert.equal(f.backend.state, "failed");
  assert.equal(f.backend.migrating, false);
  const now = tree(dir);
  for (const [rel, h] of Object.entries(before)) assert.equal(now[rel], h, "v1 untouched: " + rel);
  assert.equal(fs.readFileSync(path.join(dir, "FORMAT"), "utf8"), "1\n", "FORMAT still v1's");
  assert.ok(!fs.existsSync(path.join(dir, "index.json")));

  await launch(dir).backend.open();
  assert.deepEqual(tree(dir), ref.tree);
});

/* ---- when it must not run ---- */

test("FORMAT 3 (a newer build's folder): no migration, read-only, nothing touched", async () => {
  const dir = freshDir();
  buildV1(dir);
  fs.writeFileSync(path.join(dir, "FORMAT"), "3\n");
  const before = tree(dir);
  const { backend, store } = launch(dir);
  const r = await backend.open();
  assert.equal(r.readOnly, true);
  assert.equal(r.migrated, null, "the hook is not even called on a read-only folder");
  assert.deepEqual(await store.put(DOC_A, { id: "z01", atMs: 1 }, state("z")), { stored: false, code: "read-only" });
  assert.deepEqual(tree(dir), before);
});

test("the migrator on its own refuses FORMAT ≥ 3 too", async () => {
  const r = await migrateHistoryV1({
    readFormat: async () => "3", readIndex: async () => null, setMigrating() {}
  }, { policy, DOC_ID_RE });
  assert.deepEqual(r, { state: "newer" });
});

test("a fresh profile: nothing to migrate, FORMAT \"2\", no v1-backup/", async () => {
  const dir = freshDir();
  const { backend } = launch(dir);
  const r = await backend.open();
  assert.deepEqual(r.migrated, { state: "none" });
  assert.equal(fs.readFileSync(path.join(dir, "FORMAT"), "utf8"), "2\n");
  assert.ok(!fs.existsSync(path.join(dir, BACKUP_DIR)));
});

test("an empty v1 folder (FORMAT 1, empty docs/) still migrates: empty index, v1 moved", async () => {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "FORMAT"), "1\n");
  const { backend, store } = launch(dir);
  assert.equal((await backend.open()).migrated.state, "migrated");
  assert.deepEqual(await store.listDocs(), []);
  assert.ok(fs.existsSync(path.join(dir, BACKUP_DIR, "docs")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")).migratedFrom, 1);
});

test("'migrating' is visible while it works, and a list waits behind it", async () => {
  const ref = await reference();
  const dir = freshDir();
  buildV1(dir);
  let release;
  const gate = new Promise((r) => { release = r; });
  const { backend, store } = launch(dir, { hooks: { afterBody: (n) => (n === 2 ? gate : null) } });
  const listing = store.list(DOC_A);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(backend.migrating, true);
  assert.equal(backend.state, "migrating");
  release();
  assert.deepEqual((await listing).entries.map((m) => m.id), ["a03", "a02", "a01"]);
  assert.equal(backend.migrating, false);
  assert.equal(backend.state, "ready");
  assert.deepEqual(tree(dir), ref.tree);
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
