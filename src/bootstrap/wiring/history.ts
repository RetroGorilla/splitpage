import { createHistoryBackendProbe } from "../../adapters/storage/history-backend-testing.ts";
import { createHistoryBackends } from "../../adapters/storage/history-backends.ts";
import { createHistoryOwnerInstrumentation } from "../../adapters/storage/history-owner-testing.ts";
import type { HistoryInstrumentedOwner } from "../../application/recovery/history-instrumentation.ts";
import { createHistoryOwner } from "../../application/recovery/history.ts";
import type { HistoryOwner, HistoryOwnerPorts } from "../../application/recovery/history-ports.ts";
import { exposeTestHook } from "../../features/common/test-hooks.ts";
import { historyPorts } from "./ports/history.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;
const historyTesting = typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS ? {
  owner: createHistoryOwnerInstrumentation,
  storage: (options: Parameters<typeof createHistoryBackends>[0]) => createHistoryBackends(options, createHistoryBackendProbe())
} : null;

let started: HistoryOwner | null = null;
let stop: (() => void) | null = null;

export function historyOwner(): HistoryOwner {
  if (!started) throw new Error("The version history is not started yet");
  return started;
}

export function mountHistoryOwner(ports: HistoryOwnerPorts = historyPorts(undefined, historyTesting?.storage)): HistoryOwner {
  stopHistoryOwner();
  const mine: HistoryOwner = createHistoryOwner(historyTesting?.owner);
  const dispose = mine.startHistory(ports);
  let withdrawHook: (() => void) | null = null;
  exposeTestHook("__historyTest", () => (mine as HistoryInstrumentedOwner).testControls(), (withdraw) => { withdrawHook = withdraw; });
  started = mine;
  stop = () => {
    started = null;
    withdrawHook?.();
    void dispose();
  };
  return mine;
}

export function stopHistoryOwner(): void {
  const dispose = stop;
  stop = null;
  dispose?.();
}
