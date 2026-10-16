import type { CommandOutcome, Replay } from "../application/session/document-session.ts";
import type { ValidatedDocument } from "../core/document/validated.ts";
import type { StampPorts, UndoPort } from "../application/session/ports.ts";
import { absorbRemoteChange, configureUndo, noteEdit, noteRemoteChange, routeUndoReplays, trackDocument } from "../js/12a-undo.js";

export function createUndoAdapter(): UndoPort {
  return {
    adopt: function () { trackDocument(); },
    record: function () { noteEdit(); },
    absorbServer: function (doc) { noteRemoteChange(doc); },
    absorbReload: function () { absorbRemoteChange(); }
  };
}

export function watchUndoAdoption(adopted: (doc: unknown) => void): () => void {
  return configureUndo({ adopted: adopted });
}

export function followLiveDocument(): void {
  trackDocument();
}

type ReplayRunner = (replay: Replay, live: ValidatedDocument | null) => CommandOutcome;

export function routeReplays(run: ReplayRunner, stamps: StampPorts, amend: ReplayRunner): () => void {
  return routeUndoReplays(run, stamps, amend);
}
