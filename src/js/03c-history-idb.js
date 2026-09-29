import { sha256Bytes } from "./02b-doc-id.js";
import { DOC_ID_RE } from "../../shared/doc-id-policy.js";
import { HISTORY_OLDER_KEY } from "../../shared/history-policy.js";

export var HISTORY_IDB_NAME = "splitpage-history";
export var HISTORY_IDB_VERSION = 3;

var INDEX_STORE = "index";
var BODY_STORE = "bodies";
var V1_STORES = ["docs", "snapMeta", "snapBody", "meta"];
var V1_SNAPSHOT_STORES = ["snapMeta", "snapBody"];

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

function recordOf(row) {
  var out = {};
  Object.keys(row).forEach(function (k) { if (k !== "bucket") out[k] = row[k]; });
  if (!Array.isArray(out.snapshots)) out.snapshots = [];
  return out;
}

function rowOf(bucket, rec) {
  var row = JSON.parse(JSON.stringify(rec));
  row.bucket = bucket;
  return row;
}

function hasStores(db, names) {
  return names.every(function (n) { return db.objectStoreNames.contains(n); });
}

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
    d.onclose = function () { forget(d); };
    db = d;
    readOnly = !!ro;
    return d;
  }

  function openNewer() {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = factory.open(dbName); } catch (e) { reject(historyIdbError(e)); return; }
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

  function runIn(t, body) {
    var done = new Promise(function (resolve, reject) {
      t.oncomplete = function () { resolve(); };
      t.onabort = function () { reject(t.error || null); };
      t.onerror = function () { };
    });
    done.then(null, noop);
    var started;
    try { started = Promise.resolve(body(t)); } catch (e) { started = Promise.reject(e); }
    return started.then(function (result) {
      return done.then(function () { return result; }, function (txErr) {
        throw historyIdbError(txErr || codedError("io", "history: transaction aborted"));
      });
    }, function (e) {
      try { t.abort(); } catch (x) { }
      return done.then(function () { throw historyIdbError(e); }, function (txErr) {
        throw historyIdbError(txErr && txErr.name && txErr.name !== "AbortError" ? txErr : e);
      });
    });
  }

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

  function enqueue(job) {
    var run = chain.then(job);
    chain = run.then(noop, noop);
    return run;
  }

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

    open: function () {
      return enqueue(function () { return openDb().then(noop); });
    },

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
