import { S } from "./_state.js";
import { home } from "./_home.js";
import { makeId } from "./02-state.js";
import { mintDocId, normalizeDocId, sha256Bytes } from "./02b-doc-id.js";
import { dataUrlForSync, ensureBytes, inlineStateJson, intern, persist, recordFor } from "./02c-blobs.js";
import {
  SNAPSHOT_KEY,
  getEditorName,
  readLegacySnapshotsRaw,
  renderHistory
} from "./03-sync.js";
import { createIdbHistoryBackend, hashText as historyHashText, seedV1HistoryDb } from "./03c-history-idb.js";
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
  historyUtf8Length,
  planHistoryEviction,
  sanitizeHistoryMeta
} from "../../shared/history-policy.js";
/* HOW it is kept is one piece of code too since #83: the store below is
   shared/history-store.js, the same one desktop/main.js runs over its
   folder backend. */
import { createHistoryStore, createMemoryHistoryBackend } from "../../shared/history-store.js";
import { imageDims, isSha256Hex, refsIn, sniffImageMime } from "../../shared/blob-policy.js";
export {
  HISTORY_OLDER_KEY,
  HISTORY_OLDER_TTL_MS,
  HISTORY_PER_DOC,
  HISTORY_SNAP_ID_RE,
  historyStampAfter,
  historyUtf8Length,
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
   renderer's half of its replacement. History is addressed only by (docId,
   snapshot id) — HANDOFF invariant #38 — and one of three places answers,
   chosen per call:

     desktop   DESKTOP.historyPut exists: main owns the store (one
               shared/history-store.js over desktop/history-fs-backend.js),
               and desktopHistoryBackend below is a thin IPC client
     idb       shared/history-store.js over 03c-history-idb.js's IndexedDB
               backend (database 'splitpage-history' v2), once it has opened
     memory    the same store over the shared memory backend — kept only
               until this page closes

   WHAT the store does (put-if-absent, the stamp, the trim to 50, cap
   eviction, the quota retry, Older's creation and expiry, copy, which
   bodies may go) is shared/history-store.js's and is not repeated here
   (#83). What stays in this file is what only a page can do:

     * captureSnapshot() stringifies SYNCHRONOUSLY and returns at once.
       Eight callers replace `state` on the very next line (invariant #39),
       so any await before the capture would snapshot the wrong document.
       The write itself is queued; its outcome arrives on ticket.done.
     * A capture the store refuses (quota, io, read-only, a v1 migration
       that has not finished) stays PENDING in this page — listed, restorable,
       retried after the next successful write.
     * The images a snapshot names are made durable before it is written
       (historyPersistRefs, invariant #52).
     * No promise handed out here ever rejects (exportHistoryAll aside). A
       failed history write must never become a failed save, a failed open
       or an unhandled rejection.
     * Every write runs through one in-page queue (enqueueHistory), so a
       copyHistory() really does see the push that was issued before it,
       and a burst of pushes is stored in call order.

   '_older' is the bucket key for the one-time migration of the old shared
   list ("Older history (before per-document history)"). It is never
   accepted as a docId argument — the bucket is reachable only through
   {older:true}, so a hostile file claiming docId "_older" cannot read or
   write it. */

/* HISTORY_PER_DOC, HISTORY_OLDER_KEY, HISTORY_SNAP_ID_RE and
   HISTORY_OLDER_TTL_MS are shared/history-policy.js's, imported and
   re-exported at the top of this file (#76). */
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
   nothing else in the app reads it. It is the store's clock too. */
var historyNowOverride = null;
function historyNow() {
  return historyNowOverride != null ? historyNowOverride : Date.now();
}

/* historyUtf8Length — UTF-8 byte length without copying the string — is
   shared/history-policy.js's (#83), imported and re-exported at the top of
   this file so 20f-desktop.js keeps importing it from here. */

/* sanitizeHistoryMeta — SnapshotMeta rebuilt from plain values with every
   length clamped — is shared/history-policy.js's (#76), so a meta means the
   same thing on both sides of the desktop bridge. Imported and re-exported
   at the top of this file. */

function historyStripMeta(m) {
  var out = sanitizeHistoryMeta(m);
  if (out && m && typeof m.docId === "string") out.docId = m.docId;
  return out;
}

/* ---- test faults (window.__historyTest.injectFault) ----
   So the renderer-side logic (evict-and-retry, pending entries, the
   migration's key removal) can be driven without actually filling a disk.
   The store's own failures are the backend's: quota-once, quota-always and
   io-always become failNext() on the idb and memory backends (so the
   shared store's quota retry is what runs, exactly as it would for a real
   full disk). The gates and import-fail stay here: they hold or refuse a
   call at this file's edge. migrate-stop-after:N is 03c's, handed to its
   backend at creation, and outlives a reload (sessionStorage) because the
   migration it stops is the first thing a page does. */
var historyFault = null;
var historyDelayGate = null;
var historyDelayRelease = null;
var historyImportGate = null;
var historyImportRelease = null;
var historyImportGateHit = false;
var HISTORY_TEST_FAULT_KEY = "splitpage-history-test-fault";
var HISTORY_STOP_FAULT_RE = /^migrate-stop-after:\d+$/;

function historyStoredFault() {
  try {
    var v = sessionStorage.getItem(HISTORY_TEST_FAULT_KEY);
    return typeof v === "string" && HISTORY_STOP_FAULT_RE.test(v) ? v : null;
  } catch (e) { return null; }
}

function historyStoreFault(name) {
  try {
    if (name) sessionStorage.setItem(HISTORY_TEST_FAULT_KEY, name);
    else sessionStorage.removeItem(HISTORY_TEST_FAULT_KEY);
  } catch (e) { /* storage blocked: the fault lasts this page only */ }
}

/* Arms (or clears) the put faults on one backend. */
function historyArmFaults(backend) {
  if (!backend || typeof backend.clearFaults !== "function") return;
  backend.clearFaults();
  if (historyFault === "quota-once") backend.failNext("put", "quota", 1);
  else if (historyFault === "quota-always") backend.failNext("put", "quota", Infinity);
  else if (historyFault === "io-always") backend.failNext("put", "io", Infinity);
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

/* ---- the browser's cap ----
   From navigator.storage.estimate(), cached 5 minutes (real time, not
   historyNow — the cache is about how often we ask the browser). The
   estimate's usage includes history as it was THEN, so the history bytes at
   estimate time are cached with it; mixing an old usage with today's
   history size would misjudge "everything else". No estimate at all → no
   cap of our own; the browser's quota error still triggers the store's
   evict-and-retry. */
var historyCapOverride = null;
var historyEstimateCache = null;

function historyBrowserCap(historyBytes) {
  if (historyCapOverride != null) return Promise.resolve(historyCapOverride);
  var c = historyEstimateCache;
  if (c && Date.now() - c.at < HISTORY_ESTIMATE_TTL_MS) return Promise.resolve(historyCapFrom(c));
  if (typeof navigator === "undefined" || !navigator.storage || typeof navigator.storage.estimate !== "function") return Promise.resolve(Infinity);
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

/* The store's capBytes(lastKnownTotal) for IndexedDB. Before the store has
   read its index once, history's own size is unknown, and an estimate taken
   then would count all of history as "everything else" — so that one call
   answers no cap (the quota retry still guards it) and caches nothing. */
function historyIdbCap(lastTotal) {
  if (historyCapOverride != null) return historyCapOverride;
  if (lastTotal == null) return Infinity;
  return historyBrowserCap(lastTotal);
}

function historyMemoryCap() {
  return historyCapOverride != null ? historyCapOverride : HISTORY_MEMORY_CAP;
}

/* ---- holds ----
   Snapshots a restore is reading right now: bucket + "\n" + id → hold
   count. WHY: restoreSnapshot reads a snapshot, stores a "Before
   restoring" backup, and only then adopts. That backup's write may evict
   (the quota retry, the over-cap pass, the per-document trim) and the
   Older bucket is evicted first — so without a hold, restoring from Older
   while storage is tight could delete the very snapshot being restored,
   and the "restore anyway" click would find it gone. The list is the
   store's holds() provider in this page, and travels with every desktop
   call to main, whose store unions it into every eviction. */
var historyProtected = {};

function historyProtectKey(bucket, id) { return bucket + "\n" + id; }

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

/* ---- the browser's store: shared/history-store.js ----

   One store per backend per page: over 03c's IndexedDB backend once it has
   opened, over the memory backend otherwise. historyStoreAdapter() gives
   either one the call shape desktopHistoryBackend has (put/list/get/copy/
   touch/importOlder/usage/evict, plus the export's raw reads), so nothing
   below the backend choice knows which it is talking to — and adds the
   test gates, which belong to this page, not to the store. */
function historyMakeStore(backend, capBytes) {
  return createHistoryStore({
    backend: backend,
    now: historyNow,
    hashText: historyHashText,
    capBytes: capBytes,
    holds: historyProtectedList
  });
}

/* The raw index → one bucket's record as the test hook and the export read
   it: counts and bytes computed (nothing stores them since #83). */
function historyRecordOf(index, bucket) {
  var rec = index && index[bucket];
  if (!rec) return null;
  var snaps = Array.isArray(rec.snapshots) ? rec.snapshots : [];
  var out = {
    docId: bucket,
    title: rec.title || "",
    lastOpenedAt: Number(rec.lastOpenedAt) || 0,
    count: snaps.length,
    bytes: snaps.reduce(function (n, s) { return n + (Number(s && s.sizeBytes) || 0); }, 0)
  };
  if (rec.migratedAt != null) out.migratedAt = rec.migratedAt;
  if (rec.expiresAt != null) out.expiresAt = rec.expiresAt;
  return out;
}

/* …and its stored metas, oldest first, each carrying its bucket. */
function historyMetasOf(index, bucket) {
  var rec = index && index[bucket];
  return (rec && Array.isArray(rec.snapshots) ? rec.snapshots : []).map(function (s) {
    var m = sanitizeHistoryMeta(s);
    if (m) m.docId = bucket;
    return m;
  }).filter(Boolean);
}

function historyStoreAdapter(store) {
  return {
    name: store.name,
    persistent: store.persistent,
    store: store,
    put: function (docId, meta, stateJson) {
      /* the gate is taken at entry, so a release lets THIS put through */
      return Promise.resolve(historyPutFaultGate()).then(function () {
        return store.put(docId, meta, stateJson);
      });
    },
    /* rejects when the backend cannot be read — importHistoryBundle's
       strict read needs to tell that from "no history" (invariant #49) */
    list: function (docId) { return store.list(docId || null); },
    get: function (bucket, id) { return store.get(bucket, id); },
    copy: function (from, to) { return store.copy(from, to); },
    touch: function (docId, title) { return store.touch(docId, title); },
    importOlder: function (entries) {
      if (historyFault === "import-fail") return Promise.resolve({ ok: false, count: 0, added: 0, code: "io" });
      /* The gate is captured at entry, so releasing it lets THIS call through
         even when the test re-arms it in the same turn for the next loop. */
      return Promise.resolve(historyImportFaultGate()).then(function () {
        return store.importOlder(entries);
      });
    },
    usage: function () { return store.usage(); },
    evict: function (cap) { return store.evict(cap); },
    /* the export's reads (exportHistoryAll) and the test hook's */
    rawDocIds: function () {
      return store.listDocs().then(function (docs) { return docs.map(function (d) { return d.docId; }); });
    },
    rawDoc: function (bucket) {
      return store.rawIndex().then(function (index) { return historyRecordOf(index, bucket); });
    },
    rawList: function (bucket) {
      return store.rawIndex().then(function (index) { return historyMetasOf(index, bucket); });
    }
  };
}

var historyIdb = null;           /* {backend, store, adapter, ready, opening} */
var historyMem = null;           /* {backend, store, adapter} */
var historyPersistAsked = false;

function historyMemory() {
  if (!historyMem) {
    var backend = createMemoryHistoryBackend({ name: "memory" });
    historyArmFaults(backend);
    var store = historyMakeStore(backend, historyMemoryCap);
    historyMem = { backend: backend, store: store, adapter: historyStoreAdapter(store) };
  }
  return historyMem;
}

/* 03c's backend and its store, opened once per page. open() resolves after
   the v1 → v2 migration has run as far as it will go (the backend's first
   job), and rejects when IndexedDB cannot be opened at all — the caller's
   cue for memory. */
function historyOpenIdb() {
  if (historyIdb) return historyIdb.ready;
  if (historyFault === "idb-open-fail") return Promise.reject(new Error("Injected idb-open-fail"));
  var factory;
  try { factory = window.indexedDB || null; } catch (e) { factory = null; }
  var backend = createIdbHistoryBackend({ indexedDB: factory, now: historyNow, fault: historyStoredFault() });
  historyArmFaults(backend);
  var store = historyMakeStore(backend, historyIdbCap);
  var entry = { backend: backend, store: store, adapter: historyStoreAdapter(store), ready: null, opening: true };
  historyIdb = entry;
  entry.ready = backend.open().then(function () {
    entry.opening = false;
    /* Ask once for persistent storage so the browser does not evict
       history under storage pressure. Only where userAgentData exists
       (Chromium), which grants or refuses silently; elsewhere persist()
       can raise a permission prompt, and a prompt nobody asked for is
       worse than best-effort storage. */
    if (!historyPersistAsked && typeof navigator !== "undefined" && navigator.userAgentData && navigator.storage &&
        typeof navigator.storage.persist === "function") {
      historyPersistAsked = true;
      try { navigator.storage.persist().then(historyNoop, historyNoop); } catch (e) {}
    }
    /* a panel drawn while the migration ran showed only its notice */
    historyRenderSoon();
    return entry.adapter;
  }, function (e) {
    entry.opening = false;
    if (historyIdb === entry) historyIdb = null;
    backend.close().then(historyNoop, historyNoop);
    throw e;
  });
  return entry.ready;
}

/* The notice line for the panel (and the one toast) while the IndexedDB
   store cannot take writes: the v1 migration still running or unfinished,
   or a database a newer build wrote (read-only). null otherwise. */
function historyIdbNotice() {
  var e = historyIdb;
  if (!e) return null;
  var m = e.backend.migration;
  if (m.state === "running") {
    return { kind: "migrating", text: "Moving version history to its new format… Snapshots taken meanwhile are kept in this window until it finishes." };
  }
  if (m.state === "incomplete") {
    return { kind: "incomplete", text: "Version history could not finish moving to its new format. Everything is still readable; new snapshots are kept in this window and tried again." };
  }
  if (e.backend.readOnly) {
    return { kind: "read-only", text: "Version history is read-only here: a newer version of Splitpage wrote it. New snapshots are kept in this window." };
  }
  return null;
}

/* ---- desktop backend (HISTORY-IPC) ----

   On the desktop the store lives in the MAIN process — one
   shared/history-store.js over desktop/history-fs-backend.js (#83) — and
   main owns validation, the on-disk format, the trim and eviction. So this
   object is a thin IPC client with no store of its own: it reshapes main's
   answers into the shapes historyStoreAdapter() returns, and nothing above
   it has to know which one it is talking to.

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

  /* Main's store does the quota retry and the eviction — its answer
     already says how many snapshots went and whether we are still over
     the cap. The held
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
      /* an answer with no entries array cannot say "no history" either —
         nor can one given while main is still moving v1 history into its
         new format (#83): it lists nothing until that has finished */
      if (opts && opts.strict && ((docId && !Array.isArray(r.entries)) || r.migrating)) return null;
      /* Main sends metas with no document id in them (on disk the folder
         IS the document), so stamp it back on for the panel — the
         browser's store carries it on every meta it hands out. */
      var entries = (r.entries || []).map(historyStripMeta).filter(Boolean);
      if (docId) entries.forEach(function (m) { m.docId = docId; });
      var older = (r.older || []).map(historyStripMeta).filter(Boolean);
      older.forEach(function (m) { m.docId = HISTORY_OLDER_KEY; });
      var out = {
        entries: entries,
        older: older,
        olderExpiresAt: r.olderExpiresAt == null ? null : Number(r.olderExpiresAt)
      };
      if (r.migrating) out.migrating = true;
      return out;
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
     sweep probes for one. */
  evict: function () { return Promise.resolve({ evicted: 0, overCap: false, totalBefore: 0, totalAfter: 0 }); },

  /* Every document id this backend can enumerate, Older excluded — backs
     exportHistoryAll() the same way historyStoreAdapter's rawDocIds does.
     DESKTOP.historyListDocs() (desktop/main.js) answers from main's
     store index, so this never touches disk itself. Still null on a timeout/rejection/malformed answer, which
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

function historyUseMemory() {
  historyBackendNameNow = "memory";
  return historyMemory().adapter;
}

function resolveHistoryBackend() {
  if (historyForced === "memory") return Promise.resolve(historyUseMemory());
  if (!historyForced && S.DESKTOP && typeof S.DESKTOP.historyPut === "function") {
    historyBackendNameNow = "desktop";
    return Promise.resolve(desktopHistoryBackend);
  }
  if (historyIdbFailed) return Promise.resolve(historyUseMemory());
  return historyOpenIdb().then(function (adapter) {
    historyBackendNameNow = "idb";
    return adapter;
  }, function (e) {
    historyIdbFailed = true;
    if (window.console) console.warn("Version history: IndexedDB unavailable, keeping history in memory", e);
    return historyUseMemory();
  });
}

/* True while resolveHistoryBackend() is waiting on the v1 → v2 move (the
   IndexedDB backend's first job) — a read then answers from this page at
   once instead of waiting behind it. */
function historyIdbMigrating() {
  if (historyForced === "memory" || historyIdbFailed) return false;
  if (!historyForced && S.DESKTOP && typeof S.DESKTOP.historyPut === "function") return false;
  return !!historyIdb && historyIdb.opening && historyIdb.backend.migration.state === "running";
}

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
   at most HISTORY_PENDING_PER_DOC of them — the newest.

   One warning per document — or, when the IndexedDB store itself cannot
   take writes (its v1 migration has not finished, or a newer build made it
   read-only), ONE warning for the page naming that, since every document's
   captures will wait for the same thing. */
function historyMarkPending(entry) {
  entry.status = "pending";
  var mine = historyLocalEntries(entry.docId, "pending");
  while (mine.length > HISTORY_PENDING_PER_DOC) {
    var old = mine.shift();
    delete historyLocal[historyLocalKey(old.docId, old.meta.id)];
  }
  var notice = historyBackendNameNow === "idb" ? historyIdbNotice() : null;
  if (notice) {
    if (!historyWarnedDocs["store:" + notice.kind]) {
      historyWarnedDocs["store:" + notice.kind] = true;
      try { showToast(notice.text, "warn"); } catch (e) { /* a toast is a courtesy */ }
    }
    return;
  }
  if (!historyWarnedDocs[entry.docId]) {
    historyWarnedDocs[entry.docId] = true;
    try {
      showToast("Couldn't store a version history snapshot. It is kept in this window and will be " +
        "tried again — closing the window before then loses it.", "warn");
    } catch (e) { /* a toast is a courtesy */ }
  }
}

/* The images a snapshot names are made durable BEFORE the snapshot is
   written (#82, invariant 52): no stored snapshot may name a blob the
   blob store does not hold. The refs were read at capture, which stays
   synchronous (invariant 39); this is the job's half. A blob the store
   refused goes into the snapshot inline instead, when this page has its
   bytes; one nobody has cannot be helped (a version restored after its
   picture was lost) and is written as it is. */
function historyPersistRefs(entry) {
  var refs = entry.refs || [];
  if (!refs.length) return Promise.resolve();
  return persist(refs).then(function (failed) {
    if (failed.length) entry.stateJson = inlineStateJson(entry.stateJson, failed);
  });
}

function historyStoreEntry(backend, entry) {
  entry.status = "writing";
  return historyPersistRefs(entry).then(function () {
    return backend.put(entry.docId, entry.meta, entry.stateJson);
  }).then(function (r) {
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
  var entry = { docId: docId, meta: meta, stateJson: stateJson, status: "writing", refs: refsIn(src) };
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

/* This page's own entries for a document as panel metas, one per id not
   already in `seen`. */
function historyLocalMetas(docId, lists, seen) {
  var out = [];
  lists.forEach(function (e) {
    if (seen[e.meta.id]) return;
    seen[e.meta.id] = true;
    var m = historyStripMeta(e.meta);
    m.docId = docId;
    m.status = e.status;
    m.sizeBytes = m.sizeBytes || historyUtf8Length(e.stateJson);
    out.push(m);
  });
  return out;
}

/* → {entries, older, olderExpiresAt, backend, persistent, usage, notice}.
   entries are this document's local ('writing'/'pending') and stored
   ('stored') snapshots, newest first, one per id. Not queued: a read must
   not wait behind a slow write, and the local entries already show what is
   queued. notice (or null) is the one line the panel shows while the store
   is being moved to its new format, could not finish that, or is read-only
   (#83). */
export function listDocHistory(docId) {
  docId = normalizeDocId(docId);
  /* The v1 → v2 move runs before IndexedDB answers anything, and a big
     profile takes a while: answer from this page meanwhile, with the
     notice, rather than leave the panel waiting. historyOpenIdb() redraws
     it when the move is done. */
  if (historyIdbMigrating()) {
    var mine = docId ? historyLocalMetas(docId, historyLocalEntries(docId), {}) : [];
    mine.sort(function (a, b) { return b.atMs - a.atMs; });
    var n = historyIdbNotice();
    return Promise.resolve({ entries: mine, older: [], olderExpiresAt: null, backend: "idb", persistent: true,
                             usage: null, notice: n ? n.text : null });
  }
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
      if (docId) entries = entries.concat(historyLocalMetas(docId, historyLocalEntries(docId).concat(localBefore), seen));
      entries.sort(function (a, b) { return b.atMs - a.atMs; });
      var notice = null;
      if (backend.name === "idb") {
        var n = historyIdbNotice();
        notice = n ? n.text : null;
      } else if (backend.name === "desktop" && listed.migrating) {
        notice = "Moving version history to its new format… Snapshots taken meanwhile are kept in this window until it finishes.";
      }
      return {
        entries: entries,
        older: (listed.older || []).map(function (m) { m.status = "stored"; return m; }),
        olderExpiresAt: listed.olderExpiresAt == null ? null : listed.olderExpiresAt,
        backend: backend.name,
        persistent: !!backend.persistent,
        usage: res[1],
        notice: notice
      };
    });
  }).then(null, function (e) {
    if (window.console) console.error(e);
    return { entries: [], older: [], olderExpiresAt: null, backend: historyBackendNameNow, persistent: false, usage: null, notice: null };
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
        return { ok: false, copied: 0, code: "io" };
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
   history at once — the browser's store answers that from its index
   (listDocs), and the desktop backend through DESKTOP.historyListDocs(),
   which main answers from its own store's index. rawDocIds() still returns
   null on a genuine failure (an old desktop build, a rejected/timed-out
   call), and exportHistoryAll() turns that into a rejection with a clear
   code rather than silently exporting an empty bundle.

   IMAGES (#82). A snapshot's state names its images by sha (refsIn,
   shared/blob-policy.js) and their bytes live in the blob store, not in the
   snapshot — so an export that carried only stateJson would arrive on the
   other machine with every picture missing. exportHistoryAll() therefore
   also returns
     blobs:        {sha: {mime, b64}} for every sha an exported snapshot
                   names whose bytes this page could get (the registry's
                   ensureBytes: memory, then the blob backend — IndexedDB in
                   a browser, main's <userData>/blobs on the desktop once
                   that backend is set), each exactly once;
     missingBlobs: [sha] the ones it could not — listed, never silently
                   dropped, so the export can say so.
   Blob bytes count toward HISTORY_EXPORT_CAP_BYTES like snapshot bodies do,
   each blob once, charged to the newest snapshot that names it. */
var HISTORY_EXPORT_CAP_BYTES = 200 * 1024 * 1024;
/* A test-only stand-in for the cap (__historyTest.setExportCap), so a suite
   can prove blobs count toward it without writing 200 MB. */
var historyExportCapOverride = null;

function historyExportCap() {
  return historyExportCapOverride != null ? historyExportCapOverride : HISTORY_EXPORT_CAP_BYTES;
}

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
    if (total === 0 || total + f.sizeBytes <= historyExportCap()) {
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
  }).then(historyExportAttachBlobs);
}

/* Cheap test before a JSON.parse: a state that names no image cannot
   contain any of these (refsIn reads only imageRef, imageValue and
   <img data-blob>), and nearly every snapshot today names none. */
var HISTORY_BLOB_HINT_RE = /imageRef|imageValue|data-blob/;

function historyRefsInJson(stateJson) {
  if (typeof stateJson !== "string" || !HISTORY_BLOB_HINT_RE.test(stateJson)) return [];
  try { return refsIn(JSON.parse(stateJson)); } catch (e) { return []; }
}

/* What one blob adds to the file: its bytes as base64, its key and type,
   and the JSON around them. */
function historyBlobCost(sha, entry) {
  return sha.length + entry.mime.length + entry.b64.length + 40;
}

/* The second, image-aware pass of the cap, run AFTER the history job (so
   reading blobs never holds the history queue). The first pass
   (historyAssembleExport) picked snapshots by body size alone; this one
   walks what it kept newest first, charges each snapshot its body plus
   every image it is the newest snapshot to name, and drops a snapshot
   whose total would pass the cap (truncated, as before). The newest
   snapshot is always kept whole, as the first pass keeps it. Never
   rejects on a blob problem: a sha whose bytes cannot be had goes to
   missingBlobs, and the snapshot still exports. */
async function historyExportAttachBlobs(out) {
  var cap = historyExportCap();
  var all = [];
  out.docs.forEach(function (d) {
    d.snapshots.forEach(function (s) { all.push({ snap: s, owner: d.snapshots }); });
  });
  out.older.forEach(function (s) { all.push({ snap: s, owner: out.older }); });
  all.sort(function (a, b) {
    return (b.snap.meta.atMs - a.snap.meta.atMs) || (a.snap.meta.id < b.snap.meta.id ? 1 : -1);
  });

  var blobs = {}, missing = [], counted = {}, total = 0, dropped = [];
  for (var i = 0; i < all.length; i++) {
    var snap = all[i].snap;
    var fresh = historyRefsInJson(snap.stateJson).filter(function (sha) { return !counted[sha]; });
    var gone = fresh.length ? await ensureBytes(fresh) : [];
    var add = {}, addMissing = [], cost = historyUtf8Length(snap.stateJson);
    fresh.forEach(function (sha) {
      var url = gone.indexOf(sha) === -1 ? dataUrlForSync(sha) : null;
      var rec = url ? recordFor(sha) : null;
      if (!url || !rec) { addMissing.push(sha); return; }
      add[sha] = { mime: rec.mime, b64: url.slice(url.indexOf(",") + 1) };
      cost += historyBlobCost(sha, add[sha]);
    });
    if (total > 0 && total + cost > cap) {
      dropped.push(all[i]);
      continue;
    }
    total += cost;
    Object.keys(add).forEach(function (sha) { blobs[sha] = add[sha]; counted[sha] = true; });
    addMissing.forEach(function (sha) { missing.push(sha); counted[sha] = true; });
  }
  dropped.forEach(function (x) {
    var at = x.owner.indexOf(x.snap);
    if (at !== -1) x.owner.splice(at, 1);
  });
  if (dropped.length) out.truncated = true;
  out.blobs = blobs;
  out.missingBlobs = missing;
  return out;
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
     * IMAGES FIRST (#82). bundle.blobs ({sha: {mime, b64}}, 20h-appdata.js)
       is verified and stored durably — the registry's persist(), which
       resolves only once the blob backend holds the bytes — BEFORE the
       first history put, so no imported snapshot is ever stored naming an
       image this machine's store does not already hold. Verification: the
       key is a sha, the base64 is strict, the bytes are at most
       HISTORY_IMPORT_BLOB_MAX_BYTES, sniff as PNG/JPEG/GIF/WebP with a
       readable size (never SVG; the entry's own `mime` is not trusted),
       and hash to the key. A blob that fails is dropped and reported; the
       snapshots naming it still import (they show a placeholder, as any
       snapshot does whose image is gone). A blob no snapshot in the bundle
       names is ignored — the file is untrusted, and the store is never
       garbage-collected (#82 D4). No bundle.blobs (every file exported
       before #82) imports exactly as it always did.

   WHY OLDEST FIRST, AND WHY SOME ARE LEFT OUT. Every put re-stamps atMs to
   just after the newest snapshot already in its bucket (historyStampAfter,
   inside shared/history-store.js on both sides of the bridge). Imported oldest first into a document with no local
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

   → Promise<{docs, added, skipped, failed, older, capped, blobs, code?}>,
   never rejects. docs counts documents that received at least one
   snapshot; older counts Older entries added; code is "quota" when storage
   refused a write — the import stops there, and everything not yet written
   is counted as failed. blobs is {stored, refused: [key], failed: [sha],
   ignored}: stored counts images now held durably (already held counts
   too), refused lists the ones that failed verification, failed the ones
   the blob store would not take, ignored those no snapshot names. */
var HISTORY_IMPORT_BATCH = 25;
/* The largest image an import will store: the desktop blob bridge's own
   cap (desktop/blob-store.js refuses more), and twice the server's. */
var HISTORY_IMPORT_BLOB_MAX_BYTES = 16 * 1024 * 1024;
var HISTORY_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/* Strict base64 (what historyExportAttachBlobs writes: unwrapped, padded)
   → bytes, or null. */
function historyDecodeBase64(b64) {
  if (typeof b64 !== "string" || !HISTORY_BASE64_RE.test(b64)) return null;
  var bin;
  try { bin = atob(b64); } catch (e) { return null; }
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Every sha the bundle's snapshots name, as a set. */
function historyImportRefs(docs, older) {
  var refs = {};
  function scan(list) {
    (Array.isArray(list) ? list : []).forEach(function (s) {
      if (!s || typeof s !== "object") return;
      historyRefsInJson(s.stateJson).forEach(function (sha) { refs[sha] = true; });
    });
  }
  (Array.isArray(docs) ? docs : []).forEach(function (d) {
    if (d && typeof d === "object") scan(d.snapshots);
  });
  scan(older);
  return refs;
}

/* One entry of bundle.blobs → its verified bytes, or a reason it is not. */
function historyVerifyBlob(sha, entry) {
  if (!isSha256Hex(sha)) return { reason: "not-a-sha" };
  if (!entry || typeof entry !== "object" || typeof entry.b64 !== "string") return { reason: "malformed" };
  if (entry.b64.length > Math.ceil(HISTORY_IMPORT_BLOB_MAX_BYTES / 3) * 4) return { reason: "too-large" };
  var bytes = historyDecodeBase64(entry.b64);
  if (!bytes || !bytes.length) return { reason: "bad-base64" };
  if (bytes.length > HISTORY_IMPORT_BLOB_MAX_BYTES) return { reason: "too-large" };
  if (!sniffImageMime(bytes) || !imageDims(bytes)) return { reason: "not-an-image" };
  if (sha256Bytes(bytes) !== sha) return { reason: "hash-mismatch" };
  return { bytes: bytes };
}

/* Verifies, registers and persists every referenced blob of the bundle;
   resolves once persist() has answered — i.e. once every blob that could
   be stored IS stored durably. Never rejects. */
async function historyImportBlobs(blobs, refs) {
  var out = { stored: 0, refused: [], failed: [], ignored: 0 };
  if (!blobs || typeof blobs !== "object" || Array.isArray(blobs)) return out;
  var keys = Object.keys(blobs);
  var ready = [];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (isSha256Hex(key) && !Object.prototype.hasOwnProperty.call(refs, key)) { out.ignored++; continue; }
    var v = historyVerifyBlob(key, blobs[key]);
    if (!v.bytes) {
      out.refused.push(String(key).slice(0, 64));
      if (window.console) console.warn("Import app data: image " + String(key).slice(0, 64) + " refused (" + v.reason + ")");
      continue;
    }
    var rec = intern(v.bytes);
    if (!rec || rec.sha256 !== key) { out.refused.push(key); continue; }
    ready.push(key);
    /* hashing a large image is real work on this thread; let typing in */
    await historyImportYield();
  }
  if (ready.length) {
    out.failed = await persist(ready);
    out.stored = ready.length - out.failed.length;
    if (out.failed.length && window.console) console.warn("Import app data: the image store did not take", out.failed);
  }
  return out;
}

function historyImportYield() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

/* The browser's store answers 'quota'; main's answers 'enospc' for a full
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
  var result = { docs: 0, added: 0, skipped: 0, failed: 0, older: 0, capped: 0,
                 blobs: { stored: 0, refused: [], failed: [], ignored: 0 } };
  try {
    bundle = (bundle && typeof bundle === "object") ? bundle : {};
    var docs = Array.isArray(bundle.docs) ? bundle.docs : [];
    var stopped = false;

    /* Images before the history that names them (invariant #49). */
    if (bundle.blobs) result.blobs = await historyImportBlobs(bundle.blobs, historyImportRefs(docs, bundle.older));

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

/* The browser store now in use (idb or memory), or null on the desktop. */
function historyTestStore() {
  return resolveHistoryBackend().then(function (b) { return b.store ? b : null; });
}

/* Bodies one bucket names that the backend really holds — bodies are
   shared by content since #83, so this counts distinct shas. */
function historyTestBodyCount(adapter, bucket) {
  var backend = adapter.store.backend;
  if (!bucket) return Promise.resolve(backend.bodyCount());
  return adapter.store.rawIndex().then(function (index) {
    var shas = {};
    ((index[bucket] && index[bucket].snapshots) || []).forEach(function (s) {
      if (s && typeof s.sha === "string") shas[s.sha] = true;
    });
    return Promise.all(Object.keys(shas).map(function (sha) {
      return Promise.resolve(backend.hasBody(sha));
    })).then(function (have) { return have.filter(Boolean).length; });
  });
}

/* Closes and forgets this page's IndexedDB backend, then deletes the
   database. Nothing reopens it until the next history call. */
function historyDropIdb() {
  var e = historyIdb;
  historyIdb = null;
  var closed = e ? e.backend.close().then(historyNoop, historyNoop) : Promise.resolve();
  return closed.then(function () {
    return new Promise(function (resolve) {
      var settled = false;
      function finish() { if (!settled) { settled = true; resolve(); } }
      try {
        var req = indexedDB.deleteDatabase("splitpage-history");
        req.onsuccess = finish;
        req.onerror = finish;
        /* another same-origin page's connection closes itself on
           versionchange; give it a moment rather than hang the suite */
        req.onblocked = function () { setTimeout(finish, 3000); };
      } catch (x) { finish(); }
    });
  });
}

function historyResetForTest() {
  historyFault = null;
  historyStoreFault(null);
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
    historyProtected = {};
    historyMem = null;
    historyIdbFailed = false;
    historyBackendNameNow = null;
    return historyDropIdb();
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
       'delay-put' | 'delay-import' | 'import-fail' | 'migrate-stop-after:N'
       | null. Clearing a fault drains any pending snapshots, the way the
       next successful write would.

       migrate-stop-after:N stops the IndexedDB v1 → v2 move after N rows,
       like a crash — for the NEXT page load: it is kept in sessionStorage
       and handed to the backend when it is created (at boot), and stays set
       across reloads until cleared here or by resetForTest(). */
    injectFault: function (name) {
      var known = ["idb-open-fail", "quota-once", "quota-always", "io-always", "delay-put", "delay-import", "import-fail"];
      if (name == null) {
        if (historyFault === "delay-put") releaseDelayedPut();
        if (historyFault === "delay-import") releaseDelayedImport();
        historyFault = null;
        historyStoreFault(null);
        if (historyIdb) historyArmFaults(historyIdb.backend);
        if (historyMem) historyArmFaults(historyMem.backend);
        if (historyLocalEntries(null, "pending").length) retryPendingSnapshots();
        return null;
      }
      if (HISTORY_STOP_FAULT_RE.test(String(name))) {
        historyStoreFault(String(name));
        return String(name);
      }
      if (name === "delay-import") historyImportGateHit = false;
      historyFault = known.indexOf(name) !== -1 ? name : null;
      if (historyIdb) historyArmFaults(historyIdb.backend);
      if (historyMem) historyArmFaults(historyMem.backend);
      /* idb-open-fail only means something to an open that has not happened
         yet, and boot has usually opened the database already. Drop the
         backend so the next call really opens — and fails over to memory
         for the rest of the page, as a real failure would. forceBackend('idb')
         or resetForTest() undoes it. */
      if (historyFault === "idb-open-fail") {
        if (historyIdb) historyIdb.backend.close().then(historyNoop, historyNoop);
        historyIdb = null;
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
    /* stored bodies one document (or 'older') names, or every body stored */
    bodyCount: function (docId) {
      var bucket = docId == null ? null : historyTestBucket(docId);
      if (docId != null && !bucket) return Promise.resolve(0);
      return historyTestStore().then(function (a) { return a ? historyTestBodyCount(a, bucket) : 0; });
    },
    /* {docId, title, lastOpenedAt, migratedAt?, expiresAt?, count, bytes}
       — count and bytes computed from the index — or null */
    docRecord: function (docId) {
      var bucket = historyTestBucket(docId);
      if (!bucket) return Promise.resolve(null);
      return resolveHistoryBackend().then(function (b) { return b.rawDoc ? b.rawDoc(bucket) : null; });
    },
    /* the browser store's whole index, as plain data (bodies by sha) */
    rawIndex: function () {
      return historyTestStore().then(function (a) { return a ? a.store.rawIndex() : null; });
    },
    /* {index, bodies} straight from the backend, for comparing two stores */
    inspect: function () {
      return historyTestStore().then(function (a) { return a ? a.store.backend.inspect() : null; });
    },
    /* getHistorySnapshot itself: {docId?, older?, id} → {meta, stateJson} | null */
    read: getHistorySnapshot,
    /* this page's not-yet-stored snapshots: [{docId, id, label, status}] */
    pending: function (docId) {
      return historyLocalEntries(docId ? normalizeDocId(docId) || "-" : null, "pending").map(function (e) {
        return { docId: e.docId, id: e.meta.id, label: e.meta.label, status: e.status };
      });
    },
    migrate: startHistoryMigration,
    resetForTest: historyResetForTest,
    /* ---- the IndexedDB v1 → v2 move (#83, 03c-history-idb.js) ----
       seedV1(spec): closes this page's backend, deletes the database and
       writes a raw v1 one ({docs:[docsRow], snaps:[{meta (with its bucket
       as docId), stateJson}]} — seedV1HistoryDb's spec), leaving it closed:
       the next history call (or the next page load) opens it, and the move
       runs as that backend's first job. */
    seedV1: function (spec) {
      return historyIdle().then(function () {
        historyIdbFailed = false;
        return historyDropIdb();
      }).then(function () {
        return seedV1HistoryDb(window.indexedDB, spec || {});
      }).then(function () { return true; });
    },
    /* {state, migrated, skipped, code} — 'unknown' until opened, then
       'none' | 'running' | 'done' | 'incomplete'; null with no backend */
    migration: function () { return historyIdb ? historyIdb.backend.migration : null; },
    /* rows left in the v1 stores, {docs, snapMeta, snapBody}, or null when
       the database has none */
    v1Counts: function () {
      return historyOpenIdb().then(function () { return historyIdb.backend.v1Counts(); }, function () { return null; });
    },
    /* the panel/toast notice text now, or null */
    notice: function () { var n = historyIdbNotice(); return n ? n.text : null; },
    /* ms, or null for the real 30 s — how long a desktop bridge call may hang */
    setDesktopTimeout: function (ms) {
      historyDesktopTimeoutOverride = (ms == null || !isFinite(Number(ms))) ? null : Math.max(0, Number(ms));
      return historyDesktopTimeoutOverride;
    },
    /* the X2 write path itself: bundle.history's {docs, older} shape, plus
       the app-data bundle's blobs */
    importBundle: importHistoryBundle,
    /* bytes, or null for the real 200 MB — the export cap (#82: blobs count) */
    setExportCap: function (bytes) {
      historyExportCapOverride = (bytes == null || !isFinite(Number(bytes))) ? null : Math.max(0, Number(bytes));
      return historyExportCapOverride;
    }
  };
}
