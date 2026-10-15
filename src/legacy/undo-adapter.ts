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

export function watchUndoAdoption(adopted: (doc: unknown) => void): void {
  configureUndo({ adopted: adopted });
}

export function followLiveDocument(): void {
  trackDocument();
}

export function routeReplays(run: (replay: Replay, live: ValidatedDocument | null) => CommandOutcome, stamps: StampPorts): void {
  routeUndoReplays(run, stamps);
}
