import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { SceneBoundaryRemoval } from "../../application/editing/scene-boundary.ts";
import { sceneBeforeBeat, soleBeatSceneMovedBy } from "../../core/document/scenes.ts";
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
  function atEdge(cell: Element, range: Range, start: boolean): boolean {
    const probe = doc.createRange();
    probe.selectNodeContents(cell);
    if (start) probe.setEnd(range.startContainer, range.startOffset);
    else probe.setStart(range.endContainer, range.endOffset);
    const fragment = probe.cloneContents();
    return !fragment.textContent && !fragment.querySelector("br, img");
  }
  life.listen(doc, "keydown", event => {
    const cell = event.target.closest?.("#writer-doc .wr-para");
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
    if (!cell || !ports.allowed() || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
      (key !== "Backspace" && key !== "Delete") || !selection?.rangeCount) {
      const onMove = !!event.target.closest?.('[data-action="move-up"],[data-action="move-down"]');
      if (!["Alt", "Shift", "Control", "Meta"].includes(key) && !(onMove && (key === "Enter" || key === " "))) cancel();
      return;
    }
    const range = selection.getRangeAt(0);
    if (!range.collapsed || !cell.contains(range.startContainer) || !atEdge(cell, range, key === "Backspace")) { cancel(); return; }
    const state = ports.document.current();
    if (!state) { cancel(); return; }
    const at = state.rows.findIndex(row => row.id === cell.getAttribute("data-id"));
    const next = state.rows[key === "Backspace" ? at : at + 1];
    const scene = at === -1 || !next ? undefined : sceneBeforeBeat(state, next.id);
    if (!scene) { cancel(); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    caret = { node: selection.anchorNode, offset: selection.anchorOffset, end: selection.focusNode, endOffset: selection.focusOffset };
    ports.boundary.press(scene.id, key);
  }, true);
  for (const type of ["pointerdown", "mousedown", "click", "beforeinput", "input", "paste", "cut", "compositionstart", "blur"]) {
    life.listen(doc, type, event => {
      const keep = type === "blur" ? '[data-action="move-up"],[data-action="move-down"],.row-more' :
        '[data-action="move-up"],[data-action="move-down"]';
      if (!event.target.closest?.(keep)) cancel();
    }, true);
  }
  life.listen(doc, "selectionchange", () => { if (caret && !sameCaret(window.getSelection())) cancel(); });
  return { dispose() { life.dispose(); cancel(); } };
}
