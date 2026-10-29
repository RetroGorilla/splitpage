import type { EditorSelection } from "../../../application/editing/selection.ts";
import type { ProductionSelection } from "../../../application/editing/production-selection.ts";
import { productionSelection as productionSelectionOwner } from "../../../legacy/production-editing-bridge.ts";
import type { UndoControl } from "../../../application/editing/undo-control.ts";
import type { DocumentEdits } from "../../../application/session/document-edits.ts";
import { undoOwner } from "../undo.ts";
import type { CellEditing } from "../../../application/editing/cell-editing.ts";
import { cellEditing, editorSelection, focusMemory } from "../editor-owners.ts";
import { editAllowed, runCommand, runDocumentEdit, sessionStamps, sessionTextPorts } from "../session-owner.ts";
import { paintGuard, undoGuard } from "../editor-owners.ts";
import { appendDraftMedia, draftModel, editDraft } from "../../../features/editing/draft-edit.js";
import { isDraftBox, isScriptCell } from "../../../features/editing/cell-page.ts";

export const renderEditing = { cells: cellEditing, selection: editorSelection, paint: paintGuard, undo: undoGuard };
export const renderDraft = { appendMedia: appendDraftMedia, model: draftModel, edit: editDraft, isDraft: isDraftBox, isScript: isScriptCell };
export const renderUndo = { track: (): void => { undoOwner().track(); } };

export const edits: DocumentEdits = {
  run: runCommand,
  edit: runDocumentEdit,
  allowed: editAllowed,
  stamps: sessionStamps,
  text: sessionTextPorts
};

export const undoControl: UndoControl = {
  breakCoalescing: () => { undoOwner().breakCoalescing(); },
  flush: () => { undoOwner().flush(); },
  undo: () => undoOwner().undo(),
  redo: () => undoOwner().redo(),
  last: () => undoOwner().last()
};

export const cells: Pick<CellEditing<Element>, "edit"> = {
  edit: (cell, change) => cellEditing().edit(cell, change)
};

export const selection: Pick<EditorSelection<Element, Range, Element>, "dropLink" | "remember" | "forget" | "paintedEpoch" | "resolve"> = {
  remember: (taken) => editorSelection().remember(taken),
  resolve: () => editorSelection().resolve(),
  forget: () => { editorSelection().forget(); },
  paintedEpoch: (root) => editorSelection().paintedEpoch(root),
  dropLink: () => { editorSelection().dropLink(); }
};

export const productionSelection: ProductionSelection = {
  selectedKeys: () => productionSelectionOwner().selectedKeys(),
  selected: (key) => productionSelectionOwner().selected(key),
  anchorKey: () => productionSelectionOwner().anchorKey(),
  toggle: (key) => { productionSelectionOwner().toggle(key); },
  select: (key, order, shift) => productionSelectionOwner().select(key, order, shift),
  prune: (entries) => { productionSelectionOwner().prune(entries); },
  clear: () => { productionSelectionOwner().clear(); },
  armed: () => productionSelectionOwner().armed(),
  arm: (expired) => { productionSelectionOwner().arm(expired); },
  disarm: () => { productionSelectionOwner().disarm(); }
};

export const focus = { lastRow: () => focusMemory().lastRow() };

export const tagEditing = { cells: cellEditing, focus: focusMemory };

export const writerEditing = { cells: cellEditing, selection: editorSelection, focus: focusMemory, paint: paintGuard };
export const writerUndo = {
  breakCoalescing: () => { undoOwner().breakCoalescing(); }, last: () => undoOwner().last(), nextRedo: () => undoOwner().nextRedo(),
  lifetime: () => undoOwner().lifetime(), mark: () => undoOwner().mark(), serial: () => undoOwner().serial()
};
