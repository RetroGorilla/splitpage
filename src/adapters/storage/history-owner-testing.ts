import { normalizeDocId } from "../../../shared/doc-id-policy.js";
import { HISTORY_OLDER_KEY } from "../../../shared/history-policy.js";
import type { HistoryInstrumentation } from "../../application/recovery/history-instrumentation.ts";
import type { HistoryResolvedBackend, HistoryTestingStorage } from "../../application/recovery/history-ports.ts";

type HistoryTestAdapter = HistoryResolvedBackend & { store: NonNullable<HistoryResolvedBackend["store"]> };

export function createHistoryOwnerInstrumentation(): HistoryInstrumentation {
  let historyNowOverride: number | null = null;
  let historyExportCapOverride: number | null = null;
  return {
    clock: (now) => historyNowOverride != null ? historyNowOverride : now(),
    capacity: (defaultCap) => historyExportCapOverride != null ? historyExportCapOverride : defaultCap,
    expose: (running) => ({ testControls: () => running().extensions as NonNullable<ReturnType<typeof running>["extensions"]> }),
    controls: (access) => {
      const storage = access.storage as HistoryTestingStorage;
function historyTestBucket(docId: unknown) {
  if (docId === HISTORY_OLDER_KEY || docId === "older") return HISTORY_OLDER_KEY;
  return normalizeDocId(docId);
}

function historyTestStore() {
  return access.resolve().then(function (b) { return b.store ? b as HistoryTestAdapter : null; });
}

function historyTestBodyCount(adapter: HistoryResolvedBackend & { store: NonNullable<HistoryResolvedBackend["store"]> }, bucket: string | null) {
  const backend = adapter.store.backend;
  if (!bucket) return Promise.resolve(backend.bodyCount());
  return adapter.store.rawIndex().then(function (index) {
    const shas: Record<string, boolean> = {};
    ((index[bucket] && index[bucket].snapshots) || []).forEach(function (s) {
      if (s && typeof s.sha === "string") shas[s.sha] = true;
    });
    return Promise.all(Object.keys(shas).map(function (sha) {
      return Promise.resolve(backend.hasBody(sha));
    })).then(function (have) { return have.filter(Boolean).length; });
  });
}


function historyResetForTest() {
  storage.prepareResetForTest();
  return access.idle().then(function () {
    historyNowOverride = null;
    access.lastAt = 0;
    access.local = {};
    access.warned = {};
    access.retryQueued = false;
    access.protected = {};
    return storage.reset();
  }).then(function () { return access.resolve(); }).then(function () { return true; });
}

  const testControls = {
    idle: access.idle,
    ...storage.controls,
    setNow: function (ms: unknown) {
      historyNowOverride = (ms == null || !isFinite(Number(ms))) ? null : Number(ms);
      access.lastAt = 0;
      return historyNowOverride != null ? historyNowOverride : access.now();
    },
    injectFault: function (name: string | null) {
      const fault = storage.controls.injectFault(name);
      if (name == null && access.localEntries(null, "pending").length) access.retry();
      return fault;
    },
    listRaw: function (docId: unknown) {
      const bucket = historyTestBucket(docId);
      if (!bucket) return Promise.resolve([]);
      return access.resolve().then(function (b) { return b.rawList ? b.rawList(bucket) : []; });
    },
    bodyCount: function (docId?: unknown) {
      const bucket = docId == null ? null : historyTestBucket(docId);
      if (docId != null && !bucket) return Promise.resolve(0);
      return historyTestStore().then(function (a) { return a ? historyTestBodyCount(a, bucket) : 0; });
    },
    docRecord: function (docId: unknown) {
      const bucket = historyTestBucket(docId);
      if (!bucket) return Promise.resolve(null);
      return access.resolve().then(function (b) { return b.rawDoc ? b.rawDoc(bucket) : null; });
    },
    rawIndex: function () {
      return historyTestStore().then(function (a) { return a ? a.store.rawIndex() : null; });
    },
    inspect: function () {
      return historyTestStore().then(function (a) { return a ? a.store.backend.inspect() : null; });
    },
    read: access.read,
    pending: function (docId?: string) {
      return access.localEntries(docId ? normalizeDocId(docId) || "-" : null, "pending").map(function (e) {
        return { docId: e.docId, id: e.meta.id, label: e.meta.label, status: e.status };
      });
    },
    migrate: access.migrate,
    resetForTest: historyResetForTest,
    importBundle: access.importBundle,
    setExportCap: function (bytes: unknown) {
      historyExportCapOverride = (bytes == null || !isFinite(Number(bytes))) ? null : Math.max(0, Number(bytes));
      return historyExportCapOverride;
    }
  };

      return testControls;
    }
  };
}
