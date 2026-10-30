import { createHistoryOwner } from "../../application/recovery/history.js";
import type { HistoryOwner, HistoryOwnerPorts } from "../../application/recovery/history-ports.ts";
import { exposeTestHook, withdrawTestHook } from "../../features/common/test-hooks.ts";
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
  exposeTestHook("__historyTest", mine, () => mine.testControls());
  started = mine;
  stop = () => {
    started = null;
    withdrawTestHook("__historyTest", mine);
    void dispose();
  };
  return mine;
}

export function stopHistoryOwner(): void {
  const dispose = stop;
  stop = null;
  dispose?.();
}
