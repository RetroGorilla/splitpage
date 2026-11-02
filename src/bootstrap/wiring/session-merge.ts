import { createSessionMergeOwner } from "../../application/session/session-merge.ts";
import type { SessionMergeOwner, SessionMergeOwnerPorts, SessionMergePorts } from "../../application/session/session-merge-ports.ts";
import type { DocumentDestination, DestinationPort, HistoryPort } from "../../application/transitions/ports.ts";
import { sessionMergeOwnerPorts } from "./ports/session-merge.ts";
import { mountHistoryPanelFeature, historyPanelControls, stopHistoryPanelFeature } from "./history-panel.ts";
import { mountTitleChromeFeature, stopTitleChromeFeature } from "./title-chrome.ts";

let started: SessionMergeOwner | null = null;
let stop: (() => void) | null = null;

export function sessionMergeOwner(): SessionMergeOwner {
  if (!started) throw new Error("The session merge is not started yet");
  return started;
}

export function mountSessionMergeOwner(ports: SessionMergeOwnerPorts = sessionMergeOwnerPorts((snapshot, request) => { historyPanelControls().restored(snapshot, request); })): SessionMergeOwner {
  stopSessionMergeOwner();
  const mine: SessionMergeOwner = createSessionMergeOwner();
  const dispose = mine.startSessionMerge(ports);
  started = mine;
  mountHistoryPanelFeature(mine);
  mountTitleChromeFeature();
  stop = () => { stopTitleChromeFeature(); stopHistoryPanelFeature(); started = null; dispose(); };
  return mine;
}

export function stopSessionMergeOwner(): void {
  const dispose = stop;
  stop = null;
  dispose?.();
}

export const stampRow: SessionMergeOwner["stampRow"] = (row) => { sessionMergeOwner().stampRow(row); };
export const setBaseState: SessionMergeOwner["setBaseState"] = (next, why) => sessionMergeOwner().setBaseState(next, why);
export const baseStateReason = (): string => sessionMergeOwner().baseStateReason();
export const textMergeContext: SessionMergeOwner["textMergeContext"] = (...args) => sessionMergeOwner().textMergeContext(...args);
export const restoreMergeSnapshot: SessionMergeOwner["restoreMergeSnapshot"] = (...args) => sessionMergeOwner().restoreMergeSnapshot(...args);

export const documentDestinationPort: DestinationPort<DocumentDestination> = Object.freeze({
  set: (destination: DocumentDestination) => { sessionMergeOwner().documentDestinationPort.set(destination); },
  confirm: (baseline: Parameters<DestinationPort<DocumentDestination>["confirm"]>[0], why: string) => { sessionMergeOwner().documentDestinationPort.confirm(baseline, why); }
});
export const documentHistoryPort: HistoryPort = Object.freeze({ keep: (...[label, doc]: Parameters<HistoryPort["keep"]>) => sessionMergeOwner().documentHistoryPort.keep(label, doc) });

export function sessionMergePorts(): SessionMergePorts {
  return {
    states: (...args) => sessionMergeOwner().sessionMergePorts().states(...args),
    entry: (...args) => sessionMergeOwner().sessionMergePorts().entry(...args),
    isDocument: (...args) => sessionMergeOwner().sessionMergePorts().isDocument(...args),
    snapshot: (...args) => sessionMergeOwner().sessionMergePorts().snapshot(...args),
    current: (...args) => sessionMergeOwner().sessionMergePorts().current(...args),
    adopt: (...args) => sessionMergeOwner().sessionMergePorts().adopt(...args),
    documentId: (...args) => sessionMergeOwner().sessionMergePorts().documentId(...args),
    noteHistoryFrom: (...args) => sessionMergeOwner().sessionMergePorts().noteHistoryFrom(...args),
    armUndo: (...args) => sessionMergeOwner().sessionMergePorts().armUndo(...args),
    setBase: (...args) => sessionMergeOwner().sessionMergePorts().setBase(...args),
    capture: (...args) => sessionMergeOwner().sessionMergePorts().capture(...args),
    stillOwns: (...args) => sessionMergeOwner().sessionMergePorts().stillOwns(...args)
  };
}
