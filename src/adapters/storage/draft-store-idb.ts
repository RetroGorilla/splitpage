import { cappedLongText } from "../../core/document/text-policy.ts";
import type {
  DraftLimits,
  DraftMeta,
  DraftPutOptions,
  DraftPutResult,
  DraftWrite,
  KeyedDraftStore,
  StoredDraft
} from "../../application/recovery/ports.ts";

export const DRAFTS_IDB_NAME = "splitpage-drafts";
export const DRAFTS_IDB_VERSION = 1;

const META_STORE = "meta";
const BODY_STORE = "bodies";

export const DRAFT_LIMITS: DraftLimits = Object.freeze({
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxCount: 20,
  maxBytes: 64 * 1024 * 1024
});

export interface IdbDraftStorePorts {
  readonly indexedDB: IDBFactory | null;
  readonly limits: DraftLimits;
  readonly now: () => number;
  readonly name?: string | undefined;
}

interface EvictionMeta {
  readonly key?: unknown;
  readonly writtenAt?: unknown;
  readonly bytes?: unknown;
}

interface StoredMeta {
  key: string;
  base?: unknown;
  docId?: unknown;
  rev?: unknown;
  title?: unknown;
  writtenAt?: unknown;
  writerId?: unknown;
  generation?: unknown;
  editSeq?: unknown;
  schema?: unknown;
  docIdWrittenOut?: unknown;
  bytes?: unknown;
}

interface StoredBody {
  key: string;
  stateJson?: unknown;
  baseJson?: unknown;
}

type DraftError = Error & { draftCode?: string };

export function browserDraftKey(base: unknown, docId: unknown): string {
  return JSON.stringify([String(base || ""), String(docId || "")]);
}

export function draftBaseOf(serverUrl: unknown, pageHref: string): string {
  try {
    let u = new URL(String(serverUrl || "") || ".", pageHref);
    u = new URL(".", u.href);
    if (!/^https?:$/.test(u.protocol) || !u.origin || u.origin === "null") return "";
    return u.origin + u.pathname;
  } catch {
    return "";
  }
}

export function planDraftEviction(metas: unknown, now: number, limits?: DraftLimits, keepKey?: string): string[] {
  const lim = limits || DRAFT_LIMITS;
  const list = (Array.isArray(metas) ? metas as Array<EvictionMeta | null> : []).filter(function (m): m is EvictionMeta & { key: string } {
    return !!m && typeof m.key === "string";
  }).slice().sort(function (a, b) { return (Number(a.writtenAt) || 0) - (Number(b.writtenAt) || 0); });
  const drop: string[] = [];
  const kept: Array<EvictionMeta & { key: string }> = [];
  list.forEach(function (m) {
    const at = Number(m.writtenAt) || 0;
    if (m.key !== keepKey && now - at > lim.maxAgeMs) drop.push(m.key);
    else kept.push(m);
  });
  let bytes = kept.reduce(function (n, m) { return n + (Number(m.bytes) || 0); }, 0);
  let i = 0;
  while (i < kept.length && (kept.length > lim.maxCount || bytes > lim.maxBytes)) {
    const m = kept[i];
    if (!m) break;
    if (m.key === keepKey) { i++; continue; }
    drop.push(m.key);
    bytes -= Number(m.bytes) || 0;
    kept.splice(i, 1);
  }
  return drop;
}

function noop(): void {}

function isQuotaError(e: unknown): boolean {
  const err = e as { name?: unknown; code?: unknown } | null;
  return !!err && (err.name === "QuotaExceededError" || err.code === 22 || err.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

function codeOf(e: unknown): string {
  const err = e as { draftCode?: unknown } | null;
  if (err && typeof err.draftCode === "string") return err.draftCode;
  return isQuotaError(e) ? "QUOTA" : "EIO";
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function metaOf(rec: StoredMeta): DraftMeta {
  return {
    key: rec.key,
    base: String(rec.base || ""),
    docId: String(rec.docId || ""),
    rev: Number(rec.rev) || 0,
    title: typeof rec.title === "string" ? cappedLongText(rec.title, 500) : "",
    writtenAt: Number(rec.writtenAt) || 0,
    writerId: String(rec.writerId || ""),
    generation: Number(rec.generation) || 0,
    editSeq: Number(rec.editSeq) || 0,
    schema: rec.schema == null ? null : rec.schema,
    docIdWrittenOut: !!rec.docIdWrittenOut,
    bytes: Number(rec.bytes) || 0
  };
}

export function createIdbDraftStore(ports: IdbDraftStorePorts): KeyedDraftStore {
  if (!ports || ports.indexedDB === undefined || !ports.limits || typeof ports.now !== "function") {
    throw new Error("createIdbDraftStore: a draft store is built with its IndexedDB factory (or null), limits and clock");
  }
  const factory = ports.indexedDB;
  const dbName = typeof ports.name === "string" && ports.name ? ports.name : DRAFTS_IDB_NAME;
  const now = ports.now;
  const limits = ports.limits;

  let db: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;
  let unavailable = false;
  let chain: Promise<void> = Promise.resolve();

  function fail(code: string): DraftError {
    const e: DraftError = new Error("drafts: " + code);
    e.draftCode = code;
    return e;
  }

  function openDb(): Promise<IDBDatabase> {
    if (db) return Promise.resolve(db);
    if (unavailable) return Promise.reject(fail("UNAVAILABLE"));
    if (opening) return opening;
    opening = new Promise<IDBDatabase>(function (resolve, reject) {
      let done = false;
      function no(): void {
        if (done) return;
        done = true;
        unavailable = true;
        reject(fail("UNAVAILABLE"));
      }
      if (!factory || typeof factory.open !== "function") { no(); return; }
      let req: IDBOpenDBRequest;
      try { req = factory.open(dbName, DRAFTS_IDB_VERSION); } catch { no(); return; }
      req.onupgradeneeded = function () {
        const d = req.result;
        if (!d.objectStoreNames.contains(META_STORE)) d.createObjectStore(META_STORE, { keyPath: "key" });
        if (!d.objectStoreNames.contains(BODY_STORE)) d.createObjectStore(BODY_STORE, { keyPath: "key" });
      };
      req.onsuccess = function () {
        const d = req.result;
        if (done) { try { d.close(); } catch { noop(); } return; }
        done = true;
        d.onversionchange = function () { try { d.close(); } catch { noop(); } if (db === d) db = null; };
        d.onclose = function () { if (db === d) db = null; };
        db = d;
        resolve(d);
      };
      req.onerror = function (ev) {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        no();
      };
      req.onblocked = no;
    });
    const p = opening;
    p.then(function () { opening = null; }, function () { opening = null; });
    return p;
  }

  function job<T>(mode: IDBTransactionMode, body: (t: IDBTransaction) => Promise<T>): Promise<T> {
    const run = chain.then(function () {
      return openDb().then(function (d) {
        let t: IDBTransaction;
        try {
          t = mode === "readwrite"
            ? d.transaction([META_STORE, BODY_STORE], "readwrite", { durability: "strict" })
            : d.transaction([META_STORE, BODY_STORE], "readonly");
        } catch (e) { if (db === d) db = null; throw e; }
        const tx = t;
        const done = new Promise<void>(function (resolve, reject) {
          tx.oncomplete = function () { resolve(); };
          tx.onabort = function () { reject(tx.error || null); };
          tx.onerror = noop;
        });
        done.then(null, noop);
        let started: Promise<T>;
        try { started = Promise.resolve(body(tx)); } catch (e) { started = Promise.reject(e instanceof Error ? e : new Error(String(e))); }
        return started.then(function (result) {
          return done.then(function () { return result; });
        }, function (e: unknown) {
          try { tx.abort(); } catch { noop(); }
          return done.then(function (): never { throw e; }, function (txErr: unknown): never {
            const named = txErr as { name?: unknown } | null;
            throw (named && named.name && named.name !== "AbortError") ? txErr : e;
          });
        });
      });
    });
    chain = run.then(noop, noop);
    return run;
  }

  function expired(meta: StoredMeta | undefined): boolean {
    return !meta || now() - (Number(meta.writtenAt) || 0) > limits.maxAgeMs;
  }

  function put(rec: DraftWrite, opts?: DraftPutOptions): Promise<DraftPutResult> {
    const keepBase = !!(opts && opts.keepBase);
    if (!rec || typeof rec.key !== "string" || typeof rec.stateJson !== "string") {
      return Promise.resolve({ ok: false, code: "EIO" });
    }
    return job("readwrite", function (t): Promise<DraftPutResult> {
      const metas = t.objectStore(META_STORE);
      const bodies = t.objectStore(BODY_STORE);
      return Promise.all([
        idbReq(metas.get(rec.key) as IDBRequest<StoredMeta | undefined>),
        idbReq(bodies.get(rec.key) as IDBRequest<StoredBody | undefined>)
      ]).then(function (had) {
        const oldMeta = had[0];
        const oldBody = had[1];
        let baseJson: unknown = rec.baseJson;
        if (baseJson === null || baseJson === undefined) {
          const mayKeep = keepBase || (oldMeta && oldMeta.writerId === rec.writerId);
          if (oldBody && mayKeep) baseJson = oldBody.baseJson === undefined ? null : oldBody.baseJson;
          else if (keepBase) baseJson = null;
          else throw fail("NEED_BASE");
        }
        const meta = metaOf({
          key: rec.key, base: rec.base, docId: rec.docId, rev: rec.rev, title: rec.title,
          writtenAt: now(), writerId: rec.writerId, generation: rec.generation, editSeq: rec.editSeq, schema: rec.schema,
          docIdWrittenOut: rec.docIdWrittenOut,
          bytes: rec.stateJson.length + (typeof baseJson === "string" ? baseJson.length : 0)
        });
        return Promise.all([
          idbReq(metas.put(meta)),
          idbReq(bodies.put({ key: rec.key, stateJson: rec.stateJson, baseJson: baseJson }))
        ]).then(function () {
          return idbReq(metas.getAll() as IDBRequest<StoredMeta[]>);
        }).then(function (all) {
          const drop = planDraftEviction(all, now(), limits, rec.key);
          return Promise.all(drop.map(function (k) {
            return Promise.all([idbReq(metas.delete(k)), idbReq(bodies.delete(k))]);
          })).then(function (): DraftPutResult { return { ok: true, evicted: drop.length }; });
        });
      });
    }).then(null, function (e: unknown): DraftPutResult { return { ok: false, code: codeOf(e) }; });
  }

  function get(key: string): Promise<StoredDraft | null> {
    return job("readonly", function (t) {
      return Promise.all([
        idbReq(t.objectStore(META_STORE).get(String(key)) as IDBRequest<StoredMeta | undefined>),
        idbReq(t.objectStore(BODY_STORE).get(String(key)) as IDBRequest<StoredBody | undefined>)
      ]).then(function (r): StoredDraft | null {
        const meta = r[0], body = r[1];
        if (!meta || !body || typeof body.stateJson !== "string" || expired(meta)) return null;
        return Object.assign(metaOf(meta), {
          stateJson: body.stateJson,
          baseJson: typeof body.baseJson === "string" ? body.baseJson : null
        });
      });
    }).then(null, function () { return null; });
  }

  function list(): Promise<DraftMeta[]> {
    return job("readonly", function (t) {
      return idbReq(t.objectStore(META_STORE).getAll() as IDBRequest<StoredMeta[]>).then(function (all) {
        return (all || []).filter(function (m) { return m && !expired(m); }).map(metaOf);
      });
    }).then(null, function (): DraftMeta[] { return []; });
  }

  function remove(key: string, writerId?: string, generation?: number): Promise<boolean> {
    return job("readwrite", function (t) {
      const metas = t.objectStore(META_STORE);
      return idbReq(metas.get(String(key)) as IDBRequest<StoredMeta | undefined>).then(function (meta) {
        if (!meta) return false;
        if (writerId && meta.writerId !== writerId) return false;
        if (typeof generation === "number" && (Number(meta.generation) || 0) !== generation) return false;
        return Promise.all([
          idbReq(metas.delete(String(key))),
          idbReq(t.objectStore(BODY_STORE).delete(String(key)))
        ]).then(function () { return true; });
      });
    }).then(null, function () { return false; });
  }

  function claim(key: string, writerId: string, generation?: number): Promise<boolean> {
    return job("readwrite", function (t) {
      const metas = t.objectStore(META_STORE);
      return idbReq(metas.get(String(key)) as IDBRequest<StoredMeta | undefined>).then(function (meta) {
        if (!meta) return false;
        meta.writerId = String(writerId || "");
        if (typeof generation === "number") meta.generation = generation;
        return idbReq(metas.put(meta)).then(function () { return true; });
      });
    }).then(null, function () { return false; });
  }

  return Object.freeze({
    available: function () {
      return openDb().then(function () { return true; }, function () { return false; });
    },
    put: put,
    get: get,
    list: list,
    remove: remove,
    claim: claim
  });
}
