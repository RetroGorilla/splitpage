import type { SessionChange } from "../../application/session/change-set.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { edits as portEdits } from "./ports/editing.ts";
import { text as portText } from "./ports/text.ts";
import { createBeatStatus } from "../../features/rows/beat-status.ts";
import type { BeatStatus } from "../../features/rows/beat-status.ts";
import { owned } from "../../features/routing/owned.ts";
import { viewFlags } from "./preferences-owner.ts";
import { shotHiding } from "./shot-hiding.ts";

type BeatStatusMount = BeatStatus & { readonly dispose: () => void };

const beatStatus = owned<BeatStatusMount>();

export function mountBeatStatusFeature(): BeatStatusMount {
  return beatStatus.replace(() => {
    const status = createBeatStatus({
      document: portDocument,
      edits: portEdits,
      text: portText,
      hideShot: () => viewFlags().hideShot(),
      shots: {
        armGrace: (rowId) => { shotHiding().armGrace(rowId); },
        clearGrace: (rowId) => { shotHiding().clearGrace(rowId); }
      },
      element: (id) => document.getElementById(id)
    });
    return { ...status, dispose: () => {} };
  });
}

export const stopBeatStatusFeature = beatStatus.stop;

export function updateScriptStats(): void {
  beatStatus.owner()?.updateScriptStats();
}

export function statsFollowChange(change: SessionChange): void {
  beatStatus.owner()?.statsFollowChange(change);
}

export function onScriptStats(listener: (targetSeconds: number) => void): () => void {
  const owner = beatStatus.owner();
  return owner ? owner.onScriptStats(listener) : () => {};
}

export function cycleRowStatus(rowId: string): void {
  beatStatus.owner()?.cycleRowStatus(rowId);
}
