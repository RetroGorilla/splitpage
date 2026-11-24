import type { CollaborationPictureCounts } from "../../../application/collaboration/state.ts";
import type { BlobStore } from "../../storage/blob-store.ts";
import type { sharedPictureHttp } from "./picture-http.ts";

type PictureHttp = ReturnType<typeof sharedPictureHttp>;
type PictureTransferKind = "checking" | "uploading" | "downloading";
type PendingPicture = { attempts: number; due: number; cancel: AbortController; kind: PictureTransferKind };

export function startSharedPictures(http: PictureHttp, store: Pick<BlobStore, "bytesFor" | "ensureBytes" | "intern" | "isDurable" | "persist" | "recordFor">, changed: () => void) {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const access = new AbortController();
  const authorized = AbortSignal.any([signal, access.signal]);
  const pending = new Map<string, PendingPicture>();
  const confirmed = new Set<string>();
  const rejected = new Set<string>();
  const unstored = new Set<string>();
  const countListeners = new Set<(counts: CollaborationPictureCounts) => void>();
  let lastCounts: CollaborationPictureCounts = Object.freeze({ checking: 0, uploading: 0, downloading: 0 });
  let current = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let working = false;
  let reconnectGeneration = 0;

  const available = store.isDurable;

  function computeCounts(): CollaborationPictureCounts {
    if (authorized.aborted) return Object.freeze({ checking: 0, uploading: 0, downloading: 0 });
    let checking = 0, uploading = 0, downloading = 0;
    for (const item of pending.values()) {
      if (item.kind === "checking") checking++;
      else if (item.kind === "uploading") uploading++;
      else downloading++;
    }
    return Object.freeze({ checking, uploading, downloading });
  }

  function emitCounts(): void {
    const next = computeCounts();
    if (next.checking === lastCounts.checking && next.uploading === lastCounts.uploading && next.downloading === lastCounts.downloading) return;
    lastCounts = next;
    for (const listener of [...countListeners]) {
      try {
        listener(next);
      } catch {
        continue;
      }
    }
  }

  function initialKind(sha: string): PictureTransferKind {
    if (store.bytesFor(sha) && store.recordFor(sha) && available(sha)) return "uploading";
    return "checking";
  }

  function setItemKind(sha: string, kind: PictureTransferKind): void {
    const item = pending.get(sha);
    if (!item || item.kind === kind) return;
    item.kind = kind;
    emitCounts();
  }

  async function storePicture(sha: string, requestSignal: AbortSignal) {
    await store.persist([sha]);
    if (requestSignal.aborted) return;
    if (available(sha)) unstored.delete(sha);
    else unstored.add(sha);
  }

  async function download(sha: string, requestSignal: AbortSignal = authorized) {
    if (requestSignal.aborted) return;
    setItemKind(sha, "downloading");
    const bytes = await http.download(sha, requestSignal).catch(() => "retry" as const);
    if (requestSignal.aborted) return;
    if (bytes === "access") {
      access.abort();
      emitCounts();
      changed();
    }
    if (bytes === "rejected" && current.has(sha)) {
      rejected.add(sha);
      pending.get(sha)?.cancel.abort();
      pending.delete(sha);
      emitCounts();
      changed();
    }
    if (!(bytes instanceof Uint8Array)) return;
    store.intern(bytes);
    setItemKind(sha, "checking");
    await storePicture(sha, requestSignal);
    if (!requestSignal.aborted) {
      confirmed.add(sha);
      if (available(sha)) {
        pending.delete(sha);
        emitCounts();
      }
      changed();
    }
  }

  async function process(sha: string, requestSignal: AbortSignal) {
    await store.ensureBytes([sha]);
    if (requestSignal.aborted) return;
    const local = store.bytesFor(sha);
    const record = store.recordFor(sha);
    if (!local || !record) {
      await download(sha, requestSignal);
      return;
    }
    if (!available(sha)) {
      setItemKind(sha, "checking");
      await storePicture(sha, requestSignal);
      if (requestSignal.aborted) return;
      if (!available(sha)) changed();
    }
    if (available(sha)) changed();
    if (confirmed.has(sha) || !available(sha)) return;
    setItemKind(sha, "uploading");
    const outcome = await http.upload(sha, local, record.mime, requestSignal).catch(() => "retry" as const);
    if (requestSignal.aborted) return;
    if (outcome === "access") {
      access.abort();
      emitCounts();
      changed();
    }
    if (outcome === "stored" || outcome === "rejected") confirmed.add(sha);
  }

  function schedule() {
    clearTimeout(timer);
    if (working || authorized.aborted) return;
    let next = Infinity;
    for (const item of pending.values()) next = Math.min(next, item.due);
    if (Number.isFinite(next)) timer = setTimeout(() => { void run(); }, Math.max(0, next - Date.now()));
  }

  async function run() {
    const entry = [...pending].find(([, item]) => item.due <= Date.now());
    if (!entry) return schedule();
    const [sha, item] = entry;
    const generation = reconnectGeneration;
    working = true;
    try {
      await process(sha, AbortSignal.any([authorized, item.cancel.signal]));
    } finally {
      if (confirmed.has(sha) && available(sha) && pending.get(sha) === item) pending.delete(sha);
      emitCounts();
      const backoff = Math.min(30_000, 500 * 2 ** item.attempts++);
      if (generation === reconnectGeneration) item.due = Date.now() + backoff;
      working = false;
      schedule();
    }
  }

  return {
    track(refs: readonly string[]) {
      current = new Set(refs);
      for (const sha of confirmed) if (!current.has(sha)) confirmed.delete(sha);
      for (const sha of rejected) if (!current.has(sha)) rejected.delete(sha);
      for (const sha of unstored) if (!current.has(sha)) unstored.delete(sha);
      for (const [sha, item] of pending) {
        if (current.has(sha)) continue;
        item.cancel.abort();
        pending.delete(sha);
      }
      for (const sha of current) {
        if (!pending.has(sha) && !rejected.has(sha) && !(confirmed.has(sha) && available(sha))) {
          pending.set(sha, { attempts: 0, due: 0, cancel: new AbortController(), kind: initialKind(sha) });
        }
      }
      emitCounts();
      schedule();
    },
    counts: () => lastCounts,
    subscribeCounts(listener: (counts: CollaborationPictureCounts) => void) {
      countListeners.add(listener);
      return () => { countListeners.delete(listener); };
    },
    ready: (refs: readonly string[]) => refs.every(available),
    refused: () => access.signal.aborted,
    rejected: (refs: readonly string[]) => refs.some(sha => rejected.has(sha) && !available(sha)),
    storageFailed: (refs: readonly string[]) => refs.some(sha => unstored.has(sha) && !available(sha)),
    async prepareExport(hashes: readonly string[]) {
      const missing = await store.ensureBytes(hashes);
      const requestSignal = AbortSignal.any([authorized, AbortSignal.timeout(5_000)]);
      for (const sha of missing) {
        if (requestSignal.aborted) return;
        if (!store.bytesFor(sha) && !rejected.has(sha)) await download(sha, requestSignal);
      }
    },
    reconnect() {
      reconnectGeneration++;
      for (const item of pending.values()) item.due = 0;
      schedule();
    },
    stop() {
      lifetime.abort();
      clearTimeout(timer);
      pending.clear();
      emitCounts();
      countListeners.clear();
    }
  };
}
