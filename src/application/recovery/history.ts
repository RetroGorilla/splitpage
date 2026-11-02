import type { HistoryInstrumentation, HistoryPendingSnapshot } from "./history-instrumentation.ts";
import type { HistoryOwner, HistoryOwnerPorts, HistorySnapshotMeta, HistorySnapshotRead, HistorySnapshotReply, HistoryWriteResult, HistoryResolvedBackend, HistoryImportResult } from "./history-ports.ts";


type HistoryAddress = { id?: string; docId?: string | null; older?: boolean };
type HistoryMigrationResult = { migrated: number; removedKey: boolean };
type HistoryExportSnapshot = { meta: HistorySnapshotReply["meta"]; stateJson: HistorySnapshotReply["stateJson"] };
type HistoryExportDoc = { docId: string; title: unknown; lastOpenedAt: number; damaged?: number; metas: HistorySnapshotMeta[]; snapshots?: HistoryExportSnapshot[] };
type HistoryExportBundle = { docs: { docId: string; title: unknown; lastOpenedAt: number; snapshots: HistoryExportSnapshot[] }[]; older: HistoryExportSnapshot[]; truncated: boolean; omittedSnapshots?: number; blobs?: Record<string, HistoryImageData>; missingBlobs?: string[] };
type HistoryImageData = { mime: string; b64: string };
type HistoryImportCandidate = { atMs: number; id: string; entry: HistorySnapshotRead | null };
type HistoryImportCounts = { -readonly [K in keyof HistoryImportResult]: HistoryImportResult[K] };
type HistoryCallable = (...args: never[]) => unknown;
type HistoryOwnerApi = Omit<HistoryOwner, "startHistory">;

import { sha256Bytes } from "../../core/document/ids.ts";
import { normalizeDocId } from "../../../shared/doc-id-policy.ts";
import { HISTORY_OLDER_KEY, HISTORY_PER_DOC, HISTORY_SNAP_ID_RE, historyClip, historyUtf8Length, sanitizeHistoryMeta } from "../../../shared/history-policy.ts";
import { imageDims, isSha256Hex, refsIn, sniffImageMime } from "../../../shared/blob-policy.ts";
import { checksumText } from "../../../shared/text.ts";

function startHistory(ports: HistoryOwnerPorts, instrumentation?: HistoryInstrumentation) {
  let active = true;
  const currentDocument = ports.document.current;
  const currentHome = ports.location.home;
  const getEditorName = ports.preferences.editorName;
  const saveChanges = ports.saving.changes;
  const unsavedChanges = ports.saving.unsaved;
  const legacySnapshots = function () { return ports.recovery; };
  const seedCheckPasses = ports.seed.passes;
  const showToast = function (...args: Parameters<HistoryOwnerPorts["effects"]["show"]>) { if (active) ports.effects.show(...args); };
  const { intern, persist, recordFor, ensureBytes } = ports.pictures;
  const dataUrlForSync = ports.pictures.dataUrlFor;
  const inlineStateJson = ports.inlinePictures;
  const mintDocId = ports.ids.docId;
  const makeId = ports.ids.id;
  const storage = ports.storage({ now: historyNow, holds: historyProtectedList, desktop: ports.desktop.history, runningOnDesktop: ports.desktop.running });
  const { resolveHistoryBackend, historyIdbNotice } = storage;
let historyChain: Promise<void>;


const HISTORY_PENDING_PER_DOC = 10;
const HISTORY_MIGRATION_LOOPS = 3;

function historyNoop() {}

function enqueueHistory<T, F>(job: () => T | PromiseLike<T>, fallback: F | ((error: unknown) => F)): Promise<Awaited<T | F> | undefined> {
  const run = historyChain.then(function () { return job(); }).then(null, function (e) {
    if (ports.logger) ports.logger.error(e);
    try { return typeof fallback === "function" ? (fallback as (error: unknown) => F)(e) : fallback; } catch (x) { return undefined; }
  });
  historyChain = run.then(historyNoop, historyNoop);
  return run as Promise<Awaited<T | F> | undefined>;
}

function historyIdle(): Promise<boolean> {
  const c = historyChain;
  const m = historyMigrationPromise;
  return Promise.all([c, m]).then(function () {
    if (c === historyChain && m === historyMigrationPromise) return true;
    return historyIdle();
  });
}

function historyNow() {
  return instrumentation ? instrumentation.clock(ports.now) : ports.now();
}


function historyStripMeta(m: unknown) {
  const out: HistorySnapshotMeta | null = sanitizeHistoryMeta(m);
  if (out && m && typeof (m as { docId?: unknown }).docId === "string") out.docId = (m as { docId: string }).docId;
  return out;
}


let historyProtected: Record<string, number> = {};

function historyProtectKey(bucket: string, id: string) { return bucket + "\n" + id; }

function historyProtectedList() {
  return Object.keys(historyProtected).map(function (k) {
    const i = k.indexOf("\n");
    return { docId: k.slice(0, i), id: k.slice(i + 1) };
  });
}

function protectHistorySnapshot(q?: HistoryAddress) {
  q = q || {};
  const id = typeof q.id === "string" ? q.id : "";
  const bucket = q.older ? HISTORY_OLDER_KEY : normalizeDocId(q.docId);
  if (!bucket || !HISTORY_SNAP_ID_RE.test(id)) return historyNoop;
  const key = historyProtectKey(bucket, id);
  const holds = historyProtected;
  holds[key] = (holds[key] || 0) + 1;
  let released = false;
  return function () {
    if (released) return;
    released = true;
    if (holds !== historyProtected || !holds[key]) return;
    if ((holds[key] as number) > 1) (holds[key] as number)--; else Reflect.deleteProperty(holds, key);
  };
}


function isPristineSeedDocument() {
  return !!currentDocument() && saveChanges() === 0 && !unsavedChanges() && currentHome().kind === "none" && seedCheckPasses();
}

let historyLocal: Record<string, HistoryPendingSnapshot> = {};
let historyWarnedDocs: Record<string, boolean> = {};
let historyLastAtMs = 0;
let historyRetryQueued = false;

function historyLocalKey(docId: string, id: string) { return docId + "/" + id; }

function historyLocalEntries(docId?: string | null, status?: string) {
  return Object.keys(historyLocal).map(function (k) { return historyLocal[k] as HistoryPendingSnapshot; }).filter(function (e) {
    return (!docId || e.docId === docId) && (!status || e.status === status);
  }).sort(function (a, b) { return a.meta.atMs - b.meta.atMs; });
}

let historyChangeListeners: (() => void)[] = [];

function onHistoryChange(listener: () => void) {
  historyChangeListeners.push(listener);
  return function () {
    const at = historyChangeListeners.indexOf(listener);
    if (at !== -1) historyChangeListeners.splice(at, 1);
  };
}

function historyChanged() {
  if (!active) return;
  historyChangeListeners.slice().forEach(function (listener) { listener(); });
}

function historyMarkPending(entry: HistoryPendingSnapshot) {
  entry.status = "pending";
  const mine = historyLocalEntries(entry.docId, "pending");
  while (mine.length > HISTORY_PENDING_PER_DOC) {
    const old = mine.shift() as HistoryPendingSnapshot;
    Reflect.deleteProperty(historyLocal, historyLocalKey(old.docId, old.meta.id));
  }
  const notice = storage.backendName() === "idb" ? historyIdbNotice() : null;
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

function historyPersistRefs(entry: HistoryPendingSnapshot) {
  const refs = entry.refs || [];
  if (!refs.length) return Promise.resolve();
  return persist(refs).then(function (failed) {
    if (failed.length) entry.stateJson = inlineStateJson(entry.stateJson, failed);
  });
}

function historyStoreEntry(backend: HistoryResolvedBackend, entry: HistoryPendingSnapshot) {
  entry.status = "writing";
  return historyPersistRefs(entry).then(function () {
    return backend.put(entry.docId, entry.meta, entry.stateJson);
  }).then(function (r) {
    r = r || { stored: false, code: "io" };
    const key = historyLocalKey(entry.docId, entry.meta.id);
    if (r.stored) {
      if (historyLocal[key] === entry) Reflect.deleteProperty(historyLocal, key);
    } else if (r.code === "invalid") {
      if (historyLocal[key] === entry) Reflect.deleteProperty(historyLocal, key);
    } else if (historyLocal[key] === entry) {
      historyMarkPending(entry);
    }
    return r;
  }, function () {
    if (historyLocal[historyLocalKey(entry.docId, entry.meta.id)] === entry) historyMarkPending(entry);
    return { stored: false, code: "io" };
  });
}

function captureSnapshot(label: string | undefined, src: unknown, opts?: { allowSeedSkip?: boolean }) {
  opts = opts || {};
  if (!src || typeof src !== "object" || !Array.isArray((src as { rows?: unknown }).rows)) return null;
  if (opts.allowSeedSkip && src === currentDocument() && isPristineSeedDocument()) return null;
  const docId = normalizeDocId((src as { docId?: unknown }).docId) || ((src as { docId: string }).docId = mintDocId());
  let stateJson;
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
  let atMs = historyNow();
  if (atMs <= historyLastAtMs) atMs = historyLastAtMs + 1;
  historyLastAtMs = atMs;
  let id = makeId("s");
  while (!HISTORY_SNAP_ID_RE.test(id) || historyLocal[historyLocalKey(docId, id)]) id = makeId("s");
  const meta: HistorySnapshotMeta | null = sanitizeHistoryMeta({
    id: id,
    label: label,
    at: new Date(atMs).toISOString(),
    atMs: atMs,
    by: getEditorName(),
    rows: (src as { rows: unknown[] }).rows.length,
    title: typeof (src as { title?: unknown }).title === "string" ? (src as { title: string }).title : "",
    kind: "snapshot"
  });
  const entry: HistoryPendingSnapshot = { docId: docId, meta: meta as HistorySnapshotMeta, stateJson: stateJson, status: "writing", refs: refsIn(src) };
  historyLocal[historyLocalKey(docId, id)] = entry;
  const done = enqueueHistory(function () {
    return resolveHistoryBackend().then(function (backend) {
      return historyStoreEntry(backend, entry);
    }).then(function (r) {
      if (r.stored && historyLocalEntries(null, "pending").length) retryPendingSnapshots();
      historyChanged();
      return r;
    });
  }, function () {
    if (historyLocal[historyLocalKey(docId, id)] === entry) historyMarkPending(entry);
    return { stored: false, code: "io" };
  });
  historyChanged();
  return { id: id, docId: docId, done: done as Promise<HistoryWriteResult> };
}

function retryPendingSnapshots() {
  if (historyRetryQueued) return;
  historyRetryQueued = true;
  enqueueHistory(function () {
    historyRetryQueued = false;
    const list = historyLocalEntries(null, "pending");
    if (!list.length) return null;
    return resolveHistoryBackend().then(function (backend) {
      let i = 0;
      function next(): Promise<null> | null {
        if (i >= list.length) return null;
        const entry = list[i++] as HistoryPendingSnapshot;
        if (historyLocal[historyLocalKey(entry.docId, entry.meta.id)] !== entry) return next();
        return historyStoreEntry(backend, entry).then(function (r) { return r.stored ? next() : null; });
      }
      return next();
    }).then(function () { historyChanged(); });
  }, function () { historyRetryQueued = false; return null; });
}

function historyLocalMetas(docId: string, lists: HistoryPendingSnapshot[], seen: Record<string, boolean>) {
  const out: HistorySnapshotMeta[] = [];
  lists.forEach(function (e) {
    if (seen[e.meta.id]) return;
    seen[e.meta.id] = true;
    const m = historyStripMeta(e.meta) as HistorySnapshotMeta;
    m.docId = docId;
    m.status = e.status;
    m.sizeBytes = m.sizeBytes || historyUtf8Length(e.stateJson);
    out.push(m);
  });
  return out;
}

function listDocHistory(docId?: string | null) {
  docId = normalizeDocId(docId);
  const localBefore = docId ? historyLocalEntries(docId) : [];
  return resolveHistoryBackend().then(function (backend) {
    return backend.list(docId || null).then(null, function (): Awaited<ReturnType<HistoryResolvedBackend["list"]>> {
      return { entries: [], older: [], olderExpiresAt: null, usage: null };
    }).then(function (listed) {
      listed = listed || { entries: [], older: [], olderExpiresAt: null, usage: null };
      const seen: Record<string, boolean> = {};
      let entries: HistorySnapshotMeta[] = [];
      (listed.entries || []).forEach(function (m) {
        seen[m.id] = true;
        m.status = "stored";
        entries.push(m);
      });
      if (docId) entries = entries.concat(historyLocalMetas(docId, historyLocalEntries(docId).concat(localBefore), seen));
      entries.sort(function (a, b) { return b.atMs - a.atMs; });
      const n = backend.name === "idb" ? historyIdbNotice() : null;
      const notice = n ? n.text : null;
      return {
        entries: entries,
        older: ((listed as NonNullable<typeof listed>).older || []).map(function (m) { m.status = "stored"; return m; }),
        olderExpiresAt: listed.olderExpiresAt == null ? null : listed.olderExpiresAt,
        ...(listed.damaged ? { damaged: listed.damaged } : {}),
        ...(listed.olderDamaged ? { olderDamaged: listed.olderDamaged } : {}),
        backend: backend.name,
        persistent: !!backend.persistent,
        usage: listed.usage || null,
        notice: notice
      };
    });
  }).then(null, function (e) {
    if (ports.logger) ports.logger.error(e);
    return { entries: [], older: [], olderExpiresAt: null, backend: storage.backendName(), persistent: false, usage: null, notice: null };
  });
}

function getHistorySnapshot(q?: HistoryAddress) {
  q = q || {};
  const id = typeof q.id === "string" ? q.id : "";
  if (!HISTORY_SNAP_ID_RE.test(id)) return Promise.resolve(null);
  let bucket: string | null;
  if (q.older) {
    bucket = HISTORY_OLDER_KEY;
  } else {
    bucket = normalizeDocId(q.docId);
    if (!bucket) return Promise.resolve(null);
    const local = historyLocal[historyLocalKey(bucket, id)];
    if (local) return Promise.resolve({ meta: historyStripMeta(local.meta) as HistorySnapshotMeta, stateJson: local.stateJson });
  }
  return resolveHistoryBackend().then(function (backend) {
    return backend.get(bucket as string, id);
  }).then(function (r) { return r || null; }, function () { return null; });
}

function historyTouchDocument(docId: string | null, title: string) {
  docId = normalizeDocId(docId);
  if (!docId) return Promise.resolve();
  return enqueueHistory(function () {
    return resolveHistoryBackend().then(function (backend) { return backend.touch(docId, title); });
  }, null);
}

function historyDocumentChanged() {
  if (currentDocument() && normalizeDocId((currentDocument() as { docId: string; title: string }).docId)) historyTouchDocument((currentDocument() as { docId: string; title: string }).docId, (currentDocument() as { docId: string; title: string }).title);
  historyChanged();
}

function copyHistory(from: string | null, to: string | null) {
  if (from === HISTORY_OLDER_KEY || to === HISTORY_OLDER_KEY) return Promise.resolve({ ok: false, copied: 0, code: "invalid" });
  from = normalizeDocId(from);
  to = normalizeDocId(to);
  if (!from || !to) return Promise.resolve({ ok: false, copied: 0, code: "invalid" });
  if (from === to) return Promise.resolve({ ok: true, copied: 0 });
  return enqueueHistory(function () {
    return resolveHistoryBackend().then(function (backend) {
      return backend.copy(from, to).then(null, function (e) {
        if (ports.logger) ports.logger.error(e);
        return { ok: false, copied: 0, code: "io" };
      });
    }).then(function (r) {
      r = r || { ok: false, copied: 0, code: "io" };
      let extra = 0;
      historyLocalEntries(from, "pending").forEach(function (e) {
        const key = historyLocalKey(to, e.meta.id);
        if (historyLocal[key]) return;
        historyLocal[key] = { docId: to, meta: sanitizeHistoryMeta(e.meta) as HistorySnapshotMeta, stateJson: e.stateJson, status: "pending" };
        extra++;
      });
      if (extra) {
        const mine = historyLocalEntries(to, "pending");
        while (mine.length > HISTORY_PENDING_PER_DOC) {
          const old = mine.shift() as HistoryPendingSnapshot;
          Reflect.deleteProperty(historyLocal, historyLocalKey(old.docId, old.meta.id));
        }
      }
      historyChanged();
      return { ok: !!r.ok, copied: (r.copied || 0) + extra, code: r.code };
    });
  }, function () { return { ok: false, copied: 0, code: "io" }; }).then(function (r) {
    if (r && r.code === undefined) delete (r as { code?: string | undefined }).code;
    return r as { ok: boolean; copied: number; code?: string };
  });
}

const HISTORY_EXPORT_CAP_BYTES = 200 * 1024 * 1024;

function historyExportCap() {
  return instrumentation ? instrumentation.capacity(HISTORY_EXPORT_CAP_BYTES) : HISTORY_EXPORT_CAP_BYTES;
}

function historyExportError(code: string, message: string) {
  const e: Error & { code?: string } = new Error(message);
  e.code = code;
  return e;
}

function historyFlattenForExport(docs: HistoryExportDoc[], olderMetas: HistorySnapshotMeta[]) {
  const flat: { docId: string | null; id: string; atMs: number; sizeBytes: number }[] = [];
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

function historyAssembleExport(backend: HistoryResolvedBackend, docs: HistoryExportDoc[], olderMetas: HistorySnapshotMeta[], olderDamaged: number) {
  const flat = historyFlattenForExport(docs, olderMetas);
  let total = 0, truncated = false;
  let omittedSnapshots = docs.reduce(function (n, d) { return n + (d.damaged || 0); }, olderDamaged);
  const keep: Record<string, boolean> = {};
  flat.forEach(function (f) {
    const key = (f.docId == null ? "_older" : f.docId) + "\n" + f.id;
    if (total === 0 || total + f.sizeBytes <= historyExportCap()) {
      total += f.sizeBytes;
      keep[key] = true;
    } else {
      truncated = true;
    }
  });
  const bodyJobs: Promise<void>[] = [];
  docs.forEach(function (d) {
    d.snapshots = [];
    (d.metas || []).forEach(function (m) {
      if (!keep[d.docId + "\n" + m.id]) return;
      bodyJobs.push(backend.get(d.docId, m.id).then(function (r) {
        if (r) (d.snapshots as HistoryExportSnapshot[]).push({ meta: r.meta, stateJson: r.stateJson });
        else omittedSnapshots++;
      }));
    });
  });
  const olderOut: HistoryExportSnapshot[] = [];
  (olderMetas || []).forEach(function (m) {
    if (!keep["_older\n" + m.id]) return;
    bodyJobs.push(backend.get(HISTORY_OLDER_KEY, m.id).then(function (r) {
      if (r) olderOut.push({ meta: r.meta, stateJson: r.stateJson });
      else omittedSnapshots++;
    }));
  });
  return Promise.all(bodyJobs).then(function () {
    function newestFirst(a: HistoryExportSnapshot, b: HistoryExportSnapshot) { return (b.meta as HistorySnapshotMeta).atMs - (a.meta as HistorySnapshotMeta).atMs; }
    docs.forEach(function (d) { (d.snapshots as HistoryExportSnapshot[]).sort(newestFirst); });
    olderOut.sort(newestFirst);
    return {
      docs: docs.map(function (d) {
        return { docId: d.docId, title: d.title, lastOpenedAt: d.lastOpenedAt, snapshots: d.snapshots as HistoryExportSnapshot[] };
      }),
      older: olderOut,
      truncated: truncated,
      ...(omittedSnapshots ? { omittedSnapshots } : {})
    };
  });
}

function historyBuildExport(backend: HistoryResolvedBackend, ids: string[]) {
  const docJobs = ids.map(function (docId) {
    return Promise.all([backend.rawDoc(docId), backend.rawList(docId)]).then(function (res) {
      const rec = res[0] || null;
      return {
        docId: docId,
        title: rec ? rec.title : "",
        lastOpenedAt: rec ? rec.lastOpenedAt : 0,
        damaged: rec?.damaged || 0,
        metas: res[1] || []
      };
    });
  });
  return Promise.all(docJobs).then(function (docs) {
    return Promise.all([backend.rawList(HISTORY_OLDER_KEY), backend.rawDoc(HISTORY_OLDER_KEY)]).then(function ([olderMetas, older]) {
      return historyAssembleExport(backend, docs, olderMetas || [], older?.damaged || 0);
    });
  });
}

function exportHistoryAll() {
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
    return Promise.reject(e && (e as { code?: unknown }).code ? e : historyExportError("io", "Could not read version history for export."));
  }).then(historyExportAttachBlobs as (out: HistoryExportBundle | undefined) => Promise<HistoryExportBundle>);
}

const HISTORY_BLOB_HINT_RE = /imageRef|imageValue|data-blob/;

function historyRefsInJson(stateJson: unknown): string[] {
  if (typeof stateJson !== "string" || !HISTORY_BLOB_HINT_RE.test(stateJson)) return [];
  try { return refsIn(JSON.parse(stateJson)) as string[]; } catch (e) { return []; }
}

function historyBlobCost(sha: string, entry: HistoryImageData) {
  return sha.length + entry.mime.length + (entry as { b64: string }).b64.length + 40;
}

async function historyExportAttachBlobs(out: HistoryExportBundle) {
  const cap = historyExportCap();
  const all: { snap: HistoryExportSnapshot; owner: HistoryExportSnapshot[] }[] = [];
  out.docs.forEach(function (d) {
    d.snapshots.forEach(function (s) { all.push({ snap: s, owner: d.snapshots }); });
  });
  out.older.forEach(function (s) { all.push({ snap: s, owner: out.older }); });
  all.sort(function (a, b) {
    return ((b.snap.meta as HistorySnapshotMeta).atMs - (a.snap.meta as HistorySnapshotMeta).atMs) || ((a.snap.meta as HistorySnapshotMeta).id < (b.snap.meta as HistorySnapshotMeta).id ? 1 : -1);
  });

  const blobs: Record<string, HistoryImageData> = {}, missing: string[] = [], counted: Record<string, boolean> = {};
  let total = 0;
  const dropped: typeof all = [];
  for (let i = 0; i < all.length; i++) {
    const snap = (all[i] as typeof all[number]).snap;
    const fresh = historyRefsInJson(snap.stateJson).filter(function (sha) { return !counted[sha]; });
    const gone = fresh.length ? await ensureBytes(fresh) : [];
    const add: Record<string, HistoryImageData> = {}, addMissing: string[] = [];
    let cost = historyUtf8Length(snap.stateJson);
    fresh.forEach(function (sha) {
      const url = gone.indexOf(sha) === -1 ? dataUrlForSync(sha) : null;
      const rec = url ? recordFor(sha) : null;
      if (!url || !rec) { addMissing.push(sha); return; }
      add[sha] = { mime: rec.mime, b64: url.slice(url.indexOf(",") + 1) };
      cost += historyBlobCost(sha, add[sha] as HistoryImageData);
    });
    if (total > 0 && total + cost > cap) {
      dropped.push(all[i] as typeof all[number]);
      continue;
    }
    total += cost;
    Object.keys(add).forEach(function (sha) { blobs[sha] = add[sha] as HistoryImageData; counted[sha] = true; });
    addMissing.forEach(function (sha) { missing.push(sha); counted[sha] = true; });
  }
  dropped.forEach(function (x) {
    const at = x.owner.indexOf(x.snap);
    if (at !== -1) x.owner.splice(at, 1);
  });
  if (dropped.length) out.truncated = true;
  out.blobs = blobs;
  out.missingBlobs = missing;
  return out;
}

const HISTORY_IMPORT_BATCH = 25;
const HISTORY_IMPORT_BLOB_MAX_BYTES = 16 * 1024 * 1024;
const HISTORY_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function historyDecodeBase64(b64: unknown) {
  if (typeof b64 !== "string" || !HISTORY_BASE64_RE.test(b64)) return null;
  let bin;
  try { bin = ports.decodeBase64(b64); } catch (e) { return null; }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function historyImportRefs(docs: unknown, older: unknown) {
  const refs: Record<string, boolean> = {};
  function scan(list: unknown) {
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

function historyVerifyBlob(sha: string, entry: unknown) {
  if (!isSha256Hex(sha)) return { reason: "not-a-sha" };
  if (!entry || typeof entry !== "object" || typeof (entry as { b64?: unknown }).b64 !== "string") return { reason: "malformed" };
  if ((entry as { b64: string }).b64.length > Math.ceil(HISTORY_IMPORT_BLOB_MAX_BYTES / 3) * 4) return { reason: "too-large" };
  const bytes = historyDecodeBase64((entry as { b64: string }).b64);
  if (!bytes || !bytes.length) return { reason: "bad-base64" };
  if (bytes.length > HISTORY_IMPORT_BLOB_MAX_BYTES) return { reason: "too-large" };
  if (!sniffImageMime(bytes) || !imageDims(bytes)) return { reason: "not-an-image" };
  if (sha256Bytes(bytes) !== sha) return { reason: "hash-mismatch" };
  return { bytes: bytes };
}

async function historyImportBlobs(blobs: unknown, refs: Record<string, boolean>) {
  const out: HistoryImportResult["blobs"] = { stored: 0, refused: [], failed: [], ignored: 0 };
  if (!blobs || typeof blobs !== "object" || Array.isArray(blobs)) return out;
  const keys = Object.keys(blobs);
  const ready: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    if (isSha256Hex(key) && !Object.prototype.hasOwnProperty.call(refs, key)) { out.ignored++; continue; }
    const v = historyVerifyBlob(key, (blobs as Record<string, unknown>)[key]);
    if (!v.bytes) {
      out.refused.push(String(key).slice(0, 64));
      if (ports.logger) ports.logger.warn("Import app data: image " + String(key).slice(0, 64) + " refused (" + v.reason + ")");
      continue;
    }
    const rec = intern(v.bytes);
    if (!rec || rec.sha256 !== key) { out.refused.push(key); continue; }
    ready.push(key);
    await historyImportYield();
  }
  if (ready.length) {
    out.failed = await persist(ready);
    out.stored = ready.length - out.failed.length;
    if (out.failed.length && ports.logger) ports.logger.warn("Import app data: the image store did not take", out.failed);
  }
  return out;
}

function historyImportYield() {
  return ports.yield();
}

function historyImportIsQuota(code: unknown) {
  return code === "quota" || code === "enospc";
}

function historyImportEntries(list: unknown, counts: Pick<HistoryImportCounts, "failed" | "skipped">) {
  const out: HistorySnapshotRead[] = [], seen: Record<string, boolean> = {};
  (Array.isArray(list) ? list : []).forEach(function (s) {
    const meta: HistorySnapshotMeta | null = (s && typeof s === "object") ? sanitizeHistoryMeta(s.meta) : null;
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

function historyImportByAtAscending(a: HistorySnapshotRead, b: HistorySnapshotRead) {
  return (a.meta.atMs - b.meta.atMs) || (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0);
}

async function importHistoryBundle(bundle: unknown) {
  const result: HistoryImportCounts = { docs: 0, added: 0, skipped: 0, failed: 0, older: 0, capped: 0,
                 blobs: { stored: 0, refused: [], failed: [], ignored: 0 } };
  try {
    bundle = (bundle && typeof bundle === "object") ? bundle : {};
    const docs = (Array.isArray((bundle as { docs?: unknown }).docs) ? (bundle as { docs?: unknown }).docs : []) as { docId?: unknown; title?: unknown; snapshots?: unknown }[];
    let stopped = false;

    if ((bundle as { blobs?: unknown }).blobs) result.blobs = await historyImportBlobs((bundle as { blobs?: unknown }).blobs, historyImportRefs(docs, (bundle as { older?: unknown }).older));

    for (let d = 0; d < docs.length; d++) {
      const doc = docs[d];
      const snaps = (doc && typeof doc === "object" && Array.isArray(doc.snapshots)) ? doc.snapshots : [];
      const docId = normalizeDocId(doc && doc.docId);
      if (!docId) { result.failed += snaps.length; continue; }

      const entries = historyImportEntries(snaps, result);
      if (!entries.length) continue;
      if (stopped) { result.failed += entries.length; continue; }

      const existing = await enqueueHistory(function (id) {
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

      const have: Record<string, boolean> = {};
      existing.forEach(function (m) { if (m && typeof m.id === "string") have[m.id] = true; });
      const fresh = entries.filter(function (e) {
        if (have[e.meta.id]) { result.skipped++; return false; }
        return true;
      });
      const pool = existing.map(function (m): HistoryImportCandidate {
        return { atMs: Number(m.atMs) || 0, id: String(m.id), entry: null };
      }).concat(fresh.map(function (e) {
        return { atMs: e.meta.atMs, id: e.meta.id, entry: e };
      }));
      pool.sort(function (a, b) { return (b.atMs - a.atMs) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0); });
      const keep = pool.slice(0, HISTORY_PER_DOC).filter(function (p) { return p.entry; }).map(function (p) { return p.entry as HistorySnapshotRead; });
      const capped = fresh.length - keep.length;
      result.skipped += capped;
      result.capped += capped;
      keep.sort(historyImportByAtAscending);

      let docAdded = 0;
      let processed = 0;
      for (let start = 0; start < keep.length && !stopped; start += HISTORY_IMPORT_BATCH) {
        if (start > 0) await historyImportYield();
        const batch = keep.slice(start, start + HISTORY_IMPORT_BATCH);
        const progress = { done: 0, added: 0, skipped: 0, failed: 0, quota: false };
        await enqueueHistory(function (id, batch, progress) {
          return function () {
            return resolveHistoryBackend().then(function (backend) {
              function next(): Promise<null> | null {
                if (progress.done >= batch.length) return null;
                const e = batch[progress.done] as HistorySnapshotRead;
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
        const titleForTouch = existing.length ? "" : historyClip((doc as NonNullable<typeof doc>).title, 300);
        await enqueueHistory(function (id, t) {
          return function () {
            return resolveHistoryBackend().then(function (backend) { return backend.touch(id, t); });
          };
        }(docId, titleForTouch), null);
      }
    }

    const olderEntries = historyImportEntries((bundle as { older?: unknown }).older, result);
    if (olderEntries.length) {
      if (stopped) {
        result.failed += olderEntries.length;
      } else {
        let r = await enqueueHistory(function () {
          return resolveHistoryBackend().then(function (backend) { return backend.importOlder(olderEntries); });
        }, function () { return { ok: false, added: 0, code: "io" }; });
        r = r || { ok: false, added: 0, code: "io" };
        const added = Math.max(0, Math.min(olderEntries.length, Number(r.added) || 0));
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
    if (ports.logger) ports.logger.error(e);
    if (!result.code) result.code = "io";
  }
  historyChanged();
  return result;
}

function historyLegacyRaw() {
  return legacySnapshots().readRaw();
}

function normalizeLegacySnapshots(raw: unknown) {
  if (typeof raw !== "string") return null;
  let list;
  try { list = JSON.parse(raw); } catch (e) { return null; }
  if (!Array.isArray(list)) return null;
  const out: HistorySnapshotRead[] = [], seen: Record<string, boolean> = {};
  list.forEach(function (e) {
    if (!e || typeof e !== "object" || !e.state || typeof e.state !== "object") return;
    let stateJson;
    try { stateJson = JSON.stringify(e.state); } catch (x) { return; }
    if (typeof stateJson !== "string") return;
    const at: string = typeof e.at === "string" ? e.at : "";
    const label: string = typeof e.label === "string" ? e.label : "";
    const rawId = String(e.id == null ? "" : e.id);
    const id = HISTORY_SNAP_ID_RE.test(rawId) ? rawId : "l" + checksumText(rawId) + checksumText(at + "|" + label);
    if (seen[id]) return;
    seen[id] = true;
    let atMs = Date.parse(at);
    if (!isFinite(atMs)) atMs = 0;
    const meta: HistorySnapshotMeta | null = sanitizeHistoryMeta({
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

let historyMigrationPromise: Promise<HistoryMigrationResult> | null = null;

function startHistoryMigration() {
  if (historyMigrationPromise) return historyMigrationPromise;
  const p = runHistoryMigration().then(null, function (e) {
    if (ports.logger) ports.logger.error(e);
    return { migrated: 0, removedKey: false };
  }).then(function (r) {
    if (historyMigrationPromise === p) historyMigrationPromise = null;
    return r;
  });
  historyMigrationPromise = p;
  return p;
}

function runHistoryMigration() {
  const result = { migrated: 0, removedKey: false };
  return resolveHistoryBackend().then(function (backend) {
    if (backend.name === "memory") return result;
    if (historyLegacyRaw() == null) return result;
    let loops = 0;
    const expirySweep = typeof backend.evict === "function"
      ? enqueueHistory(function () { return backend.evict(Infinity); }, null)
      : Promise.resolve();
    function loop(): HistoryMigrationResult | Promise<HistoryMigrationResult> {
      if (loops++ >= HISTORY_MIGRATION_LOOPS) return result;
      const raw = historyLegacyRaw();
      if (raw == null) return result;
      const entries = normalizeLegacySnapshots(raw);
      if (!entries) return result;
      return enqueueHistory(function () {
        return backend.importOlder(entries as HistorySnapshotRead[]);
      }, { ok: false }).then(function (r) {
        if (!r || !r.ok) return result;
        result.migrated += (r as { added?: number }).added || 0;
        return backend.list(null).then(function (listed) {
          const have: Record<string, boolean> = {};
          ((listed as NonNullable<typeof listed>).older || []).forEach(function (m) { have[m.id] = true; });
          const confirmed = (entries as HistorySnapshotRead[]).every(function (e) { return have[e.meta.id]; });
          if (!confirmed) return result;
          if (historyLegacyRaw() !== raw) return loop();
          if (legacySnapshots().remove()) result.removedKey = true;
          historyChanged();
          return result;
        });
      });
    }
    return expirySweep.then(loop);
  });
}

  historyChain = Promise.resolve();
  const extensions = instrumentation ? instrumentation.controls({
    storage, resolve: resolveHistoryBackend, idle: historyIdle, now: ports.now,
    localEntries: historyLocalEntries, retry: retryPendingSnapshots,
    read: getHistorySnapshot, migrate: startHistoryMigration, importBundle: importHistoryBundle,
    get lastAt() { return historyLastAtMs; }, set lastAt(value) { historyLastAtMs = value; },
    get local() { return historyLocal; }, set local(value) { historyLocal = value; },
    get warned() { return historyWarnedDocs; }, set warned(value) { historyWarnedDocs = value; },
    get retryQueued() { return historyRetryQueued; }, set retryQueued(value) { historyRetryQueued = value; },
    get protected() { return historyProtected; }, set protected(value) { historyProtected = value; }
  }) : null;
  const pending = new Set<PromiseLike<unknown>>();
  function guarded<A extends unknown[], R>(fn: (...args: A) => R) {
    return function (...args: A) {
      if (!active) throw new Error("The version history is not started yet");
      const result = fn(...args);
      const promise = (result && (result as { done?: unknown }).done ? (result as { done?: unknown }).done : result) as PromiseLike<unknown> | null;
      if (promise && typeof promise.then === "function") {
        pending.add(promise);
        promise.then(function () { pending.delete(promise as PromiseLike<unknown>); }, function () { pending.delete(promise as PromiseLike<unknown>); });
      }
      return result;
    };
  }
  const api: HistoryOwnerApi & Partial<{ extensions: typeof extensions; dispose: () => Promise<void> | undefined }> = { protectHistorySnapshot, isPristineSeedDocument, onHistoryChange, captureSnapshot, listDocHistory, getHistorySnapshot, historyDocumentChanged, copyHistory, exportHistoryAll, importHistoryBundle, normalizeLegacySnapshots, startHistoryMigration };
  Object.keys(api).forEach(function (key) { (api as unknown as Record<string, HistoryCallable>)[key] = guarded((api as unknown as Record<string, HistoryCallable>)[key] as HistoryCallable); });
  if (extensions) Object.keys(extensions).forEach(function (key) { (extensions as unknown as Record<string, HistoryCallable>)[key] = guarded((extensions as unknown as Record<string, HistoryCallable>)[key] as HistoryCallable); });
  api.extensions = extensions;
  api.dispose = function () {
    if (!active) return;
    active = false;
    historyChangeListeners = [];
    return Promise.allSettled(Array.from(pending)).then(historyIdle).then(function () { return storage.close(); });
  };
  return api as HistoryOwnerApi & { extensions: typeof extensions; dispose: () => Promise<void> | undefined };
}

export function createHistoryOwner(factory?: () => HistoryInstrumentation): HistoryOwner {
  const instrumentation = factory?.();
  let started: ReturnType<typeof startHistory> | null = null;
  function running() {
    if (!started) throw new Error("The version history is not started yet");
    return started;
  }
  const owner: HistoryOwner = {
    startHistory: function (ports) {
      if (started) throw new Error("The version history is already started; stop it first");
      const mine = startHistory(ports, factory?.());
      started = mine;
      return function () {
        if (started !== mine) return;
        started = null;
        return mine.dispose();
      };
    },
    protectHistorySnapshot: function (...args) { return running().protectHistorySnapshot(...args); },
    isPristineSeedDocument: function (...args) { return running().isPristineSeedDocument(...args); },
    onHistoryChange: function (...args) { return running().onHistoryChange(...args); },
    captureSnapshot: function (...args) { return running().captureSnapshot(...args); },
    listDocHistory: function (...args) { return running().listDocHistory(...args); },
    getHistorySnapshot: function (...args) { return running().getHistorySnapshot(...args); },
    historyDocumentChanged: function (...args) { return running().historyDocumentChanged(...args); },
    copyHistory: function (...args) { return running().copyHistory(...args); },
    exportHistoryAll: function (...args) { return running().exportHistoryAll(...args); },
    importHistoryBundle: function (...args) { return running().importHistoryBundle(...args); },
    normalizeLegacySnapshots: function (...args) { return running().normalizeLegacySnapshots(...args); },
    startHistoryMigration: function (...args) { return running().startHistoryMigration(...args); }
  };
  return Object.assign(owner, instrumentation ? instrumentation.expose(running) : {});
}
