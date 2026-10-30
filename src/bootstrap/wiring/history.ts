import { createHistoryOwner } from "../../application/recovery/history.js";
import type { HistoryOwner, HistoryOwnerPorts } from "../../application/recovery/history-ports.ts";
import { exposeTestHook } from "../../features/common/test-hooks.ts";
import { historyPorts } from "./ports/history.ts";

let started: HistoryOwner | null = null;
let stop: (() => void) | null = null;

export function historyOwner(): HistoryOwner {
  if (!started) throw new Error("The version history is not started yet");
  return started;
}

export function mountHistoryOwner(ports: HistoryOwnerPorts = historyPorts()): HistoryOwner {
  stopHistoryOwner();
  const mine: HistoryOwner = createHistoryOwner();
  const dispose = mine.startHistory(ports);
  let withdrawHook: (() => void) | null = null;
  exposeTestHook("__historyTest", () => mine.testControls(), (withdraw) => { withdrawHook = withdraw; });
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
