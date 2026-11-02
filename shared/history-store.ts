"use strict";

import * as policy from "./history-policy.ts";
import { DOC_ID_RE } from "./doc-id-policy.ts";

type HistoryStoreMeta = NonNullable<ReturnType<typeof policy.sanitizeHistoryMeta>>;
type HistoryStoreEntry = HistoryStoreMeta & { sha: string };
type HistoryStorePublicMeta = HistoryStoreMeta & { docId: string };
type HistoryStoreFields = Record<string, unknown>;
export interface SharedHistorySnapshotReader {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly sha: string;
}
export interface SharedHistoryBucketReader {
  readonly [key: string]: unknown;
  readonly snapshots: readonly SharedHistorySnapshotReader[];
}
export type SharedHistoryIndex = Record<string, SharedHistoryBucketReader | null | undefined>;
export type SharedHistoryBucket = { [key: string]: unknown; snapshots: SharedHistorySnapshotReader[] };
type HistoryStoreMutableBucket = SharedHistoryBucket;
type HistoryStoreChanges = Record<string, HistoryStoreMutableBucket | null | undefined>;
type HistoryStoreHold = { docId: string; id: string };
type HistoryStoreFlags = Record<string, true | undefined>;
type HistoryStoreError = "quota" | "enospc" | "io" | "read-only";
export interface SharedHistoryTransaction {
  readonly list: () => Promise<SharedHistoryIndex>;
  readonly get: (sha: string) => Promise<string | null | undefined>;
  readonly put: (sha: string, text: string) => Promise<void>;
  readonly commit: (changes: SharedHistoryIndex, dropped: string[]) => Promise<void>;
}
export interface SharedHistoryBackend {
  readonly name: string;
  readonly persistent?: boolean;
  readOnly?: boolean;
  readonly exclusive: <T>(fn: (tx: SharedHistoryTransaction) => T | PromiseLike<T>, options?: { write?: boolean }) => Promise<T>;
}
type HistoryStoreOptions<B extends SharedHistoryBackend> = {
  backend?: B | null; now?: (() => number) | null; hashText?: ((text: string) => unknown) | null;
  capBytes?: number | null | ((total: number | null) => unknown); maxBodyBytes?: unknown; holds?: (() => unknown) | null;
};
type HistoryStoreOperationOptions = { older?: unknown; protect?: unknown };
type HistoryStorePutSuccess = { stored: true; duplicate?: boolean; evicted: number; overCap: boolean };
type HistoryStorePutResult = HistoryStorePutSuccess | { stored: false; code: string; evicted?: number; overCap?: boolean };
type HistoryStorePutOnceResult = { duplicate: true; evicted?: undefined; overCap?: undefined } |
  { duplicate: false; evicted: number; overCap: boolean };
type HistoryStoreImportResult = { ok: boolean; count: number; added: number; code?: string };
type HistoryStoreCopyResult = { ok: true; copied: number; code?: never } | { ok: false; copied: number; code: string };
type HistoryMemoryAccess = {
  index: SharedHistoryIndex; bodies: Record<string, string | undefined>;
  clone: typeof plainCopy; freeze: typeof deepFreeze;
};
type HistoryMemoryOptions<E extends object> = {
  strict?: boolean; macrotask?: (callback: () => void) => unknown; before?: (op: "put" | "commit") => unknown;
  observe?: (op: "put" | "commit" | "exclusive") => unknown; name?: string; persistent?: boolean;
  readOnly?: boolean; extend?: (access: HistoryMemoryAccess) => E;
};
type HistoryMemoryBackend = SharedHistoryBackend & { persistent: boolean; readOnly: boolean };

const HISTORY_OLDER_KEY = policy.HISTORY_OLDER_KEY;
const HISTORY_OLDER_TTL_MS = policy.HISTORY_OLDER_TTL_MS;
const HISTORY_PER_DOC = policy.HISTORY_PER_DOC;
const HISTORY_SNAP_ID_RE = policy.HISTORY_SNAP_ID_RE;
const historyClip = policy.historyClip;
const historyOlderExpired = policy.historyOlderExpired;
const historyStampAfter = policy.historyStampAfter;
const historyUtf8Length = policy.historyUtf8Length;
const planHistoryEviction = policy.planHistoryEviction;
const sanitizeHistoryMeta = policy.sanitizeHistoryMeta;

function noop() {}

function isDocId(v: unknown): boolean { return typeof v === "string" && DOC_ID_RE.test(v); }
function isBucket(v: unknown): boolean { return v === HISTORY_OLDER_KEY || isDocId(v); }

function byAtAscending(a: SharedHistorySnapshotReader | HistoryStorePublicMeta, b: SharedHistorySnapshotReader | HistoryStorePublicMeta) {
  return ((a.atMs as number) - (b.atMs as number)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function byAtDescending(a: HistoryStorePublicMeta, b: HistoryStorePublicMeta) {
  return (b.atMs - a.atMs) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function entryOf(meta: unknown, sha: string) {
  const m: (HistoryStoreMeta & { sha?: string }) | null = sanitizeHistoryMeta(meta);
  if (!m) return null;
  m.sha = sha;
  return m as HistoryStoreEntry;
}

function cloneRecord(rec: SharedHistoryBucketReader | null | undefined) {
  const out = {} as HistoryStoreMutableBucket;
  Object.keys(rec as SharedHistoryBucketReader).forEach(function (k) { if (k !== "snapshots") out[k] = (rec as SharedHistoryBucketReader)[k]; });
  out.snapshots = Array.isArray((rec as SharedHistoryBucketReader).snapshots) ? ((rec as SharedHistoryBucketReader).snapshots as readonly SharedHistorySnapshotReader[]).slice() : [];
  return out;
}

function snapshotsOf(rec: SharedHistoryBucketReader | null | undefined): readonly SharedHistorySnapshotReader[] {
  return rec && Array.isArray(rec.snapshots) ? rec.snapshots as readonly SharedHistorySnapshotReader[] : [];
}

function findEntry(rec: SharedHistoryBucketReader | null | undefined, id: string) {
  const list = snapshotsOf(rec);
  for (let i = 0; i < list.length; i++) if (list[i] && (list[i] as SharedHistorySnapshotReader).id === id) return list[i];
  return null;
}

function newestAtMs(rec: SharedHistoryBucketReader | null | undefined) {
  let n: number | null = null;
  snapshotsOf(rec).forEach(function (s) {
    const v = Number(s && s.atMs);
    if (isFinite(v) && (n == null || v > n)) n = v;
  });
  return n;
}

function totalOf(index: SharedHistoryIndex | null | undefined) {
  let total = 0;
  Object.keys(index || {}).forEach(function (b) {
    snapshotsOf((index as SharedHistoryIndex)[b]).forEach(function (s) { total += Number(s && s.sizeBytes) || 0; });
  });
  return total;
}

function publicMeta(entry: unknown, bucket: string) {
  const m: (HistoryStoreMeta & { docId?: string }) | null = sanitizeHistoryMeta(entry);
  if (m) m.docId = bucket;
  return m as HistoryStorePublicMeta | null;
}

function errorCode(e: unknown): HistoryStoreError {
  const c = e && (e as HistoryStoreFields).code;
  if (c === "quota" || c === "enospc" || c === "io" || c === "read-only") return c;
  if (e && (e as HistoryStoreFields).name === "QuotaExceededError") return "quota";
  if (c === "ENOSPC" || c === "EDQUOT") return "enospc";
  return "io";
}
function isNoRoom(code: unknown): boolean { return code === "quota" || code === "enospc"; }

function protectList(list: unknown, out: HistoryStoreHold[], seen: HistoryStoreFlags) {
  (Array.isArray(list) ? list as unknown[] : []).forEach(function (p) {
    if (!p || typeof p !== "object") return;
    if (!isBucket((p as HistoryStoreFields).docId) || typeof (p as HistoryStoreFields).id !== "string" || !HISTORY_SNAP_ID_RE.test((p as HistoryStoreFields).id as string)) return;
    const key = (p as HistoryStoreFields).docId + "\n" + (p as HistoryStoreFields).id;
    if (seen[key]) return;
    seen[key] = true;
    out.push({ docId: (p as HistoryStoreFields).docId as string, id: (p as HistoryStoreFields).id as string });
  });
  return out;
}

function namedShas(index: SharedHistoryIndex, changes: SharedHistoryIndex | null) {
  const named: HistoryStoreFlags = Object.create(null);
  const buckets = Object.keys(index || {});
  Object.keys(changes || {}).forEach(function (b) { if (!(b in (index || {}))) buckets.push(b); });
  buckets.forEach(function (b) {
    const rec = changes && Object.prototype.hasOwnProperty.call(changes, b) ? changes[b] : index[b];
    snapshotsOf(rec).forEach(function (s) { if (s && typeof s.sha === "string") named[s.sha] = true; });
  });
  return named;
}

function planChanges(index: SharedHistoryIndex, changes: HistoryStoreChanges, capBytes: number, nowMs: number, protect: HistoryStoreHold[], putShas: string[]) {
  const out: HistoryStoreChanges = {};
  Object.keys(changes).forEach(function (b) { out[b] = changes[b]; });
  const docs: { docId: string; lastOpenedAt: unknown; expiresAt: unknown; snapshots: { id: string; atMs: unknown; sizeBytes: unknown }[] }[] = [];
  const buckets = Object.keys(index);
  Object.keys(out).forEach(function (b) { if (!(b in index)) buckets.push(b); });
  buckets.forEach(function (b) {
    const rec = Object.prototype.hasOwnProperty.call(out, b) ? out[b] : index[b];
    if (!rec) return;
    docs.push({
      docId: b,
      lastOpenedAt: rec.lastOpenedAt || 0,
      expiresAt: rec.expiresAt || 0,
      snapshots: snapshotsOf(rec).map(function (s) { return { id: s.id, atMs: s.atMs, sizeBytes: s.sizeBytes }; })
    });
  });
  const plan = planHistoryEviction(docs, capBytes, nowMs, {
    perDoc: HISTORY_PER_DOC, olderKey: HISTORY_OLDER_KEY, protect: protect
  });
  const gone: Record<string, HistoryStoreFlags | undefined> = Object.create(null);
  plan.deletes.forEach(function (d) {
    (gone[d.docId] || (gone[d.docId] = Object.create(null)))[d.id] = true;
  });
  Object.keys(gone).forEach(function (b) {
    const rec = Object.prototype.hasOwnProperty.call(out, b) ? out[b] : cloneRecord(index[b]);
    (rec as HistoryStoreMutableBucket).snapshots = (rec as SharedHistoryBucketReader).snapshots.filter(function (s) { return !(gone[b] as HistoryStoreFlags)[s.id]; });
    out[b] = rec;
  });
  Object.keys(out).forEach(function (b) {
    if (out[b] && !snapshotsOf(out[b]).length) out[b] = null;
  });
  const before = namedShas(index, null);
  (putShas || []).forEach(function (sha) { before[sha] = true; });
  const after = namedShas(index, out);
  const dropped = Object.keys(before).filter(function (sha) { return !after[sha]; });
  return {
    changes: out,
    dropped: dropped,
    evicted: plan.deletes.length,
    overCap: plan.overCap,
    totalBefore: plan.totalBefore,
    totalAfter: plan.totalAfter
  };
}

function hasChanges(changes: HistoryStoreChanges) { return Object.keys(changes).length > 0; }

function createHistoryStore<B extends SharedHistoryBackend>(opts?: HistoryStoreOptions<B> | null) {
  opts = opts || {};
  const backend = opts.backend;
  if (!backend || typeof backend.exclusive !== "function") throw new TypeError("createHistoryStore: backend.exclusive is required");
  if (typeof opts.now !== "function") throw new TypeError("createHistoryStore: now() is required");
  if (typeof opts.hashText !== "function") throw new TypeError("createHistoryStore: hashText() is required");
  const now = opts.now;
  const hashText = opts.hashText;
  const capOption = opts.capBytes;
  const maxBodyBytes = Number(opts.maxBodyBytes) > 0 ? Number(opts.maxBodyBytes) : Infinity;
  const holdsProvider = typeof opts.holds === "function" ? opts.holds : null;

  let quotaStuck = false;
  let lastTotal: number | null = null;
  const ownHolds: Record<string, number | undefined> = Object.create(null);

  function readOnly() { return !!(backend as B).readOnly; }

  function run<T>(write: boolean, fn: (tx: SharedHistoryTransaction) => T | PromiseLike<T>): Promise<T> {
    return Promise.resolve().then(function () {
      return (backend as B).exclusive(fn, { write: !!write });
    });
  }

  function listIndex(tx: SharedHistoryTransaction) {
    return tx.list().then(function (index) {
      index = index || {};
      lastTotal = totalOf(index);
      return index;
    });
  }

  function commitAndNote(tx: SharedHistoryTransaction, index: SharedHistoryIndex, changes: SharedHistoryIndex, dropped: string[]) {
    return tx.commit(changes, dropped).then(function () {
      const next: SharedHistoryIndex = {};
      Object.keys(index).forEach(function (b) { next[b] = index[b]; });
      Object.keys(changes).forEach(function (b) { next[b] = changes[b]; });
      lastTotal = totalOf(next);
    });
  }

  function readCap(total: number | null) {
    return Promise.resolve().then(function () {
      return typeof capOption === "function" ? capOption(total) : capOption;
    }).then(function (v) {
      return (typeof v === "number" && v >= 0) ? v : Infinity;
    }, function () { return Infinity; });
  }

  function allHolds(protect: unknown) {
    const out: HistoryStoreHold[] = [], seen: HistoryStoreFlags = Object.create(null);
    protectList(protect, out, seen);
    Object.keys(ownHolds).forEach(function (k) {
      const i = k.indexOf("\n");
      protectList([{ docId: k.slice(0, i), id: k.slice(i + 1) }], out, seen);
    });
    if (holdsProvider) {
      let provided: unknown;
      try { provided = holdsProvider(); } catch (e) { provided = null; }
      protectList(provided, out, seen);
    }
    return out;
  }

  function hash(text: string) {
    return Promise.resolve().then(function () { return hashText(text); }).then(function (sha) {
      if (typeof sha !== "string" || !sha) throw new Error("history store: hashText gave no sha");
      return sha;
    });
  }

  function hold(q?: { id?: unknown; older?: unknown; docId?: unknown } | null) {
    q = q || {};
    const id = typeof q.id === "string" ? q.id : "";
    const bucket = q.older ? HISTORY_OLDER_KEY : (isDocId(q.docId) ? q.docId : "");
    if (!bucket || !HISTORY_SNAP_ID_RE.test(id)) return noop;
    const key = bucket + "\n" + id;
    ownHolds[key] = (ownHolds[key] || 0) + 1;
    let released = false;
    return function () {
      if (released) return;
      released = true;
      if ((ownHolds[key] as number) > 1) (ownHolds[key] as number)--; else Reflect.deleteProperty(ownHolds, key);
    };
  }

  function evictWith(capFor: (total: number) => number, protect: unknown) {
    const held = allHolds(protect);
    if (readOnly()) {
      return run(false, function (tx) {
        return listIndex(tx).then(function (index) {
          const plan = planChanges(index, {}, capFor(totalOf(index)), now(), held, []);
          return { evicted: 0, overCap: plan.overCap, totalBefore: plan.totalBefore, totalAfter: plan.totalBefore };
        });
      });
    }
    return run(true, function (tx) {
      return listIndex(tx).then(function (index) {
        const plan = planChanges(index, {}, capFor(totalOf(index)), now(), held, []);
        const result = { evicted: plan.evicted, overCap: plan.overCap, totalBefore: plan.totalBefore, totalAfter: plan.totalAfter };
        if (!hasChanges(plan.changes)) return result;
        return commitAndNote(tx, index, plan.changes, plan.dropped).then(function () { return result; });
      });
    });
  }

  function evict(cap?: unknown, o?: HistoryStoreOperationOptions | null) {
    const protect = o && o.protect;
    const capP = cap == null ? readCap(lastTotal) : Promise.resolve(typeof cap === "number" && cap >= 0 ? cap : Infinity);
    return capP.then(function (c) {
      return evictWith(function () { return c; }, protect);
    }).then(null, function (e) {
      return { evicted: 0, overCap: false, totalBefore: 0, totalAfter: 0, code: errorCode(e) };
    });
  }

  function putOnce(bucket: string, clean: HistoryStoreMeta, stateJson: string, sha: string, size: number, cap: number, held: HistoryStoreHold[]): Promise<HistoryStorePutOnceResult> {
    return run(true, function (tx) {
      return listIndex(tx).then(function (index) {
        const rec = index[bucket] || null;
        if (findEntry(rec, clean.id)) return { duplicate: true };
        const m: HistoryStoreEntry = historyStampAfter(entryOf(clean, sha) as HistoryStoreEntry, newestAtMs(rec));
        m.sizeBytes = size;
        return tx.put(sha, stateJson).then(function () {
          const t = now();
          const next: HistoryStoreMutableBucket = rec ? cloneRecord(rec) : { title: "", lastOpenedAt: t, snapshots: [] };
          next.snapshots.push(m);
          next.snapshots.sort(byAtAscending);
          if (m.title) next.title = m.title;
          next.lastOpenedAt = t;
          const changes: HistoryStoreChanges = {};
          changes[bucket] = next;
          const plan = planChanges(index, changes, cap, t, held, [sha]);
          return commitAndNote(tx, index, plan.changes, plan.dropped).then(function () {
            return { duplicate: false, evicted: plan.evicted, overCap: plan.overCap };
          });
        });
      });
    });
  }

  function put(docId: unknown, meta: unknown, stateJson: unknown, o?: HistoryStoreOperationOptions | null): Promise<HistoryStorePutResult> {
    o = o || {};
    const clean = sanitizeHistoryMeta(meta);
    if (o.older) {
      if ((docId != null && docId !== HISTORY_OLDER_KEY) || !clean || typeof stateJson !== "string") {
        return Promise.resolve({ stored: false, code: "invalid" });
      }
      if (readOnly()) return Promise.resolve({ stored: false, code: "read-only" });
      if (historyUtf8Length(stateJson) > maxBodyBytes) return Promise.resolve({ stored: false, code: "too-large" });
      return importOlder([{ meta: clean, stateJson: stateJson }]).then(function (r) {
        if (!r.ok) return { stored: false, code: r.code || "io" };
        const out: HistoryStorePutSuccess = { stored: true, evicted: 0, overCap: false };
        if (!r.added) out.duplicate = true;
        return out;
      });
    }
    if (!isDocId(docId) || !clean || typeof stateJson !== "string") {
      return Promise.resolve({ stored: false, code: "invalid" });
    }
    if (readOnly()) return Promise.resolve({ stored: false, code: "read-only" });
    const size = historyUtf8Length(stateJson);
    if (size > maxBodyBytes) return Promise.resolve({ stored: false, code: "too-large" });
    const held = allHolds(o.protect);

    return Promise.all([hash(stateJson), readCap(lastTotal)]).then(function (pre) {
      const sha = pre[0], cap = pre[1];
      function attempt() { return putOnce(docId as string, clean as HistoryStoreMeta, stateJson as string, sha, size, cap, held); }
      function stored(r: HistoryStorePutOnceResult, evictedBefore: number) {
        const out: HistoryStorePutSuccess = { stored: true, evicted: evictedBefore, overCap: false };
        if (r.duplicate) { out.duplicate = true; return out; }
        quotaStuck = false;
        out.evicted += r.evicted;
        out.overCap = !!r.overCap;
        return out;
      }
      return attempt().then(function (r) { return stored(r, 0); }, function (e): HistoryStorePutResult | Promise<HistoryStorePutResult> {
        const code = errorCode(e);
        if (!isNoRoom(code)) return { stored: false, code: code === "read-only" ? code : "io" };
        if (quotaStuck) return { stored: false, code: code, evicted: 0, overCap: true };
        return evictWith(function (total) { return Math.min(cap, Math.max(0, total - size)); }, o.protect)
          .then(null, function () { return { evicted: 0 }; })
          .then(function (ev): HistoryStorePutResult | Promise<HistoryStorePutResult> {
            const evicted = ev.evicted || 0;
            if (!evicted) {
              quotaStuck = true;
              return { stored: false, code: code, evicted: 0, overCap: true };
            }
            return attempt().then(function (r) { return stored(r, evicted); }, function (e2): HistoryStorePutResult {
              const code2 = errorCode(e2);
              if (isNoRoom(code2)) quotaStuck = true;
              return { stored: false, code: isNoRoom(code2) ? code2 : "io", evicted: evicted, overCap: true };
            });
          });
      });
    }).then(null, function (e) {
      return { stored: false, code: errorCode(e) };
    });
  }

  function healMissing(sha: string) {
    if (readOnly()) return Promise.resolve();
    return run(true, function (tx) {
      return listIndex(tx).then(function (index) {
        if (!namedShas(index, null)[sha]) return null;
        return tx.get(sha).then(function (text) {
          if (typeof text === "string") return null;
          const changes: HistoryStoreChanges = {};
          Object.keys(index).forEach(function (b) {
            const list = snapshotsOf(index[b]);
            if (!list.some(function (s) { return s && s.sha === sha; })) return;
            const next = cloneRecord(index[b]);
            next.snapshots = next.snapshots.filter(function (s) { return !s || s.sha !== sha; });
            changes[b] = next.snapshots.length ? next : null;
          });
          return commitAndNote(tx, index, changes, []);
        });
      });
    }).then(noop, noop);
  }

  function get(bucket: unknown, id: unknown) {
    if (!isBucket(bucket) || typeof id !== "string" || !HISTORY_SNAP_ID_RE.test(id)) return Promise.resolve(null);
    return run(false, function (tx) {
      return listIndex(tx).then(function (index) {
        const rec = index[bucket as string];
        const e = findEntry(rec, id);
        if (!e) return null;
        if (bucket === HISTORY_OLDER_KEY && historyOlderExpired(rec, now())) return null;
        return tx.get(e.sha).then(function (text) {
          if (typeof text !== "string") return { missing: e.sha };
          return { meta: publicMeta(e, bucket as string), stateJson: text };
        });
      });
    }).then(function (r) {
      if (r && r.missing) {
        healMissing(r.missing);
        return null;
      }
      return r;
    });
  }

  function list(docId?: unknown) {
    const id = isDocId(docId) ? docId as string : null;
    return run(false, function (tx) { return listIndex(tx); }).then(function (index) {
      const entries = id ? snapshotsOf(index[id]).map(function (s) { return publicMeta(s, id); }).filter(Boolean as unknown as (m: HistoryStorePublicMeta | null) => m is HistoryStorePublicMeta) : [];
      const olderRec = index[HISTORY_OLDER_KEY] || null;
      let older: HistoryStorePublicMeta[] = [], olderExpiresAt: number | null = null;
      if (olderRec && historyOlderExpired(olderRec, now())) {
        if (!readOnly()) evictWith(function () { return Infinity; }, null).then(noop, noop);
      } else if (olderRec) {
        older = snapshotsOf(olderRec).map(function (s) { return publicMeta(s, HISTORY_OLDER_KEY); }).filter(Boolean as unknown as (m: HistoryStorePublicMeta | null) => m is HistoryStorePublicMeta);
        const exp = Number(olderRec.expiresAt);
        olderExpiresAt = isFinite(exp) && exp > 0 ? exp : null;
      }
      return { entries: entries.sort(byAtDescending), older: older.sort(byAtDescending), olderExpiresAt: olderExpiresAt };
    });
  }

  function usage() {
    return run(false, function (tx) { return listIndex(tx); }).then(function (index) {
      const total = totalOf(index);
      const docCount = Object.keys(index).filter(function (b) { return b !== HISTORY_OLDER_KEY && index[b]; }).length;
      return readCap(total).then(function (cap) {
        return { totalBytes: total, capBytes: cap, overCap: total > cap, docCount: docCount, readOnly: readOnly() };
      });
    });
  }

  function listDocs() {
    return run(false, function (tx) { return listIndex(tx); }).then(function (index) {
      return Object.keys(index).filter(function (b) { return b !== HISTORY_OLDER_KEY && index[b]; }).sort().map(function (b) {
        return { docId: b, title: (index[b] as SharedHistoryBucketReader).title || "", lastOpenedAt: Number((index[b] as SharedHistoryBucketReader).lastOpenedAt) || 0 };
      });
    });
  }

  function rawIndex(): Promise<SharedHistoryIndex> {
    return run(false, function (tx) { return listIndex(tx); }).then(function (index) {
      return JSON.parse(JSON.stringify(index)) as SharedHistoryIndex;
    });
  }

  function copy(from: unknown, to: unknown, o?: HistoryStoreOperationOptions | null): Promise<HistoryStoreCopyResult> {
    if (!isDocId(from) || !isDocId(to)) return Promise.resolve({ ok: false, copied: 0, code: "invalid" });
    if (from === to) return Promise.resolve({ ok: true, copied: 0 });
    if (readOnly()) return Promise.resolve({ ok: false, copied: 0, code: "read-only" });
    const held = allHolds(o && o.protect);
    return readCap(lastTotal).then(function (cap) {
      return run(true, function (tx) {
        return listIndex(tx).then(function (index) {
          const src = index[from as string] || null, dst = index[to as string] || null;
          if (!snapshotsOf(src).length && !dst) return { ok: true, copied: 0 };
          const t = now();
          const next: HistoryStoreMutableBucket = dst ? cloneRecord(dst) : { title: "", lastOpenedAt: t, snapshots: [] };
          const have: HistoryStoreFlags = Object.create(null);
          next.snapshots.forEach(function (s) { if (s) have[s.id] = true; });
          let copied = 0;
          snapshotsOf(src).forEach(function (s) {
            if (!s || have[s.id] || typeof s.sha !== "string") return;
            const m = entryOf(s, s.sha);
            if (!m) return;
            next.snapshots.push(m);
            have[m.id] = true;
            copied++;
          });
          next.snapshots.sort(byAtAscending);
          if (!next.title && src && src.title) next.title = src.title;
          next.lastOpenedAt = t;
          const changes: HistoryStoreChanges = {};
          changes[to as string] = next;
          const plan = planChanges(index, changes, cap, t, held, []);
          return commitAndNote(tx, index, plan.changes, plan.dropped).then(function (): HistoryStoreCopyResult { return { ok: true, copied: copied }; });
        });
      });
    }).then(null, function (e): HistoryStoreCopyResult {
      return { ok: false, copied: 0, code: errorCode(e) };
    });
  }

  function touch(docId: unknown, title: unknown) {
    if (!isDocId(docId) || readOnly()) return Promise.resolve();
    return run(true, function (tx) {
      return listIndex(tx).then(function (index) {
        const rec = index[docId as string];
        if (!rec) return null;
        const next = cloneRecord(rec);
        next.lastOpenedAt = now();
        const t = historyClip(title, 300);
        if (t) next.title = t;
        const changes: HistoryStoreChanges = {};
        changes[docId as string] = next;
        return tx.commit(changes, []);
      });
    }).then(noop, noop);
  }

  function importOlder(entries: unknown): Promise<HistoryStoreImportResult> {
    if (!Array.isArray(entries)) return Promise.resolve({ ok: false, count: 0, added: 0, code: "invalid" });
    if (readOnly()) return Promise.resolve({ ok: false, count: 0, added: 0, code: "read-only" });
    const clean: { meta: HistoryStoreMeta; stateJson: string }[] = [], seen: HistoryStoreFlags = Object.create(null);
    (entries as unknown[]).forEach(function (e) {
      const meta: HistoryStoreMeta | null = e && typeof e === "object" ? sanitizeHistoryMeta((e as HistoryStoreFields).meta) : null;
      if (!meta || typeof (e as HistoryStoreFields).stateJson !== "string" || seen[meta.id]) return;
      const size = historyUtf8Length((e as HistoryStoreFields).stateJson as string);
      if (size > maxBodyBytes) return;
      seen[meta.id] = true;
      meta.sizeBytes = size;
      clean.push({ meta: meta, stateJson: (e as HistoryStoreFields).stateJson as string });
    });
    const held = allHolds(null);
    const heldKey: HistoryStoreFlags = Object.create(null);
    held.forEach(function (p) { heldKey[p.docId + "\n" + p.id] = true; });
    return Promise.all(clean.map(function (e) { return hash(e.stateJson); })).then(function (shas) {
      return run(true, function (tx) {
        return listIndex(tx).then(function (index) {
          const t = now();
          const rec = index[HISTORY_OLDER_KEY] || null;
          const expired = !!rec && historyOlderExpired(rec, t);
          if (!clean.length) return { ok: true, count: rec && !expired ? snapshotsOf(rec).length : 0, added: 0 };
          const next: HistoryStoreMutableBucket = (rec && !expired) ? cloneRecord(rec) : {
            title: "", lastOpenedAt: 0, migratedAt: t, expiresAt: t + HISTORY_OLDER_TTL_MS,
            snapshots: snapshotsOf(rec).filter(function (s) { return s && heldKey[HISTORY_OLDER_KEY + "\n" + s.id]; })
          };
          const have: HistoryStoreFlags = Object.create(null);
          next.snapshots.forEach(function (s) { if (s) have[s.id] = true; });
          const fresh: { entry: HistoryStoreEntry; stateJson: string }[] = [];
          clean.forEach(function (e, i) {
            if (have[e.meta.id]) return;
            have[e.meta.id] = true;
            fresh.push({ entry: entryOf(e.meta, shas[i] as string) as HistoryStoreEntry, stateJson: e.stateJson });
          });
          if (!fresh.length && rec && !expired) return { ok: true, count: next.snapshots.length, added: 0 };
          let chain = Promise.resolve();
          fresh.forEach(function (f) {
            chain = chain.then(function () { return tx.put(f.entry.sha, f.stateJson); });
          });
          return chain.then(function () {
            fresh.forEach(function (f) { next.snapshots.push(f.entry); });
            next.snapshots.sort(byAtAscending);
            const changes: HistoryStoreChanges = {};
            changes[HISTORY_OLDER_KEY] = next.snapshots.length ? next : null;
            const before = namedShas(index, null);
            fresh.forEach(function (f) { before[f.entry.sha] = true; });
            const after = namedShas(index, changes);
            const dropped = Object.keys(before).filter(function (sha) { return !after[sha]; });
            return commitAndNote(tx, index, changes, dropped).then(function () {
              return { ok: true, count: next.snapshots.length, added: fresh.length };
            });
          });
        });
      });
    }).then(null, function (e) {
      return { ok: false, count: 0, added: 0, code: errorCode(e) };
    });
  }

  return {
    get backend() { return backend as B; },
    get name() { return (backend as B).name; },
    get persistent() { return !!(backend as B).persistent; },
    get readOnly() { return readOnly(); },
    put: put,
    get: get,
    list: list,
    copy: copy,
    touch: touch,
    importOlder: importOlder,
    usage: usage,
    listDocs: listDocs,
    evict: evict,
    hold: hold,
    rawIndex: rawIndex
  };
}

function deepFreeze<T>(v: T): Readonly<T> {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    Object.keys(v).forEach(function (k) { deepFreeze((v as HistoryStoreFields)[k]); });
  }
  return v;
}

function plainCopy<T>(v: T): T { return v == null ? v : JSON.parse(JSON.stringify(v)) as T; }

function codedError(code: string, message: string, name?: string) {
  const e: Error & { code: string } = new Error(message) as Error & { code: string };
  e.code = code;
  if (name) e.name = name;
  return e;
}

function createMemoryHistoryBackend<E extends object>(o: HistoryMemoryOptions<E> & { extend: NonNullable<HistoryMemoryOptions<E>["extend"]> }): Omit<HistoryMemoryBackend, keyof E> & E;
function createMemoryHistoryBackend(o?: HistoryMemoryOptions<object> | null): HistoryMemoryBackend;
function createMemoryHistoryBackend<E extends object>(o?: HistoryMemoryOptions<E> | null) {
  o = o || {};
  const strict = !!o.strict;
  const macrotask = o.macrotask;
  if (strict && typeof macrotask !== "function") {
    throw new TypeError("createMemoryHistoryBackend: strict mode needs a macrotask(cb) scheduler");
  }
  let index: SharedHistoryIndex = Object.create(null);
  let bodies: Record<string, string | undefined> = Object.create(null);
  let chain = Promise.resolve();
  const before = o.before || noop;
  const observe = o.observe || noop;

  function isNamed(sha: string, idx: SharedHistoryIndex) {
    return Object.keys(idx).some(function (b) {
      return snapshotsOf(idx[b]).some(function (s) { return s && s.sha === sha; });
    });
  }

  function runTx<T>(fn: (tx: SharedHistoryTransaction) => T | PromiseLike<T>, write: boolean) {
    let active = true, pending = 0, done = false;
    const stagedBodies: Record<string, string | undefined> = Object.create(null);
    let staged: { changes: SharedHistoryIndex; dropped: string[] } | null = null;

    function scheduleCheck() {
      (macrotask as NonNullable<typeof macrotask>)(function () { if (!done && pending === 0) active = false; });
    }
    function op<R>(body: () => R): Promise<R> {
      if (!active) throw codedError("inactive", "The history transaction has finished (a non-tx await inside exclusive()?)", "TransactionInactiveError");
      if (!strict) return Promise.resolve().then(body);
      pending++;
      return new Promise<R>(function (resolve, reject) {
        (macrotask as NonNullable<typeof macrotask>)(function () {
          pending--;
          try { resolve(body()); } catch (e) { reject(e); }
          scheduleCheck();
        });
      });
    }
    function mustWrite(what: string) {
      if (strict && !write) throw codedError("io", "history: " + what + " in a read-only job");
      if (backend.readOnly) throw codedError("read-only", "history: the store is read-only");
    }

    const tx: SharedHistoryTransaction = {
      list: function () {
        return op(function () {
          const out: SharedHistoryIndex = {};
          Object.keys(index).forEach(function (b) { out[b] = index[b]; });
          return strict ? Object.freeze(out) : plainCopy(out);
        });
      },
      get: function (sha) {
        return op(function () {
          if (typeof sha !== "string") return null;
          if (sha in stagedBodies) return stagedBodies[sha];
          return sha in bodies ? bodies[sha] : null;
        });
      },
      put: function (sha, text) {
        return op(function () {
          mustWrite("put");
          observe("put");
          before("put");
          if (typeof sha !== "string" || typeof text !== "string") throw codedError("io", "history: bad body");
          if (!(sha in bodies)) stagedBodies[sha] = text;
        });
      },
      commit: function (changes, dropped) {
        return op(function () {
          mustWrite("commit");
          if (staged) throw codedError("io", "history: commit called twice in one transaction");
          observe("commit");
          before("commit");
          staged = { changes: plainCopy(changes || {}), dropped: Array.isArray(dropped) ? dropped.slice() : [] };
        });
      }
    };

    if (strict) scheduleCheck();
    return Promise.resolve().then(function () { return fn(tx); }).then(function (result) {
      done = true;
      active = false;
      const nextIndex: SharedHistoryIndex = Object.create(null);
      Object.keys(index).forEach(function (b) { nextIndex[b] = index[b]; });
      if (staged) {
        Object.keys(staged.changes).forEach(function (b) {
          if ((staged as NonNullable<typeof staged>).changes[b]) nextIndex[b] = deepFreeze((staged as NonNullable<typeof staged>).changes[b]);
          else Reflect.deleteProperty(nextIndex, b);
        });
      }
      const drop = staged ? staged.dropped.filter(function (sha) {
        if (!isNamed(sha, nextIndex)) return true;
        if (strict) throw codedError("io", "history: asked to drop body " + sha + " that the index still names");
        return false;
      }) : [];
      Object.keys(stagedBodies).forEach(function (sha) { bodies[sha] = stagedBodies[sha]; });
      index = nextIndex;
      drop.forEach(function (sha) { Reflect.deleteProperty(bodies, sha); });
      return result;
    }, function (e) {
      done = true;
      active = false;
      throw e;
    });
  }

  const backend = {
    name: typeof o.name === "string" ? o.name : "memory",
    persistent: !!o.persistent,
    readOnly: !!o.readOnly,

    exclusive: function <T>(fn: (tx: SharedHistoryTransaction) => T | PromiseLike<T>, xo?: { write?: boolean }) {
      const write = !(xo && xo.write === false);
      observe("exclusive");
      const job = chain.then(function () { return runTx(fn, write); });
      chain = job.then(noop, noop);
      return job;
    },


  };
  return Object.assign(backend, o.extend ? o.extend({
    get index() { return index; }, set index(value) { index = value; },
    get bodies() { return bodies; }, set bodies(value) { bodies = value; },
    clone: plainCopy, freeze: deepFreeze
  }) : {});
}

export {
  createHistoryStore,
  createMemoryHistoryBackend
};
