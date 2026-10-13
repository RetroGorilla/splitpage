import { isSha256Hex } from "../../../shared/blob-policy.js";
import { base64Encode, claimHandedOver, imageDataUrlBytes, imageRecordOf } from "../../core/document/media.ts";
import type { DecodedImage } from "../../core/document/media.ts";
import type { ImageRef } from "../../core/document/ports.ts";

export interface StoredBlob {
  bytes: Uint8Array;
  mime: string;
}

export interface BlobBackend {
  name?: string;
  persistent?: boolean;
  get: (sha: string) => Promise<StoredBlob | null>;
  put: (sha: string, bytes: Uint8Array, mime: string) => Promise<unknown>;
  missing: (shas: string[]) => Promise<string[]>;
}

export interface PreferredBlobBackend {
  available: () => boolean;
  open: () => Promise<BlobBackend>;
}

export interface BlobStoreHost {
  preferred: PreferredBlobBackend | null;
  fallback: () => BlobBackend;
  objectUrl: (bytes: Uint8Array, mime: string) => string;
  revokeObjectUrl: (url: string) => void;
  later: (run: () => void) => void;
  now: () => number;
  warn: (...args: unknown[]) => void;
}

export interface BlobBackendInfo {
  name: string;
  persistent: boolean;
}

export type RemoteBlobSource = (sha: string) => Uint8Array | ArrayBuffer | null | undefined | Promise<Uint8Array | ArrayBuffer | null | undefined>;

export interface BlobStore {
  intern: (bytes: unknown) => ImageRef | null;
  internDataUrl: (dataUrl: unknown) => ImageRef | null;
  adopt: (images: readonly DecodedImage[]) => void;
  has: (sha: unknown) => boolean;
  recordFor: (sha: unknown) => ImageRef | null;
  bytesFor: (sha: unknown) => Uint8Array | null;
  urlFor: (sha: unknown) => string | null;
  revokeUrls: () => void;
  dataUrlFor: (sha: unknown) => string | null;
  isDurable: (sha: unknown) => boolean;
  queuePersist: (shas: unknown) => void;
  persist: (shas: unknown) => Promise<string[]>;
  ensureBytes: (shas: unknown, opts?: { remote?: boolean }) => Promise<string[]>;
  setBackend: (backend: BlobBackend | null | undefined) => void;
  backendInfo: () => BlobBackendInfo | null;
  resolveBackend: () => Promise<BlobBackend>;
  setRemoteSource: (source: unknown) => void;
  forgetRemoteMisses: () => void;
  remoteMisses: () => string[];
  ageRemoteMisses: () => void;
  forgetMemory: () => void;
}

interface Entry {
  record: ImageRef;
  bytes: Uint8Array;
  url: string | null;
}

const REMOTE_MISS_MS = 5 * 60 * 1000;

function freshRecord(rec: ImageRef): ImageRef {
  return { sha256: rec.sha256, width: rec.width, height: rec.height, mime: rec.mime };
}

function uniqueStrings(list: unknown): string[] {
  const out: string[] = [], seen: Record<string, boolean> = Object.create(null);
  (Array.isArray(list) ? list as unknown[] : []).forEach(function (s) {
    if (typeof s !== "string" || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out;
}

function noop(): void {}

export function createBlobStore(host: BlobStoreHost): BlobStore {
  let entries: Record<string, Entry> = Object.create(null);
  let durable: Record<string, boolean> = Object.create(null);
  let persisting: Map<string, Promise<boolean>> = new Map();
  let loading: Map<string, Promise<void>> = new Map();

  let remote: RemoteBlobSource | null = null;
  let fetching: Map<string, Promise<void>> = new Map();
  let remoteMissAt: Map<string, number> = new Map();

  let backend: BlobBackend | null = null;
  let backendPromise: Promise<BlobBackend> | null = null;
  let backendGen = 0;
  let preferredFailed = false;

  let persistQueue: Record<string, boolean> = Object.create(null);
  let persistQueued = false;

  function held(sha: unknown): Entry | null {
    return isSha256Hex(sha) ? entries[sha as string] || null : null;
  }

  function keep(record: ImageRef, bytes: Uint8Array): ImageRef {
    const have = entries[record.sha256];
    if (have) return freshRecord(have.record);
    entries[record.sha256] = { record: record, bytes: bytes, url: null };
    return freshRecord(record);
  }

  function intern(input: unknown): ImageRef | null {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input as Uint8Array | null;
    if (!bytes || typeof bytes.length !== "number" || typeof bytes.byteLength !== "number") return null;
    const record = imageRecordOf(bytes);
    if (!record) return null;
    const have = entries[record.sha256];
    return have ? freshRecord(have.record) : keep(record, new Uint8Array(bytes));
  }

  function internDataUrl(dataUrl: unknown): ImageRef | null {
    const bytes = imageDataUrlBytes(dataUrl);
    const record = bytes ? imageRecordOf(bytes) : null;
    return bytes && record ? keep(record, bytes) : null;
  }

  function adopt(images: readonly DecodedImage[]): void {
    images.forEach(function (image) {
      if (claimHandedOver(image)) keep(freshRecord(image.ref), image.bytes);
      else intern(image.bytes);
    });
  }

  function has(sha: unknown): boolean {
    return !!held(sha);
  }

  function recordFor(sha: unknown): ImageRef | null {
    const e = held(sha);
    return e ? freshRecord(e.record) : null;
  }

  function bytesFor(sha: unknown): Uint8Array | null {
    const e = held(sha);
    return e ? e.bytes.slice() : null;
  }

  function urlFor(sha: unknown): string | null {
    const e = held(sha);
    if (!e) return null;
    if (!e.url) {
      try {
        e.url = host.objectUrl(e.bytes, e.record.mime);
      } catch {
        e.url = null;
      }
    }
    return e.url;
  }

  function revokeUrls(): void {
    Object.keys(entries).forEach(function (sha) {
      const e = entries[sha] as Entry;
      if (e.url) {
        try { host.revokeObjectUrl(e.url); } catch { noop(); }
        e.url = null;
      }
    });
  }

  function dataUrlFor(sha: unknown): string | null {
    const e = held(sha);
    return e ? "data:" + e.record.mime + ";base64," + base64Encode(e.bytes) : null;
  }

  function isDurable(sha: unknown): boolean {
    return has(sha) && !!durable[sha as string] && !!(backend && backend.persistent);
  }

  function queuePersist(shas: unknown): void {
    (Array.isArray(shas) ? shas as unknown[] : []).forEach(function (sha) {
      if (isSha256Hex(sha) && !durable[sha as string]) persistQueue[sha as string] = true;
    });
    if (persistQueued || !Object.keys(persistQueue).length) return;
    if (!backend && !(host.preferred && host.preferred.available())) { persistQueue = Object.create(null); return; }
    persistQueued = true;
    host.later(function () {
      persistQueued = false;
      const list = Object.keys(persistQueue);
      persistQueue = Object.create(null);
      if (list.length) persist(list);
    });
  }

  function setBackend(next: BlobBackend | null | undefined): void {
    backendGen++;
    backend = next || null;
    backendPromise = null;
    durable = Object.create(null);
    persisting = new Map();
    loading = new Map();
  }

  function backendInfo(): BlobBackendInfo | null {
    return backend ? { name: String(backend.name || ""), persistent: !!backend.persistent } : null;
  }

  function resolveBackend(): Promise<BlobBackend> {
    if (backend) return Promise.resolve(backend);
    if (backendPromise) return backendPromise;
    const gen = backendGen;
    const preferred = host.preferred;
    const opened: Promise<BlobBackend> = preferredFailed || !preferred ? Promise.reject(new Error("idb-failed")) : preferred.open();
    const p = opened.then(null, function (e: unknown) {
      if (!preferredFailed) host.warn("Image store: IndexedDB unavailable, keeping images in memory", e);
      preferredFailed = true;
      return host.fallback();
    }).then(function (b) {
      if (gen === backendGen && !backend) backend = b;
      backendPromise = null;
      return backend || b;
    });
    backendPromise = p;
    return p;
  }

  function ensureBytes(shas: unknown, opts?: { remote?: boolean }): Promise<string[]> {
    const list = uniqueStrings(shas);
    const need = list.filter(function (sha) { return isSha256Hex(sha) && !entries[sha]; });
    const report = function (): string[] { return list.filter(function (sha) { return !has(sha); }); };
    if (!need.length) return Promise.resolve(report());
    const useRemote = !(opts && opts.remote === false);
    return resolveBackend().then(function (b) {
      return Promise.all(need.map(function (sha) { return loadBlob(b, sha); }));
    }).then(function () {
      if (!useRemote || !remote) return null;
      return Promise.all(need.filter(function (sha) { return !entries[sha]; }).map(fetchRemoteBlob));
    }).then(report, report);
  }

  function setRemoteSource(source: unknown): void {
    remote = typeof source === "function" ? source as RemoteBlobSource : null;
    fetching = new Map();
    remoteMissAt = new Map();
  }

  function forgetRemoteMisses(): void {
    remoteMissAt = new Map();
  }

  function remoteMissFresh(sha: string): boolean {
    const at = remoteMissAt.get(sha);
    if (!at) return false;
    if (host.now() - at < REMOTE_MISS_MS) return true;
    remoteMissAt.delete(sha);
    return false;
  }

  function fetchRemoteBlob(sha: string): Promise<void> {
    const inFlight = fetching.get(sha);
    if (inFlight) return inFlight;
    if (remoteMissFresh(sha)) return Promise.resolve();
    const source = remote;
    const p: Promise<void> = Promise.resolve().then(function () { return source ? source(sha) : null; }).then(function (bytes) {
      if (entries[sha]) return;
      if (!bytes) { if (source && source === remote) remoteMissAt.set(sha, host.now()); return; }
      const rec = intern(bytes);
      if (rec && rec.sha256 !== sha) host.warn("Image store: the server's blob " + sha + " failed its hash check");
    }).then(null, noop).then(function () {
      if (fetching.get(sha) === p) fetching.delete(sha);
    });
    fetching.set(sha, p);
    return p;
  }

  function loadBlob(from: BlobBackend, sha: string): Promise<void> {
    const inFlight = loading.get(sha);
    if (inFlight) return inFlight;
    const gen = backendGen;
    const p: Promise<void> = Promise.resolve().then(function () { return from.get(sha); }).then(function (r) {
      if (!r || !r.bytes || entries[sha]) return;
      const rec = intern(r.bytes);
      if (!rec) return;
      if (rec.sha256 !== sha) {
        host.warn("Image store: blob " + sha + " failed its hash check");
        return;
      }
      if (gen === backendGen) durable[sha] = true;
    }).then(null, noop).then(function () {
      if (loading.get(sha) === p) loading.delete(sha);
    });
    loading.set(sha, p);
    return p;
  }

  function persist(shas: unknown): Promise<string[]> {
    const list = uniqueStrings(shas);
    if (!list.length) return Promise.resolve([]);
    return resolveBackend().then(function (b) {
      return Promise.all(list.map(function (sha) { return persistBlob(b, sha); }));
    }).then(function (ok) {
      return list.filter(function (_sha, i) { return !ok[i]; });
    }, function () { return list.slice(); });
  }

  function persistBlob(to: BlobBackend, sha: string): Promise<boolean> {
    if (!isSha256Hex(sha)) return Promise.resolve(false);
    if (durable[sha]) return Promise.resolve(true);
    const inFlight = persisting.get(sha);
    if (inFlight) return inFlight;
    const gen = backendGen;
    const e = entries[sha];
    const p: Promise<boolean> = Promise.resolve().then(function () {
      if (e) return to.put(sha, e.bytes.slice(), e.record.mime).then(function () { return true; });
      return to.missing([sha]).then(function (m) { return Array.isArray(m) && m.indexOf(sha) === -1; });
    }).then(function (ok) {
      if (ok && gen === backendGen) durable[sha] = true;
      return !!ok;
    }, function (err: unknown) {
      host.warn("Image store: could not store blob " + sha, err);
      return false;
    }).then(function (ok) {
      if (persisting.get(sha) === p) persisting.delete(sha);
      return ok;
    });
    persisting.set(sha, p);
    return p;
  }

  return {
    intern: intern,
    internDataUrl: internDataUrl,
    adopt: adopt,
    has: has,
    recordFor: recordFor,
    bytesFor: bytesFor,
    urlFor: urlFor,
    revokeUrls: revokeUrls,
    dataUrlFor: dataUrlFor,
    isDurable: isDurable,
    queuePersist: queuePersist,
    persist: persist,
    ensureBytes: ensureBytes,
    setBackend: setBackend,
    backendInfo: backendInfo,
    resolveBackend: resolveBackend,
    setRemoteSource: setRemoteSource,
    forgetRemoteMisses: forgetRemoteMisses,
    remoteMisses: function () { return Array.from(remoteMissAt.keys()); },
    ageRemoteMisses: function () {
      remoteMissAt.forEach(function (at, sha) { remoteMissAt.set(sha, at - REMOTE_MISS_MS); });
    },
    forgetMemory: function () {
      revokeUrls();
      entries = Object.create(null);
      loading = new Map();
    }
  };
}

export function createMemoryBlobBackend(): BlobBackend {
  const kept: Record<string, StoredBlob> = Object.create(null);
  return {
    name: "memory",
    persistent: false,
    get: function (sha) {
      const r = isSha256Hex(sha) ? kept[sha] : null;
      return Promise.resolve(r ? { bytes: r.bytes.slice(), mime: r.mime } : null);
    },
    put: function (sha, bytes, mime) {
      if (!isSha256Hex(sha)) return Promise.reject(new Error("bad sha"));
      if (!kept[sha]) kept[sha] = { bytes: bytes.slice(), mime: mime };
      return Promise.resolve();
    },
    missing: function (shas) {
      return Promise.resolve(uniqueStrings(shas).filter(function (sha) {
        return !isSha256Hex(sha) || !kept[sha];
      }));
    }
  };
}

const BLOB_DB_NAME = "splitpage-blobs";
const BLOB_DB_VERSION = 1;
const BLOB_STORE = "blobs";
const BLOB_TOUCH_MS = 24 * 60 * 60 * 1000;

interface IdbBlobRecord {
  mime: string;
  size: number;
  bytes: Blob;
  addedAt: number;
  usedAt: number;
}

export interface IdbBlobRecordInfo {
  mime: string;
  size: number;
  isBlob: boolean;
  addedAt: number;
  usedAt: number;
}

export interface IdbBlobBackend extends PreferredBlobBackend {
  record: (sha: string) => Promise<IdbBlobRecordInfo | null>;
}

function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }
  return new Promise(function (resolve, reject) {
    const fr = new FileReader();
    fr.onload = function () { resolve(new Uint8Array(fr.result as ArrayBuffer)); };
    fr.onerror = function () { reject(fr.error); };
    fr.readAsArrayBuffer(blob);
  });
}

export function createIdbBlobBackend(factory: () => IDBFactory | null, now: () => number): IdbBlobBackend {
  let db: IDBDatabase | null = null;
  let dbPromise: Promise<IDBDatabase> | null = null;

  function openDb(): Promise<IDBDatabase> {
    if (db) return Promise.resolve(db);
    if (dbPromise) return dbPromise;
    const p = new Promise<IDBDatabase>(function (resolve, reject) {
      let failed = false;
      function fail(e: unknown): void { failed = true; reject(e); }
      const idb = factory();
      if (!idb) { fail(new Error("no-indexeddb")); return; }
      let req: IDBOpenDBRequest;
      try { req = idb.open(BLOB_DB_NAME, BLOB_DB_VERSION); } catch (e) { fail(e); return; }
      req.onupgradeneeded = function (e) {
        if ((e.oldVersion || 0) < 1) req.result.createObjectStore(BLOB_STORE);
      };
      req.onsuccess = function () {
        const opened = req.result;
        if (failed) { try { opened.close(); } catch { noop(); } return; }
        function forget(): void {
          if (db === opened) { db = null; dbPromise = null; }
        }
        opened.onversionchange = function () { try { opened.close(); } catch { noop(); } forget(); };
        opened.onclose = forget;
        db = opened;
        resolve(opened);
      };
      req.onerror = function () { fail(req.error || new Error("idb-open")); };
      req.onblocked = function () { fail(new Error("idb-blocked")); };
    });
    dbPromise = p;
    p.then(null, function () { if (dbPromise === p) dbPromise = null; });
    return p;
  }

  function tx<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore, done: (r: T) => void) => void): Promise<T | undefined> {
    return openDb().then(function (opened) {
      return new Promise<T | undefined>(function (resolve, reject) {
        const t = mode === "readwrite"
          ? opened.transaction([BLOB_STORE], "readwrite", { durability: "strict" })
          : opened.transaction([BLOB_STORE], "readonly");
        let result: T | undefined;
        t.oncomplete = function () { resolve(result); };
        t.onabort = function () { reject(t.error || new Error("transaction aborted")); };
        t.onerror = noop;
        try {
          body(t.objectStore(BLOB_STORE), function (r) { result = r; });
        } catch (e) {
          try { t.abort(); } catch { noop(); }
          reject(e);
        }
      });
    });
  }

  function read(sha: string): Promise<IdbBlobRecord | null> {
    return tx<IdbBlobRecord | null>("readonly", function (store, done) {
      const req = store.get(sha);
      req.onsuccess = function () { done((req.result as IdbBlobRecord | undefined) || null); };
    }).then(function (rec) { return rec || null; });
  }

  const backend: BlobBackend = {
    name: "idb",
    persistent: true,
    get: function (sha) {
      if (!isSha256Hex(sha)) return Promise.resolve(null);
      return read(sha).then(function (rec) {
        if (!rec || !(rec.bytes instanceof Blob)) return null;
        return blobToBytes(rec.bytes).then(function (bytes) { return { bytes: bytes, mime: rec.mime }; });
      });
    },
    put: function (sha, bytes, mime) {
      if (!isSha256Hex(sha)) return Promise.reject(new Error("bad sha"));
      return tx<never>("readwrite", function (store) {
        const req = store.get(sha);
        req.onsuccess = function () {
          const at = now();
          const rec = req.result as IdbBlobRecord | undefined;
          if (rec && rec.bytes instanceof Blob) {
            if (!(at - (rec.usedAt || 0) < BLOB_TOUCH_MS)) {
              rec.usedAt = at;
              store.put(rec, sha);
            }
            return;
          }
          const fresh: IdbBlobRecord = { mime: mime, size: bytes.length, bytes: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), addedAt: at, usedAt: at };
          store.put(fresh, sha);
        };
      });
    },
    missing: function (shas) {
      const list = uniqueStrings(shas);
      const valid = list.filter(isSha256Hex);
      if (!valid.length) return Promise.resolve(list);
      return tx<Record<string, boolean>>("readonly", function (store, done) {
        const found: Record<string, boolean> = Object.create(null);
        let left = valid.length;
        valid.forEach(function (sha) {
          const req = store.count(sha);
          req.onsuccess = function () {
            if (req.result > 0) found[sha] = true;
            if (--left === 0) done(found);
          };
        });
      }).then(function (found) {
        return list.filter(function (sha) { return !(found && found[sha]); });
      });
    }
  };

  return {
    available: function () { return !!factory(); },
    open: function () { return openDb().then(function () { return backend; }); },
    record: function (sha) {
      return read(sha).then(function (rec) {
        return rec ? { mime: rec.mime, size: rec.size, isBlob: rec.bytes instanceof Blob, addedAt: rec.addedAt, usedAt: rec.usedAt } : null;
      });
    }
  };
}
