/* ---------------------------------------------------------------------
 * 03c-history-idb.js: the browser's storage for version history (#83),
 * as a backend for shared/history-store.js.
 *
 * 03a-history-store.js builds the browser's one createHistoryStore() on top
 * of it (step 3b), falling back to the shared memory backend when IndexedDB
 * will not open. It has no __init(): nothing here reads the DOM or storage at evaluation
 * time — the factory is handed its indexedDB, so node --test runs it over
 * fake-indexeddb (src/test/history-idb.test.mjs).
 *
 * ---- THE SCHEMA: database 'splitpage-history', version 3 ----
 *
 *   index   keyPath 'bucket'   one DocRecord per bucket (a docId, or
 *                              HISTORY_OLDER_KEY): {bucket, title,
 *                              lastOpenedAt, migratedAt?, expiresAt?,
 *                              snapshots: [SnapshotMeta + {sha}] oldest first}
 *   bodies  keyPath 'sha'      {sha, stateJson}; one row per distinct body,
 *                              shared by every entry (in any bucket) naming it
 *
 * Versions. v1 (2.1) had four other stores: docs, snapMeta [docId,id],
 * snapBody [docId,id] and an unused meta. v2 (3.0.0) added index and bodies
 * and moved the v1 rows into them, one snapshot at a time, emptying v1 as
 * it went (#83). v3 (#100) retires the v1 stores — see upgradeDb() below:
 * they are dropped only when they hold no snapshot, which is what a
 * finished 3.0.0 move leaves. v1 stores that still hold rows (a profile
 * that skipped 3.0.0, or whose move never finished) are KEPT, dormant:
 * this build has no reader for them, so dropping them would destroy
 * history nobody can see any more; keeping them loses nothing. Nothing
 * here ever reads or writes them.
 *
 * ---- TRANSACTIONS ----
 *
 * exclusive(fn, {write}) is ONE transaction over index + bodies:
 * 'readwrite' with durability 'strict', or 'readonly' for {write:false}.
 * It resolves only on the transaction's `complete` — a snapshot is stored
 * when the browser says so, not when the last request came back. Jobs from
 * this page run one after another (an in-page chain); jobs from other tabs
 * are serialised by IndexedDB itself, because every write job's scope is
 * both stores. So:
 *   * a body and the index entry naming it land together or not at all —
 *     no orphan body, no entry without its body;
 *   * tx.put writes a body only if its sha is absent (a count first);
 *   * tx.commit's dropped bodies are deleted in the SAME transaction as the
 *     index change that stopped naming them.
 * THE AUTO-COMMIT RULE (shared/history-store.js's header): fn may await
 * only tx.* calls. Each resolves inside its request's success event and its
 * continuation runs in that event's microtask checkpoint, while the
 * transaction is still active; a timer, a fetch or an async hash would let
 * it commit half a job. fn is called synchronously in the turn the
 * transaction was created in, so its first request never finds it inactive.
 *
 * Errors. A job that throws aborts its transaction (nothing lands). The
 * error handed back prefers the TRANSACTION's reason over a request's
 * generic AbortError, because Chromium reports a full quota as the
 * transaction's QuotaExceededError at commit time, and Firefox as the
 * request's. Either becomes err.code 'quota' (the store's evict-and-retry);
 * everything else becomes 'io'; writes against a read-only database throw
 * 'read-only'.
 *
 * ---- OPENING, OTHER TABS, OTHER VERSIONS ----
 *
 *   * onversionchange closes this connection (and forgets it; the next job
 *     reopens), so a tab running a newer build — or resetForTest's
 *     deleteDatabase — is never blocked by this one. Older builds do the
 *     same (3.0.0's copy of this file, and 2.1's v1 connection in its
 *     03a), which is what lets this build's upgrade to v3 through: the
 *     old tab closes; a 3.0.0 tab's next open(…, 2) then fails with a
 *     VersionError and it serves the v3 database read-only (the rule
 *     below — v3 keeps index and bodies as they were), and a 2.1 tab's
 *     open(…, 1) fails the same way and it falls back to memory.
 *   * onblocked (an old connection that will not close) fails THIS open at
 *     once with 'io' instead of hanging every snapshot behind it; a success
 *     that arrives later is closed, not adopted — the caller has already
 *     chosen another backend (03a's rule).
 *   * VersionError (the database is NEWER than 3 — a newer build ran here,
 *     and this tab is stale or a downgrade): reopen WITHOUT a version and,
 *     when it still has the index and bodies stores, serve it READ-ONLY
 *     (backend.readOnly = true; every write answers 'read-only'). Why not
 *     memory: memory would show an empty panel, which looks like lost
 *     history, and would take captures that vanish at close. Read-only
 *     shows everything that is there, and a capture stays PENDING in 03a
 *     (visible, retried) — the desktop's FORMAT-higher rule. A newer
 *     database without those stores (a format this build cannot read) fails
 *     the open instead, and 03a falls back to memory.
 *
 * open() resolves once the database is usable, or rejects — 03a's
 * resolveHistoryBackend() chooses memory on that.
 * --------------------------------------------------------------------- */

import { sha256Bytes } from "./02b-doc-id.js";
import { DOC_ID_RE } from "../../shared/doc-id-policy.js";
import { HISTORY_OLDER_KEY } from "../../shared/history-policy.js";

export var HISTORY_IDB_NAME = "splitpage-history";
export var HISTORY_IDB_VERSION = 3;

var INDEX_STORE = "index";
var BODY_STORE = "bodies";
/* 2.1's stores (see THE SCHEMA). Named only by upgradeDb(), which decides
   whether they go; the two that hold snapshots decide it. */
var V1_STORES = ["docs", "snapMeta", "snapBody", "meta"];
var V1_SNAPSHOT_STORES = ["snapMeta", "snapBody"];

/* The content address the store hands every body: SHA-256 of its UTF-8, as
   64 lowercase hex — synchronous (02b's core over TextEncoder output), so
   the store can run it before a transaction opens. */
export function hashText(text) {
  return sha256Bytes(new TextEncoder().encode(String(text)));
}

function noop() {}

function codedError(code, message, cause) {
  var e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

function isQuotaError(e) {
  return !!e && (e.name === "QuotaExceededError" || e.code === 22 || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

/* Anything IndexedDB threw → an error whose .code the store understands. */
function historyIdbError(e) {
  if (e && (e.code === "quota" || e.code === "enospc" || e.code === "io" || e.code === "read-only")) return e;
  if (isQuotaError(e)) return codedError("quota", "history: the browser's storage quota is full", e);
  return codedError("io", "history: IndexedDB failed" + (e && e.name ? " (" + e.name + ")" : ""), e);
}

function idbReq(req) {
  return new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function isBucket(v) {
  return v === HISTORY_OLDER_KEY || (typeof v === "string" && DOC_ID_RE.test(v));
}

/* An index row → the DocRecord the store sees (the key field dropped). */
function recordOf(row) {
  var out = {};
  Object.keys(row).forEach(function (k) { if (k !== "bucket") out[k] = row[k]; });
  if (!Array.isArray(out.snapshots)) out.snapshots = [];
  return out;
}

/* A DocRecord → the row stored under `bucket`: plain data only. */
function rowOf(bucket, rec) {
  var row = JSON.parse(JSON.stringify(rec));
  row.bucket = bucket;
  return row;
}

function hasStores(db, names) {
  return names.every(function (n) { return db.objectStoreNames.contains(n); });
}

/* ================= the upgrade (onupgradeneeded) =================

   Runs inside the versionchange transaction `t`, whatever the version
   found (0 = no database yet, 1 = 2.1's, 2 = 3.0.0's):
     1. index and bodies are created if absent (so a fresh profile gets
        only these two, and a 2.1 profile gets them alongside its v1 ones);
     2. if any v1 store is there, snapMeta and snapBody are COUNTED in the
        same transaction, and the four v1 stores are deleted only when both
        counts are 0 (a finished 3.0.0 move empties them; 2.1 never wrote
        meta, and a docs row alone is a title, not history). Any rows → all
        four stay, dormant. A count that fails keeps them too (the error is
        swallowed so the upgrade itself still completes).
   deleteObjectStore from a request's success callback is legal: the
   versionchange transaction is active while its events are dispatched,
   and the open's success waits for the transaction to complete — so by
   the time open() resolves, the decision has landed. */
function upgradeDb(d, t) {
  if (!d.objectStoreNames.contains(INDEX_STORE)) d.createObjectStore(INDEX_STORE, { keyPath: "bucket" });
  if (!d.objectStoreNames.contains(BODY_STORE)) d.createObjectStore(BODY_STORE, { keyPath: "sha" });
  var v1 = V1_STORES.filter(function (n) { return d.objectStoreNames.contains(n); });
  if (!v1.length) return;
  function dropV1() {
    v1.forEach(function (n) { if (d.objectStoreNames.contains(n)) d.deleteObjectStore(n); });
  }
  var counted = V1_SNAPSHOT_STORES.filter(function (n) { return d.objectStoreNames.contains(n); });
  var left = counted.length, rows = 0, failed = false;
  if (!left) { dropV1(); return; }
  counted.forEach(function (n) {
    var r = t.objectStore(n).count();
    r.onsuccess = function () {
      rows += Number(r.result) || 0;
      if (--left === 0 && !failed && rows === 0) dropV1();
    };
    r.onerror = function (ev) {
      failed = true;
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    };
  });
}

/* ================= the backend ================= */

/* createIdbHistoryBackend({indexedDB, name})
     indexedDB  the IDBFactory (default: window.indexedDB)
     name       the database name (default 'splitpage-history')

   The interface is shared/history-store.js's; the extras are open(),
   close(), and test helpers mirroring the memory backend's (failNext,
   clearFaults, counts, and — as promises here — bodyCount, hasBody,
   dropBody, inspect, seed). */
export function createIdbHistoryBackend(o) {
  o = o || {};
  var factory = o.indexedDB || (typeof window !== "undefined" ? window.indexedDB : null) || null;
  var dbName = typeof o.name === "string" && o.name ? o.name : HISTORY_IDB_NAME;

  var db = null;
  var opening = null;
  var readOnly = false;
  var chain = Promise.resolve();
  var faults = { put: [], commit: [] };
  var counts = { exclusive: 0, put: 0, commit: 0 };

  function takeFault(op) {
    var q = faults[op];
    if (!q.length) return null;
    var f = q[0];
    if (--f.times <= 0) q.shift();
    return f.code;
  }

  function forget(d) {
    if (db === d) { db = null; readOnly = false; }
  }

  function adopt(d, ro) {
    d.onversionchange = function () { try { d.close(); } catch (e) {} forget(d); };
    d.onclose = function () { forget(d); };   /* the browser closed it (storage cleared) */
    db = d;
    readOnly = !!ro;
    return d;
  }

  /* The database at a version newer than this build's, opened as it is. */
  function openNewer() {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = factory.open(dbName); } catch (e) { reject(historyIdbError(e)); return; }
      /* Only fires when the database has vanished since the VersionError:
         never create an empty one here (it would sit at version 1 with no
         stores, in the way of every build). */
      req.onupgradeneeded = function () { try { req.transaction.abort(); } catch (e) {} };
      req.onsuccess = function () {
        var d = req.result;
        if (!hasStores(d, [INDEX_STORE, BODY_STORE])) {
          try { d.close(); } catch (e) {}
          reject(codedError("io", "history: the database is a newer format this build cannot read"));
          return;
        }
        resolve(adopt(d, true));
      };
      req.onerror = function (ev) {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        reject(historyIdbError(req.error));
      };
    });
  }

  function openDb() {
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    var p = new Promise(function (resolve, reject) {
      var failed = false;
      function fail(e) { failed = true; reject(historyIdbError(e)); }
      if (!factory) { fail(codedError("io", "history: no IndexedDB")); return; }
      var req;
      try { req = factory.open(dbName, HISTORY_IDB_VERSION); } catch (e) { fail(e); return; }
      req.onupgradeneeded = function () { upgradeDb(req.result, req.transaction); };
      req.onsuccess = function () {
        var d = req.result;
        if (failed) { try { d.close(); } catch (e) {} return; }
        resolve(adopt(d, false));
      };
      req.onerror = function (ev) {
        var err = req.error;
        if (err && err.name === "VersionError" && !failed) {
          if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
          openNewer().then(resolve, function (e) { failed = true; reject(e); });
          return;
        }
        fail(err || new Error("idb-open"));
      };
      req.onblocked = function () { fail(codedError("io", "history: the upgrade is blocked by another tab")); };
    });
    opening = p;
    p.then(function () { if (opening === p) opening = null; }, function () { if (opening === p) opening = null; });
    return p;
  }

  /* d.transaction(), reopening once if the connection was closed under us
     (a versionchange between the open and this job). */
  function transaction(stores, mode) {
    function make(d) {
      var names = stores.filter(function (n) { return d.objectStoreNames.contains(n); });
      return mode === "readwrite"
        ? d.transaction(names, "readwrite", { durability: "strict" })
        : d.transaction(names, "readonly");
    }
    return openDb().then(function (d) {
      try { return make(d); } catch (e) {
        if (!e || e.name !== "InvalidStateError") throw historyIdbError(e);
        forget(d);
        return openDb().then(make);
      }
    });
  }

  /* Runs body(t) in transaction t and resolves with its result once t has
     COMPLETED. body is called synchronously, in the turn t was created. */
  function runIn(t, body) {
    var done = new Promise(function (resolve, reject) {
      t.oncomplete = function () { resolve(); };
      /* t.error is null after our own abort() — the job's error is the reason then */
      t.onabort = function () { reject(t.error || null); };
      t.onerror = function () { /* onabort follows and carries the reason */ };
    });
    done.then(null, noop);
    var started;
    try { started = Promise.resolve(body(t)); } catch (e) { started = Promise.reject(e); }
    return started.then(function (result) {
      return done.then(function () { return result; }, function (txErr) {
        throw historyIdbError(txErr || codedError("io", "history: transaction aborted"));
      });
    }, function (e) {
      try { t.abort(); } catch (x) { /* already finished or aborting */ }
      return done.then(function () { throw historyIdbError(e); }, function (txErr) {
        throw historyIdbError(txErr && txErr.name && txErr.name !== "AbortError" ? txErr : e);
      });
    });
  }

  /* ---- the tx handed to the store ---- */

  function makeTx(t, write) {
    var index = t.objectStore(INDEX_STORE);
    var bodies = t.objectStore(BODY_STORE);
    var committed = false;
    function mustWrite() {
      if (readOnly) throw codedError("read-only", "history: the database is read-only (a newer build's)");
      if (!write) throw codedError("io", "history: a write in a read-only job");
    }
    return {
      list: function () {
        return idbReq(index.getAll()).then(function (rows) {
          var out = {};
          (rows || []).forEach(function (row) { if (row && isBucket(row.bucket)) out[row.bucket] = recordOf(row); });
          return out;
        });
      },
      get: function (sha) {
        if (typeof sha !== "string") return Promise.resolve(null);
        return idbReq(bodies.get(sha)).then(function (row) {
          return row && typeof row.stateJson === "string" ? row.stateJson : null;
        });
      },
      put: function (sha, text) {
        try {
          mustWrite();
          counts.put++;
          var code = takeFault("put");
          if (code) throw codedError(code, "Injected " + code + " fault");
          if (typeof sha !== "string" || !sha || typeof text !== "string") throw codedError("io", "history: bad body");
        } catch (e) { return Promise.reject(e); }
        /* Put-if-absent: a body already stored is the same bytes (it is
           content-addressed), so rewriting it would only cost quota. */
        return idbReq(bodies.count(sha)).then(function (n) {
          if (n > 0) return undefined;
          return idbReq(bodies.put({ sha: sha, stateJson: text })).then(noop);
        });
      },
      commit: function (changes, dropped) {
        try {
          mustWrite();
          if (committed) throw codedError("io", "history: commit called twice in one transaction");
          committed = true;
          counts.commit++;
          var code = takeFault("commit");
          if (code) throw codedError(code, "Injected " + code + " fault");
        } catch (e) { return Promise.reject(e); }
        var reqs = [];
        Object.keys(changes || {}).forEach(function (bucket) {
          if (!isBucket(bucket)) return;
          var rec = changes[bucket];
          reqs.push(idbReq(rec ? index.put(rowOf(bucket, rec)) : index.delete(bucket)));
        });
        (Array.isArray(dropped) ? dropped : []).forEach(function (sha) {
          if (typeof sha === "string") reqs.push(idbReq(bodies.delete(sha)));
        });
        return Promise.all(reqs).then(noop);
      }
    };
  }

  function runTx(fn, write) {
    var mode = write && !readOnly ? "readwrite" : "readonly";
    return transaction([INDEX_STORE, BODY_STORE], mode).then(function (t) {
      return runIn(t, function () { return fn(makeTx(t, write)); });
    });
  }

  /* ---- the backend object ---- */

  function enqueue(job) {
    var run = chain.then(job);
    chain = run.then(noop, noop);
    return run;
  }

  /* A test helper's read, in the chain like a job. */
  function peek(stores, body) {
    return enqueue(function () {
      return transaction(stores, "readonly").then(function (t) { return runIn(t, body); });
    });
  }

  var backend = {
    name: "idb",
    persistent: true,
    get readOnly() { return readOnly; },
    counts: counts,

    exclusive: function (fn, xo) {
      var write = !(xo && xo.write === false);
      counts.exclusive++;
      return enqueue(function () { return runTx(fn, write); }).then(null, function (e) { throw historyIdbError(e); });
    },

    /* Resolves once usable (upgraded to v3, or a newer database adopted
       read-only); rejects when the database cannot be opened at all — the
       caller's cue for memory. */
    open: function () {
      return enqueue(function () { return openDb().then(noop); });
    },

    /* Closes the connection after the queued jobs (a reload in the tests;
       resetForTest). The next job reopens. */
    close: function () {
      return enqueue(function () {
        var d = db;
        if (d) { try { d.close(); } catch (e) {} forget(d); }
      });
    },

    failNext: function (op, code, times) {
      if (!faults[op]) throw new TypeError("failNext: unknown op " + op);
      faults[op].push({ code: code, times: times == null ? 1 : times });
    },
    clearFaults: function () { faults.put = []; faults.commit = []; },

    /* ---- test helpers (promises; the memory backend's are synchronous,
       and `await` reads both) ---- */
    bodyCount: function () {
      return peek([BODY_STORE], function (t) { return idbReq(t.objectStore(BODY_STORE).count()); });
    },
    hasBody: function (sha) {
      return peek([BODY_STORE], function (t) {
        return idbReq(t.objectStore(BODY_STORE).count(String(sha))).then(function (n) { return n > 0; });
      });
    },
    inspect: function () {
      return peek([INDEX_STORE, BODY_STORE], function (t) {
        return Promise.all([idbReq(t.objectStore(INDEX_STORE).getAll()), idbReq(t.objectStore(BODY_STORE).getAll())]).then(function (res) {
          var index = {}, bodies = {};
          res[0].forEach(function (row) { index[row.bucket] = recordOf(row); });
          res[1].forEach(function (row) { bodies[row.sha] = row.stateJson; });
          return { index: index, bodies: bodies };
        });
      });
    },
    dropBody: function (sha) {
      return enqueue(function () {
        return transaction([BODY_STORE], "readwrite").then(function (t) {
          return runIn(t, function () { return idbReq(t.objectStore(BODY_STORE).delete(String(sha))); });
        });
      });
    },
    /* Replace everything in index and bodies (a fixture). */
    seed: function (idx, bods) {
      return enqueue(function () {
        return transaction([INDEX_STORE, BODY_STORE], "readwrite").then(function (t) {
          return runIn(t, function () {
            var index = t.objectStore(INDEX_STORE), bodies = t.objectStore(BODY_STORE);
            return Promise.all([idbReq(index.clear()), idbReq(bodies.clear())]).then(function () {
              var reqs = [];
              Object.keys(idx || {}).forEach(function (b) { reqs.push(idbReq(index.put(rowOf(b, idx[b])))); });
              Object.keys(bods || {}).forEach(function (sha) { reqs.push(idbReq(bodies.put({ sha: sha, stateJson: bods[sha] }))); });
              return Promise.all(reqs);
            });
          });
        });
      });
    }
  };
  return backend;
}
