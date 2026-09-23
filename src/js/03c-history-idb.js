/* ---------------------------------------------------------------------
 * 03c-history-idb.js: the browser's storage for version history (#83),
 * as a backend for shared/history-store.js — and, clearly marked below and
 * TEMPORARY, the one-time move of the v1 IndexedDB rows into it.
 *
 * NOT WIRED IN YET (step 2b). Nothing in the app imports this file; step 3b
 * switches 03a-history-store.js over to createHistoryStore() on top of it.
 * It has no __init(): nothing here reads the DOM or storage at evaluation
 * time — the factory is handed its indexedDB, so node --test runs it over
 * fake-indexeddb (src/test/history-idb.test.mjs).
 *
 * ---- THE SCHEMA: database 'splitpage-history', version 2 ----
 *
 *   index   keyPath 'bucket'   one DocRecord per bucket (a docId, or
 *                              HISTORY_OLDER_KEY): {bucket, title,
 *                              lastOpenedAt, migratedAt?, expiresAt?,
 *                              snapshots: [SnapshotMeta + {sha}] oldest first}
 *   bodies  keyPath 'sha'      {sha, stateJson}; one row per distinct body,
 *                              shared by every entry (in any bucket) naming it
 *
 * The v2 upgrade only CREATES those two stores. The v1 stores (docs,
 * snapMeta [docId,id] + index byDocAt, snapBody [docId,id], and the unused
 * meta / byLastOpened) are left in place for the migrator below, and a
 * fresh profile never gets them at all; a later v3 deletes them.
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
 *     deleteDatabase — is never blocked by this one. 03a's v1 connection
 *     does the same, which is what lets this build's v1 → v2 upgrade
 *     through: an old-build tab closes, its next open(…, 1) fails with a
 *     VersionError, and 03a falls back to memory for that page.
 *   * onblocked (an old connection that will not close) fails THIS open at
 *     once with 'io' instead of hanging every snapshot behind it; a success
 *     that arrives later is closed, not adopted — the caller has already
 *     chosen another backend (03a's rule).
 *   * VersionError (the database is NEWER than 2 — a newer build ran here,
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
 * open() resolves once the database is usable (and the migration below has
 * run), or rejects — 03a's resolveHistoryBackend() chooses memory on that,
 * as it does today.
 * --------------------------------------------------------------------- */

import { sha256Bytes } from "./02b-doc-id.js";
import { DOC_ID_RE } from "../../shared/doc-id-policy.js";
import {
  HISTORY_OLDER_KEY,
  HISTORY_OLDER_TTL_MS,
  HISTORY_SNAP_ID_RE,
  historyClip,
  historyUtf8Length,
  sanitizeHistoryMeta
} from "../../shared/history-policy.js";

export var HISTORY_IDB_NAME = "splitpage-history";
export var HISTORY_IDB_VERSION = 2;

var INDEX_STORE = "index";
var BODY_STORE = "bodies";
/* The v1 stores (03a-history-store.js's openHistoryDb). */
var V1_DOCS = "docs";
var V1_META = "snapMeta";
var V1_BODY = "snapBody";
/* A v1 entry seen through the read-only v1 reader carries this pseudo-sha
   instead of a real one; tx.get() resolves it from snapBody. */
var V1_SHA_PREFIX = "v1:";

/* The content address the store hands every body: SHA-256 of its UTF-8, as
   64 lowercase hex — synchronous (02b's core over TextEncoder output), so
   the store can run it before a transaction and the migrator INSIDE one. */
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

function finiteOr(v, dflt) {
  var n = Number(v);
  return isFinite(n) ? n : dflt;
}

function byAtAscending(a, b) {
  return (a.atMs - b.atMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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

/* ================= the backend ================= */

/* createIdbHistoryBackend({indexedDB, name, now, hashText, fault})
     indexedDB  the IDBFactory (default: window.indexedDB)
     name       the database name (default 'splitpage-history')
     now()      the migrator's clock (default Date.now)
     hashText   SYNCHRONOUS text → sha (default: hashText above)
     fault      a test fault, as injectFault() below takes it

   The interface is shared/history-store.js's; the extras are open(),
   close(), migration, injectFault(), and test helpers mirroring the memory
   backend's (failNext, clearFaults, counts, and — as promises here —
   bodyCount, hasBody, dropBody, inspect, seed, v1Counts). */
export function createIdbHistoryBackend(o) {
  o = o || {};
  var factory = o.indexedDB || (typeof window !== "undefined" ? window.indexedDB : null) || null;
  var dbName = typeof o.name === "string" && o.name ? o.name : HISTORY_IDB_NAME;
  var now = typeof o.now === "function" ? o.now : Date.now;
  var hash = typeof o.hashText === "function" ? o.hashText : hashText;

  var db = null;
  var opening = null;
  var readOnly = false;
  var chain = Promise.resolve();
  var faults = { put: [], commit: [] };
  var counts = { exclusive: 0, put: 0, commit: 0 };
  /* state: 'unknown' (not checked yet) | 'none' (no v1 stores) | 'running'
     | 'done' | 'incomplete' (a step failed or was stopped; see below) */
  var migration = { state: "unknown", migrated: 0, skipped: 0, code: null };
  var stopAfter = null;      /* test fault: migrate-stop-after:N */
  var stopped = false;       /* …which then also stops the retry */

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
      req.onupgradeneeded = function () {
        /* Creates only. The v1 stores stay where they are for the migrator. */
        var d = req.result;
        if (!d.objectStoreNames.contains(INDEX_STORE)) d.createObjectStore(INDEX_STORE, { keyPath: "bucket" });
        if (!d.objectStoreNames.contains(BODY_STORE)) d.createObjectStore(BODY_STORE, { keyPath: "sha" });
      };
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

  function makeTx(t, write, withV1) {
    var index = t.objectStore(INDEX_STORE);
    var bodies = t.objectStore(BODY_STORE);
    var committed = false;
    function mustWrite() {
      if (readOnly) throw codedError("read-only", "history: the database is read-only (a newer build's)");
      if (!write) throw codedError("io", "history: a write in a read-only job");
    }
    return {
      list: function () {
        var main = idbReq(index.getAll()).then(function (rows) {
          var out = {};
          (rows || []).forEach(function (row) { if (row && isBucket(row.bucket)) out[row.bucket] = recordOf(row); });
          return out;
        });
        if (!withV1) return main;
        return Promise.all([
          main,
          idbReq(t.objectStore(V1_DOCS).getAll()),
          idbReq(t.objectStore(V1_META).getAll())
        ]).then(function (res) { return mergeV1(res[0], res[1], res[2], now()); });
      },
      get: function (sha) {
        if (typeof sha !== "string") return Promise.resolve(null);
        if (sha.indexOf(V1_SHA_PREFIX) === 0) {
          var key = v1KeyOf(sha);
          if (!withV1 || !key) return Promise.resolve(null);
          return idbReq(t.objectStore(V1_BODY).get(key)).then(function (row) {
            return row && typeof row.stateJson === "string" ? row.stateJson : null;
          });
        }
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
          if (typeof sha === "string" && sha.indexOf(V1_SHA_PREFIX) !== 0) reqs.push(idbReq(bodies.delete(sha)));
        });
        return Promise.all(reqs).then(noop);
      }
    };
  }

  function runTx(fn, write) {
    var withV1 = migration.state === "incomplete";
    if (withV1 && write) {
      return Promise.reject(codedError("io", "history: the move to the new history format has not finished"));
    }
    var stores = [INDEX_STORE, BODY_STORE];
    if (withV1) stores = stores.concat([V1_DOCS, V1_META, V1_BODY]);
    var mode = write && !readOnly ? "readwrite" : "readonly";
    return transaction(stores, mode).then(function (t) {
      withV1 = withV1 && hasStores(t.db || db, [V1_DOCS, V1_META, V1_BODY]);
      return runIn(t, function () { return fn(makeTx(t, write, withV1)); });
    });
  }

  /* Opened, and migrated as far as it will go. A write job retries an
     incomplete migration first (quota freed since, another tab finished
     it); the test fault's stop is final for this backend, like a crash. */
  function ready(write) {
    return openDb().then(function (d) {
      if (readOnly) return d;
      if (migration.state === "unknown" || (migration.state === "incomplete" && write && !stopped)) {
        return runMigration(d).then(function () { return d; });
      }
      return d;
    });
  }

  /* ================= TEMPORARY: the v1 → v2 migration (#83) =================

     Delete with the v1 stores in the v3 that drops them.

     One v1 snapshot per transaction, as this backend's first job (every
     other job waits behind it in the chain). Each step, in ONE readwrite
     transaction over the five stores:
       1. take the first snapMeta row (key order [docId, id], so a bucket's
          rows are contiguous) and peek at the next, to know whether this is
          the bucket's last;
       2. read its snapBody row, the bucket's v1 docs row and its index row;
       3. hash the body (synchronously, inside the transaction), put it into
          bodies if absent, and merge meta + sha into index[bucket] —
          creating that record from the v1 docs row (title, lastOpenedAt,
          migratedAt, expiresAt) the first time;
       4. delete the v1 snapMeta + snapBody rows, and the docs row when this
          was the bucket's last snapshot.
     A row that was never readable in v1 (no body, an unusable meta or
     bucket) is dropped in step 4 without an entry. When no snapMeta row is
     left, the last step clears docs and snapBody (rows nothing reaches).

     RESUMABLE: every step is atomic, so what is left in v1 is exactly what
     remains to move. Another tab of this build running the same loop is
     serialised by IndexedDB (same scope, readwrite), and each step reads
     its row inside its own transaction — a row the other tab has already
     moved is simply not there any more; an id already in the index is not
     added twice.

     IF IT CANNOT FINISH (a step fails: quota, io, or the test fault), the
     state is 'incomplete': write jobs answer 'io' (03a keeps the capture
     pending and toasts once) after retrying the migration, and read jobs
     see the v2 index merged with a read-only view of the v1 rows, so
     nothing disappears from the panel meanwhile. */

  function runMigration(d) {
    if (!hasStores(d, [V1_DOCS, V1_META, V1_BODY])) {
      migration.state = "none";
      return Promise.resolve();
    }
    migration.state = "running";
    migration.code = null;
    function step() {
      if (stopAfter != null && migration.migrated + migration.skipped >= stopAfter) {
        stopped = true;
        migration.state = "incomplete";
        migration.code = "stopped";
        return undefined;
      }
      return migrateOne().then(function (outcome) {
        if (!outcome) {
          migration.state = "done";
          return undefined;
        }
        /* Counted only once the step's transaction has completed. */
        if (outcome === "moved") migration.migrated++; else migration.skipped++;
        return step();
      });
    }
    return Promise.resolve().then(step).then(null, function (e) {
      migration.state = "incomplete";
      migration.code = historyIdbError(e).code;
      if (typeof console !== "undefined" && console.warn) console.warn("Version history: moving to the new format stopped", e);
    });
  }

  /* One step. → 'moved' (an entry and its body landed in v2), 'skipped'
     (an unreadable v1 row was dropped), or false when no row was left. */
  function migrateOne() {
    return transaction([INDEX_STORE, BODY_STORE, V1_DOCS, V1_META, V1_BODY], "readwrite").then(function (t) {
      return runIn(t, function () {
        var metaStore = t.objectStore(V1_META);
        var v1Bodies = t.objectStore(V1_BODY);
        var docsStore = t.objectStore(V1_DOCS);
        var index = t.objectStore(INDEX_STORE);
        var bodies = t.objectStore(BODY_STORE);
        return firstTwo(metaStore).then(function (pair) {
          if (!pair) {
            /* Nothing left to move: what remains in v1 is unreachable. */
            return Promise.all([idbReq(docsStore.clear()), idbReq(v1Bodies.clear())]).then(function () { return false; });
          }
          var row = pair.row, key = pair.key, bucket = key[0], id = key[1];
          var last = !pair.next || pair.next[0] !== bucket;
          return Promise.all([
            idbReq(v1Bodies.get(key)),
            idbReq(docsStore.get(bucket)),
            isBucket(bucket) ? idbReq(index.get(bucket)) : null
          ]).then(function (res) {
            var body = res[0], docsRow = res[1], indexRow = res[2];
            var jobs = [];
            var entry = isBucket(bucket) && HISTORY_SNAP_ID_RE.test(String(id)) ? sanitizeHistoryMeta(row) : null;
            if (entry && body && typeof body.stateJson === "string") {
              var text = body.stateJson;
              entry.sha = hash(text);
              if (typeof entry.sha !== "string" || !entry.sha) throw codedError("io", "history: hashText gave no sha");
              entry.sizeBytes = historyUtf8Length(text);
              var rec = indexRow ? recordOf(indexRow) : v1Record(docsRow, bucket, entry, now());
              if (!rec.snapshots.some(function (s) { return s && s.id === entry.id; })) {
                rec.snapshots = rec.snapshots.concat([entry]).sort(byAtAscending);
              }
              jobs.push(idbReq(bodies.count(entry.sha)).then(function (n) {
                return n > 0 ? null : idbReq(bodies.put({ sha: entry.sha, stateJson: text }));
              }));
              jobs.push(idbReq(index.put(rowOf(bucket, rec))));
            }
            var outcome = jobs.length ? "moved" : "skipped";
            jobs.push(idbReq(metaStore.delete(key)));
            jobs.push(idbReq(v1Bodies.delete(key)));
            if (last) jobs.push(idbReq(docsStore.delete(bucket)));
            return Promise.all(jobs).then(function () { return outcome; });
          });
        });
      });
    });
  }

  function injectFault(name) {
    var m = /^migrate-stop-after:(\d+)$/.exec(String(name || ""));
    stopAfter = m ? Number(m[1]) : null;
    if (!m) stopped = false;
  }
  if (o.fault) injectFault(o.fault);

  /* ---- the backend object ---- */

  function enqueue(job) {
    var run = chain.then(job);
    chain = run.then(noop, noop);
    return run;
  }

  /* A test helper's read, in the chain like a job. */
  function peek(stores, body) {
    return enqueue(function () {
      return ready(false).then(function () {
        return transaction(stores, "readonly").then(function (t) { return runIn(t, body); });
      });
    });
  }

  var backend = {
    name: "idb",
    persistent: true,
    get readOnly() { return readOnly; },
    counts: counts,
    /* {state, migrated, skipped, code} — a copy. */
    get migration() {
      return { state: migration.state, migrated: migration.migrated, skipped: migration.skipped, code: migration.code };
    },

    exclusive: function (fn, xo) {
      var write = !(xo && xo.write === false);
      counts.exclusive++;
      return enqueue(function () {
        return ready(write).then(function () { return runTx(fn, write); });
      }).then(null, function (e) { throw historyIdbError(e); });
    },

    /* Resolves once usable (and migrated as far as it goes); rejects when
       the database cannot be opened at all — the caller's cue for memory. */
    open: function () {
      return enqueue(function () { return ready(false).then(noop); });
    },

    /* Closes the connection after the queued jobs (a reload in the tests;
       resetForTest). The next job reopens. */
    close: function () {
      return enqueue(function () {
        var d = db;
        if (d) { try { d.close(); } catch (e) {} forget(d); }
      });
    },

    injectFault: injectFault,

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
    /* Rows left in the v1 stores ({docs, snapMeta, snapBody}; null when the
       database has none). */
    v1Counts: function () {
      return enqueue(function () {
        return openDb().then(function (d) {
          if (!hasStores(d, [V1_DOCS, V1_META, V1_BODY])) return null;
          return runIn(d.transaction([V1_DOCS, V1_META, V1_BODY], "readonly"), function (t) {
            return Promise.all([V1_DOCS, V1_META, V1_BODY].map(function (n) { return idbReq(t.objectStore(n).count()); }))
              .then(function (c) { return { docs: c[0], snapMeta: c[1], snapBody: c[2] }; });
          });
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
    /* Replace everything in the v2 stores (a fixture). */
    seed: function (idx, bods) {
      return enqueue(function () {
        return ready(true).then(function () { return transaction([INDEX_STORE, BODY_STORE], "readwrite"); }).then(function (t) {
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

/* ---- TEMPORARY: v1 helpers (the migrator and the read-only v1 reader) ---- */

/* [first row, its key, the next row's key] of a store, in key order, or
   null when it is empty — the next key tells the migrator whether this is
   its bucket's last row, without a key range. */
function firstTwo(store) {
  return new Promise(function (resolve, reject) {
    var req = store.openCursor();
    var out = null;
    req.onsuccess = function () {
      var cur = req.result;
      if (!out) {
        if (!cur) { resolve(null); return; }
        out = { row: cur.value, key: cur.primaryKey, next: null };
        cur.continue();
        return;
      }
      out.next = cur ? cur.primaryKey : null;
      resolve(out);
    };
    req.onerror = function () { reject(req.error); };
  });
}

/* A v2 DocRecord for a bucket first met in v1: the v1 docs row's title,
   lastOpenedAt, migratedAt and expiresAt. No docs row (never written that
   way by 03a, but a profile is what it is) → the first entry's title and
   date. An Older bucket without a valid expiry gets a fresh 90 days — the
   desktop migration's rule — rather than none (v2 reads ≤ 0 as never). */
function v1Record(docsRow, bucket, entry, nowMs) {
  var rec = { title: "", lastOpenedAt: 0, snapshots: [] };
  if (docsRow) {
    rec.title = historyClip(docsRow.title, 300);
    rec.lastOpenedAt = finiteOr(docsRow.lastOpenedAt, 0);
    if (docsRow.migratedAt != null && isFinite(Number(docsRow.migratedAt))) rec.migratedAt = Number(docsRow.migratedAt);
    if (docsRow.expiresAt != null && isFinite(Number(docsRow.expiresAt))) rec.expiresAt = Number(docsRow.expiresAt);
  } else if (entry) {
    rec.title = entry.title || "";
    rec.lastOpenedAt = finiteOr(entry.atMs, 0);
  }
  if (bucket === HISTORY_OLDER_KEY) {
    rec.lastOpenedAt = 0;
    if (!(Number(rec.expiresAt) > 0)) {
      if (!(Number(rec.migratedAt) > 0)) rec.migratedAt = nowMs;
      rec.expiresAt = nowMs + HISTORY_OLDER_TTL_MS;
    }
  }
  return rec;
}

function v1ShaOf(bucket, id) { return V1_SHA_PREFIX + JSON.stringify([bucket, id]); }

function v1KeyOf(sha) {
  try {
    var k = JSON.parse(sha.slice(V1_SHA_PREFIX.length));
    return Array.isArray(k) && k.length === 2 && typeof k[0] === "string" && typeof k[1] === "string" ? k : null;
  } catch (e) { return null; }
}

/* The read-only v1 reader: the v2 index with every v1 row still waiting
   laid over it (a v2 entry wins by id). v1 entries name a pseudo-sha that
   tx.get() resolves from snapBody. A v1 meta whose body is gone shows until
   get() answers null — the store then tries to heal it, which is a write,
   and a write is refused while this view is in use: harmless. */
function mergeV1(index, docsRows, metas, nowMs) {
  var out = {};
  Object.keys(index).forEach(function (b) { out[b] = index[b]; });
  var docs = {};
  (docsRows || []).forEach(function (r) { if (r && typeof r.docId === "string") docs[r.docId] = r; });
  var touched = {};
  (metas || []).forEach(function (row) {
    var bucket = row && row.docId;
    if (!isBucket(bucket)) return;
    var entry = sanitizeHistoryMeta(row);
    if (!entry) return;
    entry.sha = v1ShaOf(bucket, entry.id);
    if (!touched[bucket]) {
      out[bucket] = out[bucket] ? recordOf(out[bucket]) : v1Record(docs[bucket] || null, bucket, entry, nowMs);
      out[bucket].snapshots = out[bucket].snapshots.slice();
      touched[bucket] = true;
    }
    var rec = out[bucket];
    if (!rec.snapshots.some(function (s) { return s && s.id === entry.id; })) rec.snapshots.push(entry);
  });
  Object.keys(touched).forEach(function (b) { out[b].snapshots.sort(byAtAscending); });
  return out;
}

/* ---- TEMPORARY test hook: a raw v1 database, exactly as 03a's
   openHistoryDb() lays it out (schema and row shapes), so the migration can
   be driven from a real-looking profile. Tests and step 3b's browser suite
   only.

   seedV1HistoryDb(indexedDB, {name?, docs: [docsRow], snaps: [{meta,
   stateJson}]}) — each meta carries its bucket as meta.docId; a docs row
   missing bytes/count gets them computed; a snap with stateJson null gets
   no body row (a meta whose body is lost). Resolves once written and
   closed. */
export function seedV1HistoryDb(factory, spec) {
  spec = spec || {};
  var name = typeof spec.name === "string" && spec.name ? spec.name : HISTORY_IDB_NAME;
  return new Promise(function (resolve, reject) {
    var req = factory.open(name, 1);
    req.onupgradeneeded = function (e) {
      var d = req.result;
      if ((e.oldVersion || 0) < 1) {
        /* Spelled in single quotes like 03a's: 17-formats searches the
           standalone export for the double-quoted JSON key. */
        var K = 'docId';
        var docs = d.createObjectStore("docs", { keyPath: K });
        docs.createIndex("byLastOpened", "lastOpenedAt");
        var metaStore = d.createObjectStore("snapMeta", { keyPath: [K, "id"] });
        metaStore.createIndex("byDocAt", [K, "atMs"]);
        d.createObjectStore("snapBody", { keyPath: [K, "id"] });
        d.createObjectStore("meta", { keyPath: "key" });
      }
    };
    req.onerror = function () { reject(req.error); };
    req.onsuccess = function () {
      var d = req.result;
      var t = d.transaction(["docs", "snapMeta", "snapBody"], "readwrite");
      var sums = {};
      (spec.snaps || []).forEach(function (s) {
        var m = JSON.parse(JSON.stringify(s.meta));
        if (m.sizeBytes == null && typeof s.stateJson === "string") m.sizeBytes = historyUtf8Length(s.stateJson);
        t.objectStore("snapMeta").put(m);
        if (typeof s.stateJson === "string") {
          t.objectStore("snapBody").put({ docId: m.docId, id: m.id, stateJson: s.stateJson });
        }
        var sum = sums[m.docId] || (sums[m.docId] = { bytes: 0, count: 0 });
        sum.bytes += Number(m.sizeBytes) || 0;
        sum.count++;
      });
      (spec.docs || []).forEach(function (r) {
        var row = JSON.parse(JSON.stringify(r));
        var sum = sums[row.docId] || { bytes: 0, count: 0 };
        if (row.bytes == null) row.bytes = sum.bytes;
        if (row.count == null) row.count = sum.count;
        t.objectStore("docs").put(row);
      });
      t.oncomplete = function () { d.close(); resolve(); };
      t.onabort = function () { d.close(); reject(t.error || new Error("seed aborted")); };
    };
  });
}
