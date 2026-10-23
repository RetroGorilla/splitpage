import type { CellEditing } from "../application/editing/cell-editing.ts";
import { createFocusMemory } from "../application/editing/focus-memory.ts";
import type { FocusMemory } from "../application/editing/focus-memory.ts";
import { createPaintGuard, createUndoGuard } from "../application/editing/paint-guard.ts";
import type { PaintGuard, UndoGuard } from "../application/editing/paint-guard.ts";
import { createRowDrag } from "../application/editing/row-drag.ts";
import type { RowDrag } from "../application/editing/row-drag.ts";
import { createEditorSelection } from "../application/editing/selection.ts";
import type { EditorSelection, SelectionPorts } from "../application/editing/selection.ts";
import { createMergeUndo } from "../application/session/merge-undo.ts";
import type { MergeUndo } from "../application/session/merge-undo.ts";
import type { LiveDocumentPort } from "../application/transitions/ports.ts";
import { editorKeys } from "../core/text/selection.ts";
import { scriptCellOf } from "./richtext.ts";
import { liveSession } from "./session-bridge.ts";

export type PicturePicker = (rowId: string) => void;

export type CellSelection = EditorSelection<Element, Range, Element>;

interface Started {
  readonly drag: RowDrag;
  readonly undo: UndoGuard;
  readonly paint: PaintGuard;
  readonly focus: FocusMemory<Element>;
  readonly merge: MergeUndo;
  readonly selection: CellSelection;
  picker: PicturePicker | null;
  editing: CellEditing<Element> | null;
}

let started: Started | null = null;

function running(): Started {
  if (!started) throw new Error("The editor's owners are not started yet");
  return started;
}

function selectionPorts(live: LiveDocumentPort): SelectionPorts {
  return {
    epoch: function () { return liveSession().epoch(); },
    order: function () {
      const doc = live.current();
      return doc ? doc.rows.map(function (r) { return r.id; }) : [];
    },
    keys: function (rowId, field) {
      const doc = live.current();
      const row = doc ? doc.rows.find(function (r) { return r.id === rowId; }) : undefined;
      return row ? editorKeys(scriptCellOf(row[field] || "")) : null;
    }
  };
}

export function startEditor(live: LiveDocumentPort): () => void {
  if (started) throw new Error("The editor's owners are already started; stop them first");
  const mine: Started = {
    drag: createRowDrag(),
    undo: createUndoGuard(),
    paint: createPaintGuard(),
    focus: createFocusMemory<Element>(),
    merge: createMergeUndo(),
    selection: createEditorSelection<Element, Range, Element>(selectionPorts(live)),
    picker: null,
    editing: null
  };
  started = mine;
  return function () {
    if (started === mine) started = null;
  };
}

export function editorStarted(): boolean {
  return started !== null;
}

export function rowDrag(): RowDrag {
  return running().drag;
}

export function undoGuard(): UndoGuard {
  return running().undo;
}

export function paintGuard(): PaintGuard {
  return running().paint;
}

export function focusMemory(): FocusMemory<Element> {
  return running().focus;
}

export function mergeUndo(): MergeUndo {
  return running().merge;
}

export function editorSelection(): CellSelection {
  return running().selection;
}

export function installPicturePicker(pick: PicturePicker): () => void {
  const mine = running();
  mine.picker = pick;
  return function () {
    if (mine.picker === pick) mine.picker = null;
  };
}

export function pickPictureFor(rowId: string): void {
  const pick = running().picker;
  if (pick) pick(rowId);
}

export function installCellEditing(editing: CellEditing<Element>): () => void {
  const mine = running();
  if (mine.editing) throw new Error("Cell editing is already installed; stop it first");
  mine.editing = editing;
  return function () {
    if (mine.editing === editing) mine.editing = null;
  };
}

export function cellEditing(): CellEditing<Element> {
  const editing = running().editing;
  if (!editing) throw new Error("Cell editing is not installed yet");
  return editing;
}
