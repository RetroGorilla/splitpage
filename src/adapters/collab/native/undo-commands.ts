import * as Y from "yjs";
import { observeNativePress, withNativeCommand } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { nativeAvailability, resolveNativeUndoSelection, snapshotNativeUndoAnchor } from "./text-commands.ts";
import type { NativeRefusal, NativeUndoAnchor, NativeUndoSelection, NativeUndoSelectionInput } from "./text-commands.ts";

type NativeUndoItem = NonNullable<ReturnType<Y.UndoManager["undo"]>>;
interface RecordedSelection {
  readonly before: NativeUndoAnchor | null;
  after: NativeUndoAnchor | null;
}
interface SelectionCapture {
  before: NativeUndoAnchor | null;
  typedCaret: NativeUndoAnchor | null;
  readonly recordTypedCaret: (anchor: NativeUndoAnchor) => void;
}

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

  function selectionOf(item: NativeUndoItem): RecordedSelection | undefined {
    return item.meta.get(selectionKey) as RecordedSelection | undefined;
  }

  function record(item: NativeUndoItem, before: NativeUndoAnchor | null, prior?: RecordedSelection): void {
    pending = null;
    if (!capture && !prior) return;
    const selection = prior ?? { before, after: null };
    selection.after = null;
    if (!prior) item.meta.set(selectionKey, selection);
    if (capture) pending = { capture, selection };
  }

  manager.on("stack-item-added", ({ stackItem, origin }) => {
    if (origin !== manager) record(stackItem, capture?.before ?? null);
  });
  manager.on("stack-item-updated", ({ stackItem }) => {
    const prior = selectionOf(stackItem);
    record(stackItem, null, prior);
  });

  function captureSelection<T>(before: NativeUndoSelectionInput | null, write: (prepareWrite: () => void) => T) {
    const ticket: SelectionCapture = {
      before: null, typedCaret: null,
      recordTypedCaret(anchor) { ticket.typedCaret = anchor; }
    };
    capture = ticket;
    try {
      const result = write(() => {
        ticket.before = before && snapshotNativeUndoAnchor(script, before);
      });
      return {
        result,
        recordAfter(after?: NativeUndoSelectionInput | null): void {
          if (pending?.capture !== ticket) return;
          const { selection } = pending;
          pending = null;
          selection.after = after === undefined ? ticket.typedCaret
            : after && withNativeCommand(script, () => snapshotNativeUndoAnchor(script, after));
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
    const unavailable = nativeAvailability(script) ?? (disposed ? "closed" : script.sizeRefusal?.());
    if (unavailable) return Object.freeze({ kind: "refused", reason: unavailable });
    pending = null;
    manager.stopCapturing();
    const inverses = direction === "undo" ? manager.redoStack : manager.undoStack;
    const depth = inverses.length;
    // why: Yjs must finish the transaction while its undoing or redoing flag is still set
    const { result: item, changed } = observeNativePress(script, manager, () => manager[direction]());
    if (!changed) return UNCHANGED;
    const recorded = item && selectionOf(item);
    if (recorded) inverses[depth]?.meta.set(selectionKey, recorded);
    const replay = direction === "undo" ? recorded?.before : recorded?.after;
    const selection = replay && resolveNativeUndoSelection(script, replay);
    return Object.freeze({ kind: "written", entry: item ? entryOf(item) : null, ...(selection ? { selection } : {}) });
  }

  return Object.freeze({
    undo: () => press("undo"),
    redo: () => press("redo"),
    captureSelection,
    get typingRecorder() { return capture?.recordTypedCaret; },
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
