import { normalizeDocId } from "../../../shared/doc-id-policy.js";
import { HISTORY_OLDER_KEY, sanitizeHistoryMeta } from "../../../shared/history-policy.js";
import { createHistoryStore, createMemoryHistoryBackend } from "../../../shared/history-store.js";
import { createIdbHistoryBackend, hashText as historyHashText } from "./03c-history-idb.js";

export function createHistoryBackends(ports) {
  var historyNow = ports.now;
  var historyProtectedList = ports.holds;
  var desktopPort = ports.desktop;
  var runningOnDesktop = ports.runningOnDesktop;
var HISTORY_BROWSER_MIN_CAP = 5 * 1024 * 1024;
var HISTORY_BROWSER_HEADROOM = 50 * 1024 * 1024;
var HISTORY_ESTIMATE_TTL_MS = 5 * 60 * 1000;
var HISTORY_MEMORY_CAP = 50 * 1024 * 1024;

function historyNoop() {}

function historyStripMeta(m) {
  var out = sanitizeHistoryMeta(m);
  if (out && m && typeof m.docId === "string") out.docId = m.docId;
  return out;
}

var historyFault = null;
var historyDelayGate = null;
var historyDelayRelease = null;
var historyImportGate = null;
var historyImportRelease = null;
var historyImportGateHit = false;

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

function releaseDelayedPut() {
  if (historyFault === "delay-put") historyFault = null;
  var r = historyDelayRelease;
  historyDelayGate = null;
  historyDelayRelease = null;
  if (r) r();
}

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

function historyIdbCap(lastTotal) {
  if (historyCapOverride != null) return historyCapOverride;
  if (lastTotal == null) return Infinity;
  return historyBrowserCap(lastTotal);
}

function historyMemoryCap() {
  return historyCapOverride != null ? historyCapOverride : HISTORY_MEMORY_CAP;
}


function historyMakeStore(backend, capBytes) {
  return createHistoryStore({
    backend: backend,
    now: historyNow,
    hashText: historyHashText,
    capBytes: capBytes,
    holds: historyProtectedList
  });
}

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
      return Promise.resolve(historyPutFaultGate()).then(function () {
        return store.put(docId, meta, stateJson);
      });
    },
    list: function (docId) {
      return store.list(docId || null).then(function (r) {
        return store.usage().then(function (u) { r.usage = u; return r; }, function () { r.usage = null; return r; });
      });
    },
    get: function (bucket, id) { return store.get(bucket, id); },
    copy: function (from, to) { return store.copy(from, to); },
    touch: function (docId, title) { return store.touch(docId, title); },
    importOlder: function (entries) {
      if (historyFault === "import-fail") return Promise.resolve({ ok: false, count: 0, added: 0, code: "io" });
      return Promise.resolve(historyImportFaultGate()).then(function () {
        return store.importOlder(entries);
      });
    },
    evict: function (cap) { return store.evict(cap); },
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

var historyIdb = null;
var historyMem = null;
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

function historyOpenIdb() {
  if (historyIdb) return historyIdb.ready;
  if (historyFault === "idb-open-fail") return Promise.reject(new Error("Injected idb-open-fail"));
  var factory;
  try { factory = window.indexedDB || null; } catch (e) { factory = null; }
  var backend = createIdbHistoryBackend({ indexedDB: factory });
  historyArmFaults(backend);
  var store = historyMakeStore(backend, historyIdbCap);
  var entry = { backend: backend, store: store, adapter: historyStoreAdapter(store), ready: null };
  historyIdb = entry;
  entry.ready = backend.open().then(function () {
    if (!historyPersistAsked && typeof navigator !== "undefined" && navigator.userAgentData && navigator.storage &&
        typeof navigator.storage.persist === "function") {
      historyPersistAsked = true;
      try { navigator.storage.persist().then(historyNoop, historyNoop); } catch (e) {}
    }
    return entry.adapter;
  }, function (e) {
    if (historyIdb === entry) historyIdb = null;
    backend.close().then(historyNoop, historyNoop);
    throw e;
  });
  return entry.ready;
}

function historyIdbNotice() {
  var e = historyIdb;
  if (!e) return null;
  if (e.backend.readOnly) {
    return { kind: "read-only", text: "Version history is read-only here: a newer version of Splitpage wrote it. New snapshots are kept in this window." };
  }
  return null;
}

var HISTORY_DESKTOP_TIMEOUT_MS = 30000;
var historyDesktopTimeoutOverride = null;

function historyDesktopUsage(u) {
  if (!u || typeof u !== "object") return null;
  return {
    totalBytes: Number(u.totalBytes) || 0,
    capBytes: Number(u.capBytes) || 0,
    overCap: !!u.overCap,
    docCount: Number(u.docCount) || 0,
    readOnly: !!u.readOnly
  };
}

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

  put: function (docId, meta, stateJson) {
    var clean = sanitizeHistoryMeta(meta);
    if (!normalizeDocId(docId) || !clean || typeof stateJson !== "string") {
      return Promise.resolve({ stored: false, code: "invalid" });
    }
    return historyDesktopCall(function () {
      return desktopPort().historyPut(docId, clean, stateJson, { protect: historyProtectedList() });
    }, { stored: false, code: "timeout" }, { stored: false, code: "invalid" }).then(function (r) {
      if (!r || typeof r !== "object") return { stored: false, code: "io" };
      if (r.stored === false) return r;
      if (!r.ok) return { stored: false, code: typeof r.code === "string" ? r.code : "io" };
      var out = { stored: true, evicted: Number(r.evicted) || 0, overCap: !!r.overCap };
      if (r.duplicate) out.duplicate = true;
      return out;
    });
  },

  list: function (docId, opts) {
    var empty = { entries: [], older: [], olderExpiresAt: null };
    var failed = (opts && opts.strict) ? null : empty;
    return historyDesktopCall(function () {
      return desktopPort().historyList(docId || null);
    }, failed, failed).then(function (r) {
      if (!r || typeof r !== "object") return failed;
      if (opts && opts.strict && docId && !Array.isArray(r.entries)) return null;
      var entries = (r.entries || []).map(historyStripMeta).filter(Boolean);
      if (docId) entries.forEach(function (m) { m.docId = docId; });
      var older = (r.older || []).map(historyStripMeta).filter(Boolean);
      older.forEach(function (m) { m.docId = HISTORY_OLDER_KEY; });
      return {
        entries: entries,
        older: older,
        olderExpiresAt: r.olderExpiresAt == null ? null : Number(r.olderExpiresAt),
        usage: historyDesktopUsage(r.usage)
      };
    });
  },

  get: function (bucket, id) {
    var query = bucket === HISTORY_OLDER_KEY
      ? { older: true, protect: historyProtectedList() }
      : { docId: bucket, protect: historyProtectedList() };
    return historyDesktopCall(function () {
      return desktopPort().historyGet(query, id);
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
      return desktopPort().historyCopy(from, to);
    }, { ok: false, copied: 0, code: "timeout" }, { ok: false, copied: 0, code: "invalid" })
      .then(function (r) {
        if (!r || typeof r !== "object") return { ok: false, copied: 0, code: "io" };
        return { ok: !!r.ok, copied: Number(r.copied) || 0, code: r.code };
      });
  },

  touch: function (docId, title) {
    return historyDesktopCall(function () {
      return desktopPort().historyTouch(docId, title);
    }, null, null);
  },

  importOlder: function (entries) {
    if (!Array.isArray(entries)) return Promise.resolve({ ok: false, count: 0, added: 0, code: "invalid" });
    var added = 0, count = 0, i = 0;
    function next() {
      if (i >= entries.length) return Promise.resolve({ ok: true, count: count, added: added });
      var e = entries[i++];
      var meta = e && typeof e === "object" ? sanitizeHistoryMeta(e.meta) : null;
      if (!meta || typeof e.stateJson !== "string") return next();
      return historyDesktopCall(function () {
        return desktopPort().historyPut(null, meta, e.stateJson, { protect: historyProtectedList(), older: true });
      }, { ok: false, code: "timeout" }, { ok: false, code: "invalid" }).then(function (r) {
        if (!r || typeof r !== "object") r = { ok: false, code: "io" };
        if (r.ok) {
          count++;
          if (!r.duplicate) added++;
          return next();
        }
        if (r.code === "too-large") return next();
        return { ok: false, count: count, added: added, code: typeof r.code === "string" ? r.code : "io" };
      });
    }
    return next();
  },

  evict: function () { return Promise.resolve({ evicted: 0, overCap: false, totalBefore: 0, totalAfter: 0 }); },

  rawDocIds: function () {
    return historyDesktopCall(function () {
      return desktopPort().historyListDocs();
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

  rawDoc: function (bucket) {
    return historyDesktopCall(function () {
      return desktopPort().historyListDocs();
    }, null, null).then(function (r) {
      if (!Array.isArray(r)) return null;
      var hit = null;
      r.forEach(function (d) {
        if (d && normalizeDocId(d.docId) === bucket) hit = d;
      });
      return hit ? { title: hit.title || "", lastOpenedAt: Number(hit.lastOpenedAt) || 0 } : null;
    });
  },

  rawList: function (bucket) {
    var docId = bucket === HISTORY_OLDER_KEY ? null : bucket;
    return desktopHistoryBackend.list(docId).then(function (r) {
      if (!r) return [];
      return bucket === HISTORY_OLDER_KEY ? r.older : r.entries;
    });
  }
};

var historyForced = null;
var historyIdbFailed = false;
var historyBackendNameNow = null;

function historyUseMemory() {
  historyBackendNameNow = "memory";
  return historyMemory().adapter;
}

function resolveHistoryBackend() {
  if (historyForced === "memory") return Promise.resolve(historyUseMemory());
  if (!historyForced && runningOnDesktop() && typeof desktopPort().historyPut === "function") {
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
        req.onblocked = function () { setTimeout(finish, 3000); };
      } catch (x) { finish(); }
    });
  });
}


  return {
    resolveHistoryBackend,
    historyIdbNotice,
    backendName: function () { return historyBackendNameNow; },
    close: function () { return historyIdb ? historyIdb.backend.close() : Promise.resolve(); },
    prepareResetForTest: function () {
      historyFault = null;
      releaseDelayedPut();
      releaseDelayedImport();
      historyImportGateHit = false;
    },
    reset: function () {
      historyForced = null;
      historyCapOverride = null;
      historyDesktopTimeoutOverride = null;
      historyEstimateCache = null;
      historyMem = null;
      historyIdbFailed = false;
      historyBackendNameNow = null;
      return historyDropIdb();
    },
    controls: {
      backendName: function () { return historyBackendNameNow; },
      forceBackend: function (name) {
        historyForced = name === "idb" || name === "memory" ? name : null;
        if (historyForced === "idb") historyIdbFailed = false;
        return resolveHistoryBackend().then(function (b) { return b.name; });
      },
      setCapOverride: function (bytes) {
        historyCapOverride = (bytes == null || !isFinite(Number(bytes))) ? null : Number(bytes);
        historyEstimateCache = null;
        return historyCapOverride;
      },
      injectFault: function (name) {
        var known = ["idb-open-fail", "quota-once", "quota-always", "io-always", "delay-put", "delay-import", "import-fail"];
        if (name == null) {
          if (historyFault === "delay-put") releaseDelayedPut();
          if (historyFault === "delay-import") releaseDelayedImport();
          historyFault = null;
          if (historyIdb) historyArmFaults(historyIdb.backend);
          if (historyMem) historyArmFaults(historyMem.backend);
          return null;
        }
        if (name === "delay-import") historyImportGateHit = false;
        historyFault = known.indexOf(name) !== -1 ? name : null;
        if (historyIdb) historyArmFaults(historyIdb.backend);
        if (historyMem) historyArmFaults(historyMem.backend);
        if (historyFault === "idb-open-fail") {
          if (historyIdb) historyIdb.backend.close().then(historyNoop, historyNoop);
          historyIdb = null;
          historyIdbFailed = false;
        }
        return historyFault;
      },
      releaseDelayedPut,
      releaseDelayedImport,
      importGateHit: function () { return historyImportGateHit; },
      notice: function () { var n = historyIdbNotice(); return n ? n.text : null; },
      setDesktopTimeout: function (ms) {
        historyDesktopTimeoutOverride = (ms == null || !isFinite(Number(ms))) ? null : Math.max(0, Number(ms));
        return historyDesktopTimeoutOverride;
      }
    }
  };
}
