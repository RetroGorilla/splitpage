import * as Y from "yjs";
import { observeNativePress } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { nativeAvailability, nativeRangeSnapshot, resolveNativeUndoSelection } from "./text-commands.ts";
import type { NativeRangeData, NativeRefusal, NativeTextRange, NativeUndoSelection } from "./text-commands.ts";

type NativeUndoItem = NonNullable<ReturnType<Y.UndoManager["undo"]>>;
interface RecordedSelection {
  readonly before: NativeRangeData | null;
  after: NativeRangeData | null;
}
interface SelectionCapture { readonly before: NativeRangeData | null }

export type NativeUndoOutcome =
  | { readonly kind: "written"; readonly entry: number | null; readonly selection?: NativeUndoSelection }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: NativeRefusal };

const UNCHANGED: NativeUndoOutcome = Object.freeze({ kind: "unchanged" });

export function openNativeUndo(script: NativeScript) {
  const { order, segments, beats, visuals, headings, names, comments, replies } = script.roots;
  const manager = new Y.UndoManager([order, segments, beats, visuals, headings, names, comments, replies], {
    trackedOrigins: new Set([script.origin]),
    captureTimeout: Infinity
  });
  const entries = new WeakMap<NativeUndoItem, number>();
  const selectionKey = Symbol();
  let nextEntry = 0, disposed = false;
  let capture: SelectionCapture | null = null;
  let pending: { readonly capture: SelectionCapture; readonly selection: RecordedSelection } | null = null;
  let inverse: NativeUndoItem | null = null, replay: NativeRangeData | null = null;

  function selectionOf(item: NativeUndoItem): RecordedSelection | undefined {
    return item.meta.get(selectionKey) as RecordedSelection | undefined;
  }

  function record(item: NativeUndoItem, before: NativeRangeData | null, prior?: RecordedSelection): void {
    pending = null;
    if (!capture && !prior) return;
    const selection = prior ?? { before, after: null };
    selection.after = null;
    if (!prior) item.meta.set(selectionKey, selection);
    if (capture) pending = { capture, selection };
  }

  manager.on("stack-item-added", ({ stackItem, origin }) => {
    if (origin === manager) inverse = stackItem;
    else record(stackItem, capture?.before ?? null);
  });
  manager.on("stack-item-updated", ({ stackItem }) => {
    const prior = selectionOf(stackItem);
    record(stackItem, null, prior);
  });
  manager.on("stack-item-popped", ({ stackItem, type }) => {
    const selection = selectionOf(stackItem);
    if (!selection) return;
    inverse?.meta.set(selectionKey, selection);
    replay = type === "undo" ? selection.before : selection.after;
  });

  function captureSelection<T>(before: NativeTextRange | null, write: () => T) {
    const ticket = { before: before && nativeRangeSnapshot(before) };
    capture = ticket;
    try {
      const result = write();
      return {
        result,
        recordAfter(after: NativeTextRange | null): void {
          if (pending?.capture !== ticket) return;
          const { selection } = pending;
          pending = null;
          selection.after = after && nativeRangeSnapshot(after);
        }
      };
    } finally { capture = null; }
  }

  function entryOf(item: NativeUndoItem): number {
    const entry = entries.get(item) ?? ++nextEntry;
    entries.set(item, entry);
    return entry;
  }

  function press(direction: "undo" | "redo"): NativeUndoOutcome {
    const unavailable = nativeAvailability(script) ?? (disposed ? "closed" : null);
    if (unavailable) return Object.freeze({ kind: "refused", reason: unavailable });
    pending = null;
    manager.stopCapturing();
    // why: Yjs must finish the transaction while its undoing or redoing flag is still set
    try {
      const { result: item, changed } = observeNativePress(script, manager, () => manager[direction]());
      if (!changed) return UNCHANGED;
      const selection = replay && resolveNativeUndoSelection(script, replay);
      return Object.freeze({ kind: "written", entry: item ? entryOf(item) : null, ...(selection ? { selection } : {}) });
    } finally {
      inverse = null;
      replay = null;
    }
  }

  return Object.freeze({
    undo: () => press("undo"),
    redo: () => press("redo"),
    captureSelection,
    stopCapturing: () => manager.stopCapturing(),
    get undoStack() { return Object.freeze(manager.undoStack.map(entryOf)); },
    get redoStack() { return Object.freeze(manager.redoStack.map(entryOf)); },
    destroy() {
      disposed = true;
      pending = null;
      manager.destroy();
    }
  });
}
