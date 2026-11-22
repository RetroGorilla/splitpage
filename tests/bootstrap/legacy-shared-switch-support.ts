import { createSharedDocument, destroySharedDocument } from "../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../src/adapters/collab/hydrate.ts";
import { registerSharedOperationFamilies } from "../../src/adapters/collab/operation-families.ts";
import { createSharedReplica } from "../../src/adapters/collab/replica.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import { sharedUndoActions } from "../../src/application/editing/undo/shared-undo-actions.ts";
import { sharedAuthorPort } from "../collab/editor-ports/shared-author.ts";
import { sharedUndoOwner } from "../collab/editor-ports/shared-undo.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import type { SharedStructureContentPorts } from "../../src/adapters/collab/structure-content.ts";
import { fromHtml } from "../../src/bootstrap/richtext.ts";
import { currentDocument, sharedRecoverySession } from "../../src/bootstrap/wiring/session-owner.ts";
import { enterSharedSession } from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedEditorBackend, SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";

import type { SharedUndo } from "../../src/application/editing/undo/shared-undo.ts";
import type { SharedDocumentSession } from "../../src/application/session/shared-session.ts";

export interface SharedAuthorPort {
  readonly next: () => { readonly id: string; readonly by: string } | null;
}

export interface SharedSessionParts {
  readonly handle: SharedDocumentHandle;
  readonly session: SharedDocumentSession;
  readonly undo: SharedUndo;
  readonly author: SharedAuthorPort;
}

export interface SharedBindings {
  readonly enter: (parts: SharedSessionParts) => void;
  readonly settle: () => string | null;
  readonly leave: () => void;
  readonly abandon?: () => void;
  readonly drop?: () => void;
}

const partsBySession = new WeakMap<object, SharedSessionParts>();

export function legacySessionParts(): SharedSessionParts | null {
  const session = sharedRecoverySession();
  return session ? partsBySession.get(session) ?? null : null;
}

export interface LegacySharedSwitchPorts extends SharedSwitchPorts {
  readonly bindings: SharedBindings;
  readonly structure: SharedStructureContentPorts;
  readonly hydrate?: (handle: SharedDocumentHandle, migrated: ValidatedDocument) => void;
}

export function withLegacySwitchPorts(ports: SharedSwitchPorts): LegacySharedSwitchPorts {
  return { ...ports, bindings: { enter: () => {}, settle: () => null, leave: () => {} }, structure: { cells: fromHtml } };
}

// why: a destroy listener that throws stops Yjs before it drops its observers; a second attempt finishes the job
function destroy(attempt: (step: () => void) => boolean, handle: SharedDocumentHandle): void {
  if (!attempt(() => { destroySharedDocument(handle); })) attempt(() => { destroySharedDocument(handle); });
}

function openLegacyBackend(ports: LegacySharedSwitchPorts, hydration: ValidatedDocument, attempt: (step: () => void) => boolean): SharedEditorBackend {
  const handle = createSharedDocument();
  let on = true, parts: SharedSessionParts | null = null;
  const author = sharedAuthorPort({ handle: () => on ? handle : null, name: ports.editor });
  try {
    registerSharedOperationFamilies(handle, ports.structure);
    const undo = sharedUndoOwner(handle, () => author.next(), ports.now, ports.report);
    const replica = createSharedReplica(handle, undefined, undo);
    return {
      replica,
      undo: admission => ({ actions: sharedUndoActions(admission, undo), breakGroup: undo.breakGroup }),
      bind: session => { parts ??= { handle, session, undo, author }; partsBySession.set(session, parts); ports.bindings.enter(parts); },
      unbind: () => ports.bindings.leave(),
      settle: () => ports.bindings.settle(),
      abandon: () => { ports.bindings.abandon?.(); },
      drop: () => { ports.bindings.drop?.(); },
      start: () => (ports.hydrate ?? hydrateSharedDocument)(handle, hydration),
      landing: currentDocument,
      live: value => { on = value; },
      dispose: attempt => {
        if (parts) partsBySession.delete(parts.session);
        attempt(() => { replica.dispose(); });
        destroy(attempt, handle);
      }
    };
  } catch (error) {
    destroy(attempt, handle);
    throw error;
  }
}

export function enterLegacySharedSession(ports: LegacySharedSwitchPorts) {
  return enterSharedSession(ports, (doc, _failed, attempt) => openLegacyBackend(ports, doc, attempt));
}
