import type { CellPage } from "../../application/editing/cell-editing.ts";
import { cellSelection, setCellSelection } from "./cell-selection.ts";

export interface CellPagePorts {
  readonly storedHtml: (html: string) => string;
  readonly caretSpot: (cellEl: Element) => void;
}

const ZWSP = /\u200B/g;

export function createCellPage(ports: CellPagePorts): CellPage<Element> {
  return {
    address: function (cellEl) {
      return { rowId: cellEl.getAttribute("data-id"), field: cellEl.getAttribute("data-field") };
    },
    attached: function (cellEl) { return cellEl.isConnected; },
    html: function (cellEl) {
      const shown = cellEl.innerHTML;
      return ports.storedHtml(shown.indexOf("\u200B") === -1 ? shown : shown.replace(ZWSP, ""));
    },
    selection: cellSelection,
    write: function (cellEl, html) {
      cellEl.innerHTML = html;
      ports.caretSpot(cellEl);
    },
    focus: function (cellEl, sel) {
      (cellEl as HTMLElement).focus({ preventScroll: true });
      if (sel) setCellSelection(cellEl, sel.from, sel.to);
    }
  };
}

export function isScriptCell(cellEl: Element | null | undefined): boolean {
  return !!(cellEl && cellEl.closest("#rows, #writer-doc") && cellEl.getAttribute("data-field"));
}

export function isDraftBox(el: Element | null | undefined): boolean {
  return !!(el && el.classList && el.classList.contains("cell-editable") &&
    el.getAttribute("contenteditable") === "true" && !el.closest("#rows, #writer-doc"));
}
