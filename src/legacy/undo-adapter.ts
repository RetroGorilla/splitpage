import type { StampPorts, UndoPort } from "../application/session/ports.ts";
import type { SessionReplayRunner } from "./session-bridge.ts";
import { absorbRemoteChange, adoptDocument, noteEdit, noteRemoteChange, routeUndoReplays } from "./undo-bridge.ts";

export function createUndoAdapter(): UndoPort {
  return {
    adopt: function (doc) { adoptDocument(doc); },
    record: function () { noteEdit(); },
    absorbServer: function (doc) { noteRemoteChange(doc); },
    absorbReload: function () { absorbRemoteChange(); }
  };
}

export function routeReplays(run: SessionReplayRunner, stamps: StampPorts, amend: SessionReplayRunner): () => void {
  return routeUndoReplays(run, stamps, amend);
}
