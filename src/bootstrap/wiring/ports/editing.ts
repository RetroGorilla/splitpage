import type { EditorSelectionPort } from "../../../application/editing/selection.ts";
import type { UndoControl } from "../../../application/editing/undo-control.ts";
import type { DocumentEdits } from "../../../application/session/document-edits.ts";
import { breakUndoCoalescing, flushEdits, lastUndoEntry, redo, undo } from "../../../legacy/undo-bridge.ts";
import { editorSelection } from "../../../legacy/editor-bridge.ts";
import { editAllowed, runCommand, runDocumentEdit, sessionStamps, sessionTextPorts } from "../../../legacy/session-bridge.ts";

export const edits: DocumentEdits = {
  run: runCommand,
  edit: runDocumentEdit,
  allowed: editAllowed,
  stamps: sessionStamps,
  text: sessionTextPorts
};

export const undoControl: UndoControl = {
  breakCoalescing: breakUndoCoalescing,
  flush: flushEdits,
  undo,
  redo,
  last: lastUndoEntry
};

export const selection: EditorSelectionPort = {
  dropLink: () => { editorSelection().dropLink(); }
};
