import type { HistoryOwner } from "../application/recovery/history-ports.ts";

let started: HistoryOwner | null = null;

export function handHistoryTo(owner: HistoryOwner): () => void {
  started = owner;
  return () => { if (started === owner) started = null; };
}

function history(): HistoryOwner {
  if (!started) throw new Error("The version history is not started yet");
  return started;
}

export function captureSnapshot(...args: Parameters<HistoryOwner["captureSnapshot"]>): ReturnType<HistoryOwner["captureSnapshot"]> {
  return history().captureSnapshot(...args);
}
export function listDocHistory(...args: Parameters<HistoryOwner["listDocHistory"]>): ReturnType<HistoryOwner["listDocHistory"]> {
  return history().listDocHistory(...args);
}
export function getHistorySnapshot(...args: Parameters<HistoryOwner["getHistorySnapshot"]>): ReturnType<HistoryOwner["getHistorySnapshot"]> {
  return history().getHistorySnapshot(...args);
}
export function protectHistorySnapshot(...args: Parameters<HistoryOwner["protectHistorySnapshot"]>): ReturnType<HistoryOwner["protectHistorySnapshot"]> {
  return history().protectHistorySnapshot(...args);
}
export function copyHistory(...args: Parameters<HistoryOwner["copyHistory"]>): ReturnType<HistoryOwner["copyHistory"]> {
  return history().copyHistory(...args);
}
export function historyDocumentChanged(): void { history().historyDocumentChanged(); }
