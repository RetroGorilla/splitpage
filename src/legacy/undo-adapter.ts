import type { UndoPort } from "../application/session/ports.ts";
import { absorbRemoteChange, configureUndo, noteEdit, noteRemoteChange, trackDocument } from "../js/12a-undo.js";

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
