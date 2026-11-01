import type { HistoryBackendTransaction, HistoryIndex, HistoryIndexRecord } from "./history-backend-types.ts";

type IdbHistoryError = { name?: string; code?: string | number; cause?: unknown };
type IdbHistoryRow = HistoryIndexRecord & { bucket: string };

import { DOC_ID_RE } from "../../../shared/doc-id-policy.js";
import { HISTORY_OLDER_KEY } from "../../../shared/history-policy.js";
import { sha256Bytes } from "../../core/document/ids.ts";

export const HISTORY_IDB_NAME = "splitpage-history";
export const HISTORY_IDB_VERSION = 3;

const INDEX_STORE = "index";
const BODY_STORE = "bodies";
const V1_STORES = ["docs", "snapMeta", "snapBody", "meta"];
const V1_SNAPSHOT_STORES = ["snapMeta", "snapBody"];

export function hashText(text: unknown) {
  return sha256Bytes(new TextEncoder().encode(String(text)));
}

function noop() {}

function codedError(code: string, message: string, cause?: unknown) {
  const e: Error & IdbHistoryError = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

function isQuotaError(e: IdbHistoryError | null | undefined) {
  return !!e && (e.name === "QuotaExceededError" || (e as IdbHistoryError).code === 22 || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

function historyIdbError(e: unknown) {
  if (e && ((e as IdbHistoryError).code === "quota" || (e as IdbHistoryError).code === "enospc" || (e as IdbHistoryError).code === "io" || (e as IdbHistoryError).code === "read-only")) return e;
  if (isQuotaError(e as IdbHistoryError | null | undefined)) return codedError("quota", "history: the browser's storage quota is full", e);
  return codedError("io", "history: IndexedDB failed" + (e && (e as IdbHistoryError).name ? " (" + (e as IdbHistoryError).name + ")" : ""), e);
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function isBucket(v: unknown) {
  return v === HISTORY_OLDER_KEY || (typeof v === "string" && DOC_ID_RE.test(v));
}

function recordOf(row: IdbHistoryRow) {
  const out = {} as HistoryIndexRecord;
  Object.keys(row).forEach(function (k) { if (k !== "bucket") out[k] = row[k]; });
  if (!Array.isArray(out.snapshots)) out.snapshots = [];
  return out;
}

function rowOf(bucket: string, rec: HistoryIndexRecord) {
  const row = JSON.parse(JSON.stringify(rec)) as IdbHistoryRow;
  row.bucket = bucket;
  return row;
}

function hasStores(db: IDBDatabase, names: string[]) {
  return names.every(function (n) { return db.objectStoreNames.contains(n); });
}

function upgradeDb(d: IDBDatabase, t: IDBTransaction) {
  if (!d.objectStoreNames.contains(INDEX_STORE)) d.createObjectStore(INDEX_STORE, { keyPath: "bucket" });
  if (!d.objectStoreNames.contains(BODY_STORE)) d.createObjectStore(BODY_STORE, { keyPath: "sha" });
  const v1 = V1_STORES.filter(function (n) { return d.objectStoreNames.contains(n); });
  if (!v1.length) return;
  function dropV1() {
    v1.forEach(function (n) { if (d.objectStoreNames.contains(n)) d.deleteObjectStore(n); });
  }
  const counted = V1_SNAPSHOT_STORES.filter(function (n) { return d.objectStoreNames.contains(n); });
  let left = counted.length, rows = 0, failed = false;
  if (!left) { dropV1(); return; }
  counted.forEach(function (n) {
    const r = t.objectStore(n).count();
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

export interface HistoryIdbInspectionAccess {
  readonly enqueue: <T>(job: () => T | PromiseLike<T>) => Promise<T>;
  readonly transaction: (stores: string[], mode: IDBTransactionMode) => Promise<IDBTransaction>;
  readonly runIn: <T>(tx: IDBTransaction, body: (tx: IDBTransaction) => T | PromiseLike<T>) => Promise<T>;
  readonly request: <T>(req: IDBRequest<T>) => Promise<T>;
  readonly record: (row: IdbHistoryRow) => HistoryIndexRecord;
  readonly row: (bucket: string, record: HistoryIndexRecord) => IdbHistoryRow;
}

export function createIdbHistoryBackend(o?: { indexedDB?: IDBFactory | null; name?: string; before?: (op: "put" | "commit") => void; observe?: (op: "exclusive" | "put" | "commit") => void; extend?: (access: HistoryIdbInspectionAccess) => object }) {
  o = o || {};
  const factory = o.indexedDB || (typeof window !== "undefined" ? window.indexedDB : null) || null;
  const dbName = typeof o.name === "string" && o.name ? o.name : HISTORY_IDB_NAME;

  let db: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;
  let readOnly = false;
  let chain = Promise.resolve();
  const before = o.before || noop;
  const observe = o.observe || noop;

  function forget(d: IDBDatabase) {
    if (db === d) { db = null; readOnly = false; }
  }

  function adopt(d: IDBDatabase, ro: boolean) {
    d.onversionchange = function () { try { d.close(); } catch (e) {} forget(d); };
    d.onclose = function () { forget(d); };
    db = d;
    readOnly = !!ro;
    return d;
  }

  function openNewer() {
    return new Promise<IDBDatabase>(function (resolve, reject) {
      let req: IDBOpenDBRequest;
      try { req = (factory as IDBFactory).open(dbName); } catch (e) { reject(historyIdbError(e)); return; }
      req.onupgradeneeded = function () { try { (req.transaction as IDBTransaction).abort(); } catch (e) {} };
      req.onsuccess = function () {
        const d = req.result;
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
    const p = new Promise<IDBDatabase>(function (resolve, reject) {
      let failed = false;
      function fail(e: unknown) { failed = true; reject(historyIdbError(e)); }
      if (!factory) { fail(codedError("io", "history: no IndexedDB")); return; }
      let req: IDBOpenDBRequest;
      try { req = factory.open(dbName, HISTORY_IDB_VERSION); } catch (e) { fail(e); return; }
      req.onupgradeneeded = function () { upgradeDb(req.result, req.transaction as IDBTransaction); };
      req.onsuccess = function () {
        const d = req.result;
        if (failed) { try { d.close(); } catch (e) {} return; }
        resolve(adopt(d, false));
      };
      req.onerror = function (ev) {
        const err = req.error;
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

  function transaction(stores: string[], mode: IDBTransactionMode) {
    function make(d: IDBDatabase) {
      const names = stores.filter(function (n) { return d.objectStoreNames.contains(n); });
      return mode === "readwrite"
        ? d.transaction(names, "readwrite", { durability: "strict" })
        : d.transaction(names, "readonly");
    }
    return openDb().then(function (d) {
      try { return make(d); } catch (e) {
        if (!e || (e as IdbHistoryError).name !== "InvalidStateError") throw historyIdbError(e);
        forget(d);
        return openDb().then(make);
      }
    });
  }

  function runIn<T>(t: IDBTransaction, body: (tx: IDBTransaction) => T | PromiseLike<T>): Promise<T> {
    const done = new Promise<void>(function (resolve, reject) {
      t.oncomplete = function () { resolve(); };
      t.onabort = function () { reject(t.error || null); };
      t.onerror = function () { };
    });
    done.then(null, noop);
    let started: Promise<T>;
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

  function makeTx(t: IDBTransaction, write: boolean): HistoryBackendTransaction {
    const index = t.objectStore(INDEX_STORE);
    const bodies = t.objectStore(BODY_STORE);
    let committed = false;
    function mustWrite() {
      if (readOnly) throw codedError("read-only", "history: the database is read-only (a newer build's)");
      if (!write) throw codedError("io", "history: a write in a read-only job");
    }
    return {
      list: function () {
        return idbReq(index.getAll()).then(function (rows) {
          const out: HistoryIndex = {};
          (rows as IdbHistoryRow[] || []).forEach(function (row) { if (row && isBucket(row.bucket)) out[row.bucket] = recordOf(row); });
          return out;
        });
      },
      get: function (sha: string) {
        if (typeof sha !== "string") return Promise.resolve(null);
        return idbReq(bodies.get(sha) as IDBRequest<{ stateJson?: unknown } | undefined>).then(function (row) {
          return row && typeof row.stateJson === "string" ? row.stateJson : null;
        });
      },
      put: function (sha: string, text: string) {
        try {
          mustWrite();
          observe("put");
          before("put");
          if (typeof sha !== "string" || !sha || typeof text !== "string") throw codedError("io", "history: bad body");
        } catch (e) { return Promise.reject(e); }
        return idbReq(bodies.count(sha)).then(function (n) {
          if (n > 0) return undefined;
          return idbReq(bodies.put({ sha: sha, stateJson: text })).then(noop);
        });
      },
      commit: function (changes: Record<string, HistoryIndexRecord | null>, dropped: string[]) {
        try {
          mustWrite();
          if (committed) throw codedError("io", "history: commit called twice in one transaction");
          committed = true;
          observe("commit");
          before("commit");
        } catch (e) { return Promise.reject(e); }
        const reqs: Promise<unknown>[] = [];
        Object.keys(changes || {}).forEach(function (bucket) {
          if (!isBucket(bucket)) return;
          const rec = changes[bucket];
          reqs.push(idbReq((rec ? index.put(rowOf(bucket, rec)) : index.delete(bucket)) as IDBRequest<IDBValidKey | undefined>));
        });
        (Array.isArray(dropped) ? dropped : []).forEach(function (sha) {
          if (typeof sha === "string") reqs.push(idbReq(bodies.delete(sha)));
        });
        return Promise.all(reqs).then(noop);
      }
    };
  }

  function runTx<T>(fn: (tx: HistoryBackendTransaction) => T | PromiseLike<T>, write: boolean) {
    const mode: IDBTransactionMode = write && !readOnly ? "readwrite" : "readonly";
    return transaction([INDEX_STORE, BODY_STORE], mode).then(function (t) {
      return runIn(t, function () { return fn(makeTx(t, write)); });
    });
  }

  function enqueue<T>(job: () => T | PromiseLike<T>): Promise<T> {
    const run = chain.then(job);
    chain = run.then(noop, noop);
    return run;
  }

  const backend = {
    name: "idb",
    persistent: true,
    get readOnly() { return readOnly; },

    exclusive: function <T>(fn: (tx: HistoryBackendTransaction) => T | PromiseLike<T>, xo?: { write?: boolean }) {
      const write = !(xo && xo.write === false);
      observe("exclusive");
      return enqueue(function () { return runTx(fn, write); }).then(null, function (e) { throw historyIdbError(e); });
    },

    open: function () {
      return enqueue(function () { return openDb().then(noop); });
    },

    close: function () {
      return enqueue(function () {
        const d = db;
        if (d) { try { d.close(); } catch (e) {} forget(d); }
      });
    },


  };
  return Object.assign(backend, o.extend ? o.extend({ enqueue, transaction, runIn, request: idbReq, record: recordOf, row: rowOf }) : {});
}
