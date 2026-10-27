import type { SessionMergeOwner } from "../application/session/session-merge-ports.ts";

let started: SessionMergeOwner | null = null;
let swatches: ((name: string, radioName?: string, legendClass?: string) => string) | null = null;

export function handSessionMergeTo(owner: SessionMergeOwner, chrome: { readonly personSwatchesHtml: NonNullable<typeof swatches> }): () => void {
  started = owner;
  swatches = chrome.personSwatchesHtml;
  return () => { if (started === owner) { started = null; swatches = null; } };
}

function sessionMerge(): SessionMergeOwner {
  if (!started) throw new Error("The session merge is not started yet");
  return started;
}

export const stampRow: SessionMergeOwner["stampRow"] = (row) => { sessionMerge().stampRow(row); };
export const setBaseState: SessionMergeOwner["setBaseState"] = (next, why) => sessionMerge().setBaseState(next, why);
export function personSwatchesHtml(name: string, radioName?: string, legendClass?: string): string {
  if (!swatches) throw new Error("The document chrome is not started yet");
  return swatches(name, radioName, legendClass);
}
