import { isSelectionField } from "../../core/text/selection.ts";
import type { ModelSelection } from "../../core/text/selection.ts";
import type { EditorSelection } from "../../application/editing/selection.ts";
import { domKeys, domToPos, placeSelection, posToDom, readSelection } from "./cell-dom.ts";

export type CellSelectionOwner = EditorSelection<Element, Range, Element>;

export interface CellRange {
  readonly from: number;
  readonly to: number;
}

function shownCells(rootEl: Element, field: string): HTMLElement[] {
  return Array.from(rootEl.querySelectorAll<HTMLElement>('.cell-editable[data-id][data-field="' + field + '"]'));
}

export function rememberCellSelection(owner: CellSelectionOwner, cellEl: Element | null): ModelSelection | null {
  const rootEl = cellEl && cellEl.isConnected ? cellEl.closest("#rows, #writer-doc") : null;
  if (!cellEl || !rootEl) {
    owner.forget();
    return null;
  }
  const rowId = cellEl.getAttribute("data-id");
  const field = cellEl.getAttribute("data-field");
  const points = rowId && isSelectionField(field) ? readSelection(cellEl, window.getSelection()) : null;
  if (!rowId || !isSelectionField(field) || !points) {
    owner.forget();
    return null;
  }
  return owner.remember({
    epoch: owner.paintedEpoch(rootEl),
    order: shownCells(rootEl, field).map(function (el) { return el.getAttribute("data-id") as string; }),
    rowId: rowId,
    field: field,
    anchor: points.anchor,
    head: points.head,
    affinity: points.affinity,
    keys: domKeys(cellEl)
  });
}

export function placeEditorSelection(owner: CellSelectionOwner, rootEl: Element | null): HTMLElement | null {
  const sel = owner.resolve();
  if (!sel || !rootEl) return null;
  const cellEl = shownCells(rootEl, sel.field).find(function (el) { return el.getAttribute("data-id") === sel.rowId; });
  if (!cellEl) return null;
  cellEl.focus({ preventScroll: true });
  placeSelection(cellEl, window.getSelection(), sel);
  return cellEl;
}

export function cellSelection(cellEl: Element): CellRange | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!cellEl.contains(r.startContainer) || !cellEl.contains(r.endContainer)) return null;
  const a = domToPos(cellEl, r.startContainer, r.startOffset);
  const b = domToPos(cellEl, r.endContainer, r.endOffset);
  if (a === null || b === null) return null;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

export function setCellSelection(cellEl: Element, from: number, to?: number): void {
  const a = posToDom(cellEl, from);
  const b = to === undefined || to === from ? a : posToDom(cellEl, to);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}
