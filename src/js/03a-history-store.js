import { S } from "./_state.js";
import { home } from "./_home.js";
import { mintDocId, normalizeDocId, sha256Bytes } from "./02b-doc-id.js";
import { dataUrlForSync, ensureBytes, inlineStateJson, intern, persist, recordFor } from "../adapters/storage/02c-blobs.js";
import {
  SNAPSHOT_KEY,
  getEditorName,
  readLegacySnapshotsRaw,
  renderHistory
} from "./03-sync.js";
import { createIdbHistoryBackend, hashText as historyHashText } from "../adapters/storage/03c-history-idb.js";
import { showToast } from "./12-dirty-toast.js";
import { checksumText, seedCheckPasses } from "./20b-onboarding.js";
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
import { createHistoryStore, createMemoryHistoryBackend } from "../../shared/history-store.js";
import { imageDims, isSha256Hex, refsIn, sniffImageMime } from "../../shared/blob-policy.js";
import { makeId } from "../adapters/identity/ids.ts";
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

var historyChain;

var HISTORY_BROWSER_MIN_CAP = 5 * 1024 * 1024;
var HISTORY_BROWSER_HEADROOM = 50 * 1024 * 1024;
var HISTORY_ESTIMATE_TTL_MS = 5 * 60 * 1000;
var HISTORY_MEMORY_CAP = 50 * 1024 * 1024;
var HISTORY_PENDING_PER_DOC = 10;
var HISTORY_MIGRATION_LOOPS = 3;

export function historyNoop() {}

function enqueueHistory(job, fallback) {
  var run = historyChain.then(function () { return job(); }).then(null, function (e) {
    if (window.console) console.error(e);
    try { return typeof fallback === "function" ? fallback(e) : fallback; } catch (x) { return undefined; }
  });
  historyChain = run.then(historyNoop, historyNoop);
  return run;
}

function historyIdle() {
  var c = historyChain;
  var m = historyMigrationPromise;
  return Promise.all([c, m]).then(function () {
    if (c === historyChain && m === historyMigrationPromise) return true;
    return historyIdle();
  });
}

var historyNowOverride = null;
function historyNow() {
  return historyNowOverride != null ? historyNowOverride : Date.now();
}

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

var historyProtected = {};

function historyProtectKey(bucket, id) { return bucket + "\n" + id; }

function historyProtectedList() {
  return Object.keys(historyProtected).map(function (k) {
    var i = k.indexOf("\n");
    return { docId: k.slice(0, i), id: k.slice(i + 1) };
  });
}

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
    if (holds !== historyProtected || !holds[key]) return;
    if (holds[key] > 1) holds[key]--; else delete holds[key];
  };
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
      return S.DESKTOP.historyPut(docId, clean, stateJson, { protect: historyProtectedList() });
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
      return S.DESKTOP.historyList(docId || null);
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
    if (!Array.isArray(entries)) return Promise.resolve({ ok: false, count: 0, added: 0, code: "invalid" });
    var added = 0, count = 0, i = 0;
    function next() {
      if (i >= entries.length) return Promise.resolve({ ok: true, count: count, added: added });
      var e = entries[i++];
      var meta = e && typeof e === "object" ? sanitizeHistoryMeta(e.meta) : null;
      if (!meta || typeof e.stateJson !== "string") return next();
      return historyDesktopCall(function () {
        return S.DESKTOP.historyPut(null, meta, e.stateJson, { protect: historyProtectedList(), older: true });
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

export function isPristineSeedDocument() {
  return !!S.state && S.editSeq === 0 && !S.dirty && home.kind === "none" && seedCheckPasses();
}

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
      try { showToast(notice.text, "warn"); } catch (e) { }
    }
    return;
  }
  if (!historyWarnedDocs[entry.docId]) {
    historyWarnedDocs[entry.docId] = true;
    try {
      showToast("Could not store a version history snapshot. It is kept in this window and will be " +
        "tried again — closing the window before then loses it.", "warn");
    } catch (e) { }
  }
}

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
      if (historyLocal[key] === entry) delete historyLocal[key];
    } else if (historyLocal[key] === entry) {
      historyMarkPending(entry);
    }
    return r;
  }, function () {
    if (historyLocal[historyLocalKey(entry.docId, entry.meta.id)] === entry) historyMarkPending(entry);
    return { stored: false, code: "io" };
  });
}

export function captureSnapshot(label, src, opts) {
  opts = opts || {};
  if (!src || typeof src !== "object" || !Array.isArray(src.rows)) return null;
  if (opts.allowSeedSkip && src === S.state && isPristineSeedDocument()) return null;
  var docId = normalizeDocId(src.docId) || (src.docId = mintDocId());
  var stateJson;
  try {
    stateJson = JSON.stringify(src);
  } catch (e) {
    if (!historyWarnedDocs["size:" + docId]) {
      historyWarnedDocs["size:" + docId] = true;
      try { showToast("This document is too large to snapshot — version history is unavailable.", "warn"); } catch (x) {}
    }
    return null;
  }
  if (typeof stateJson !== "string") return null;
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

export function listDocHistory(docId) {
  docId = normalizeDocId(docId);
  var localBefore = docId ? historyLocalEntries(docId) : [];
  return resolveHistoryBackend().then(function (backend) {
    return backend.list(docId || null).then(null, function () {
      return { entries: [], older: [], olderExpiresAt: null, usage: null };
    }).then(function (listed) {
      listed = listed || { entries: [], older: [], olderExpiresAt: null, usage: null };
      var seen = {}, entries = [];
      (listed.entries || []).forEach(function (m) {
        seen[m.id] = true;
        m.status = "stored";
        entries.push(m);
      });
      if (docId) entries = entries.concat(historyLocalMetas(docId, historyLocalEntries(docId).concat(localBefore), seen));
      entries.sort(function (a, b) { return b.atMs - a.atMs; });
      var n = backend.name === "idb" ? historyIdbNotice() : null;
      var notice = n ? n.text : null;
      return {
        entries: entries,
        older: (listed.older || []).map(function (m) { m.status = "stored"; return m; }),
        olderExpiresAt: listed.olderExpiresAt == null ? null : listed.olderExpiresAt,
        backend: backend.name,
        persistent: !!backend.persistent,
        usage: listed.usage || null,
        notice: notice
      };
    });
  }).then(null, function (e) {
    if (window.console) console.error(e);
    return { entries: [], older: [], olderExpiresAt: null, backend: historyBackendNameNow, persistent: false, usage: null, notice: null };
  });
}

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

export function historyDocumentChanged() {
  if (S.state && normalizeDocId(S.state.docId)) historyTouchDocument(S.state.docId, S.state.title);
  historyRenderSoon();
}

export function copyHistory(from, to) {
  if (from === HISTORY_OLDER_KEY || to === HISTORY_OLDER_KEY) return Promise.resolve({ ok: false, copied: 0, code: "invalid" });
  from = normalizeDocId(from);
  to = normalizeDocId(to);
  if (!from || !to) return Promise.resolve({ ok: false, copied: 0, code: "invalid" });
  if (from === to) return Promise.resolve({ ok: true, copied: 0 });
  return enqueueHistory(function () {
    return resolveHistoryBackend().then(function (backend) {
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

var HISTORY_EXPORT_CAP_BYTES = 200 * 1024 * 1024;
var historyExportCapOverride = null;

function historyExportCap() {
  return historyExportCapOverride != null ? historyExportCapOverride : HISTORY_EXPORT_CAP_BYTES;
}

function historyExportError(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

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

var HISTORY_BLOB_HINT_RE = /imageRef|imageValue|data-blob/;

function historyRefsInJson(stateJson) {
  if (typeof stateJson !== "string" || !HISTORY_BLOB_HINT_RE.test(stateJson)) return [];
  try { return refsIn(JSON.parse(stateJson)); } catch (e) { return []; }
}

function historyBlobCost(sha, entry) {
  return sha.length + entry.mime.length + entry.b64.length + 40;
}

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

var HISTORY_IMPORT_BATCH = 25;
var HISTORY_IMPORT_BLOB_MAX_BYTES = 16 * 1024 * 1024;
var HISTORY_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function historyDecodeBase64(b64) {
  if (typeof b64 !== "string" || !HISTORY_BASE64_RE.test(b64)) return null;
  var bin;
  try { bin = atob(b64); } catch (e) { return null; }
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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

function historyImportIsQuota(code) {
  return code === "quota" || code === "enospc";
}

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

    if (bundle.blobs) result.blobs = await historyImportBlobs(bundle.blobs, historyImportRefs(docs, bundle.older));

    for (var d = 0; d < docs.length; d++) {
      var doc = docs[d];
      var snaps = (doc && typeof doc === "object" && Array.isArray(doc.snapshots)) ? doc.snapshots : [];
      var docId = normalizeDocId(doc && doc.docId);
      if (!docId) { result.failed += snaps.length; continue; }

      var entries = historyImportEntries(snaps, result);
      if (!entries.length) continue;
      if (stopped) { result.failed += entries.length; continue; }

      var existing = await enqueueHistory(function (id) {
        return function () {
          return resolveHistoryBackend().then(function (backend) { return backend.list(id, { strict: true }); })
            .then(function (listed) {
              return (listed && typeof listed === "object" && Array.isArray(listed.entries)) ? listed.entries : null;
            });
        };
      }(docId), function () { return null; });
      if (existing == null) {
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
      var processed = 0;
      for (var start = 0; start < keep.length && !stopped; start += HISTORY_IMPORT_BATCH) {
        if (start > 0) await historyImportYield();
        var batch = keep.slice(start, start + HISTORY_IMPORT_BATCH);
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
          return null;
        });
        docAdded += progress.added;
        result.added += progress.added;
        result.skipped += progress.skipped;
        result.failed += progress.failed;
        if (progress.quota) {
          stopped = true;
          result.code = "quota";
          processed += progress.done;
          result.failed += keep.length - processed;
          processed = keep.length;
        } else {
          result.failed += batch.length - progress.done;
          processed += batch.length;
        }
      }

      if (docAdded) {
        result.docs++;
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

function historyLegacyRaw() {
  if (typeof readLegacySnapshotsRaw === "function") return readLegacySnapshotsRaw();
  try { return localStorage.getItem(SNAPSHOT_KEY); } catch (e) { return null; }
}

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
          } catch (e) { }
          historyRenderSoon();
          return result;
        });
      });
    }
    return expirySweep.then(loop);
  });
}

function historyTestBucket(docId) {
  if (docId === HISTORY_OLDER_KEY || docId === "older") return HISTORY_OLDER_KEY;
  return normalizeDocId(docId);
}

function historyTestStore() {
  return resolveHistoryBackend().then(function (b) { return b.store ? b : null; });
}

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

function historyResetForTest() {
  historyFault = null;
  releaseDelayedPut();
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

export function __init() {
  historyChain = Promise.resolve();

  window.__historyTest = {
    idle: historyIdle,
    backendName: function () { return historyBackendNameNow; },
    forceBackend: function (name) {
      historyForced = name === "idb" || name === "memory" ? name : null;
      if (historyForced === "idb") historyIdbFailed = false;
      return resolveHistoryBackend().then(function (b) { return b.name; });
    },
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
    injectFault: function (name) {
      var known = ["idb-open-fail", "quota-once", "quota-always", "io-always", "delay-put", "delay-import", "import-fail"];
      if (name == null) {
        if (historyFault === "delay-put") releaseDelayedPut();
        if (historyFault === "delay-import") releaseDelayedImport();
        historyFault = null;
        if (historyIdb) historyArmFaults(historyIdb.backend);
        if (historyMem) historyArmFaults(historyMem.backend);
        if (historyLocalEntries(null, "pending").length) retryPendingSnapshots();
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
    releaseDelayedPut: releaseDelayedPut,
    releaseDelayedImport: releaseDelayedImport,
    importGateHit: function () { return historyImportGateHit; },
    listRaw: function (docId) {
      var bucket = historyTestBucket(docId);
      if (!bucket) return Promise.resolve([]);
      return resolveHistoryBackend().then(function (b) { return b.rawList ? b.rawList(bucket) : []; });
    },
    bodyCount: function (docId) {
      var bucket = docId == null ? null : historyTestBucket(docId);
      if (docId != null && !bucket) return Promise.resolve(0);
      return historyTestStore().then(function (a) { return a ? historyTestBodyCount(a, bucket) : 0; });
    },
    docRecord: function (docId) {
      var bucket = historyTestBucket(docId);
      if (!bucket) return Promise.resolve(null);
      return resolveHistoryBackend().then(function (b) { return b.rawDoc ? b.rawDoc(bucket) : null; });
    },
    rawIndex: function () {
      return historyTestStore().then(function (a) { return a ? a.store.rawIndex() : null; });
    },
    inspect: function () {
      return historyTestStore().then(function (a) { return a ? a.store.backend.inspect() : null; });
    },
    read: getHistorySnapshot,
    pending: function (docId) {
      return historyLocalEntries(docId ? normalizeDocId(docId) || "-" : null, "pending").map(function (e) {
        return { docId: e.docId, id: e.meta.id, label: e.meta.label, status: e.status };
      });
    },
    migrate: startHistoryMigration,
    resetForTest: historyResetForTest,
    notice: function () { var n = historyIdbNotice(); return n ? n.text : null; },
    setDesktopTimeout: function (ms) {
      historyDesktopTimeoutOverride = (ms == null || !isFinite(Number(ms))) ? null : Math.max(0, Number(ms));
      return historyDesktopTimeoutOverride;
    },
    importBundle: importHistoryBundle,
    setExportCap: function (bytes) {
      historyExportCapOverride = (bytes == null || !isFinite(Number(bytes))) ? null : Math.max(0, Number(bytes));
      return historyExportCapOverride;
    }
  };
}
