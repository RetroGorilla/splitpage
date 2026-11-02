import type { HistoryBackendOptions, HistoryTestingStorage, HistorySnapshotMeta, HistorySnapshotRead, HistoryDesktopPort } from "../../application/recovery/history-ports.ts";
import type { HistoryBackendAdapter, HistoryBackendDoc, HistoryBackendList, HistoryIndex, HistoryOlderImportResult, HistoryStoreUsage } from "./history-backend-types.ts";

type HistoryStore = {
  name: string;
  persistent: boolean;
  put: HistoryBackendAdapter["put"];
  get: HistoryBackendAdapter["get"];
  copy: HistoryBackendAdapter["copy"];
  touch: HistoryBackendAdapter["touch"];
  importOlder: HistoryBackendAdapter["importOlder"];
  evict: HistoryBackendAdapter["evict"];
  list: (docId: string | null) => Promise<HistoryBackendList>;
  usage: () => Promise<HistoryStoreUsage>;
  rawIndex: () => Promise<HistoryIndex>;
  listDocs: () => Promise<{ docId: string }[]>;
};
type HistoryBrowserBackend = Pick<ReturnType<typeof createIdbHistoryBackend>, "name" | "persistent" | "exclusive">;
type HistoryLocalEntry = { backend: HistoryBrowserBackend; store: HistoryStore; adapter: HistoryBackendAdapter };
type HistoryIdbEntry = HistoryLocalEntry & { backend: ReturnType<typeof createIdbHistoryBackend>; ready: Promise<HistoryBackendAdapter> | null };
type HistoryCapacityEstimate = { at: number; quota: number; usage: number; historyBytes: number };

type HistoryReplyKeys<T> = T extends object ? keyof T : never;
type HistoryReplyAlternatives<T, All = T> = T extends object ? T & {
  [K in Exclude<HistoryReplyKeys<All>, keyof T>]?: never;
} : T;
type HistoryDesktopDoc = Awaited<ReturnType<HistoryDesktopPort["historyListDocs"]>>[number];
import { normalizeDocId } from "../../../shared/doc-id-policy.ts";
import { HISTORY_OLDER_KEY, sanitizeHistoryMeta } from "../../../shared/history-policy.ts";
import { createHistoryStore, createMemoryHistoryBackend } from "../../../shared/history-store.js";
import { createIdbHistoryBackend, hashText as historyHashText } from "./03c-history-idb.ts";

export interface HistoryBackendProbe {
  readonly capacity: () => number | null;
  readonly timeout: () => number | null;
  readonly choice: () => "idb" | "memory" | null;
  readonly write: () => Promise<void> | null;
  readonly importing: () => Promise<void> | null;
  readonly refuseImport: () => boolean;
  readonly opening: () => Error | null;
  readonly memory: (options: { name: string }) => HistoryBrowserBackend;
  readonly idb: typeof createIdbHistoryBackend;
  readonly arm: (backend: HistoryBrowserBackend) => void;
  readonly bind: (access: HistoryBackendAccess) => Pick<HistoryTestingStorage, "prepareResetForTest" | "reset" | "controls">;
}

export interface HistoryBackendAccess {
  readonly resolve: () => Promise<HistoryBackendAdapter>;
  readonly notice: () => { kind: string; text: string } | null;
  idb: HistoryIdbEntry | null;
  memory: HistoryLocalEntry | null;
  failed: boolean;
  name: string | null;
  readonly clearEstimate: () => void;
}

export function createHistoryBackends(ports: HistoryBackendOptions, probe?: HistoryBackendProbe) {
  const historyNow = ports.now;
  const historyProtectedList = ports.holds;
  const desktopPort = function () {
    const port = ports.desktop();
    if (!port) throw new TypeError("The desktop history port is unavailable");
    return port;
  };
  const runningOnDesktop = ports.runningOnDesktop;
const HISTORY_BROWSER_MIN_CAP = 5 * 1024 * 1024;
const HISTORY_BROWSER_HEADROOM = 50 * 1024 * 1024;
const HISTORY_ESTIMATE_TTL_MS = 5 * 60 * 1000;
const HISTORY_MEMORY_CAP = 50 * 1024 * 1024;

function historyNoop() {}

function historyStripMeta(m: unknown) {
  const out: HistorySnapshotMeta | null = sanitizeHistoryMeta(m);
  if (out && m && typeof (m as { docId?: unknown }).docId === "string") out.docId = (m as { docId: string }).docId;
  return out;
}

let historyEstimateCache: HistoryCapacityEstimate | null = null;

function historyBrowserCap(historyBytes: number) {
  if (probe?.capacity() != null) return Promise.resolve(probe?.capacity() as number);
  const c = historyEstimateCache;
  if (c && Date.now() - c.at < HISTORY_ESTIMATE_TTL_MS) return Promise.resolve(historyCapFrom(c));
  if (typeof navigator === "undefined" || !navigator.storage || typeof navigator.storage.estimate !== "function") return Promise.resolve(Infinity);
  return navigator.storage.estimate().then(function (est) {
    if (!est || !isFinite(Number(est.quota))) return Infinity;
    historyEstimateCache = { at: Date.now(), quota: Number(est.quota), usage: Number(est.usage) || 0, historyBytes: historyBytes };
    return historyCapFrom(historyEstimateCache);
  }, function () { return Infinity; });
}

function historyCapFrom(c: HistoryCapacityEstimate) {
  const other = Math.max(0, c.usage - c.historyBytes);
  return Math.max(HISTORY_BROWSER_MIN_CAP, c.quota - other - HISTORY_BROWSER_HEADROOM);
}

function historyIdbCap(lastTotal?: number | null) {
  if (probe?.capacity() != null) return probe?.capacity() as number;
  if (lastTotal == null) return Infinity;
  return historyBrowserCap(lastTotal);
}

function historyMemoryCap() {
  return probe?.capacity() != null ? probe?.capacity() as number : HISTORY_MEMORY_CAP;
}


function historyMakeStore(backend: HistoryBrowserBackend, capBytes: (lastTotal?: number | null) => number | Promise<number>): HistoryStore {
  return createHistoryStore({
    backend: backend,
    now: historyNow,
    hashText: historyHashText,
    capBytes: capBytes,
    holds: historyProtectedList
  }) as unknown as HistoryStore;
}

function historyRecordOf(index: HistoryIndex, bucket: string) {
  const rec = index && index[bucket];
  if (!rec) return null;
  const snaps = Array.isArray(rec.snapshots) ? rec.snapshots : [];
  const out: HistoryBackendDoc = {
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

function historyMetasOf(index: HistoryIndex, bucket: string) {
  const rec = index && index[bucket];
  return (rec && Array.isArray(rec.snapshots) ? rec.snapshots : []).map(function (s) {
    const m: HistorySnapshotMeta | null = sanitizeHistoryMeta(s);
    if (m) m.docId = bucket;
    return m;
  }).filter(Boolean) as HistorySnapshotMeta[];
}

function historyStoreAdapter(store: HistoryStore): HistoryBackendAdapter & { store: HistoryStore } {
  return {
    name: store.name,
    persistent: store.persistent,
    store: store,
    put: function (docId, meta, stateJson) {
      return Promise.resolve(probe?.write()).then(function () {
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
      if (probe?.refuseImport()) return Promise.resolve({ ok: false, count: 0, added: 0, code: "io" });
      return Promise.resolve(probe?.importing()).then(function () {
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

let historyIdb: HistoryIdbEntry | null = null;
let historyMem: HistoryLocalEntry | null = null;
let historyPersistAsked = false;

function historyMemory() {
  if (!historyMem) {
    const backend = (probe ? probe.memory : createMemoryHistoryBackend)({ name: "memory" }) as HistoryBrowserBackend;
    probe?.arm(backend);
    const store = historyMakeStore(backend, historyMemoryCap);
    historyMem = { backend: backend, store: store, adapter: historyStoreAdapter(store) };
  }
  return historyMem;
}

function historyOpenIdb() {
  if (historyIdb) return historyIdb.ready as Promise<HistoryBackendAdapter>;
  const openingError = probe?.opening();
  if (openingError) return Promise.reject(openingError);
  let factory;
  try { factory = window.indexedDB || null; } catch (e) { factory = null; }
  const backend = (probe ? probe.idb : createIdbHistoryBackend)({ indexedDB: factory });
  probe?.arm(backend);
  const store = historyMakeStore(backend, historyIdbCap);
  const entry: HistoryIdbEntry = { backend: backend, store: store, adapter: historyStoreAdapter(store), ready: null };
  historyIdb = entry;
  entry.ready = backend.open().then(function () {
    if (!historyPersistAsked && typeof navigator !== "undefined" && (navigator as Navigator & { userAgentData?: unknown }).userAgentData && navigator.storage &&
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
  const e = historyIdb;
  if (!e) return null;
  if (e.backend.readOnly) {
    return { kind: "read-only", text: "Version history is read-only here: a newer version of Splitpage wrote it. New snapshots are kept in this window." };
  }
  return null;
}

const HISTORY_DESKTOP_TIMEOUT_MS = 30000;

function historyDesktopUsage(u: Awaited<ReturnType<HistoryDesktopPort["historyList"]>>["usage"] | undefined) {
  if (!u || typeof u !== "object") return null;
  return {
    totalBytes: Number(u.totalBytes) || 0,
    capBytes: Number(u.capBytes) || 0,
    overCap: !!u.overCap,
    docCount: Number(u.docCount) || 0,
    readOnly: !!u.readOnly
  };
}

function historyDesktopCall<T, const Timeout, const Rejected>(run: () => T, onTimeout: Timeout, onReject: Rejected): Promise<HistoryReplyAlternatives<Awaited<T> | Timeout | Rejected>>;
function historyDesktopCall<T, Timeout, Rejected>(run: () => T, onTimeout: Timeout, onReject: Rejected): Promise<Awaited<T> | Timeout | Rejected> {
  return new Promise<Awaited<T> | Timeout | Rejected>(function (resolve) {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function finish(v: Awaited<T> | Timeout | Rejected) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    }
    timer = setTimeout(function () { finish(onTimeout); },
      probe?.timeout() != null ? probe?.timeout() as number : HISTORY_DESKTOP_TIMEOUT_MS);
    let p;
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

const desktopHistoryBackend: HistoryBackendAdapter = {
  name: "desktop",
  persistent: true,

  put: function (docId, meta, stateJson) {
    const clean = sanitizeHistoryMeta(meta);
    if (!normalizeDocId(docId) || !clean || typeof stateJson !== "string") {
      return Promise.resolve({ stored: false, code: "invalid" });
    }
    return historyDesktopCall(function () {
      return desktopPort().historyPut(docId, clean, stateJson, { protect: historyProtectedList() });
    }, { stored: false, code: "timeout" }, { stored: false, code: "invalid" }).then(function (r) {
      if (!r || typeof r !== "object") return { stored: false, code: "io" };
      if (r.stored === false) return r;
      if (!r.ok) return { stored: false, code: typeof r.code === "string" ? r.code : "io" };
      const out: { stored: boolean; evicted: number; overCap: boolean; duplicate?: boolean } = { stored: true, evicted: Number(r.evicted) || 0, overCap: !!r.overCap };
      if (r.duplicate) out.duplicate = true;
      return out;
    });
  },

  list: function (docId, opts) {
    const empty = { entries: [], older: [], olderExpiresAt: null };
    const failed = (opts && opts.strict) ? null : empty;
    return historyDesktopCall(function () {
      return desktopPort().historyList(docId || null);
    }, failed, failed).then(function (r) {
      if (!r || typeof r !== "object") return failed;
      if (opts && opts.strict && docId && !Array.isArray(r.entries)) return null;
      const entries = (r.entries || []).map(historyStripMeta).filter(Boolean) as HistorySnapshotMeta[];
      if (docId) entries.forEach(function (m) { m.docId = docId; });
      const older = (r.older || []).map(historyStripMeta).filter(Boolean) as HistorySnapshotMeta[];
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
    const query = bucket === HISTORY_OLDER_KEY
      ? { older: true, protect: historyProtectedList() }
      : { docId: bucket, protect: historyProtectedList() };
    return historyDesktopCall(function () {
      return desktopPort().historyGet(query, id);
    }, null, null).then(function (r) {
      if (!r || typeof r !== "object" || typeof r.stateJson !== "string") return null;
      const meta = historyStripMeta(r.meta);
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
    let added = 0, count = 0, i = 0;
    function next(): Promise<HistoryOlderImportResult> {
      if (i >= entries.length) return Promise.resolve({ ok: true, count: count, added: added });
      const e = entries[i++] as HistorySnapshotRead;
      const meta = e && typeof e === "object" ? sanitizeHistoryMeta(e.meta) : null;
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
      const ids: string[] = [];
      r.forEach(function (d) {
        const id = normalizeDocId(d && d.docId);
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
      let hit: HistoryDesktopDoc | null = null;
      r.forEach(function (d) {
        if (d && normalizeDocId(d.docId) === bucket) hit = d;
      });
      return hit ? { title: (hit as HistoryDesktopDoc).title || "", lastOpenedAt: Number((hit as HistoryDesktopDoc).lastOpenedAt) || 0 } : null;
    });
  },

  rawList: function (bucket) {
    const docId = bucket === HISTORY_OLDER_KEY ? null : bucket;
    return desktopHistoryBackend.list(docId).then(function (r) {
      if (!r) return [];
      return bucket === HISTORY_OLDER_KEY ? r.older : r.entries;
    });
  }
};

let historyIdbFailed = false;
let historyBackendNameNow: string | null = null;

function historyUseMemory() {
  historyBackendNameNow = "memory";
  return historyMemory().adapter;
}

function resolveHistoryBackend() {
  if (probe?.choice() === "memory") return Promise.resolve(historyUseMemory());
  if (!probe?.choice() && runningOnDesktop() && typeof desktopPort().historyPut === "function") {
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


  const api = { resolveHistoryBackend, historyIdbNotice, backendName: () => historyBackendNameNow,
    close: () => historyIdb ? historyIdb.backend.close() : Promise.resolve() };
  return Object.assign(api, probe ? probe.bind({
    resolve: resolveHistoryBackend,
    notice: historyIdbNotice,
    get idb() { return historyIdb; },
    set idb(value) { historyIdb = value; },
    get memory() { return historyMem; },
    set memory(value) { historyMem = value; },
    get failed() { return historyIdbFailed; },
    set failed(value) { historyIdbFailed = value; },
    get name() { return historyBackendNameNow; },
    set name(value) { historyBackendNameNow = value; },
    clearEstimate: () => { historyEstimateCache = null; }
  }) : {});
}
