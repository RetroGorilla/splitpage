import * as Y from "yjs";
import type { NativeScript } from "./script.ts";
import { nativeAvailability } from "./text-commands.ts";
import type { NativeRefusal } from "./text-commands.ts";

type NativeUndoItem = NonNullable<ReturnType<Y.UndoManager["undo"]>>;
export type NativeUndoOutcome =
  | { readonly kind: "written"; readonly item: NativeUndoItem }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: NativeRefusal };

const UNCHANGED: NativeUndoOutcome = Object.freeze({ kind: "unchanged" });

export function openNativeUndo(script: NativeScript, captureTimeout = Infinity) {
  const { order, segments, beats, visuals, headings, names, comments, replies } = script.roots;
  const manager = new Y.UndoManager([order, segments, beats, visuals, headings, names, comments, replies], {
    trackedOrigins: new Set([script.origin]),
    captureTimeout
  });
  let disposed = false;
  function press(direction: "undo" | "redo"): NativeUndoOutcome {
    const unavailable = nativeAvailability(script) ?? (disposed ? "closed" : null);
    if (unavailable) return Object.freeze({ kind: "refused", reason: unavailable });
    manager.stopCapturing();
    // why: Yjs must finish the transaction while its undoing or redoing flag is still set
    const item = manager[direction]();
    return item ? Object.freeze({ kind: "written", item }) : UNCHANGED;
  }
  return Object.freeze({
    undo: () => press("undo"),
    redo: () => press("redo"),
    stopCapturing: () => manager.stopCapturing(),
    get undoStack(): readonly NativeUndoItem[] { return manager.undoStack; },
    get redoStack(): readonly NativeUndoItem[] { return manager.redoStack; },
    destroy() {
      if (disposed) return;
      disposed = true;
      manager.destroy();
    }
  });
}
