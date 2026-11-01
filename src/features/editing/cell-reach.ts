import type { CellReachPorts } from "./ports.ts";

function reachTarget(t: Element | null) {
  if (!t || !t.classList) return null;
  if (!(t.classList.contains("cell") || t.classList.contains("field-wrap") ||
        (t.classList.contains("visual-media") && t.classList.contains("is-empty")))) return null;
  const cell = t.closest("#rows > .row > .cell");
  if (!cell) return null;
  return cell.querySelector<HTMLElement>(":scope > .field-wrap > .cell-editable");
}

export function placeCaretAtEnd(el: HTMLElement) {
  el.focus({ preventScroll: true });
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function mountCellReach({ window }: CellReachPorts) {
  const document = window.document;
  const rowsEl = document.getElementById("rows");
  if (!rowsEl) return { dispose: function () {} };
  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const field = reachTarget(e.target as Element | null);
    if (!field) return;
    e.preventDefault();
    placeCaretAtEnd(field);
  }
  rowsEl.addEventListener("mousedown", onMouseDown);
  return { dispose: function () { rowsEl.removeEventListener("mousedown", onMouseDown); } };
}
