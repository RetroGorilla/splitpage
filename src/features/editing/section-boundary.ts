import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { SectionBoundaryRemoval } from "../../application/editing/section-boundary.ts";
import { sectionBeforeScene, sectionGroups } from "../../core/document/sections.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";

export interface SectionBoundaryPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly boundary: SectionBoundaryRemoval;
  readonly allowed: () => boolean;
}

export function mountSectionBoundary(window: Window, ports: SectionBoundaryPorts): { dispose: () => void } {
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
      const at = state?.rows.findIndex(row => row.id === scriptCell.getAttribute("data-id")) ?? -1;
      const group = state && sectionGroups(state).find(item => item.start === at && item.end === at + 1);
      const next = state?.rows[at + (key === "ArrowUp" ? -1 : 1)];
      if (group && next && selection) {
        caret = { node: selection.anchorNode, offset: selection.anchorOffset, end: selection.focusNode, endOffset: selection.focusOffset };
        const chord = event.shiftKey ? (key === "ArrowUp" ? "Alt+Shift+ArrowUp" : "Alt+Shift+ArrowDown") :
          (key === "ArrowUp" ? "Alt+ArrowUp" : "Alt+ArrowDown");
        if (!event.repeat && ports.boundary.press(group.section.id, chord)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        return;
      }
    }
    if (!cell || !ports.allowed() || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
      (key !== "Backspace" && key !== "Delete") || !selection?.rangeCount) {
      if (!["Alt", "Shift", "Control", "Meta"].includes(key)) cancel();
      return;
    }
    const range = selection.getRangeAt(0);
    if (!range.collapsed || !cell.contains(range.startContainer) || !atEdge(cell, range, key === "Backspace")) { cancel(); return; }
    const state = ports.document.current();
    if (!state) { cancel(); return; }
    const at = state.rows.findIndex(row => row.id === cell.getAttribute("data-id"));
    const next = state.rows[key === "Backspace" ? at : at + 1];
    const section = at === -1 || !next ? undefined : sectionBeforeScene(state, next.id);
    if (!section) { cancel(); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    caret = { node: selection.anchorNode, offset: selection.anchorOffset, end: selection.focusNode, endOffset: selection.focusOffset };
    ports.boundary.press(section.id, key);
  }, true);
  for (const type of ["pointerdown", "mousedown", "click", "beforeinput", "input", "paste", "cut", "compositionstart", "blur"]) {
    life.listen(doc, type, cancel, true);
  }
  life.listen(doc, "selectionchange", () => { if (caret && !sameCaret(window.getSelection())) cancel(); });
  return { dispose() { life.dispose(); cancel(); } };
}
