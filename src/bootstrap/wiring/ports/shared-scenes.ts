import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import { collabState } from "../../../adapters/collab/state.ts";
import type { SharedDocumentSession } from "../../../application/session/shared-session.ts";
import { sharedSceneCommand } from "../../../application/commands/shared-scenes.ts";
import type { SharedSceneCreation } from "../../../application/commands/shared-scenes.ts";
import { sharedStructureKey } from "../../../core/collab/structure-key.ts";
import { holdSharedBuffer } from "../../../adapters/collab/ingress.ts";

export function sharedSceneCreation(handle: SharedDocumentHandle, session: Pick<SharedDocumentSession, "run" | "beforeCommand">,
  author: () => { readonly id: string; readonly by: string }): SharedSceneCreation {
  return { hold: () => holdSharedBuffer(handle), beforeCommand: session.beforeCommand, create: (beat, name) => {
    const next = author(), heading = sharedStructureKey(String(collabState(handle).doc.clientID), next.id, "heading");
    if (!heading) return { heading: null, outcome: { kind: "rejected", reason: "invalid-structure-operation-id" } };
    const outcome = session.run(sharedSceneCommand(beat, name, next));
    return { heading: outcome.kind === "applied" || outcome.kind === "committed" ? heading : null, outcome };
  } };
}
