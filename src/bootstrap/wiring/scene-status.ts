import type { SessionChange } from "../../application/session/change-set.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { edits as portEdits } from "./ports/editing.ts";
import { text as portText } from "./ports/text.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { createSceneStatus } from "../../features/rows/scene-status.ts";
import type { SceneStatus } from "../../features/rows/scene-status.ts";
import { owned } from "../../features/routing/owned.ts";
import { viewFlags } from "../../legacy/preferences-bridge.ts";
import { REVIEW_ONLY } from "../../legacy/session-bridge.ts";
import { shotHiding } from "../../legacy/shot-hiding-bridge.ts";

type SceneStatusMount = SceneStatus & { readonly dispose: () => void };

const sceneStatus = owned<SceneStatusMount>();

export function mountSceneStatusFeature(): SceneStatusMount {
  return sceneStatus.replace(() => {
    const status = createSceneStatus({
      document: portDocument,
      edits: portEdits,
      reviewRefusal: REVIEW_ONLY,
      text: portText,
      notices: portNotices,
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

export const stopSceneStatusFeature = sceneStatus.stop;

export function updateScriptStats(): void {
  sceneStatus.owner()?.updateScriptStats();
}

export function statsFollowChange(change: SessionChange): void {
  sceneStatus.owner()?.statsFollowChange(change);
}

export function onScriptStats(listener: (targetSeconds: number) => void): () => void {
  const owner = sceneStatus.owner();
  return owner ? owner.onScriptStats(listener) : () => {};
}

export function cycleRowStatus(rowId: string): void {
  sceneStatus.owner()?.cycleRowStatus(rowId);
}
