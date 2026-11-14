import type { SharedDocumentSession } from "../../session/shared-session.ts";
import type { SharedUndo, SharedUndoOutcome } from "./shared-undo.ts";
import type { UndoDirection } from "./undo.ts";

export interface SharedUndoActions {
  readonly undo: () => SharedUndoOutcome;
  readonly redo: () => SharedUndoOutcome;
}

export function sharedUndoActions(session: Pick<SharedDocumentSession, "admit">, owner: Pick<SharedUndo, "undo" | "redo">): SharedUndoActions {
  function step(direction: UndoDirection): SharedUndoOutcome {
    const refused = session.admit();
    if (refused?.kind === "failed") throw refused.error;
    if (refused) return { ok: false, reason: refused.reason };
    return direction === "undo" ? owner.undo() : owner.redo();
  }
  return Object.freeze({ undo: () => step("undo"), redo: () => step("redo") });
}
