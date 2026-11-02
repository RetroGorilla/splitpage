import { historyMemoryInspection, historyIdbInspection } from "./history-inspection-testing.ts";
import { createHistoryTestFaults } from "./history-fault-queue.ts";
import { createMemoryHistoryBackend } from "../../../shared/history-store.ts";
import { createIdbHistoryBackend } from "./03c-history-idb.ts";
import type { HistoryBackendAccess, HistoryBackendProbe } from "./history-backends.ts";
import type { HistoryFaultBackend } from "./history-backend-types.ts";

export function createMemoryHistoryTestBackend(options?: { name?: string; persistent?: boolean; readOnly?: boolean; strict?: boolean; macrotask?: (callback: () => void) => void }) {
  const faults = createHistoryTestFaults();
  const counts = { exclusive: 0, put: 0, commit: 0 };
  return Object.assign(createMemoryHistoryBackend({ ...options, before: faults.before, observe: (op: keyof typeof counts) => { counts[op]++; }, extend: historyMemoryInspection }), { counts }, faults.controls) as Pick<ReturnType<typeof createIdbHistoryBackend>, "name" | "persistent" | "readOnly" | "exclusive"> & ReturnType<typeof historyMemoryInspection> & typeof faults.controls & { counts: typeof counts };
}

export function createIdbHistoryTestBackend(options?: Parameters<typeof createIdbHistoryBackend>[0]) {
  const faults = createHistoryTestFaults();
  const counts = { exclusive: 0, put: 0, commit: 0 };
  return Object.assign(createIdbHistoryBackend({ ...options, before: faults.before, observe: (op) => { counts[op]++; }, extend: historyIdbInspection }), { counts }, faults.controls);
}

export function createHistoryBackendProbe(): HistoryBackendProbe {
  let access: HistoryBackendAccess;
  let historyCapOverride: number | null = null;
  let historyDesktopTimeoutOverride: number | null = null;
  let historyForced: "idb" | "memory" | null = null;
  function historyNoop() {}
  let historyFault: string | null = null;
  let historyDelayGate: Promise<void> | null = null;
  let historyDelayRelease: (() => void) | null = null;
  let historyImportGate: Promise<void> | null = null;
  let historyImportRelease: (() => void) | null = null;
  let historyImportGateHit = false;

  function historyArmFaults(backend: HistoryFaultBackend | null) {
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
    const r = historyDelayRelease;
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
    const r = historyImportRelease;
    historyImportGate = null;
    historyImportRelease = null;
    if (r) r();
  }

  function historyDropIdb() {
    const e = access.idb;
    access.idb = null;
    const closed = e ? e.backend.close().then(historyNoop, historyNoop) : Promise.resolve();
    return closed.then(function () {
      return new Promise<void>(function (resolve) {
        let settled = false;
        function finish() { if (!settled) { settled = true; resolve(); } }
        try {
          const req = indexedDB.deleteDatabase("splitpage-history");
          req.onsuccess = finish;
          req.onerror = finish;
          req.onblocked = function () { setTimeout(finish, 3000); };
        } catch (x) { finish(); }
      });
    });
  }

  return {
    capacity: () => historyCapOverride,
    timeout: () => historyDesktopTimeoutOverride,
    choice: () => historyForced,
    write: historyPutFaultGate,
    importing: historyImportFaultGate,
    refuseImport: () => historyFault === "import-fail",
    opening: () => historyFault === "idb-open-fail" ? new Error("Injected idb-open-fail") : null,
    memory: createMemoryHistoryTestBackend,
    idb: createIdbHistoryTestBackend,
    arm: (backend) => { historyArmFaults(backend as typeof backend & HistoryFaultBackend); },
    bind: (state) => {
      access = state;
      return {
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
          access.clearEstimate();
          access.memory = null;
          access.failed = false;
          access.name = null;
          return historyDropIdb();
        },
        controls: {
          backendName: function () { return access.name; },
          forceBackend: function (name: string | null) {
            historyForced = name === "idb" || name === "memory" ? name : null;
            if (historyForced === "idb") access.failed = false;
            return access.resolve().then(function (b) { return b.name; });
          },
          setCapOverride: function (bytes: unknown) {
            historyCapOverride = (bytes == null || !isFinite(Number(bytes))) ? null : Number(bytes);
            access.clearEstimate();
            return historyCapOverride;
          },
          injectFault: function (name: string | null) {
            const known = ["idb-open-fail", "quota-once", "quota-always", "io-always", "delay-put", "delay-import", "import-fail"];
            if (name == null) {
              if (historyFault === "delay-put") releaseDelayedPut();
              if (historyFault === "delay-import") releaseDelayedImport();
              historyFault = null;
              if (access.idb) historyArmFaults(access.idb.backend as unknown as HistoryFaultBackend);
              if (access.memory) historyArmFaults(access.memory.backend as unknown as HistoryFaultBackend);
              return null;
            }
            if (name === "delay-import") historyImportGateHit = false;
            historyFault = known.indexOf(name) !== -1 ? name : null;
            if (access.idb) historyArmFaults(access.idb.backend as unknown as HistoryFaultBackend);
            if (access.memory) historyArmFaults(access.memory.backend as unknown as HistoryFaultBackend);
            if (historyFault === "idb-open-fail") {
              if (access.idb) access.idb.backend.close().then(historyNoop, historyNoop);
              access.idb = null;
              access.failed = false;
            }
            return historyFault;
          },
          releaseDelayedPut,
          releaseDelayedImport,
          importGateHit: function () { return historyImportGateHit; },
          notice: function () { const n = access.notice(); return n ? n.text : null; },
          setDesktopTimeout: function (ms: unknown) {
            historyDesktopTimeoutOverride = (ms == null || !isFinite(Number(ms))) ? null : Math.max(0, Number(ms));
            return historyDesktopTimeoutOverride;
          }
        }
      };
    }
  };
}
