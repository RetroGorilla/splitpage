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
const { createDraftStore, writeFileDurableSync } = require(path.join(here, "..", "drafts.js"));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-drafts-test-"));
const TAB = "0123456789abcdef0123456789abcdef";
const TAB2 = "fedcba9876543210fedcba9876543210";

let caseCounter = 0;
function freshDir() {
  return path.join(ROOT, `case-${++caseCounter}`);
}

function makeStore(dir, testHooks, fsImpl) {
  return createDraftStore({ dir, fs: fsImpl || fs, fsp, path, crypto, appVersion: "9.9.9-test", testHooks });
}

function header(title) {
  return { title, docId: null, docIdWrittenOut: false, schema: 1, origin: { kind: "untitled", filePath: null }, placement: null };
}

const stateJ = (marker) => JSON.stringify({ rows: [{ id: "r1", text: marker }] });
const baseJ = (marker) => JSON.stringify({ rows: [{ id: "r1", text: `base ${marker}` }] });

function tabFile(dir, name, tabId = TAB) {
  return path.join(dir, tabId, name);
}

function rootTmps(dir) {
  return fs.readdirSync(dir).filter((n) => n.startsWith(".tmp-") || n.startsWith(".trash-"));
}

function readSession(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Flips one body byte, length unchanged.
function damageBody(file) {
  const buf = fs.readFileSync(file);
  const nl = buf.indexOf(0x0a);
  const i = nl + 5;
  buf[i] = buf[i] === 0x41 ? 0x42 : 0x41;
  fs.writeFileSync(file, buf);
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("a torn write keeps the previous generation, and the temp file is swept on init", async () => {
  const dir = freshDir();
  let killed = 0;
  const a = makeStore(dir, { killBeforeRenameAt: 2, onKill: () => { killed++; } });
  const first = a.init();
  assert.equal(first.previousSession, "none");

  assert.deepEqual(await a.write(TAB, header("one"), stateJ("gen1"), baseJ("b"), 1), { ok: true, seq: 1, bytes: Buffer.byteLength(stateJ("gen1")) });
  const gen1Bytes = fs.readFileSync(tabFile(dir, "current.draft"));

  const torn = await a.write(TAB, header("two"), stateJ("gen2"), null, 2);
  assert.equal(torn.ok, false);
  assert.equal(killed, 1, "onKill ran once, before the rename");
  assert.ok(rootTmps(dir).some((n) => n.startsWith(".tmp-")), "the killed write left its temp file behind");
  assert.deepEqual(fs.readFileSync(tabFile(dir, "current.draft")), gen1Bytes, "current.draft is still generation 1");
  assert.equal(fs.existsSync(tabFile(dir, "previous.draft")), false);

  const b = makeStore(dir);
  const res = b.init();
  assert.equal(res.previousSession, "running", "the killed process never marked a clean exit");
  assert.deepEqual(rootTmps(dir), [], "init swept the temp file");
  assert.equal(res.drafts.length, 1);
  assert.equal(res.drafts[0].tabId, TAB);
  assert.equal(res.drafts[0].title, "one");
  const t = await b.take(TAB);
  assert.equal(t.stateJson, stateJ("gen1"));
  assert.equal(t.baseJson, baseJ("b"));
  assert.equal(t.baseProblem, null);
  assert.equal(t.usedPrevGeneration, false);
  assert.equal(t.previousSession, "running");
  assert.equal(t.header.seq, 1);
});

test("a checksum mismatch falls back to previous; both bad -> quarantine, never unlinked", async () => {
  const dir = freshDir();
  const a = makeStore(dir);
  a.init();
  assert.equal((await a.write(TAB, header("t"), stateJ("gen1"), baseJ("b"), 1)).ok, true);
  assert.equal((await a.write(TAB, header("t"), stateJ("gen2"), null, 2)).ok, true);

  const cur = tabFile(dir, "current.draft");
  const full = fs.readFileSync(cur);
  fs.writeFileSync(cur, full.subarray(0, full.length - 3));

  const b = makeStore(dir);
  b.init();
  const t = await b.take(TAB);
  assert.equal(t.stateJson, stateJ("gen1"));
  assert.equal(t.usedPrevGeneration, true);
  assert.equal(t.baseJson, baseJ("b"));
  assert.ok(fs.existsSync(cur), "take never deletes");

  damageBody(tabFile(dir, "previous.draft"));
  const curBytes = fs.readFileSync(cur);
  const prevBytes = fs.readFileSync(tabFile(dir, "previous.draft"));
  const baseName = fs.readdirSync(path.join(dir, TAB)).find((n) => n.startsWith("base-"));
  const baseBytes = fs.readFileSync(tabFile(dir, baseName));

  const c = makeStore(dir);
  c.init();
  assert.deepEqual(fs.readFileSync(cur), curBytes, "init leaves a damaged folder for take to decide");
  assert.deepEqual(await c.take(TAB), { corrupt: true });
  assert.equal(fs.existsSync(path.join(dir, TAB)), false, "the tab folder moved out of the way");
  assert.equal(c.hasDraft(TAB), false);
  const q = fs.readdirSync(path.join(dir, "corrupt"));
  assert.equal(q.length, 1);
  assert.match(q[0], new RegExp(`^${TAB}-\\d+$`));
  const qdir = path.join(dir, "corrupt", q[0]);
  assert.deepEqual(fs.readFileSync(path.join(qdir, "current.draft")), curBytes, "quarantined current is byte-identical");
  assert.deepEqual(fs.readFileSync(path.join(qdir, "previous.draft")), prevBytes, "quarantined previous is byte-identical");
  assert.deepEqual(fs.readFileSync(path.join(qdir, baseName)), baseBytes, "the base went with them");

  makeStore(dir).init();
  assert.equal(fs.readdirSync(path.join(dir, "corrupt")).length, 1);
});

test("discardForUserDecision during a delayed write: folder gone, DISCARDED, tombstone persisted first, recreated folder removed by next init", async () => {
  const dir = freshDir();
  const order = [];
  const spyFs = {
    ...fs,
    renameSync(from, to) {
      if (from === path.join(dir, TAB) && path.basename(to).startsWith(".trash-")) {
        const s = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
        order.push(s.discardedTabIds.includes(TAB) ? "rename-after-tombstone" : "rename-BEFORE-tombstone");
      }
      return fs.renameSync(from, to);
    },
  };
  const a = makeStore(dir, { writeDelayMs: 300 }, spyFs);
  a.init();
  assert.equal((await a.write(TAB, header("t"), stateJ("gen1"), baseJ("b"), 1)).ok, true);
  assert.equal((await a.write(TAB2, header("other"), stateJ("other"), baseJ("o"), 1)).ok, true);

  const pending = a.write(TAB, header("t"), stateJ("gen2"), null, 2);
  await wait(80);
  assert.ok(rootTmps(dir).length > 0, "the delayed write has its temp file in place");

  const d = a.discardForUserDecision([TAB], "leave-without-saving");
  assert.equal(d.ok, true);
  assert.equal(d.persisted, true);
  assert.equal(fs.existsSync(path.join(dir, TAB)), false, "folder absent immediately");
  assert.deepEqual(order, ["rename-after-tombstone"]);
  assert.ok(readSession(dir).discardedTabIds.includes(TAB), "tombstone persisted");

  assert.deepEqual(await pending, { ok: false, code: "DISCARDED" });
  assert.equal(fs.existsSync(path.join(dir, TAB)), false, "the late write did not bring the folder back");
  assert.deepEqual(rootTmps(dir), [], "the late write removed its temp file");
  assert.equal(a.hasDraft(TAB), false);
  assert.deepEqual(await a.write(TAB, header("t"), stateJ("gen3"), baseJ("b"), 3), { ok: false, code: "DISCARDED" });
  assert.equal(a.hasDraft(TAB2), true, "the other tab's draft is untouched");

  fs.mkdirSync(path.join(dir, TAB));
  fs.writeFileSync(tabFile(dir, "current.draft"), "resurrected");
  const b = makeStore(dir);
  const res = b.init();
  assert.equal(fs.existsSync(path.join(dir, TAB)), false, "next init removed the tombstoned folder");
  assert.deepEqual(readSession(dir).discardedTabIds, [], "the tombstone list is pruned once the folder is gone");
  assert.deepEqual(res.drafts.map((x) => x.tabId), [TAB2]);
  assert.equal((await b.write(TAB, header("t"), stateJ("new"), baseJ("b"), 1)).ok, true);
});

test("STALE_SEQ, NEED_BASE, TOO_LARGE, NO_TAB, BAD_PAYLOAD, hold and resetSeq", async () => {
  const dir = freshDir();
  const s = makeStore(dir, { maxBodyBytes: 100 });
  s.init();

  assert.deepEqual(await s.write(TAB, header("t"), "{}", null, 1), { ok: false, code: "NEED_BASE" }, "first write of a tab needs its base");
  assert.equal(fs.existsSync(path.join(dir, TAB)), false);
  assert.equal((await s.write(TAB, header("t"), "{}", "{}", 1)).ok, true);
  assert.deepEqual(await s.write(TAB, header("t"), "{}", "{}", 1), { ok: false, code: "STALE_SEQ" });
  assert.deepEqual(await s.write(TAB, header("t"), "{}", "{}", 0), { ok: false, code: "STALE_SEQ" });
  assert.deepEqual(await s.write(TAB, header("t"), "{\"a\":1}", null, 2), { ok: false, code: "NEED_BASE" });
  assert.equal((await s.write(TAB, header("t"), "{\"a\":1}", "{}", 2)).ok, true);
  assert.equal((await s.write(TAB, header("t"), "{\"a\":2}", null, 3)).ok, true, "a known base is reused");
  const t = await s.take(TAB);
  assert.equal(t.stateJson, "{\"a\":2}");
  assert.equal(t.baseJson, "{}");

  const [w5, w4] = await Promise.all([
    s.write(TAB, header("t"), "{\"a\":5}", null, 5),
    s.write(TAB, header("t"), "{\"a\":4}", "{}", 4),
  ]);
  assert.equal(w5.ok, true);
  assert.deepEqual(w4, { ok: false, code: "STALE_SEQ" });

  assert.deepEqual(await s.write(TAB, header("t"), "x".repeat(101), "{}", 6), { ok: false, code: "TOO_LARGE" });
  assert.deepEqual(await s.write(TAB, header("t"), "{}", "x".repeat(101), 6), { ok: false, code: "TOO_LARGE" });
  assert.deepEqual(await s.write(TAB, header("t"), "\u00e9".repeat(51), "{}", 6), { ok: false, code: "TOO_LARGE" }, "the cap counts UTF-8 bytes");
  assert.equal((await s.write(TAB, header("t"), "\u00e9".repeat(50), "{}", 6)).ok, true);

  assert.deepEqual(await s.write("ABC", header("t"), "{}", "{}", 7), { ok: false, code: "NO_TAB" });
  assert.deepEqual(await s.write(TAB.toUpperCase(), header("t"), "{}", "{}", 7), { ok: false, code: "NO_TAB" });
  assert.deepEqual(await s.write(TAB, header("t"), 42, "{}", 7), { ok: false, code: "BAD_PAYLOAD" });
  assert.deepEqual(await s.write(TAB, null, "{}", "{}", 7), { ok: false, code: "BAD_PAYLOAD" });
  assert.deepEqual(await s.write(TAB, header("t"), "{}", "{}", NaN), { ok: false, code: "BAD_PAYLOAD" });

  s.hold(TAB);
  assert.equal(s.isHeld(TAB), true);
  assert.deepEqual(await s.discardClean(TAB, 100), { ok: false, code: "HELD" });
  assert.equal(s.hasDraft(TAB), true);
  s.release(TAB);
  assert.deepEqual(await s.discardClean(TAB, 5), { ok: false, code: "STALE_SEQ" }, "seq 6 already landed");
  assert.deepEqual(await s.discardClean(TAB, 6), { ok: true });
  assert.equal(s.hasDraft(TAB), false);
  assert.deepEqual(await s.write(TAB, header("t"), "{}", "{}", 6), { ok: false, code: "STALE_SEQ" }, "no write at or below the discard lands");
  assert.deepEqual(await s.write(TAB, header("t"), "{}", null, 7), { ok: false, code: "NEED_BASE" }, "the discard forgot the base");
  assert.equal((await s.write(TAB, header("t"), "{}", "{}", 7)).ok, true);

  s.resetSeq(TAB);
  assert.deepEqual(await s.write(TAB, header("t"), "{}", null, 1), { ok: false, code: "NEED_BASE" });
  assert.equal((await s.write(TAB, header("t"), "{\"after\":1}", "{}", 1)).ok, true);
  assert.equal(s.status(TAB).lastSeq, 1);
  assert.equal((await s.take(TAB)).stateJson, "{\"after\":1}");
});

test("a hold keeps an unrestored draft byte-identical against writes called under it", async () => {
  const dir = freshDir();
  const folder = path.join(dir, TAB);
  const snapshot = () => Object.fromEntries(fs.readdirSync(folder).sort().map((n) => [n, fs.readFileSync(path.join(folder, n)).toString("base64")]));

  const a = makeStore(dir);
  a.init();
  assert.equal((await a.write(TAB, header("crash work"), stateJ("gen1"), baseJ("b"), 1)).ok, true);
  assert.equal((await a.write(TAB, header("crash work"), stateJ("gen2"), null, 2)).ok, true);
  const before = snapshot();
  const gen2Bytes = fs.readFileSync(tabFile(dir, "current.draft"));

  let locked = true;
  const lockingFsp = {
    ...fsp,
    async readFile(p, ...rest) {
      if (locked && /(current|previous)\.draft$/.test(String(p))) throw Object.assign(new Error("locked"), { code: "EBUSY" });
      return fsp.readFile(p, ...rest);
    },
  };
  const b = createDraftStore({ dir, fs, fsp: lockingFsp, path, crypto, appVersion: "9.9.9-test" });
  b.init();
  b.hold(TAB);
  assert.deepEqual(await b.take(TAB), { corrupt: true });
  assert.deepEqual(snapshot(), before, "a locked draft is not quarantined");

  assert.deepEqual(await b.write(TAB, header("typed after"), stateJ("new1"), baseJ("seed"), 1), { ok: false, code: "HELD" });
  assert.deepEqual(await b.write(TAB, header("typed after"), stateJ("new2"), baseJ("seed"), 2), { ok: false, code: "HELD" });
  assert.deepEqual(snapshot(), before, "neither generation was rotated or overwritten");
  assert.deepEqual(rootTmps(dir), [], "refused writes leave no temp file");
  assert.equal(b.isHeld(TAB), true);
  assert.equal(b.status(TAB).failures, 0, "HELD is a deliberate refusal, not a disk failure");
  assert.deepEqual(await b.discardClean(TAB, Infinity), { ok: false, code: "HELD" });

  b.hold(TAB);
  assert.deepEqual(await b.write(TAB, header("typed after"), stateJ("new3"), baseJ("seed"), 3), { ok: false, code: "HELD" });

  locked = false;
  const t = await b.take(TAB);
  assert.equal(t.stateJson, stateJ("gen2"));
  assert.equal(t.baseJson, baseJ("b"));
  assert.equal(t.usedPrevGeneration, false);
  const c = makeStore(dir);
  assert.deepEqual(c.init().drafts.map((x) => x.title), ["crash work"]);
  assert.equal((await c.take(TAB)).stateJson, stateJ("gen2"));

  b.release(TAB);
  assert.equal((await b.write(TAB, header("restored"), stateJ("new4"), baseJ("seed"), 4)).ok, true);
  assert.deepEqual(fs.readFileSync(tabFile(dir, "previous.draft")), gen2Bytes, "the restored crash work is the fallback generation");
  assert.equal((await b.take(TAB)).stateJson, stateJ("new4"));
});

test("a hold does not refuse a write called before it, nor protect a tab with no draft", async () => {
  const dir = freshDir();
  const s = makeStore(dir, { writeDelayMs: 200 });
  s.init();
  assert.equal((await s.write(TAB, header("t"), stateJ("gen1"), baseJ("b"), 1)).ok, true);

  const inFlight = s.write(TAB, header("t"), stateJ("gen2"), null, 2);
  await wait(50);
  s.hold(TAB);
  const underHold = s.write(TAB, header("t"), stateJ("reloaded page"), baseJ("seed"), 3);
  assert.equal((await inFlight).ok, true, "a write called before the hold lands");
  assert.deepEqual(await underHold, { ok: false, code: "HELD" });
  assert.equal((await s.take(TAB)).stateJson, stateJ("gen2"));
  assert.equal(fs.readFileSync(tabFile(dir, "previous.draft"), "utf8").split("\n")[1], stateJ("gen1"));

  s.hold(TAB2);
  assert.equal(s.hasDraft(TAB2), false);
  assert.equal((await s.write(TAB2, header("o"), stateJ("o1"), baseJ("o"), 1)).ok, true);
  assert.equal(s.isHeld(TAB2), false);
  assert.equal((await s.write(TAB2, header("o"), stateJ("o2"), null, 2)).ok, true, "later writes are not refused either");
  assert.equal((await s.take(TAB2)).stateJson, stateJ("o2"));
});

test("injected ENOSPC leaves current.draft byte-identical", async () => {
  const dir = freshDir();
  const a = makeStore(dir);
  a.init();
  assert.equal((await a.write(TAB, header("t"), stateJ("gen1"), baseJ("b"), 1)).ok, true);
  const before = fs.readFileSync(tabFile(dir, "current.draft"));
  const namesBefore = fs.readdirSync(path.join(dir, TAB)).sort();

  const b = makeStore(dir, { failNext: { code: "ENOSPC", count: 2 } });
  b.init();
  assert.deepEqual(await b.write(TAB, header("t"), stateJ("gen2"), baseJ("b2"), 1), { ok: false, code: "ENOSPC" });
  assert.deepEqual(await b.write(TAB, header("t"), stateJ("gen2"), baseJ("b2"), 2), { ok: false, code: "ENOSPC" });
  assert.deepEqual(fs.readFileSync(tabFile(dir, "current.draft")), before, "current.draft byte-identical");
  assert.deepEqual(fs.readdirSync(path.join(dir, TAB)).sort(), namesBefore, "no previous.draft, no new base");
  assert.deepEqual(rootTmps(dir), [], "failed writes removed their temp files");
  assert.equal(b.status(TAB).failures, 2);
  assert.equal((await b.write(TAB, header("t"), stateJ("gen3"), baseJ("b2"), 3)).ok, true, "writes work again after the failures");
  assert.equal((await b.take(TAB)).stateJson, stateJ("gen3"));
});

test("a base referenced only by previous survives the sweep", async () => {
  const dir = freshDir();
  const a = makeStore(dir);
  a.init();
  assert.equal((await a.write(TAB, header("t"), stateJ("gen1"), baseJ("B1"), 1)).ok, true);
  assert.equal((await a.write(TAB, header("t"), stateJ("gen2"), baseJ("B2"), 2)).ok, true);
  const bases = () => fs.readdirSync(path.join(dir, TAB)).filter((n) => n.startsWith("base-")).sort();
  assert.equal(bases().length, 2, "both generations' bases kept after the write");

  const stray = "base-000000000000.json";
  fs.writeFileSync(tabFile(dir, stray), "stray");
  fs.writeFileSync(tabFile(dir, ".tmp-stray"), "stray");

  const b = makeStore(dir);
  b.init();
  assert.equal(bases().length, 2, "B1 (previous only) and B2 (current) survive");
  assert.equal(fs.existsSync(tabFile(dir, stray)), false, "an unreferenced base is swept");
  assert.equal(fs.existsSync(tabFile(dir, ".tmp-stray")), false);

  damageBody(tabFile(dir, "current.draft"));
  const t = await b.take(TAB);
  assert.equal(t.usedPrevGeneration, true);
  assert.equal(t.stateJson, stateJ("gen1"));
  assert.equal(t.baseJson, baseJ("B1"));
  assert.equal(t.baseProblem, null);

  const b1 = t.header.base.file;
  fs.renameSync(tabFile(dir, b1), path.join(dir, "moved-away"));
  const t2 = await b.take(TAB);
  assert.equal(t2.stateJson, stateJ("gen1"));
  assert.equal(t2.baseJson, null);
  assert.equal(t2.baseProblem, "missing");
});

test("formatVersion 99 -> unsupported and kept", async () => {
  const dir = freshDir();
  const folder = path.join(dir, TAB);
  fs.mkdirSync(folder, { recursive: true });
  const future = JSON.stringify({ format: "splitpage-draft", formatVersion: 99, tabId: TAB, title: "from the future", something: "new" }) + "\nnot even json";
  fs.writeFileSync(path.join(folder, "current.draft"), future);
  fs.writeFileSync(path.join(folder, "base-aaaaaaaaaaaa.json"), "future base");
  fs.writeFileSync(path.join(folder, "future-extra.bin"), "x");
  const snapshot = () => Object.fromEntries(fs.readdirSync(folder).sort().map((n) => [n, fs.readFileSync(path.join(folder, n), "utf8")]));
  const before = snapshot();

  const s = makeStore(dir);
  const res = s.init();
  assert.deepEqual(snapshot(), before, "init left it untouched");
  assert.equal(res.drafts.length, 1);
  assert.equal(res.drafts[0].status, "unsupported");
  assert.equal(s.hasDraft(TAB), true);
  assert.deepEqual(await s.take(TAB), { unsupported: true });
  assert.deepEqual(snapshot(), before, "take left it untouched");
  assert.deepEqual(await s.write(TAB, header("t"), "{}", "{}", 1), { ok: false, code: "EPERM" }, "an older app does not rotate a newer draft out");
  assert.deepEqual(snapshot(), before, "write left it untouched");
});

test("writeFileDurableSync replaces content atomically", async () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "desktop-state.json");
  writeFileDurableSync(file, "first");
  assert.equal(fs.readFileSync(file, "utf8"), "first");
  const text = JSON.stringify({ version: 2, title: "Sm\u00f6rg\u00e5sbord \u2014 \ud83d\udcdd" });
  writeFileDurableSync(file, text);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.deepEqual(fs.readdirSync(dir), ["desktop-state.json"], "no temp file left");

  const blocked = path.join(dir, "blocked");
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, "keep"), "k");
  assert.throws(() => writeFileDurableSync(blocked, "nope"));
  assert.equal(fs.readFileSync(path.join(blocked, "keep"), "utf8"), "k");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["blocked", "desktop-state.json"], "failed write removed its temp file");
});

test("session states, take never deletes, list fields, init sweeps trash and old quarantine", async () => {
  const dir = freshDir();
  const a = makeStore(dir);
  assert.equal(a.init().previousSession, "none");
  const s1 = readSession(dir);
  assert.equal(s1.formatVersion, 1);
  assert.equal(s1.state, "running");
  assert.equal(s1.pid, process.pid);
  assert.equal(s1.appVersion, "9.9.9-test");

  const h = { title: "My script", docId: "d" + "a".repeat(32), docIdWrittenOut: true, schema: 1,
    origin: { kind: "file", filePath: "C:\\docs\\x.md", fileName: "x.md" }, placement: { windowKey: "w1", index: 2, active: true } };
  assert.equal((await a.write(TAB, h, stateJ("x"), baseJ("x"), 10)).ok, true);
  const hdr = JSON.parse(fs.readFileSync(tabFile(dir, "current.draft"), "utf8").split("\n")[0]);
  assert.equal(hdr.format, "splitpage-draft");
  assert.equal(hdr.formatVersion, 1);
  assert.equal(hdr.tabId, TAB);
  assert.equal(hdr.appVersion, "9.9.9-test");
  assert.equal(hdr.seq, 10);
  assert.equal(hdr.state.bytes, Buffer.byteLength(stateJ("x")));
  assert.equal(hdr.state.sha256, crypto.createHash("sha256").update(stateJ("x")).digest("hex"));
  assert.match(hdr.base.file, /^base-[0-9a-f]{12}\.json$/);
  const baseLine = JSON.parse(fs.readFileSync(tabFile(dir, hdr.base.file), "utf8").split("\n")[0]);
  assert.deepEqual(baseLine, { format: "splitpage-draft-base", formatVersion: 1, bytes: hdr.base.bytes, sha256: hdr.base.sha256 });

  assert.equal(a.markSessionEnd(), true);
  assert.equal(readSession(dir).state, "session-end");
  assert.equal(a.markCleanExit(), true);
  assert.equal(readSession(dir).state, "clean-exit");

  fs.mkdirSync(path.join(dir, `.trash-${TAB2}-abc`, "inner"), { recursive: true });
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const q = path.join(dir, "corrupt");
  const mk = (ts, i) => fs.mkdirSync(path.join(q, `${TAB2}-${ts}${i ? "-" + i : ""}`), { recursive: true });
  mk(now - 1000, 0);
  mk(now - day, 1); mk(now - day, 2);
  for (let i = 0; i < 11; i++) mk(now - 40 * day - i * 1000, 0);
  fs.mkdirSync(path.join(q, "not-ours"));

  const b = makeStore(dir);
  const res = b.init();
  assert.equal(res.previousSession, "clean-exit");
  assert.deepEqual(rootTmps(dir), [], ".trash-* swept");
  const left = fs.readdirSync(q);
  assert.equal(left.filter((n) => n !== "not-ours").length, 10, "newest 10 kept, older-than-30-days beyond them pruned");
  assert.ok(left.includes("not-ours"), "unrecognised entries are not touched");
  assert.ok(left.includes(`${TAB2}-${now - 1000}`));

  assert.equal(res.drafts.length, 1);
  const L = res.drafts[0];
  assert.equal(L.status, "ok");
  assert.equal(L.generation, "current");
  assert.equal(L.title, "My script");
  assert.equal(L.seq, 10);
  assert.equal(L.docId, h.docId);
  assert.equal(L.originKind, "file");
  assert.equal(L.filePath, "C:\\docs\\x.md");
  assert.deepEqual(L.placement, { windowKey: "w1", index: 2, active: true });

  const t = await b.take(TAB);
  assert.equal(t.stateJson, stateJ("x"));
  assert.equal(t.header.docIdWrittenOut, true);
  assert.equal(t.previousSession, "clean-exit");
  assert.ok(t.ageMs >= 0);
  assert.equal(b.hasDraft(TAB), true, "take never deletes");
  assert.equal((await b.take(TAB)).stateJson, stateJ("x"), "a second take reads the same draft");
  assert.equal(await b.take(TAB2), null, "no draft -> null");
  assert.equal(await b.take("nope"), null);
});

const failures = [];
for (const c of cases) {
  try {
    await c.fn();
    console.log(`ok   - ${c.name}`);
  } catch (err) {
    failures.push(c.name);
    console.log(`FAIL - ${c.name}\n       ${String((err && err.stack) || err).split("\n").slice(0, 6).join("\n       ")}`);
  }
}

try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch (_) {
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED of ${cases.length}`);
  process.exit(1);
}
console.log(`\nALL PASS (${cases.length} cases)`);
