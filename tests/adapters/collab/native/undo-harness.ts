import assert from "node:assert/strict";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { openNativeUndo } from "../../../../src/adapters/collab/native/undo-commands.ts";
import type { NativeUndoOutcome } from "../../../../src/adapters/collab/native/undo-commands.ts";

export type TestNativeUndo = ReturnType<typeof testNativeUndo>;

function itemOf(outcome: NativeUndoOutcome) {
  assert.notEqual(outcome.kind, "refused");
  return outcome.kind === "written" ? outcome.entry : null;
}

export function testNativeUndo(script: NativeScript) {
  const history = openNativeUndo(script);
  const endGroup = history.stopCapturing;
  script.doc.on("afterTransaction", endGroup);
  return {
    undo: () => itemOf(history.undo()),
    redo: () => itemOf(history.redo()),
    stopCapturing: history.stopCapturing,
    get undoStack() { return history.undoStack; },
    get redoStack() { return history.redoStack; },
    destroy() {
      script.doc.off("afterTransaction", endGroup);
      history.destroy();
    }
  };
}
