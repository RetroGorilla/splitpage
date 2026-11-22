import type { SharedGalleryCommands } from "../../../application/commands/gallery.ts";
import type { EditorRegistryCommands } from "../../../application/commands/registry-editor.ts";
import type { SharedBeatField } from "../../../application/commands/shared-values.ts";
import type { CommandOutcome } from "../../../application/session/document-session.ts";
import type { UndoControl } from "../../../application/editing/undo-control.ts";
import { nativeEditorRecords } from "../shared-session.ts";
import { sharedUndoRoute, stepSharedUndo, undoOwner } from "../undo.ts";
import { notices } from "./effects.ts";
import { sharedCommandRefusalNotice } from "./shared-command-notices.ts";

const refuse = sharedCommandRefusalNotice(notices);

function refused(outcome: CommandOutcome): void {
  if (outcome.kind === "rejected" && !outcome.notified) refuse(outcome.reason);
}

export const nativeBeatField: SharedBeatField = (...args) => nativeEditorRecords()?.beatField(...args) ?? null;

export const sharedRecordCommands: EditorRegistryCommands = {
  native: () => nativeEditorRecords()?.registry ?? null,
  ports: () => null,
  refused
};

export const sharedGalleryCommands: SharedGalleryCommands = {
  editNative: (...args) => nativeEditorRecords()?.gallery(...args) ?? null
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
