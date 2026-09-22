import { S } from "./_state.js";
import { home } from "./_home.js";
import { makeId } from "./02-state.js";
import { mintDocId, normalizeDocId } from "./02b-doc-id.js";
import {
  SNAPSHOT_KEY,
  getEditorName,
  readLegacySnapshotsRaw,
  renderHistory
} from "./03-sync.js";
import { showToast } from "./12-dirty-toast.js";
import { checksumText, seedCheckPasses } from "./20b-onboarding.js";
/* The policy half of version history — what is kept and what is thrown
   away — is shared with desktop/main.js, which used to carry a line-for-line
   copy of planHistoryEviction and its own clamps for a meta (#76). Re-
   exported below so every importer of this module keeps naming this file. */
import {
  HISTORY_OLDER_KEY,
  HISTORY_OLDER_TTL_MS,
  HISTORY_PER_DOC,
  HISTORY_SNAP_ID_RE,
  historyClip,
  historyStampAfter,
  planHistoryEviction,
  sanitizeHistoryMeta
} from "../../shared/history-policy.js";
export {
  HISTORY_OLDER_KEY,
  HISTORY_OLDER_TTL_MS,
  HISTORY_PER_DOC,
  HISTORY_SNAP_ID_RE,
  historyStampAfter,
  planHistoryEviction,
  sanitizeHistoryMeta
};

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
var historyChain;

/* ================= version history store (per document) =================

   Version history used to be ONE list in localStorage ('splitpage-snapshots',
   12 entries, ~1.2 MB) shared by every document this browser ever opened:
   restoring "an earlier version" could hand you a different script, and one
   big document pushed everyone else's snapshots out. This fragment is the
   replacement's storage half. History is addressed only by (docId,
   snapshot id) — HANDOFF invariant #38 — and lives in one of three
   backends, chosen per call:

     desktop   DESKTOP.historyPut exists (step I; a stub below until then)
     idb       IndexedDB database 'splitpage-history', once it has opened
     memory    everything else — kept only until this page closes

   What this file promises its callers (03-sync.js, 14-export.js, 02b):

     * captureSnapshot() stringifies SYNCHRONOUSLY and returns at once.
       Eight callers replace `state` on the very next line (invariant #39),
       so any await before the capture would snapshot the wrong document.
       The write itself is queued; its outcome arrives on ticket.done.
     * No promise handed out here ever rejects. A failed history write must
       never become a failed save, a failed open or an unhandled rejection.
     * Every write runs through one in-page queue (enqueueHistory), so a
       copyHistory() really does see the push that was issued before it,
       and a burst of pushes is stored in call order.

   '_older' is the IndexedDB bucket key for the one-time migration of the
   old shared list ("Older history (before per-document history)"). It is
   never accepted as a docId argument — the bucket is reachable only through
   {older:true}, so a hostile file claiming docId "_older" cannot read or
   write it. */

/* HISTORY_PER_DOC, HISTORY_OLDER_KEY, HISTORY_SNAP_ID_RE and
   HISTORY_OLDER_TTL_MS are shared/history-policy.js's, imported and
   re-exported at the top of this file (#76). */
var HISTORY_DB_NAME = "splitpage-history";
var HISTORY_DB_VERSION = 1;
/* Browser cap = max(5 MB, quota − (usage − historyBytes) − 50 MB): history
   may use what the origin's quota leaves after everything else, minus
   headroom, but never less than a floor that keeps a few snapshots alive. */
var HISTORY_BROWSER_MIN_CAP = 5 * 1024 * 1024;
var HISTORY_BROWSER_HEADROOM = 50 * 1024 * 1024;
var HISTORY_ESTIMATE_TTL_MS = 5 * 60 * 1000;
/* The memory backend holds whole documents in this page's RAM. 50 per
   document already bounds it per script; this bounds it across scripts. */
var HISTORY_MEMORY_CAP = 50 * 1024 * 1024;
var HISTORY_PENDING_PER_DOC = 10;
var HISTORY_MIGRATION_LOOPS = 3;

/* ---- scaffolding ---- */

export function historyNoop() {}

function enqueueHistory(job, fallback) {
  var run = historyChain.then(function () { return job(); }).then(null, function (e) {
    if (window.console) console.error(e);
    try { return typeof fallback === "function" ? fallback(e) : fallback; } catch (x) { return undefined; }
  });
  historyChain = run.then(historyNoop, historyNoop);
  return run;
}

/* Resolves once nothing is queued and no migration is running — re-checking
   after each wait, because a finishing job may have queued another (a
   pending-snapshot retry after a successful write). */
function historyIdle() {
  var c = historyChain;
  var m = historyMigrationPromise;
  return Promise.all([c, m]).then(function () {
    if (c === historyChain && m === historyMigrationPromise) return true;
    return historyIdle();
  });
}

/* Test hook setNow() moves this clock (Older expiry, eviction order);
   nothing else in the app reads it. */
var historyNowOverride = null;
function historyNow() {
  return historyNowOverride != null ? historyNowOverride : Date.now();
}

/* UTF-8 byte length without allocating a copy of a multi-megabyte string.
   sizeBytes means the same thing here and on desktop disk, so a cap and a
   "bytes equal the sum" check agree across backends. */
export function historyUtf8Length(str) {
  var n = 0, c, i;
  for (i = 0; i < str.length; i++) {
    c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length &&
             str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function isQuotaError(e) {
  return !!e && (e.name === "QuotaExceededError" || e.code === 22 || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

/* sanitizeHistoryMeta — SnapshotMeta rebuilt from plain values with every
   length clamped — is shared/history-policy.js's (#76), so a meta means the
   same thing on both sides of the desktop bridge. Imported and re-exported
   at the top of this file. */

/* ---- test faults (window.__historyTest.injectFault) ----
   Checked at the start of each backend write, so the renderer-side logic
   (evict-and-retry, pending entries, the migration's key removal) can be
   driven without actually filling a disk. */
var historyFault = null;
var historyDelayGate = null;
var historyDelayRelease = null;
var historyImportGate = null;
var historyImportRelease = null;
var historyImportGateHit = false;

function historyQuotaError() {
  var e;
  try { e = new DOMException("Injected quota fault", "QuotaExceededError"); }
  catch (x) { e = new Error("Injected quota fault"); e.name = "QuotaExceededError"; }
  return e;
}

function historyPutFaultGate() {
  if (historyFault === "delay-put") {
    if (!historyDelayGate) {
      historyDelayGate = new Promise(function (resolve) { historyDelayRelease = resolve; });
    }
    return historyDelayGate;
  }
  return null;
}

function historyThrowPutFault() {
  if (historyFault === "quota-once") { historyFault = null; throw historyQuotaError(); }
  if (historyFault === "quota-always") throw historyQuotaError();
  if (historyFault === "io-always") throw new Error("Injected io fault");
}

/* One-shot: releasing the delayed put also clears the fault, so the put it
   let through (and anything queued behind it) runs normally. */
function releaseDelayedPut() {
  if (historyFault === "delay-put") historyFault = null;
  var r = historyDelayRelease;
  historyDelayGate = null;
  historyDelayRelease = null;
  if (r) r();
}

/* The same gate for importOlder, so a test can hold a migration open at the
   exact point where it has read the legacy key but not yet confirmed it —
   the only window in which "the key changed mid-migration" means anything.
   Racing a real setItem() against an in-flight migrate() cannot decide that
   window: on a fast backend the migration is already finished (and the key
   already deleted) before the next CDP round trip lands, so the change is
   really a change AFTER the migration, and the test reads a re-created key
   next to removedKey === true. Re-armable, because exhausting
   HISTORY_MIGRATION_LOOPS needs the key to change on every pass. */
function historyImportFaultGate() {
  if (historyFault === "delay-import") {
    historyImportGateHit = true;
    if (!historyImportGate) {
      historyImportGate = new Promise(function (resolve) { historyImportRelease = resolve; });
    }
    return historyImportGate;
  }
  return null;
}

function releaseDelayedImport() {
  if (historyFault === "delay-import") historyFault = null;
  var r = historyImportRelease;
  historyImportGate = null;
  historyImportRelease = null;
  if (r) r();
}

/* ---- IndexedDB ---- */

var historyDb = null;
var historyDbPromise = null;
var historyPersistAsked = false;

/* Same promise shape as openHandleDb (00-prelude.js), plus the three things
   a long-lived store needs that a one-key handle store did not:
     - the upgrade branches on e.oldVersion, so a v2 later adds to v1
       instead of re-creating (and wiping) it;
     - onversionchange closes this connection, so another tab running a
       newer build (or resetForTest's deleteDatabase) is not blocked
       forever by this one;
     - onblocked fails THIS call instead of hanging every snapshot behind
       an upgrade some other tab refuses to let through. */
function openHistoryDb() {
  if (historyDb) return Promise.resolve(historyDb);
  if (historyDbPromise) return historyDbPromise;
  var p = new Promise(function (resolve, reject) {
    /* Once this call has failed (blocked), a success that arrives later
       must not be adopted behind the caller's back: the caller has already
       fallen back to memory, and a stray open connection would only block
       the next upgrade. It is closed instead. */
    var failed = false;
    function fail(e) { failed = true; reject(e); }
    if (historyFault === "idb-open-fail") { fail(new Error("Injected idb-open-fail")); return; }
    if (!("indexedDB" in window) || !window.indexedDB) { fail(new Error("no-indexeddb")); return; }
    var req;
    try { req = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION); } catch (e) { fail(e); return; }
    req.onupgradeneeded = function (e) {
      var db = req.result;
      var old = e.oldVersion || 0;
      if (old < 1) {
        /* The field name is spelled once, in single quotes, on purpose: the
           Standalone HTML export is this whole page, app script included,
           and 17-formats proves that export carries no document id by
           searching it for the double-quoted JSON key. A double-quoted
           literal here would be a false positive in that check. */
        var K = 'docId';
        var docs = db.createObjectStore("docs", { keyPath: K });
        docs.createIndex("byLastOpened", "lastOpenedAt");
        var metaStore = db.createObjectStore("snapMeta", { keyPath: [K, "id"] });
        metaStore.createIndex("byDocAt", [K, "atMs"]);
        db.createObjectStore("snapBody", { keyPath: [K, "id"] });
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    req.onsuccess = function () {
      var db = req.result;
      if (failed) { try { db.close(); } catch (e) {} return; }
      function forget() {
        if (historyDb === db) { historyDb = null; historyDbPromise = null; }
      }
      db.onversionchange = function () { try { db.close(); } catch (e) {} forget(); };
      db.onclose = forget; /* the browser closed it (storage cleared) — reopen next call */
      historyDb = db;
      /* Ask once for persistent storage so the browser does not evict
         history under storage pressure. Only where userAgentData exists
         (Chromium), which grants or refuses silently; elsewhere persist()
         can raise a permission prompt, and a prompt nobody asked for is
         worse than best-effort storage. */
      if (!historyPersistAsked && navigator.userAgentData && navigator.storage &&
          typeof navigator.storage.persist === "function") {
        historyPersistAsked = true;
        try { navigator.storage.persist().then(historyNoop, historyNoop); } catch (e) {}
      }
      resolve(db);
    };
    req.onerror = function () { fail(req.error || new Error("idb-open")); };
    req.onblocked = function () { fail(new Error("idb-blocked")); };
  });
  historyDbPromise = p;
  p.then(null, function () { if (historyDbPromise === p) historyDbPromise = null; });
  return p;
}

function idbReq(req) {
  return new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

/* Runs body(tx) inside one transaction and resolves with its result only
   after the transaction COMMITS — a snapshot is "stored" when the browser
   says so, not when the last request came back.

   WHY awaiting inside the transaction is safe here: the body awaits only
   IndexedDB request promises. Each resolves inside the request's success
   event, and its continuation runs in that event's microtask checkpoint,
   while the transaction is still active. Awaiting anything else (a timer,
   fetch, storage.estimate) would let it auto-commit half done — which is
   why the cap is computed BEFORE a transaction starts and passed in. */
function idbRun(storeNames, mode, body) {
  return openHistoryDb().then(function (db) {
    var tx = mode === "readwrite"
      ? db.transaction(storeNames, "readwrite", { durability: "strict" })
      : db.transaction(storeNames, "readonly");
    var done = new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onabort = function () { reject(tx.error || new Error("transaction aborted")); };
      tx.onerror = function () { /* onabort follows and carries the reason */ };
    });
    done.then(null, historyNoop);
    var result, started;
    /* body(tx) runs synchronously, in the same turn the transaction was
       created, so its first requests can never find it already inactive. */
    try { started = Promise.resolve(body(tx)); } catch (e) { started = Promise.reject(e); }
    return started.then(function (r) {
      result = r;
      return done;
    }, function (e) {
      try { tx.abort(); } catch (x) { /* already finished or aborting */ }
      return done.then(function () { throw e; }, function (txErr) {
        /* Prefer the transaction's own reason (QuotaExceededError arrives
           there) over a request's generic AbortError. */
        throw (txErr && txErr.name && txErr.name !== "AbortError") ? txErr : e;
      });
    }).then(function () { return result; });
  });
}

function historyDocRange(bucket) {
  return IDBKeyRange.bound([bucket, -Infinity], [bucket, Infinity]);
}

function historyStripMeta(m) {
  var out = sanitizeHistoryMeta(m);
  if (out && typeof m.docId === "string") out.docId = m.docId;
  return out;
}

/* Deletes the oldest metas of `bucket` (by the byDocAt index) until the
   record holds at most HISTORY_PER_DOC. Synchronous cursor callbacks, so it
   stays inside the caller's transaction. Never deletes keepId, nor a
   snapshot a restore is holding (protectHistorySnapshot). */
function idbTrimBucket(tx, bucket, rec, keepId) {
  var over = rec.count - HISTORY_PER_DOC;
  if (over <= 0) return Promise.resolve(0);
  var metaStore = tx.objectStore("snapMeta");
  var bodyStore = tx.objectStore("snapBody");
  var trimmed = 0;
  return new Promise(function (resolve, reject) {
    var req = metaStore.index("byDocAt").openCursor(historyDocRange(bucket));
    req.onsuccess = function () {
      var cur = req.result;
      if (!cur || over <= 0) { resolve(trimmed); return; }
      var v = cur.value;
      if (v.id !== keepId && !historyIsProtected(bucket, v.id)) {
        cur.delete();
        bodyStore.delete([bucket, v.id]);
        rec.bytes = Math.max(0, rec.bytes - (Number(v.sizeBytes) || 0));
        rec.count--;
        over--;
        trimmed++;
      }
      cur.continue();
    };
    req.onerror = function () { reject(req.error); };
  });
}

/* Browser cap from navigator.storage.estimate(), cached 5 minutes (real
   time, not historyNow — the cache is about how often we ask the browser).
   The estimate's usage includes history as it was THEN, so the history
   bytes at estimate time are cached with it; mixing an old usage with
   today's history size would misjudge "everything else". No estimate at
   all → no cap of our own; the browser's quota error still triggers the
   evict-and-retry path. */
var historyCapOverride = null;
var historyEstimateCache = null;

function historyBrowserCap(historyBytes) {
  if (historyCapOverride != null) return Promise.resolve(historyCapOverride);
  var c = historyEstimateCache;
  if (c && Date.now() - c.at < HISTORY_ESTIMATE_TTL_MS) return Promise.resolve(historyCapFrom(c));
  if (!navigator.storage || typeof navigator.storage.estimate !== "function") return Promise.resolve(Infinity);
  return navigator.storage.estimate().then(function (est) {
    if (!est || !isFinite(Number(est.quota))) return Infinity;
    historyEstimateCache = { at: Date.now(), quota: Number(est.quota), usage: Number(est.usage) || 0, historyBytes: historyBytes };
    return historyCapFrom(historyEstimateCache);
  }, function () { return Infinity; });
}

function historyCapFrom(c) {
  var other = Math.max(0, c.usage - c.historyBytes);
  return Math.max(HISTORY_BROWSER_MIN_CAP, c.quota - other - HISTORY_BROWSER_HEADROOM);
}

/* "A QuotaExceededError → evict, then retry once" — shared by the idb and
   memory backends. The retry's cap is the normal cap lowered by the size of
   the snapshot being written: evicting under the normal cap alone frees
   nothing when the browser's real quota is what refused us. Anything other
   than quota is an 'io' failure and is not retried here (the caller keeps
   the entry pending).

   WHY historyQuotaStuck. The eviction is committed before the retry runs
   and cannot be undone. When the retry is refused too (other storage holds
   the quota, or Chromium has not compacted the deletes yet), evicting again
   on the next capture would delete roughly one more snapshot per capture —
   the Older bucket, then every document down to its newest — while nothing
   new is stored at all. So after one evict-and-retry has failed, later quota
   refusals go straight to 'quota' (the entry stays pending) until some
   write is stored again. Every put still makes its first attempt, so space
   freed elsewhere is picked up; at worst one eviction runs per page load. */
var historyQuotaStuck = false;

function historyPutWithQuotaRetry(backend, bucket, meta, stateJson) {
  /* Public puts are per document only — the Older bucket is written by
     importOlder alone. A bad argument can never succeed, so it is reported
     'invalid' (and dropped by the caller) rather than retried as pending. */
  if (!normalizeDocId(bucket) || !sanitizeHistoryMeta(meta) || typeof stateJson !== "string") {
    return Promise.resolve({ stored: false, code: "invalid" });
  }
  var size = historyUtf8Length(stateJson);
  function attempt() { return backend.putOnce(bucket, meta, stateJson, size); }
  function after(r, evictedBefore) {
    return backend.usage().then(function (u) {
      var out = { stored: true, evicted: evictedBefore || 0, overCap: false };
      if (r.duplicate) out.duplicate = true;
      if (!(u.totalBytes > u.capBytes)) return out;
      return backend.evict(u.capBytes).then(function (ev) {
        out.evicted += ev.evicted;
        out.overCap = !!ev.overCap;
        return out;
      });
    }).then(null, function () { return { stored: true, evicted: evictedBefore || 0 }; });
  }
  return attempt().then(function (r) { historyQuotaStuck = false; return after(r, 0); }, function (e) {
    if (!isQuotaError(e)) return { stored: false, code: "io" };
    if (historyQuotaStuck) return { stored: false, code: "quota", evicted: 0, overCap: true };
    var evicted = 0;
    return backend.usage().then(function (u) {
      var cap = Math.min(u.capBytes, Math.max(0, u.totalBytes - size));
      return backend.evict(cap);
    }).then(function (ev) { evicted = ev.evicted; }, historyNoop).then(function () {
      return attempt().then(function (r) { historyQuotaStuck = false; return after(r, evicted); }, function (e2) {
        if (isQuotaError(e2)) historyQuotaStuck = true;
        return { stored: false, code: isQuotaError(e2) ? "quota" : "io", evicted: evicted, overCap: true };
      });
    });
  });
}

/* historyStampAfter — why a put stamps strictly after the newest snapshot
   already in its bucket — is shared/history-policy.js's (#76). Imported and
   re-exported at the top of this file. */

/* Snapshots a restore is reading right now: bucket + "\n" + id → hold
   count. WHY: restoreSnapshot reads a snapshot, stores a "Before
   restoring" backup, and only then adopts. That backup's write may evict
   (the quota retry, the over-cap pass, the per-document trim) and the
   Older bucket is evicted first — so without a hold, restoring from Older
   while storage is tight could delete the very snapshot being restored,
   and the "restore anyway" click would find it gone. Every eviction plan
   and trim in this file skips a held snapshot. */
var historyProtected = {};

function historyProtectKey(bucket, id) { return bucket + "\n" + id; }

function historyIsProtected(bucket, id) {
  return Object.prototype.hasOwnProperty.call(historyProtected, historyProtectKey(bucket, id));
}

function historyProtectedList() {
  return Object.keys(historyProtected).map(function (k) {
    var i = k.indexOf("\n");
    return { docId: k.slice(0, i), id: k.slice(i + 1) };
  });
}

/* ({docId?, older?, id}) — getHistorySnapshot's query shape → release().
   Holds nest (a count per snapshot), and a release runs at most once. An
   unusable query holds nothing and returns a no-op. */
export function protectHistorySnapshot(q) {
  q = q || {};
  var id = typeof q.id === "string" ? q.id : "";
  var bucket = q.older ? HISTORY_OLDER_KEY : normalizeDocId(q.docId);
  if (!bucket || !HISTORY_SNAP_ID_RE.test(id)) return historyNoop;
  var key = historyProtectKey(bucket, id);
  var holds = historyProtected;
  holds[key] = (holds[key] || 0) + 1;
  var released = false;
  return function () {
    if (released) return;
    released = true;
    /* resetForTest may have replaced the map meanwhile; then there is
       nothing of ours left to release */
    if (holds !== historyProtected || !holds[key]) return;
    if (holds[key] > 1) holds[key]--; else delete holds[key];
  };
}

/* Record shape in 'docs': {docId|'_older', title, lastOpenedAt (ms), bytes,
   count, migratedAt?, expiresAt?}. bytes/count are kept inside the same
   transaction as every add and delete, and evict() recomputes them from the
   metas, so a counter can never drift for long. */
var idbHistoryBackend = {
  name: "idb",
  persistent: true,

  /* One strict transaction: idempotent get, add meta and body, update the
     record's counters, trim to 50 via the byDocAt cursor. */
  putOnce: function (bucket, meta, stateJson, size) {
    var gate = historyPutFaultGate();
    return Promise.resolve(gate).then(function () {
      historyThrowPutFault();
      return idbRun(["docs", "snapMeta", "snapBody"], "readwrite", function (tx) {
        var metaStore = tx.objectStore("snapMeta");
        var bodyStore = tx.objectStore("snapBody");
        var docsStore = tx.objectStore("docs");
        var rec;
        return idbReq(metaStore.get([bucket, meta.id])).then(function (existing) {
          if (existing) return { duplicate: true };
          return Promise.all([
            idbReq(docsStore.get(bucket)),
            /* the bucket's newest stored snapshot, for historyStampAfter */
            idbReq(metaStore.index("byDocAt").openCursor(historyDocRange(bucket), "prev"))
          ]).then(function (res) {
            var r = res[0], newest = res[1];
            var now = historyNow();
            rec = r || { docId: bucket, title: "", lastOpenedAt: now, bytes: 0, count: 0 };
            var m = historyStampAfter(sanitizeHistoryMeta(meta), newest ? newest.value.atMs : null);
            m.sizeBytes = size;
            m.docId = bucket;
            metaStore.add(m);
            bodyStore.add({ docId: bucket, id: m.id, stateJson: stateJson });
            rec.bytes = (Number(rec.bytes) || 0) + size;
            rec.count = (Number(rec.count) || 0) + 1;
            if (m.title) rec.title = m.title;
            if (bucket !== HISTORY_OLDER_KEY) rec.lastOpenedAt = now;
            return idbTrimBucket(tx, bucket, rec, m.id);
          }).then(function () {
            return idbReq(docsStore.put(rec));
          }).then(function () { return { duplicate: false }; });
        });
      });
    });
  },

  put: function (docId, meta, stateJson) {
    return historyPutWithQuotaRetry(idbHistoryBackend, docId, meta, stateJson);
  },

  list: function (docId) {
    return idbRun(["docs", "snapMeta"], "readonly", function (tx) {
      var idx = tx.objectStore("snapMeta").index("byDocAt");
      var out = { entries: [], older: [], olderExpiresAt: null };
      var jobs = [];
      if (docId) {
        jobs.push(idbReq(idx.getAll(historyDocRange(docId))).then(function (list) { out.entries = list; }));
      }
      jobs.push(idbReq(tx.objectStore("docs").get(HISTORY_OLDER_KEY)).then(function (rec) {
        out.olderRec = rec || null;
      }));
      jobs.push(idbReq(idx.getAll(historyDocRange(HISTORY_OLDER_KEY))).then(function (list) { out.older = list; }));
      return Promise.all(jobs).then(function () { return out; });
    }).then(historyFinishList);
  },

  get: function (bucket, id) {
    return idbRun(["docs", "snapMeta", "snapBody"], "readonly", function (tx) {
      return Promise.all([
        idbReq(tx.objectStore("snapMeta").get([bucket, id])),
        idbReq(tx.objectStore("snapBody").get([bucket, id])),
        bucket === HISTORY_OLDER_KEY ? idbReq(tx.objectStore("docs").get(bucket)) : null
      ]).then(function (pair) {
        if (!pair[0] || !pair[1] || typeof pair[1].stateJson !== "string") return null;
        if (historyOlderExpired(pair[2])) return null;
        return { meta: historyStripMeta(pair[0]), stateJson: pair[1].stateJson };
      });
    });
  },

  /* Idempotent union into `to`, keeping snapshot ids; sets to's
     lastOpenedAt; trims to 50. One strict transaction, so a crash leaves
     either no copy or the whole copy. */
  copy: function (from, to) {
    return idbRun(["docs", "snapMeta", "snapBody"], "readwrite", function (tx) {
      var metaStore = tx.objectStore("snapMeta");
      var bodyStore = tx.objectStore("snapBody");
      var docsStore = tx.objectStore("docs");
      var now = historyNow();
      var copied = 0, fromRec = null, toRec = null, metas = [];
      return Promise.all([
        idbReq(metaStore.index("byDocAt").getAll(historyDocRange(from))),
        idbReq(docsStore.get(from)),
        idbReq(docsStore.get(to))
      ]).then(function (res) {
        metas = res[0] || [];
        fromRec = res[1] || null;
        toRec = res[2] || null;
        if (!toRec && !metas.length) return null;
        toRec = toRec || { docId: to, title: fromRec ? fromRec.title : "", lastOpenedAt: now, bytes: 0, count: 0 };
        var i = 0;
        function next() {
          if (i >= metas.length) return null;
          var m = metas[i++];
          return idbReq(metaStore.get([to, m.id])).then(function (exists) {
            if (exists) return next();
            return idbReq(bodyStore.get([from, m.id])).then(function (body) {
              if (!body || typeof body.stateJson !== "string") return next();
              var copy = sanitizeHistoryMeta(m);
              copy.docId = to;
              metaStore.add(copy);
              bodyStore.add({ docId: to, id: copy.id, stateJson: body.stateJson });
              toRec.bytes = (Number(toRec.bytes) || 0) + copy.sizeBytes;
              toRec.count = (Number(toRec.count) || 0) + 1;
              copied++;
              return next();
            });
          });
        }
        return next();
      }).then(function () {
        if (!toRec) return { ok: true, copied: 0 };
        toRec.lastOpenedAt = now;
        return idbTrimBucket(tx, to, toRec, null).then(function () {
          return idbReq(docsStore.put(toRec));
        }).then(function () { return { ok: true, copied: copied }; });
      });
    });
  },

  /* Touch never creates a record: opening a document that has no history
     yet must not leave an empty row behind for every file ever opened. */
  touch: function (docId, title) {
    return idbRun(["docs"], "readwrite", function (tx) {
      var docsStore = tx.objectStore("docs");
      return idbReq(docsStore.get(docId)).then(function (rec) {
        if (!rec) return null;
        rec.lastOpenedAt = historyNow();
        var t = historyClip(title, 300);
        if (t) rec.title = t;
        return idbReq(docsStore.put(rec));
      });
    });
  },

  /* Put-if-absent into the Older bucket. migratedAt/expiresAt are set only
     when the bucket is created, so re-running the migration never extends
     the 90 days. */
  importOlder: function (entries) {
    if (historyFault === "import-fail") return Promise.resolve({ ok: false, count: 0, added: 0, code: "io" });
    /* The gate is captured at entry, so releasing it lets THIS call through
       even when the test re-arms it in the same turn for the next loop. */
    return Promise.resolve(historyImportFaultGate()).then(function () {
      return idbRun(["docs", "snapMeta", "snapBody"], "readwrite", function (tx) {
        var metaStore = tx.objectStore("snapMeta");
        var bodyStore = tx.objectStore("snapBody");
        var docsStore = tx.objectStore("docs");
        var added = 0, rec = null, i = 0;
        function next() {
          if (i >= entries.length) return null;
          var e = entries[i++];
          return idbReq(metaStore.get([HISTORY_OLDER_KEY, e.meta.id])).then(function (exists) {
            if (exists) return next();
            var m = sanitizeHistoryMeta(e.meta);
            m.sizeBytes = historyUtf8Length(e.stateJson);
            m.docId = HISTORY_OLDER_KEY;
            metaStore.add(m);
            bodyStore.add({ docId: HISTORY_OLDER_KEY, id: m.id, stateJson: e.stateJson });
            rec.bytes = (Number(rec.bytes) || 0) + m.sizeBytes;
            rec.count = (Number(rec.count) || 0) + 1;
            added++;
            return next();
          });
        }
        return idbReq(docsStore.get(HISTORY_OLDER_KEY)).then(function (r) {
          var now = historyNow();
          rec = r || { docId: HISTORY_OLDER_KEY, title: "", lastOpenedAt: 0, bytes: 0, count: 0,
                       migratedAt: now, expiresAt: now + HISTORY_OLDER_TTL_MS };
          return next();
        }).then(function () {
          if (!added && !entries.length) return { ok: true, count: rec.count, added: 0 };
          return idbReq(docsStore.put(rec)).then(function () { return { ok: true, count: rec.count, added: added }; });
        });
      }).then(null, function (e) {
        return { ok: false, count: 0, added: 0, code: isQuotaError(e) ? "quota" : "io" };
      });
    });
  },

  usage: function () {
    return idbRun(["docs"], "readonly", function (tx) {
      return idbReq(tx.objectStore("docs").getAll());
    }).then(function (recs) {
      var total = 0, docCount = 0;
      (recs || []).forEach(function (r) {
        total += Number(r.bytes) || 0;
        if (r.docId !== HISTORY_OLDER_KEY) docCount++;
      });
      return historyBrowserCap(total).then(function (cap) {
        return { totalBytes: total, capBytes: cap, overCap: total > cap, docCount: docCount, readOnly: false };
      });
    });
  },

  /* Plan over every meta, delete in the same strict transaction, and
     recompute each record's counters from what is left — which also heals
     a counter an interrupted older build might have left wrong. */
  evict: function (capBytes) {
    return idbRun(["docs", "snapMeta", "snapBody"], "readwrite", function (tx) {
      var metaStore = tx.objectStore("snapMeta");
      var bodyStore = tx.objectStore("snapBody");
      var docsStore = tx.objectStore("docs");
      return Promise.all([idbReq(docsStore.getAll()), idbReq(metaStore.getAll())]).then(function (res) {
        var recs = res[0] || [], metas = res[1] || [];
        var plan = historyPlanFromRecords(recs, metas, capBytes);
        plan.deletes.forEach(function (d) {
          metaStore.delete([d.docId, d.id]);
          bodyStore.delete([d.docId, d.id]);
        });
        historyRecountRecords(recs, metas, plan.deletes).forEach(function (op) {
          if (op.remove) docsStore.delete(op.rec.docId);
          else docsStore.put(op.rec);
        });
        return { evicted: plan.deletes.length, overCap: plan.overCap, totalBefore: plan.totalBefore, totalAfter: plan.totalAfter };
      });
    });
  },

  /* test-only reads (window.__historyTest) */
  rawList: function (bucket) {
    return idbRun(["snapMeta"], "readonly", function (tx) {
      return idbReq(tx.objectStore("snapMeta").index("byDocAt").getAll(historyDocRange(bucket)));
    });
  },
  /* Every document id this backend can enumerate, Older excluded — the
     export read path (exportHistoryAll). null means "cannot enumerate",
     which only the desktop backend answers. */
  rawDocIds: function () {
    return idbRun(["docs"], "readonly", function (tx) {
      return idbReq(tx.objectStore("docs").getAllKeys());
    }).then(function (keys) {
      return (keys || []).filter(function (k) { return k !== HISTORY_OLDER_KEY; });
    });
  },
  rawBodyCount: function (bucket) {
    return idbRun(["snapBody"], "readonly", function (tx) {
      var s = tx.objectStore("snapBody");
      /* snapBody's key is [docId, id] with a STRING id, and IndexedDB
         orders every string after every number — so the numeric range the
         byDocAt index uses would match nothing here. "" is the smallest
         string and [] sorts after all strings. */
      return idbReq(bucket ? s.count(IDBKeyRange.bound([bucket, ""], [bucket, []])) : s.count());
    });
  },
  rawDoc: function (bucket) {
    return idbRun(["docs"], "readonly", function (tx) {
      return idbReq(tx.objectStore("docs").get(bucket));
    }).then(function (r) { return r || null; });
  }
};

/* Shared by idb and memory evict(): records + flat metas → planner input. */
function historyPlanFromRecords(recs, metas, capBytes) {
  var byDoc = {};
  (recs || []).forEach(function (r) {
    byDoc[r.docId] = { docId: r.docId, lastOpenedAt: r.lastOpenedAt, expiresAt: r.expiresAt, snapshots: [] };
  });
  (metas || []).forEach(function (m) {
    if (!byDoc[m.docId]) byDoc[m.docId] = { docId: m.docId, lastOpenedAt: 0, snapshots: [] };
    byDoc[m.docId].snapshots.push({ id: m.id, atMs: m.atMs, sizeBytes: m.sizeBytes });
  });
  var docs = Object.keys(byDoc).map(function (k) { return byDoc[k]; });
  return planHistoryEviction(docs, capBytes, historyNow(), {
    perDoc: HISTORY_PER_DOC, olderKey: HISTORY_OLDER_KEY, protect: historyProtectedList()
  });
}

/* Which records to rewrite after deletes: counters recomputed from the
   surviving metas; a record left with nothing is removed (an expired Older
   bucket goes as a whole, so a later migration starts a fresh 90 days). */
function historyRecountRecords(recs, metas, deletes) {
  var gone = {};
  deletes.forEach(function (d) { gone[d.docId + "\n" + d.id] = true; });
  var tally = {};
  metas.forEach(function (m) {
    if (gone[m.docId + "\n" + m.id]) return;
    var t = tally[m.docId] || (tally[m.docId] = { bytes: 0, count: 0 });
    t.bytes += Number(m.sizeBytes) || 0;
    t.count++;
  });
  var ops = [];
  recs.forEach(function (r) {
    var t = tally[r.docId] || { bytes: 0, count: 0 };
    if (!t.count) { ops.push({ remove: true, rec: r }); return; }
    if (r.bytes !== t.bytes || r.count !== t.count) {
      r.bytes = t.bytes;
      r.count = t.count;
      ops.push({ remove: false, rec: r });
    }
  });
  return ops;
}

/* Expired Older bucket → reported empty, and its delete queued (the list
   is a read and must not write inside its own transaction). Sorted newest
   first for display. */
/* One expiry test for list() and get(): a restore must not reach a
   snapshot the panel has already stopped showing. A record without a
   numeric expiresAt never expires. */
function historyOlderExpired(rec) {
  if (!rec || rec.expiresAt == null || !isFinite(Number(rec.expiresAt))) return false;
  return historyNow() >= Number(rec.expiresAt);
}

function historyFinishList(out) {
  var rec = out.olderRec || null;
  var expiresAt = rec && rec.expiresAt != null && isFinite(Number(rec.expiresAt)) ? Number(rec.expiresAt) : null;
  var older = (out.older || []).map(historyStripMeta).filter(Boolean);
  if (historyOlderExpired(rec)) {
    if (older.length || rec) {
      enqueueHistory(function () {
        return resolveHistoryBackend().then(function (b) { return b.evict(Infinity); });
      }, null);
    }
    older = [];
    expiresAt = null;
  }
  function newestFirst(a, b) { return (b.atMs - a.atMs) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0); }
  return {
    entries: (out.entries || []).map(historyStripMeta).filter(Boolean).sort(newestFirst),
    older: older.sort(newestFirst),
    olderExpiresAt: expiresAt
  };
}

/* ---- memory backend ----
   Same API, persistent:false. Used when IndexedDB cannot open (blocked,
   disabled, a sandboxed frame) so capture, restore and copy still work for
   as long as the page lives. It never takes part in the migration: moving
   the legacy key into RAM and then deleting it would lose it at close. */
var historyMem = { docs: {}, snaps: {} };

function memBucket(bucket) {
  return historyMem.snaps[bucket] || (historyMem.snaps[bucket] = {});
}

function memMetasSorted(bucket) {
  var b = historyMem.snaps[bucket] || {};
  return Object.keys(b).map(function (k) { return b[k].meta; }).sort(function (x, y) {
    return (x.atMs - y.atMs) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  });
}

function memTrim(bucket, rec, keepId) {
  var metas = memMetasSorted(bucket), b = memBucket(bucket), i = 0;
  while (rec.count > HISTORY_PER_DOC && i < metas.length) {
    var m = metas[i++];
    if (m.id === keepId || historyIsProtected(bucket, m.id)) continue;
    delete b[m.id];
    rec.bytes = Math.max(0, rec.bytes - m.sizeBytes);
    rec.count--;
  }
}

var memoryHistoryBackend = {
  name: "memory",
  persistent: false,

  putOnce: function (bucket, meta, stateJson, size) {
    var gate = historyPutFaultGate();
    return Promise.resolve(gate).then(function () {
      historyThrowPutFault();
      var b = memBucket(bucket);
      if (b[meta.id]) return { duplicate: true };
      var now = historyNow();
      var rec = historyMem.docs[bucket] || (historyMem.docs[bucket] = { docId: bucket, title: "", lastOpenedAt: now, bytes: 0, count: 0 });
      var have = memMetasSorted(bucket);
      var m = historyStampAfter(sanitizeHistoryMeta(meta), have.length ? have[have.length - 1].atMs : null);
      m.sizeBytes = size;
      m.docId = bucket;
      b[m.id] = { meta: m, stateJson: stateJson };
      rec.bytes += size;
      rec.count++;
      if (m.title) rec.title = m.title;
      if (bucket !== HISTORY_OLDER_KEY) rec.lastOpenedAt = now;
      memTrim(bucket, rec, m.id);
      return { duplicate: false };
    });
  },

  put: function (docId, meta, stateJson) {
    return historyPutWithQuotaRetry(memoryHistoryBackend, docId, meta, stateJson);
  },

  list: function (docId) {
    return Promise.resolve(historyFinishList({
      entries: docId ? memMetasSorted(docId) : [],
      older: memMetasSorted(HISTORY_OLDER_KEY),
      olderRec: historyMem.docs[HISTORY_OLDER_KEY] || null
    }));
  },

  get: function (bucket, id) {
    if (bucket === HISTORY_OLDER_KEY && historyOlderExpired(historyMem.docs[bucket])) return Promise.resolve(null);
    var e = (historyMem.snaps[bucket] || {})[id];
    return Promise.resolve(e ? { meta: historyStripMeta(e.meta), stateJson: e.stateJson } : null);
  },

  copy: function (from, to) {
    var src = memMetasSorted(from);
    var toRec = historyMem.docs[to] || null;
    if (!toRec && !src.length) return Promise.resolve({ ok: true, copied: 0 });
    var now = historyNow();
    var fromRec = historyMem.docs[from];
    toRec = toRec || (historyMem.docs[to] = { docId: to, title: fromRec ? fromRec.title : "", lastOpenedAt: now, bytes: 0, count: 0 });
    var dst = memBucket(to), copied = 0;
    src.forEach(function (m) {
      if (dst[m.id]) return;
      var body = historyMem.snaps[from][m.id];
      var copy = sanitizeHistoryMeta(m);
      copy.docId = to;
      dst[copy.id] = { meta: copy, stateJson: body.stateJson };
      toRec.bytes += copy.sizeBytes;
      toRec.count++;
      copied++;
    });
    toRec.lastOpenedAt = now;
    memTrim(to, toRec, null);
    return Promise.resolve({ ok: true, copied: copied });
  },

  touch: function (docId, title) {
    var rec = historyMem.docs[docId];
    if (rec) {
      rec.lastOpenedAt = historyNow();
      var t = historyClip(title, 300);
      if (t) rec.title = t;
    }
    return Promise.resolve();
  },

  importOlder: function (entries) {
    if (historyFault === "import-fail") return Promise.resolve({ ok: false, count: 0, added: 0, code: "io" });
    /* Gated like the idb copy, so 'delay-import' means the same thing on
       whichever backend a test happens to be running. */
    return Promise.resolve(historyImportFaultGate()).then(function () {
      var now = historyNow();
      var rec = historyMem.docs[HISTORY_OLDER_KEY];
      if (!rec && !entries.length) return { ok: true, count: 0, added: 0 };
      rec = rec || (historyMem.docs[HISTORY_OLDER_KEY] = { docId: HISTORY_OLDER_KEY, title: "", lastOpenedAt: 0, bytes: 0, count: 0,
                                                            migratedAt: now, expiresAt: now + HISTORY_OLDER_TTL_MS });
      var b = memBucket(HISTORY_OLDER_KEY), added = 0;
      entries.forEach(function (e) {
        if (b[e.meta.id]) return;
        var m = sanitizeHistoryMeta(e.meta);
        m.sizeBytes = historyUtf8Length(e.stateJson);
        m.docId = HISTORY_OLDER_KEY;
        b[m.id] = { meta: m, stateJson: e.stateJson };
        rec.bytes += m.sizeBytes;
        rec.count++;
        added++;
      });
      return { ok: true, count: rec.count, added: added };
    });
  },

  usage: function () {
    var total = 0, docCount = 0;
    Object.keys(historyMem.docs).forEach(function (k) {
      total += historyMem.docs[k].bytes;
      if (k !== HISTORY_OLDER_KEY) docCount++;
    });
    var cap = historyCapOverride != null ? historyCapOverride : HISTORY_MEMORY_CAP;
    return Promise.resolve({ totalBytes: total, capBytes: cap, overCap: total > cap, docCount: docCount, readOnly: false });
  },

  evict: function (capBytes) {
    var recs = Object.keys(historyMem.docs).map(function (k) { return historyMem.docs[k]; });
    var metas = [];
    Object.keys(historyMem.snaps).forEach(function (k) { metas = metas.concat(memMetasSorted(k)); });
    var plan = historyPlanFromRecords(recs, metas, capBytes);
    plan.deletes.forEach(function (d) {
      if (historyMem.snaps[d.docId]) delete historyMem.snaps[d.docId][d.id];
    });
    historyRecountRecords(recs, metas, plan.deletes).forEach(function (op) {
      if (op.remove) { delete historyMem.docs[op.rec.docId]; delete historyMem.snaps[op.rec.docId]; }
    });
    return Promise.resolve({ evicted: plan.deletes.length, overCap: plan.overCap, totalBefore: plan.totalBefore, totalAfter: plan.totalAfter });
  },

  rawList: function (bucket) { return Promise.resolve(memMetasSorted(bucket)); },
  rawBodyCount: function (bucket) {
    var n = 0;
    Object.keys(historyMem.snaps).forEach(function (k) {
      if (!bucket || k === bucket) n += Object.keys(historyMem.snaps[k]).length;
    });
    return Promise.resolve(n);
  },
  rawDoc: function (bucket) { return Promise.resolve(historyMem.docs[bucket] || null); },
  rawDocIds: function () {
    return Promise.resolve(Object.keys(historyMem.docs).filter(function (k) { return k !== HISTORY_OLDER_KEY; }));
  }
};

/* ---- desktop backend (HISTORY-IPC) ----

   On the desktop the store is a folder tree under userData, and the MAIN
   process owns all of it — validation, the on-disk format, the per-document
   trim, eviction (desktop/main.js section 8b). So this object is a thin
   translator with no putOnce and no evict of its own: it reshapes main's
   answers into the same HistoryWriteResult / list / usage shapes the
   IndexedDB and memory backends return, and nothing above it has to know
   which one it is talking to.

   WHY EVERY CALL IS RACED. An invoke that never settles — main wedged
   behind a slow disk, this view torn off mid-call, a handler that threw
   before replying — would hold the one history queue (enqueueHistory) for
   the life of the page. The snapshot would not even be reported as failed;
   it would simply hang, never becoming 'pending', so nothing would ever
   retry it. Thirty seconds, then code 'timeout' and the entry stays this
   page's to retry.

   WHY A REJECTION IS 'invalid'. Main answers a value for everything a
   retry could fix (a full disk, an I/O error, a read-only folder, a body
   over 256 MiB) and rejects ONLY when the call itself was malformed. An
   entry that can never succeed is dropped rather than held in RAM forever
   (historyStoreEntry). */
var HISTORY_DESKTOP_TIMEOUT_MS = 30000;
/* test hook setDesktopTimeout(): a suite cannot wait 30 s for each case */
var historyDesktopTimeoutOverride = null;

function historyDesktopCall(run, onTimeout, onReject) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = null;
    function finish(v) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    }
    timer = setTimeout(function () { finish(onTimeout); },
      historyDesktopTimeoutOverride != null ? historyDesktopTimeoutOverride : HISTORY_DESKTOP_TIMEOUT_MS);
    var p;
    try { p = run(); } catch (e) {
      if (window.console) console.error(e);
      finish(onReject);
      return;
    }
    Promise.resolve(p).then(finish, function (e) {
      if (window.console) console.error(e);
      finish(onReject);
    });
  });
}

var desktopHistoryBackend = {
  name: "desktop",
  persistent: true,

  /* Main does the quota retry and the eviction, so there is no
     historyPutWithQuotaRetry here — its answer already says how many
     snapshots went and whether we are still over the cap. The held
     snapshots travel WITH the call (orchestrator override §2b): a restore
     from Older is reading one of them while this very write may be what
     forces an eviction. */
  put: function (docId, meta, stateJson) {
    var clean = sanitizeHistoryMeta(meta);
    if (!normalizeDocId(docId) || !clean || typeof stateJson !== "string") {
      return Promise.resolve({ stored: false, code: "invalid" });
    }
    return historyDesktopCall(function () {
      return S.DESKTOP.historyPut(docId, clean, stateJson, historyProtectedList());
    }, { stored: false, code: "timeout" }, { stored: false, code: "invalid" }).then(function (r) {
      if (!r || typeof r !== "object") return { stored: false, code: "io" };
      if (r.stored === false) return r;           /* our own timeout/invalid answer */
      if (!r.ok) return { stored: false, code: typeof r.code === "string" ? r.code : "io" };
      var out = { stored: true, evicted: Number(r.evicted) || 0, overCap: !!r.overCap };
      if (r.duplicate) out.duplicate = true;
      return out;
    });
  },

  /* opts.strict (importHistoryBundle only): a timeout, a rejection or a
     malformed answer resolves null instead of "empty". Every other caller
     wants the panel to degrade to an empty list; the import must be able
     to tell "this document has no history" from "could not read it",
     because treating the second as the first would let its puts trim
     genuine local snapshots away (invariant #49). */
  list: function (docId, opts) {
    var empty = { entries: [], older: [], olderExpiresAt: null };
    var failed = (opts && opts.strict) ? null : empty;
    return historyDesktopCall(function () {
      return S.DESKTOP.historyList(docId || null);
    }, failed, failed).then(function (r) {
      if (!r || typeof r !== "object") return failed;
      /* an answer with no entries array cannot say "no history" either */
      if (opts && opts.strict && docId && !Array.isArray(r.entries)) return null;
      /* Main sends metas with no document id in them (on disk the folder
         IS the document), so stamp it back on for the panel — the other
         two backends carry it on every meta they hand out. */
      var entries = (r.entries || []).map(historyStripMeta).filter(Boolean);
      if (docId) entries.forEach(function (m) { m.docId = docId; });
      var older = (r.older || []).map(historyStripMeta).filter(Boolean);
      older.forEach(function (m) { m.docId = HISTORY_OLDER_KEY; });
      return {
        entries: entries,
        older: older,
        olderExpiresAt: r.olderExpiresAt == null ? null : Number(r.olderExpiresAt)
      };
    });
  },

  /* The held snapshots ride along on the READ as well as the write, in the
     query object (the bridge passes it through whole). A restore takes its
     hold and then reads — and main's eviction is process-wide, so between
     that read and the "Before restoring" backup that follows it, a save in
     ANOTHER tab, a history-copy or the expired-Older sweep could delete the
     snapshot being read. Main remembers the list per page, so telling it at
     the first call of a restore is what closes that window. */
  get: function (bucket, id) {
    var query = bucket === HISTORY_OLDER_KEY
      ? { older: true, protect: historyProtectedList() }
      : { docId: bucket, protect: historyProtectedList() };
    return historyDesktopCall(function () {
      return S.DESKTOP.historyGet(query, id);
    }, null, null).then(function (r) {
      if (!r || typeof r !== "object" || typeof r.stateJson !== "string") return null;
      var meta = historyStripMeta(r.meta);
      if (!meta) return null;
      meta.docId = bucket;
      return { meta: meta, stateJson: r.stateJson };
    });
  },

  copy: function (from, to) {
    return historyDesktopCall(function () {
      return S.DESKTOP.historyCopy(from, to);
    }, { ok: false, copied: 0, code: "timeout" }, { ok: false, copied: 0, code: "invalid" })
      .then(function (r) {
        if (!r || typeof r !== "object") return { ok: false, copied: 0, code: "io" };
        return { ok: !!r.ok, copied: Number(r.copied) || 0, code: r.code };
      });
  },

  touch: function (docId, title) {
    return historyDesktopCall(function () {
      return S.DESKTOP.historyTouch(docId, title);
    }, null, null);
  },

  importOlder: function (entries) {
    return historyDesktopCall(function () {
      return S.DESKTOP.historyImportOlder(entries);
    }, { ok: false, count: 0, added: 0, code: "timeout" }, { ok: false, count: 0, added: 0, code: "invalid" })
      .then(function (r) {
        if (!r || typeof r !== "object") return { ok: false, count: 0, added: 0, code: "io" };
        return { ok: !!r.ok, count: Number(r.count) || 0, added: Number(r.added) || 0, code: r.code };
      });
  },

  usage: function () {
    var unknown = { totalBytes: 0, capBytes: Infinity, overCap: false, docCount: 0, readOnly: false };
    return historyDesktopCall(function () {
      return S.DESKTOP.historyUsage();
    }, unknown, unknown).then(function (r) {
      if (!r || typeof r !== "object") return unknown;
      return {
        totalBytes: Number(r.totalBytes) || 0,
        capBytes: Number(r.capBytes) || 0,
        overCap: !!r.overCap,
        docCount: Number(r.docCount) || 0,
        readOnly: !!r.readOnly
      };
    });
  },

  /* Main evicts as part of every write it accepts, including the expired
     Older bucket a list() reports empty — so there is nothing for this side
     to ask for. It stays a function because runHistoryMigration's expiry
     sweep and historyFinishList both probe for one. */
  evict: function () { return Promise.resolve({ evicted: 0, overCap: false, totalBefore: 0, totalAfter: 0 }); },

  /* Every document id this backend can enumerate, Older excluded — backs
     exportHistoryAll() the same way the idb/memory backends' own
     rawDocIds do. DESKTOP.historyListDocs() (desktop/main.js) walks main's
     in-memory index, which the fsck keeps current, so this never touches
     disk itself. Still null on a timeout/rejection/malformed answer, which
     is exportHistoryAll()'s "cannot enumerate" signal — but a working
     bridge never returns it, so an older desktop build without this
     method (or a real I/O problem) is the only way export still sees the
     browser-only refusal. */
  rawDocIds: function () {
    return historyDesktopCall(function () {
      return S.DESKTOP.historyListDocs();
    }, null, null).then(function (r) {
      if (!Array.isArray(r)) return null;
      var ids = [];
      r.forEach(function (d) {
        var id = normalizeDocId(d && d.docId);
        if (id) ids.push(id);
      });
      return ids;
    });
  },

  /* {title, lastOpenedAt} for one document — historyBuildExport's other
     half of "docs" alongside rawList. Re-fetches the same full list
     historyListDocs() answers rather than caching it: export runs once, on
     demand, for at most a few dozen documents, and a cache here would be
     one more place for this file's per-page state to drift from main's. */
  rawDoc: function (bucket) {
    return historyDesktopCall(function () {
      return S.DESKTOP.historyListDocs();
    }, null, null).then(function (r) {
      if (!Array.isArray(r)) return null;
      var hit = null;
      r.forEach(function (d) {
        if (d && normalizeDocId(d.docId) === bucket) hit = d;
      });
      return hit ? { title: hit.title || "", lastOpenedAt: Number(hit.lastOpenedAt) || 0 } : null;
    });
  },

  /* Raw metas for one bucket (a document, or HISTORY_OLDER_KEY), oldest-
     or-newest order does not matter — historyFlattenForExport sorts its
     own flattened list. Reuses this backend's own list() (above), which
     already turns a DESKTOP.historyList() answer into sanitized metas;
     list(null) asks for "no document, just tell me what's in Older". */
  rawList: function (bucket) {
    var docId = bucket === HISTORY_OLDER_KEY ? null : bucket;
    return desktopHistoryBackend.list(docId).then(function (r) {
      if (!r) return [];
      return bucket === HISTORY_OLDER_KEY ? r.older : r.entries;
    });
  }
};

/* ---- backend choice (per call) ----

   desktop when the bridge has history; else IndexedDB once it has opened;
   else memory. An IndexedDB that fails to open is not retried for the rest
   of this page: flipping between memory and IndexedDB mid-session would
   scatter one document's history across two stores, and the memory half
   would vanish at close while the panel had shown it as one list. */
var historyForced = null;          /* test hook: 'idb' | 'memory' | null */
var historyIdbFailed = false;
var historyBackendNameNow = null;

function resolveHistoryBackend() {
  if (historyForced === "memory") { historyBackendNameNow = "memory"; return Promise.resolve(memoryHistoryBackend); }
  if (!historyForced && S.DESKTOP && typeof S.DESKTOP.historyPut === "function") {
    historyBackendNameNow = "desktop";
    return Promise.resolve(desktopHistoryBackend);
  }
  if (historyIdbFailed) { historyBackendNameNow = "memory"; return Promise.resolve(memoryHistoryBackend); }
  return openHistoryDb().then(function () {
    historyBackendNameNow = "idb";
    return idbHistoryBackend;
  }, function (e) {
    historyIdbFailed = true;
    if (window.console) console.warn("Version history: IndexedDB unavailable, keeping history in memory", e);
    historyBackendNameNow = "memory";
    return memoryHistoryBackend;
  });
}

/* ---- eviction planner ----

   planHistoryEviction lives in shared/history-policy.js (#76) — what the
   browser and the desktop app expire, trim and evict has to be one
   decision, and it used to be two line-for-line copies kept honest by a
   smoke test that compared them over CDP. It is imported and re-exported at
   the top of this file, so the callers in this module and everything that
   imports it still name it the same way; src/test/history-eviction.test.mjs
   imports it straight from shared/, and window.__historyTest.planEviction
   — which existed only for that smoke case to drive — is gone with it. */

/* ---- capture ---- */

/* The one pristine test (shared with the tab shell): the demo document
   exactly as shipped, never touched, with no home. Snapshotting it would
   fill every new user's history with copies of the seed before they have
   typed a word. */
export function isPristineSeedDocument() {
  return !!S.state && S.editSeq === 0 && !S.dirty && home.kind === "none" && seedCheckPasses();
}

/* Snapshots this page has captured but not (yet) stored, keyed
   docId + "/" + id (a copy can put one id under two documents):
     {docId, meta, stateJson, status: 'writing' | 'pending'}
   'writing' is queued; 'pending' failed and waits for the next successful
   write to retry it. The panel and getHistorySnapshot read these first, so
   a snapshot is restorable the moment it is captured. */
var historyLocal = {};
var historyWarnedDocs = {};
var historyLastAtMs = 0;
var historyRetryQueued = false;

function historyLocalKey(docId, id) { return docId + "/" + id; }

function historyLocalEntries(docId, status) {
  return Object.keys(historyLocal).map(function (k) { return historyLocal[k]; }).filter(function (e) {
    return (!docId || e.docId === docId) && (!status || e.status === status);
  }).sort(function (a, b) { return a.meta.atMs - b.meta.atMs; });
}

function historyRenderSoon() {
  if (typeof renderHistory !== "function") return;
  try {
    var p = renderHistory();
    if (p && typeof p.then === "function") p.then(historyNoop, historyNoop);
  } catch (e) { if (window.console) console.error(e); }
}

/* Pending entries are whole documents held in RAM, so each document keeps
   at most HISTORY_PENDING_PER_DOC of them — the newest. */
function historyMarkPending(entry) {
  entry.status = "pending";
  var mine = historyLocalEntries(entry.docId, "pending");
  while (mine.length > HISTORY_PENDING_PER_DOC) {
    var old = mine.shift();
    delete historyLocal[historyLocalKey(old.docId, old.meta.id)];
  }
  if (!historyWarnedDocs[entry.docId]) {
    historyWarnedDocs[entry.docId] = true;
    try {
      showToast("Couldn't store a version history snapshot. It is kept in this window and will be " +
        "tried again — closing the window before then loses it.", "warn");
    } catch (e) { /* a toast is a courtesy */ }
  }
}

function historyStoreEntry(backend, entry) {
  entry.status = "writing";
  return backend.put(entry.docId, entry.meta, entry.stateJson).then(function (r) {
    r = r || { stored: false, code: "io" };
    var key = historyLocalKey(entry.docId, entry.meta.id);
    if (r.stored) {
      if (historyLocal[key] === entry) delete historyLocal[key];
    } else if (r.code === "invalid") {
      /* never going to succeed — do not hold it in RAM forever */
      if (historyLocal[key] === entry) delete historyLocal[key];
    } else if (historyLocal[key] === entry) {
      historyMarkPending(entry);
    }
    return r;
  }, function () {
    /* Only an entry this page still holds can be retried; one already
       dropped (the pending cap, resetForTest) must not raise a warning
       about a snapshot that no longer exists anywhere. */
    if (historyLocal[historyLocalKey(entry.docId, entry.meta.id)] === entry) historyMarkPending(entry);
    return { stored: false, code: "io" };
  });
}

/* HISTORY-RENDERER-API captureSnapshot. Synchronous up to the returned
   ticket; the write is queued. Returns null when there is nothing to
   capture (no rows array), when this is the pristine seed and the caller
   allowed skipping it, or when the document cannot be serialized. */
export function captureSnapshot(label, src, opts) {
  opts = opts || {};
  if (!src || typeof src !== "object" || !Array.isArray(src.rows)) return null;
  if (opts.allowSeedSkip && src === S.state && isPristineSeedDocument()) return null;
  var docId = normalizeDocId(src.docId) || (src.docId = mintDocId());
  var stateJson;
  try {
    stateJson = JSON.stringify(src);
  } catch (e) {
    /* RangeError: a string longer than the engine allows (a document full
       of pasted images). Nothing to store; say so once per document. */
    if (!historyWarnedDocs["size:" + docId]) {
      historyWarnedDocs["size:" + docId] = true;
      try { showToast("This document is too large to snapshot — version history is unavailable.", "warn"); } catch (x) {}
    }
    return null;
  }
  if (typeof stateJson !== "string") return null;
  /* Strictly increasing within the page, so a burst inside one millisecond
     still sorts (and trims) in call order. */
  var atMs = historyNow();
  if (atMs <= historyLastAtMs) atMs = historyLastAtMs + 1;
  historyLastAtMs = atMs;
  var id = makeId("s");
  while (!HISTORY_SNAP_ID_RE.test(id) || historyLocal[historyLocalKey(docId, id)]) id = makeId("s");
  var meta = sanitizeHistoryMeta({
    id: id,
    label: label,
    at: new Date(atMs).toISOString(),
    atMs: atMs,
    by: getEditorName(),
    rows: src.rows.length,
    title: typeof src.title === "string" ? src.title : "",
    kind: "snapshot"
  });
  var entry = { docId: docId, meta: meta, stateJson: stateJson, status: "writing" };
  historyLocal[historyLocalKey(docId, id)] = entry;
  var done = enqueueHistory(function () {
    return resolveHistoryBackend().then(function (backend) {
      return historyStoreEntry(backend, entry);
    }).then(function (r) {
      if (r.stored && historyLocalEntries(null, "pending").length) retryPendingSnapshots();
      historyRenderSoon();
      return r;
    });
  }, function () {
    if (historyLocal[historyLocalKey(docId, id)] === entry) historyMarkPending(entry);
    return { stored: false, code: "io" };
  });
  historyRenderSoon();
  return { id: id, docId: docId, done: done };
}

/* Queued after the write that succeeded, oldest pending first; stops at the
   first failure (the store is still refusing — no point hammering it).
   Called from inside a job, so it only queues and never awaits. */
function retryPendingSnapshots() {
  if (historyRetryQueued) return;
  historyRetryQueued = true;
  enqueueHistory(function () {
    historyRetryQueued = false;
    var list = historyLocalEntries(null, "pending");
    if (!list.length) return null;
    return resolveHistoryBackend().then(function (backend) {
      var i = 0;
      function next() {
        if (i >= list.length) return null;
        var entry = list[i++];
        if (historyLocal[historyLocalKey(entry.docId, entry.meta.id)] !== entry) return next();
        return historyStoreEntry(backend, entry).then(function (r) { return r.stored ? next() : null; });
      }
      return next();
    }).then(function () { historyRenderSoon(); });
  }, function () { historyRetryQueued = false; return null; });
}

/* ---- reads and copies ---- */

/* → {entries, older, olderExpiresAt, backend, persistent, usage}. entries
   are this document's local ('writing'/'pending') and stored ('stored')
   snapshots, newest first, one per id. Not queued: a read must not wait
   behind a slow write, and the local entries already show what is queued. */
export function listDocHistory(docId) {
  docId = normalizeDocId(docId);
  /* Local entries are read both BEFORE the backend read and after it. A
     write that commits in between is gone from historyLocal by the time
     the second read runs, yet may be missing from the backend read that
     began earlier — reading only once, afterwards, would drop that
     snapshot from this render. */
  var localBefore = docId ? historyLocalEntries(docId) : [];
  return resolveHistoryBackend().then(function (backend) {
    return Promise.all([
      backend.list(docId || null).then(null, function () { return { entries: [], older: [], olderExpiresAt: null }; }),
      backend.usage().then(null, function () { return null; })
    ]).then(function (res) {
      var listed = res[0] || { entries: [], older: [], olderExpiresAt: null };
      var seen = {}, entries = [];
      (listed.entries || []).forEach(function (m) {
        seen[m.id] = true;
        m.status = "stored";
        entries.push(m);
      });
      if (docId) {
        historyLocalEntries(docId).concat(localBefore).forEach(function (e) {
          if (seen[e.meta.id]) return;
          seen[e.meta.id] = true;
          var m = historyStripMeta(e.meta);
          m.docId = docId;
          m.status = e.status;
          m.sizeBytes = m.sizeBytes || historyUtf8Length(e.stateJson);
          entries.push(m);
        });
      }
      entries.sort(function (a, b) { return b.atMs - a.atMs; });
      return {
        entries: entries,
        older: (listed.older || []).map(function (m) { m.status = "stored"; return m; }),
        olderExpiresAt: listed.olderExpiresAt == null ? null : listed.olderExpiresAt,
        backend: backend.name,
        persistent: !!backend.persistent,
        usage: res[1]
      };
    });
  }).then(null, function (e) {
    if (window.console) console.error(e);
    return { entries: [], older: [], olderExpiresAt: null, backend: historyBackendNameNow, persistent: false, usage: null };
  });
}

/* ({docId?, older?, id}) → {meta, stateJson} | null. Both ids validated
   here (invariant #38); the Older bucket only through older:true. */
export function getHistorySnapshot(q) {
  q = q || {};
  var id = typeof q.id === "string" ? q.id : "";
  if (!HISTORY_SNAP_ID_RE.test(id)) return Promise.resolve(null);
  var bucket;
  if (q.older) {
    bucket = HISTORY_OLDER_KEY;
  } else {
    bucket = normalizeDocId(q.docId);
    if (!bucket) return Promise.resolve(null);
    var local = historyLocal[historyLocalKey(bucket, id)];
    if (local) return Promise.resolve({ meta: historyStripMeta(local.meta), stateJson: local.stateJson });
  }
  return resolveHistoryBackend().then(function (backend) {
    return backend.get(bucket, id);
  }).then(function (r) { return r || null; }, function () { return null; });
}

function historyTouchDocument(docId, title) {
  docId = normalizeDocId(docId);
  if (!docId) return Promise.resolve();
  return enqueueHistory(function () {
    return resolveHistoryBackend().then(function (backend) { return backend.touch(docId, title); });
  }, null);
}

/* Called only by syncDocIdentity (02b-doc-id.js), when the docId|home pair
   changed — not per keystroke, and not from each open path separately. */
export function historyDocumentChanged() {
  if (S.state && normalizeDocId(S.state.docId)) historyTouchDocument(S.state.docId, S.state.title);
  historyRenderSoon();
}

/* HISTORY-RENDERER-API copyHistory. Queued, so it sees every push issued
   before it (those are stored or pending by the time it runs). Copies the
   stored entries through the backend and this page's pending entries as
   pending entries of `to`, keeping ids either way — so a second copy is a
   no-op. Resolves {ok, copied, code?}; never rejects. */
export function copyHistory(from, to) {
  if (from === HISTORY_OLDER_KEY || to === HISTORY_OLDER_KEY) return Promise.resolve({ ok: false, copied: 0, code: "invalid" });
  from = normalizeDocId(from);
  to = normalizeDocId(to);
  if (!from || !to) return Promise.resolve({ ok: false, copied: 0, code: "invalid" });
  if (from === to) return Promise.resolve({ ok: true, copied: 0 });
  return enqueueHistory(function () {
    return resolveHistoryBackend().then(function (backend) {
      /* A failed stored copy must not also skip the pending entries below:
         they are this page's only copy of those snapshots. */
      return backend.copy(from, to).then(null, function (e) {
        if (window.console) console.error(e);
        return { ok: false, copied: 0, code: isQuotaError(e) ? "quota" : "io" };
      });
    }).then(function (r) {
      r = r || { ok: false, copied: 0, code: "io" };
      var extra = 0;
      historyLocalEntries(from, "pending").forEach(function (e) {
        var key = historyLocalKey(to, e.meta.id);
        if (historyLocal[key]) return;
        historyLocal[key] = { docId: to, meta: sanitizeHistoryMeta(e.meta), stateJson: e.stateJson, status: "pending" };
        extra++;
      });
      if (extra) {
        var mine = historyLocalEntries(to, "pending");
        while (mine.length > HISTORY_PENDING_PER_DOC) {
          var old = mine.shift();
          delete historyLocal[historyLocalKey(old.docId, old.meta.id)];
        }
      }
      historyRenderSoon();
      return { ok: !!r.ok, copied: (r.copied || 0) + extra, code: r.code };
    });
  }, function () { return { ok: false, copied: 0, code: "io" }; }).then(function (r) {
    if (r && r.code === undefined) delete r.code;
    return r;
  });
}

/* ---- export (X1: File ▸ Export app data…) ----

   The read path history never needed until now: every existing caller
   wants one document (list/get) or a write. Export wants EVERY document's
   history at once — idb/memory answer that by walking their own store,
   and the desktop backend answers it through DESKTOP.historyListDocs(),
   which walks the folder tree main.js owns. rawDocIds() still returns
   null on a genuine failure (an old desktop build, a rejected/timed-out
   call), and exportHistoryAll() turns that into a rejection with a clear
   code rather than silently exporting an empty bundle. */
var HISTORY_EXPORT_CAP_BYTES = 200 * 1024 * 1024;

function historyExportError(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

/* Every stored snapshot across every document plus Older, newest first,
   tagged with where it came from (docId, or null for Older). Only metas —
   bodies are fetched afterwards, and only for what the cap keeps, so a
   history well past 200 MB does not read every body just to discard most
   of them. */
function historyFlattenForExport(docs, olderMetas) {
  var flat = [];
  docs.forEach(function (d) {
    (d.metas || []).forEach(function (m) {
      flat.push({ docId: d.docId, id: m.id, atMs: m.atMs, sizeBytes: Number(m.sizeBytes) || 0 });
    });
  });
  (olderMetas || []).forEach(function (m) {
    flat.push({ docId: null, id: m.id, atMs: m.atMs, sizeBytes: Number(m.sizeBytes) || 0 });
  });
  flat.sort(function (a, b) { return (b.atMs - a.atMs) || (a.id < b.id ? 1 : -1); });
  return flat;
}

/* Applies the 200 MB total cap, newest snapshots first (so what survives a
   truncated export is always what a user would want back most), then
   fetches only the bodies that made the cut. */
function historyAssembleExport(backend, docs, olderMetas) {
  var flat = historyFlattenForExport(docs, olderMetas);
  var total = 0, truncated = false, keep = {};
  flat.forEach(function (f) {
    var key = (f.docId == null ? "_older" : f.docId) + "\n" + f.id;
    if (total === 0 || total + f.sizeBytes <= HISTORY_EXPORT_CAP_BYTES) {
      total += f.sizeBytes;
      keep[key] = true;
    } else {
      truncated = true;
    }
  });
  var bodyJobs = [];
  docs.forEach(function (d) {
    d.snapshots = [];
    (d.metas || []).forEach(function (m) {
      if (!keep[d.docId + "\n" + m.id]) return;
      bodyJobs.push(backend.get(d.docId, m.id).then(function (r) {
        if (r) d.snapshots.push({ meta: r.meta, stateJson: r.stateJson });
      }));
    });
  });
  var olderOut = [];
  (olderMetas || []).forEach(function (m) {
    if (!keep["_older\n" + m.id]) return;
    bodyJobs.push(backend.get(HISTORY_OLDER_KEY, m.id).then(function (r) {
      if (r) olderOut.push({ meta: r.meta, stateJson: r.stateJson });
    }));
  });
  return Promise.all(bodyJobs).then(function () {
    function newestFirst(a, b) { return b.meta.atMs - a.meta.atMs; }
    docs.forEach(function (d) { d.snapshots.sort(newestFirst); });
    olderOut.sort(newestFirst);
    return {
      docs: docs.map(function (d) {
        return { docId: d.docId, title: d.title, lastOpenedAt: d.lastOpenedAt, snapshots: d.snapshots };
      }),
      older: olderOut,
      truncated: truncated
    };
  });
}

function historyBuildExport(backend, ids) {
  var docJobs = ids.map(function (docId) {
    return Promise.all([backend.rawDoc(docId), backend.rawList(docId)]).then(function (res) {
      var rec = res[0] || null;
      return {
        docId: docId,
        title: rec ? rec.title : "",
        lastOpenedAt: rec ? rec.lastOpenedAt : 0,
        metas: res[1] || []
      };
    });
  });
  return Promise.all(docJobs).then(function (docs) {
    return backend.rawList(HISTORY_OLDER_KEY).then(function (olderMetas) {
      return historyAssembleExport(backend, docs, olderMetas || []);
    });
  });
}

/* HISTORY-RENDERER-API exportHistoryAll (X1). Queued through
   enqueueHistory, so it never reads a document mid-put — but unlike every
   other job on that queue, this one is allowed to REJECT: a caller needs
   to tell "no history at all" apart from "this backend cannot enumerate
   documents" (desktop, today), and enqueueHistory's own contract of never
   rejecting exists to protect the QUEUE, not this one read. The fallback
   below is what turns a thrown error back into a rejection for our caller
   while still leaving the shared chain intact for the next job. */
export function exportHistoryAll() {
  return enqueueHistory(function () {
    return resolveHistoryBackend().then(function (backend) {
      return backend.rawDocIds().then(function (ids) {
        if (ids == null) {
          throw historyExportError("no-enumeration",
            "This app's history cannot be listed on this backend (desktop). Export app data from the browser build instead.");
        }
        return historyBuildExport(backend, ids);
      });
    });
  }, function (e) {
    return Promise.reject(e && e.code ? e : historyExportError("io", "Could not read version history for export."));
  });
}

/* ---- import (X2: File ▸ Import app data…) ----

   THE ONLY WRITE PATH for imported history (invariant #49). Everything an
   app-data file carries — per-document snapshots, the Older bucket, the
   legacy 'splitpage-snapshots' list (20h-appdata.js normalises that one
   and hands it in as Older entries) — reaches storage through here and
   through nothing else, so the rules below hold for every byte of it:

     * MERGE, NEVER REPLACE. Only backend.put (put-if-absent by snapshot id)
       and backend.importOlder (put-if-absent into Older). Nothing here
       deletes, and nothing evicts beyond what a put already does on its
       own (the per-document trim, the over-cap pass, the quota retry).
     * Every id is validated again here, whatever the caller did: a docId
       that is not canonical fails that whole document, a snapshot id that
       does not fit HISTORY_SNAP_ID_RE or a body that is not a string fails
       that snapshot. The file is untrusted input.
     * historyLocal is never touched: an imported snapshot is not this
       page's capture, so it must never become a 'pending' entry held in
       RAM and retried.

   WHY OLDEST FIRST, AND WHY SOME ARE LEFT OUT. Every put re-stamps atMs to
   just after the newest snapshot already in its bucket (historyStampAfter,
   and main.js's twin). Imported oldest first into a document with no local
   history, each one is already newer than the last, so every original
   timestamp survives. Into a document that already has NEWER local
   snapshots, the imported ones are re-stamped after them (their `at` text
   is kept). Re-stamped snapshots sort as the newest, so the per-document
   trim would delete genuine local snapshots to make room for older
   imported ones. So a document only takes the imported snapshots that
   would rank inside its newest HISTORY_PER_DOC of local ∪ incoming by
   their ORIGINAL times; the rest are counted as skipped (and as capped).

   Batches of HISTORY_IMPORT_BATCH puts each run as ONE enqueueHistory job,
   with a macrotask yield between jobs — a big import must not freeze
   typing, and a capture issued meanwhile slots in between batches instead
   of waiting behind the whole file.

   → Promise<{docs, added, skipped, failed, older, capped, code?}>, never
   rejects. docs counts documents that received at least one snapshot;
   older counts Older entries added; code is "quota" when storage refused a
   write — the import stops there, and everything not yet written is
   counted as failed. */
var HISTORY_IMPORT_BATCH = 25;

function historyImportYield() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

/* The browser backends answer 'quota'; main answers 'enospc' for a full
   disk. Both mean "stop — nothing later will fit either". */
function historyImportIsQuota(code) {
  return code === "quota" || code === "enospc";
}

/* bundle snapshots → [{meta, stateJson}] that can be stored, one per id.
   Unusable entries count as failed, a repeated id as skipped. */
function historyImportEntries(list, counts) {
  var out = [], seen = {};
  (Array.isArray(list) ? list : []).forEach(function (s) {
    var meta = (s && typeof s === "object") ? sanitizeHistoryMeta(s.meta) : null;
    if (!meta || !HISTORY_SNAP_ID_RE.test(meta.id) || typeof s.stateJson !== "string") {
      counts.failed++;
      return;
    }
    if (seen[meta.id]) { counts.skipped++; return; }
    seen[meta.id] = true;
    out.push({ meta: meta, stateJson: s.stateJson });
  });
  return out;
}

function historyImportByAtAscending(a, b) {
  return (a.meta.atMs - b.meta.atMs) || (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0);
}

export async function importHistoryBundle(bundle) {
  var result = { docs: 0, added: 0, skipped: 0, failed: 0, older: 0, capped: 0 };
  try {
    bundle = (bundle && typeof bundle === "object") ? bundle : {};
    var docs = Array.isArray(bundle.docs) ? bundle.docs : [];
    var stopped = false;

    for (var d = 0; d < docs.length; d++) {
      var doc = docs[d];
      var snaps = (doc && typeof doc === "object" && Array.isArray(doc.snapshots)) ? doc.snapshots : [];
      var docId = normalizeDocId(doc && doc.docId);
      if (!docId) { result.failed += snaps.length; continue; }

      var entries = historyImportEntries(snaps, result);
      if (!entries.length) continue;
      if (stopped) { result.failed += entries.length; continue; }

      /* Read through the queue, so it sees every write issued before it.
         strict: a desktop list that timed out or failed answers null, not
         "empty" — null here means "could not read", never "no history". */
      var existing = await enqueueHistory(function (id) {
        return function () {
          return resolveHistoryBackend().then(function (backend) { return backend.list(id, { strict: true }); })
            .then(function (listed) {
              return (listed && typeof listed === "object" && Array.isArray(listed.entries)) ? listed.entries : null;
            });
        };
      }(docId), function () { return null; });
      if (existing == null) {
        /* Cannot tell what is already there — and so cannot tell what a put
           would push out. Leave this document alone rather than guess. */
        result.failed += entries.length;
        continue;
      }

      var have = {};
      existing.forEach(function (m) { if (m && typeof m.id === "string") have[m.id] = true; });
      var fresh = entries.filter(function (e) {
        if (have[e.meta.id]) { result.skipped++; return false; }
        return true;
      });
      var pool = existing.map(function (m) {
        return { atMs: Number(m.atMs) || 0, id: String(m.id), entry: null };
      }).concat(fresh.map(function (e) {
        return { atMs: e.meta.atMs, id: e.meta.id, entry: e };
      }));
      pool.sort(function (a, b) { return (b.atMs - a.atMs) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0); });
      var keep = pool.slice(0, HISTORY_PER_DOC).filter(function (p) { return p.entry; }).map(function (p) { return p.entry; });
      var capped = fresh.length - keep.length;
      result.skipped += capped;
      result.capped += capped;
      keep.sort(historyImportByAtAscending);

      var docAdded = 0;
      var processed = 0;   /* entries of keep that got an answer (or were given up on) */
      for (var start = 0; start < keep.length && !stopped; start += HISTORY_IMPORT_BATCH) {
        if (start > 0) await historyImportYield();
        var batch = keep.slice(start, start + HISTORY_IMPORT_BATCH);
        /* done = puts that answered (added + skipped + failed) */
        var progress = { done: 0, added: 0, skipped: 0, failed: 0, quota: false };
        await enqueueHistory(function (id, batch, progress) {
          return function () {
            return resolveHistoryBackend().then(function (backend) {
              function next() {
                if (progress.done >= batch.length) return null;
                var e = batch[progress.done];
                return Promise.resolve(backend.put(id, e.meta, e.stateJson)).then(function (r) {
                  r = r || { stored: false, code: "io" };
                  if (!r.stored && historyImportIsQuota(r.code)) { progress.quota = true; return null; }
                  progress.done++;
                  if (r.stored && r.duplicate) progress.skipped++;
                  else if (r.stored) progress.added++;
                  else progress.failed++;
                  return next();
                });
              }
              return next();
            });
          };
        }(docId, batch, progress), function () {
          /* a put that threw: whatever it had not reached is not stored */
          return null;
        });
        docAdded += progress.added;
        result.added += progress.added;
        result.skipped += progress.skipped;
        result.failed += progress.failed;
        if (progress.quota) {
          /* the refused put and everything after it in this document */
          stopped = true;
          result.code = "quota";
          processed += progress.done;
          result.failed += keep.length - processed;
          processed = keep.length;
        } else {
          /* a put that threw leaves the rest of its batch unanswered */
          result.failed += batch.length - progress.done;
          processed += batch.length;
        }
      }

      if (docAdded) {
        result.docs++;
        /* A put already stamps the record's title and lastOpenedAt; the touch
           is how a document with no local history before this import gets
           the file's own title. A document that already had history keeps
           its title — the local value wins — so it is touched with none.
           backend.touch rather than historyTouchDocument(): this runs from a
           job-issuing loop, and historyTouchDocument queues its own job. */
        var titleForTouch = existing.length ? "" : historyClip(doc.title, 300);
        await enqueueHistory(function (id, t) {
          return function () {
            return resolveHistoryBackend().then(function (backend) { return backend.touch(id, t); });
          };
        }(docId, titleForTouch), null);
      }
    }

    var olderEntries = historyImportEntries(bundle.older, result);
    if (olderEntries.length) {
      if (stopped) {
        result.failed += olderEntries.length;
      } else {
        var r = await enqueueHistory(function () {
          return resolveHistoryBackend().then(function (backend) { return backend.importOlder(olderEntries); });
        }, function () { return { ok: false, added: 0, code: "io" }; });
        r = r || { ok: false, added: 0, code: "io" };
        var added = Math.max(0, Math.min(olderEntries.length, Number(r.added) || 0));
        result.older += added;
        if (r.ok) {
          result.skipped += olderEntries.length - added;
        } else {
          result.failed += olderEntries.length - added;
          if (historyImportIsQuota(r.code)) result.code = "quota";
        }
      }
    }
  } catch (e) {
    if (window.console) console.error(e);
    if (!result.code) result.code = "io";
  }
  historyRenderSoon();
  return result;
}

/* ---- one-time migration of the shared localStorage list ---- */

function historyLegacyRaw() {
  if (typeof readLegacySnapshotsRaw === "function") return readLegacySnapshotsRaw();
  try { return localStorage.getItem(SNAPSHOT_KEY); } catch (e) { return null; }
}

/* raw 'splitpage-snapshots' text → [{meta, stateJson}] for the Older
   bucket, or null when the text is not a JSON array (a corrupt key is
   never deleted — it may be a newer or older app's data we do not
   understand). Entries without a state object are skipped: no version of
   the app could ever restore them.

   An id that does not fit HISTORY_SNAP_ID_RE is re-minted from the entry's
   own content, never at random: a migration interrupted before the key is
   removed runs again, and put-if-absent can only dedupe what gets the same
   id both times. */
export function normalizeLegacySnapshots(raw) {
  if (typeof raw !== "string") return null;
  var list;
  try { list = JSON.parse(raw); } catch (e) { return null; }
  if (!Array.isArray(list)) return null;
  var out = [], seen = {};
  list.forEach(function (e) {
    if (!e || typeof e !== "object" || !e.state || typeof e.state !== "object") return;
    var stateJson;
    try { stateJson = JSON.stringify(e.state); } catch (x) { return; }
    if (typeof stateJson !== "string") return;
    var at = typeof e.at === "string" ? e.at : "";
    var label = typeof e.label === "string" ? e.label : "";
    var rawId = String(e.id == null ? "" : e.id);
    var id = HISTORY_SNAP_ID_RE.test(rawId) ? rawId : "l" + checksumText(rawId) + checksumText(at + "|" + label);
    if (seen[id]) return;
    seen[id] = true;
    var atMs = Date.parse(at);
    if (!isFinite(atMs)) atMs = 0;
    var meta = sanitizeHistoryMeta({
      id: id,
      label: label,
      at: isFinite(Date.parse(at)) ? at : new Date(0).toISOString(),
      atMs: atMs,
      by: typeof e.by === "string" ? e.by : "",
      rows: Array.isArray(e.state.rows) ? e.state.rows.length : Number(e.rows) || 0,
      title: typeof e.state.title === "string" ? e.state.title : "",
      kind: "legacy",
      legacyId: rawId
    });
    if (meta) out.push({ meta: meta, stateJson: stateJson });
  });
  return out;
}

var historyMigrationPromise = null;

/* → Promise<{migrated, removedKey}>, never rejects. Re-entrant calls (boot
   and a 'storage' event at once) share the running promise.

   The key is removed only after the write is confirmed by reading the ids
   back AND the key re-reads byte-identical to what was migrated. Another
   tab still running an older build may append to the key mid-migration;
   then the loop migrates again (put-if-absent keeps it cheap), at most
   HISTORY_MIGRATION_LOOPS times, and otherwise leaves the key for next
   time rather than delete a snapshot nobody copied. Nothing happens on
   the memory backend. */
export function startHistoryMigration() {
  if (historyMigrationPromise) return historyMigrationPromise;
  var p = runHistoryMigration().then(null, function (e) {
    if (window.console) console.error(e);
    return { migrated: 0, removedKey: false };
  }).then(function (r) {
    if (historyMigrationPromise === p) historyMigrationPromise = null;
    return r;
  });
  historyMigrationPromise = p;
  return p;
}

function runHistoryMigration() {
  var result = { migrated: 0, removedKey: false };
  return resolveHistoryBackend().then(function (backend) {
    if (backend.name === "memory") return result;
    if (historyLegacyRaw() == null) return result;
    var loops = 0;
    /* An Older bucket past its 90 days goes first, as a whole: importing
       into it would add entries that list() already reports as expired, so
       the write could never be confirmed and the key would never go. A key
       that reappears that late (an old build in another tab) starts a
       fresh bucket with its own 90 days instead. */
    var expirySweep = typeof backend.evict === "function"
      ? enqueueHistory(function () { return backend.evict(Infinity); }, null)
      : Promise.resolve();
    function loop() {
      if (loops++ >= HISTORY_MIGRATION_LOOPS) return result;
      var raw = historyLegacyRaw();
      if (raw == null) return result;
      var entries = normalizeLegacySnapshots(raw);
      if (!entries) return result;
      return enqueueHistory(function () {
        return backend.importOlder(entries);
      }, { ok: false }).then(function (r) {
        if (!r || !r.ok) return result;
        result.migrated += r.added || 0;
        return backend.list(null).then(function (listed) {
          var have = {};
          (listed.older || []).forEach(function (m) { have[m.id] = true; });
          var confirmed = entries.every(function (e) { return have[e.meta.id]; });
          if (!confirmed) return result;
          if (historyLegacyRaw() !== raw) return loop();
          try {
            localStorage.removeItem(SNAPSHOT_KEY);
            result.removedKey = true;
          } catch (e) { /* storage blocked — try again next launch */ }
          historyRenderSoon();
          return result;
        });
      });
    }
    return expirySweep.then(loop);
  });
}

/* ---- test hook ---- */

function historyTestBucket(docId) {
  if (docId === HISTORY_OLDER_KEY || docId === "older") return HISTORY_OLDER_KEY;
  return normalizeDocId(docId);
}

function historyResetForTest() {
  historyFault = null;
  releaseDelayedPut();
  /* A migration still parked on the import gate would hold the queue, and
     historyIdle() below would never settle. */
  releaseDelayedImport();
  historyImportGateHit = false;
  return historyIdle().then(function () {
    historyForced = null;
    historyNowOverride = null;
    historyCapOverride = null;
    historyDesktopTimeoutOverride = null;
    historyEstimateCache = null;
    historyLastAtMs = 0;
    historyLocal = {};
    historyWarnedDocs = {};
    historyRetryQueued = false;
    historyQuotaStuck = false;
    historyProtected = {};
    historyMem = { docs: {}, snaps: {} };
    historyIdbFailed = false;
    historyBackendNameNow = null;
    if (historyDb) { try { historyDb.close(); } catch (e) {} }
    historyDb = null;
    historyDbPromise = null;
    return new Promise(function (resolve) {
      var settled = false;
      function finish() { if (!settled) { settled = true; resolve(); } }
      try {
        var req = indexedDB.deleteDatabase(HISTORY_DB_NAME);
        req.onsuccess = finish;
        req.onerror = finish;
        /* another same-origin page's connection closes itself on
           versionchange; give it a moment rather than hang the suite */
        req.onblocked = function () { setTimeout(finish, 3000); };
      } catch (e) { finish(); }
    });
  }).then(function () {
    return resolveHistoryBackend();
  }).then(function () { return true; });
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* One promise chain for every history WRITE in this page. The chain itself
     never rejects: a job that throws is logged and resolves to its fallback,
     so one bad job cannot wedge every later snapshot behind it. A job must
     never await another enqueueHistory() — it would wait on itself. */
  historyChain = Promise.resolve();

  window.__historyTest = {
    idle: historyIdle,
    backendName: function () { return historyBackendNameNow; },
    /* 'idb' | 'memory' | null → resolves the backend name now in use */
    forceBackend: function (name) {
      historyForced = name === "idb" || name === "memory" ? name : null;
      if (historyForced === "idb") historyIdbFailed = false;
      return resolveHistoryBackend().then(function (b) { return b.name; });
    },
    /* absolute ms, or null for the real clock */
    /* Also forgets the last capture time: after a jump forward and back,
       captures would otherwise keep future timestamps (last + 1 ms) until
       the real clock caught up. */
    setNow: function (ms) {
      historyNowOverride = (ms == null || !isFinite(Number(ms))) ? null : Number(ms);
      historyLastAtMs = 0;
      return historyNow();
    },
    setCapOverride: function (bytes) {
      historyCapOverride = (bytes == null || !isFinite(Number(bytes))) ? null : Number(bytes);
      historyEstimateCache = null;
      return historyCapOverride;
    },
    /* 'idb-open-fail' | 'quota-once' | 'quota-always' | 'io-always' |
       'delay-put' | 'delay-import' | 'import-fail' | null. Clearing a fault
       drains any pending snapshots, the way the next successful write would. */
    injectFault: function (name) {
      var known = ["idb-open-fail", "quota-once", "quota-always", "io-always", "delay-put", "delay-import", "import-fail"];
      if (name == null) {
        if (historyFault === "delay-put") releaseDelayedPut();
        if (historyFault === "delay-import") releaseDelayedImport();
        historyFault = null;
        if (historyLocalEntries(null, "pending").length) retryPendingSnapshots();
        return null;
      }
      if (name === "delay-import") historyImportGateHit = false;
      historyFault = known.indexOf(name) !== -1 ? name : null;
      /* idb-open-fail only means something to an open that has not happened
         yet, and boot has usually opened the database already. Drop the
         connection so the next call really opens — and fails over to memory
         for the rest of the page, as a real failure would. forceBackend('idb')
         or resetForTest() undoes it. */
      if (historyFault === "idb-open-fail") {
        if (historyDb) { try { historyDb.close(); } catch (e) {} }
        historyDb = null;
        historyDbPromise = null;
        historyIdbFailed = false;
      }
      return historyFault;
    },
    releaseDelayedPut: releaseDelayedPut,
    releaseDelayedImport: releaseDelayedImport,
    /* true once a migration has actually stopped on the 'delay-import' gate,
       so a test can wait for that instead of guessing at a delay. Cleared by
       re-arming the fault. */
    importGateHit: function () { return historyImportGateHit; },
    /* stored metas of a document (or 'older'), oldest first */
    listRaw: function (docId) {
      var bucket = historyTestBucket(docId);
      if (!bucket) return Promise.resolve([]);
      return resolveHistoryBackend().then(function (b) { return b.rawList ? b.rawList(bucket) : []; });
    },
    /* stored bodies of one document (or 'older'), or of everything */
    bodyCount: function (docId) {
      var bucket = docId == null ? null : historyTestBucket(docId);
      if (docId != null && !bucket) return Promise.resolve(0);
      return resolveHistoryBackend().then(function (b) { return b.rawBodyCount ? b.rawBodyCount(bucket) : 0; });
    },
    docRecord: function (docId) {
      var bucket = historyTestBucket(docId);
      if (!bucket) return Promise.resolve(null);
      return resolveHistoryBackend().then(function (b) { return b.rawDoc ? b.rawDoc(bucket) : null; });
    },
    /* this page's not-yet-stored snapshots: [{docId, id, label, status}] */
    pending: function (docId) {
      return historyLocalEntries(docId ? normalizeDocId(docId) || "-" : null, "pending").map(function (e) {
        return { docId: e.docId, id: e.meta.id, label: e.meta.label, status: e.status };
      });
    },
    migrate: startHistoryMigration,
    resetForTest: historyResetForTest,
    exportAll: exportHistoryAll,
    /* ms, or null for the real 30 s — how long a desktop bridge call may hang */
    setDesktopTimeout: function (ms) {
      historyDesktopTimeoutOverride = (ms == null || !isFinite(Number(ms))) ? null : Math.max(0, Number(ms));
      return historyDesktopTimeoutOverride;
    },
    /* the X2 write path itself: bundle.history's {docs, older} shape */
    importBundle: importHistoryBundle
  };
}
