import * as Y from "yjs";
import { observeNativePress } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { nativeAvailability } from "./text-commands.ts";
import type { NativeRefusal } from "./text-commands.ts";

type NativeUndoItem = NonNullable<ReturnType<Y.UndoManager["undo"]>>;
export type NativeUndoOutcome =
  | { readonly kind: "written"; readonly entry: number | null }
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
  let nextEntry = 0, disposed = false;

  function entryOf(item: NativeUndoItem): number {
    const entry = entries.get(item) ?? ++nextEntry;
    entries.set(item, entry);
    return entry;
  }

  function press(direction: "undo" | "redo"): NativeUndoOutcome {
    const unavailable = nativeAvailability(script) ?? (disposed ? "closed" : script.sizeRefusal?.());
    if (unavailable) return Object.freeze({ kind: "refused", reason: unavailable });
    manager.stopCapturing();
    // why: Yjs must finish the transaction while its undoing or redoing flag is still set
    const { result: item, changed } = observeNativePress(script, manager, () => manager[direction]());
    return changed ? Object.freeze({ kind: "written", entry: item ? entryOf(item) : null }) : UNCHANGED;
  }

  return Object.freeze({
    undo: () => press("undo"),
    redo: () => press("redo"),
    stopCapturing: () => manager.stopCapturing(),
    get undoStack() { return Object.freeze(manager.undoStack.map(entryOf)); },
    get redoStack() { return Object.freeze(manager.redoStack.map(entryOf)); },
    destroy() {
      disposed = true;
      manager.destroy();
    }
  });
}
