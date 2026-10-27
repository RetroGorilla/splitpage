import { createHistoryOwner } from "../../application/recovery/history.js";
import type { HistoryOwner, HistoryOwnerPorts } from "../../application/recovery/history-ports.ts";
import { handHistoryTo } from "../../legacy/history-bridge.ts";
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
  const disconnect = handHistoryTo(mine);
  const hooks: unknown = mine.testControls();
  Object.assign(window, { __historyTest: hooks });
  started = mine;
  stop = () => {
    disconnect();
    started = null;
    if ((window as Window & { __historyTest?: unknown }).__historyTest === hooks) delete (window as Window & { __historyTest?: unknown }).__historyTest;
    void dispose();
  };
  return mine;
}

export function stopHistoryOwner(): void {
  const dispose = stop;
  stop = null;
  dispose?.();
}
