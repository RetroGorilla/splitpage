import type { StampPorts, UndoPort } from "../application/session/ports.ts";
import type { ReplayRunner } from "./session-bridge.ts";
import { absorbRemoteChange, adoptDocument, noteEdit, noteRemoteChange, routeUndoReplays } from "../js/12a-undo.js";

export function createUndoAdapter(): UndoPort {
  return {
    adopt: function (doc) { adoptDocument(doc); },
    record: function () { noteEdit(); },
    absorbServer: function (doc) { noteRemoteChange(doc); },
    absorbReload: function () { absorbRemoteChange(); }
  };
}

export function routeReplays(run: ReplayRunner, stamps: StampPorts, amend: ReplayRunner): () => void {
  return routeUndoReplays(run, stamps, amend);
}
