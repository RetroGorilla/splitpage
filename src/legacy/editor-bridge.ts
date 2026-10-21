import { createFocusMemory } from "../application/editing/focus-memory.ts";
import type { FocusMemory } from "../application/editing/focus-memory.ts";
import { createUndoGuard } from "../application/editing/paint-guard.ts";
import type { UndoGuard } from "../application/editing/paint-guard.ts";
import { createRowDrag } from "../application/editing/row-drag.ts";
import type { RowDrag } from "../application/editing/row-drag.ts";
import { createMergeUndo } from "../application/session/merge-undo.ts";
import type { MergeUndo } from "../application/session/merge-undo.ts";

export type PicturePicker = (rowId: string) => void;

interface Started {
  readonly drag: RowDrag;
  readonly undo: UndoGuard;
  readonly focus: FocusMemory<Element>;
  readonly merge: MergeUndo;
  picker: PicturePicker | null;
}

let started: Started | null = null;

function running(): Started {
  if (!started) throw new Error("The editor's owners are not started yet");
  return started;
}

export function startEditor(): () => void {
  if (started) throw new Error("The editor's owners are already started; stop them first");
  const mine: Started = {
    drag: createRowDrag(),
    undo: createUndoGuard(),
    focus: createFocusMemory<Element>(),
    merge: createMergeUndo(),
    picker: null
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

export function focusMemory(): FocusMemory<Element> {
  return running().focus;
}

export function mergeUndo(): MergeUndo {
  return running().merge;
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
