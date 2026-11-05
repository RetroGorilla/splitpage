import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { SceneBoundaryRemoval } from "../../application/editing/scene-boundary.ts";
import { soleBeatSceneMovedBy } from "../../core/document/scenes.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";

export interface SceneBoundaryPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly boundary: SceneBoundaryRemoval;
  readonly allowed: () => boolean;
}

export function mountSceneBoundary(window: Window, ports: SceneBoundaryPorts): { dispose: () => void } {
  const doc = window.document;
  const life = createViewLifetime(window);
  let caret: { node: Node | null; offset: number; end: Node | null; endOffset: number } | null = null;
  function cancel(): void { caret = null; ports.boundary.cancel(); }
  function sameCaret(selection: Selection | null): boolean {
    return !!caret && !!selection && selection.anchorNode === caret.node && selection.anchorOffset === caret.offset &&
      selection.focusNode === caret.end && selection.focusOffset === caret.endOffset;
  }
  life.listen(doc, "keydown", event => {
    const selection = window.getSelection();
    const key = event.key;
    if (caret && !sameCaret(selection)) cancel();
    const scriptCell = event.target.closest?.('.cell-editable[data-field="audioText"],.cell-editable[data-field="visualText"]');
    if (scriptCell && ports.allowed() && event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing &&
      (key === "ArrowUp" || key === "ArrowDown")) {
      const state = ports.document.current();
      const scene = state && soleBeatSceneMovedBy(state, scriptCell.getAttribute("data-id") ?? "", key === "ArrowUp" ? -1 : 1);
      if (scene && selection) {
        caret = { node: selection.anchorNode, offset: selection.anchorOffset, end: selection.focusNode, endOffset: selection.focusOffset };
        const chord = event.shiftKey ? (key === "ArrowUp" ? "Alt+Shift+ArrowUp" : "Alt+Shift+ArrowDown") :
          (key === "ArrowUp" ? "Alt+ArrowUp" : "Alt+ArrowDown");
        if (!event.repeat && ports.boundary.press(scene.id, chord)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        return;
      }
    }
    const onMove = !!event.target.closest?.('[data-action="move-up"],[data-action="move-down"]');
    const activates = onMove && (key === "Enter" || key === " ");
    if (activates && event.repeat) event.preventDefault();
    if (!["Alt", "Shift", "Control", "Meta"].includes(key) && !activates) cancel();
  }, true);
  for (const type of ["pointerdown", "mousedown", "click", "beforeinput", "input", "paste", "cut", "compositionstart", "blur"]) {
    life.listen(doc, type, event => {
      if (!event.target.closest?.('[data-action="move-up"],[data-action="move-down"]')) cancel();
    }, true);
  }
  life.listen(doc, "selectionchange", () => { if (caret && !sameCaret(window.getSelection())) cancel(); });
  return { dispose() { life.dispose(); cancel(); } };
}
