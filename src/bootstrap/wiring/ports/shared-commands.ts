import type { SharedCommentPorts } from "../../../application/commands/comments.ts";
import type { SharedGalleryCommands } from "../../../application/commands/gallery.ts";
import type { SharedRecordCommands } from "../../../application/commands/shared-records.ts";
import type { SharedStructureCommands } from "../../../application/commands/shared-structure.ts";
import type { SharedValueCommands } from "../../../application/commands/shared-values.ts";
import type { CommandOutcome } from "../../../application/session/document-session.ts";
import type { UndoControl } from "../../../application/editing/undo-control.ts";
import { sessionStamps, sessionTextPorts } from "../session-owner.ts";
import { sharedSessionParts } from "../shared-session.ts";
import type { SharedSessionParts } from "../shared-session.ts";
import { sharedUndoRoute, stepSharedUndo, undoOwner } from "../undo.ts";
import { notices } from "./effects.ts";
import { sharedCommandRefusalNotice } from "./shared-command-notices.ts";
import { sharedCommentPorts } from "./shared-comments.ts";
import { sharedGalleryPorts } from "./shared-gallery.ts";
import { sharedRecordPorts } from "./shared-records.ts";
import { sharedStructurePorts, sharedValuePorts } from "./shared-values.ts";

const refuse = sharedCommandRefusalNotice(notices);

function refused(outcome: CommandOutcome): void {
  if (outcome.kind === "rejected" && !outcome.notified) refuse(outcome.reason);
}

function source(parts: SharedSessionParts) {
  return { handle: () => sharedSessionParts() === parts ? parts.handle : null, author: () => parts.author.next(), stamps: sessionStamps };
}

export const sharedValueCommands: SharedValueCommands = {
  ports: () => {
    const parts = sharedSessionParts();
    return parts ? sharedValuePorts(source(parts))() : null;
  },
  refused
};

export const sharedRecordCommands: SharedRecordCommands = {
  ports: () => {
    const parts = sharedSessionParts();
    return parts ? sharedRecordPorts(source(parts)) : null;
  },
  refused
};

export const sharedGalleryCommands: SharedGalleryCommands = {
  ports: () => {
    const parts = sharedSessionParts();
    return parts ? sharedGalleryPorts(source(parts)) : null;
  },
  refused,
  done: message => { notices.show(message, "ok"); }
};

export const sharedCommentCommands: SharedRecordCommands<SharedCommentPorts> = {
  ports: () => {
    const parts = sharedSessionParts();
    return parts ? sharedCommentPorts({ ...source(parts), cells: html => sessionTextPorts.cells(html ?? "") })() : null;
  },
  refused
};

export const sharedStructureCommands: SharedStructureCommands = {
  ports: () => {
    const parts = sharedSessionParts();
    return parts ? sharedStructurePorts({ ...source(parts), cells: html => sessionTextPorts.cells(html) })() : null;
  },
  refused
};

// why: while shared the standalone owner refuses its held document, so a control's own Ctrl+Z steps the shared owner
export const sharedAwareUndo: Pick<UndoControl, "undo" | "redo"> = {
  undo: () => {
    const route = sharedUndoRoute();
    return route ? stepSharedUndo(route, "undo", message => { notices.show(message, "warn"); }) : undoOwner().undo();
  },
  redo: () => {
    const route = sharedUndoRoute();
    return route ? stepSharedUndo(route, "redo", message => { notices.show(message, "warn"); }) : undoOwner().redo();
  }
};
