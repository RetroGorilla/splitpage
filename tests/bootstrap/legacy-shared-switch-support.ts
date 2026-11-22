import { createSharedDocument, destroySharedDocument } from "../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../src/adapters/collab/hydrate.ts";
import { registerSharedOperationFamilies } from "../../src/adapters/collab/operation-families.ts";
import { createSharedReplica } from "../../src/adapters/collab/replica.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import { sharedUndoActions } from "../../src/application/editing/undo/shared-undo-actions.ts";
import { sharedAuthorPort } from "../collab/editor-ports/shared-author.ts";
import { sharedUndoOwner } from "../collab/editor-ports/shared-undo.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { currentDocument } from "../../src/bootstrap/wiring/session-owner.ts";
import { enterSharedSession } from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedEditorBackend, SharedSessionParts, SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";

// why: a destroy listener that throws stops Yjs before it drops its observers; a second attempt finishes the job
function destroy(attempt: (step: () => void) => boolean, handle: SharedDocumentHandle): void {
  if (!attempt(() => { destroySharedDocument(handle); })) attempt(() => { destroySharedDocument(handle); });
}

function openLegacyBackend(ports: SharedSwitchPorts, hydration: ValidatedDocument, attempt: (step: () => void) => boolean): SharedEditorBackend {
  const handle = createSharedDocument();
  let on = true, parts: SharedSessionParts | null = null;
  const author = sharedAuthorPort({ handle: () => on ? handle : null, name: ports.editor });
  try {
    registerSharedOperationFamilies(handle, ports.structure);
    const undo = sharedUndoOwner(handle, () => author.next(), ports.now, ports.report);
    const replica = createSharedReplica(handle, undefined, undo);
    return {
      replica,
      get parts() { return parts; },
      undo: admission => ({ actions: sharedUndoActions(admission, undo), breakGroup: undo.breakGroup, replayed: undo.replayed }),
      bind: session => { parts ??= { handle, session, undo, author }; ports.bindings.enter(parts); },
      unbind: () => ports.bindings.leave(),
      settle: () => ports.bindings.settle(),
      abandon: () => { ports.bindings.abandon?.(); },
      drop: () => { ports.bindings.drop?.(); },
      start: () => (ports.hydrate ?? hydrateSharedDocument)(handle, hydration),
      landing: currentDocument,
      live: value => { on = value; },
      dispose: attempt => {
        attempt(() => { replica.dispose(); });
        destroy(attempt, handle);
      }
    };
  } catch (error) {
    destroy(attempt, handle);
    throw error;
  }
}

export function enterLegacySharedSession(ports: SharedSwitchPorts) {
  return enterSharedSession(ports, (doc, _failed, attempt) => openLegacyBackend(ports, doc, attempt));
}
