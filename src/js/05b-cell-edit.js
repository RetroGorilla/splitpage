import { S } from "./_state.js";
import { findRowIndex } from "./03-sync.js";
import { ensureTrailingCaretSpot } from "./04-richtext.js";
import { screenIsStale, syncFieldFromDom } from "./05-render.js";
import { breakUndoCoalescing, flushEdits } from "./12a-undo.js";
import { toHtml } from "../core/text/html.ts";
import { cellRuns, cellTextCommand } from "../application/commands/cell-text.ts";
import { posToDom } from "../features/editing/cell-dom.ts";
import { cellSelection, setCellSelection } from "../features/editing/cell-selection.ts";
import { fromHtml } from "../legacy/richtext.ts";
import { runCommand, sessionTextPorts } from "../legacy/session-bridge.ts";

export { posToDom };

export function openCellEdit(cellEl) {
  if (screenIsStale()) return null;
  var rowId = cellEl.getAttribute("data-id");
  var field = cellEl.getAttribute("data-field");
  var idx = findRowIndex(rowId);
  if (idx === -1 || (field !== "visualText" && field !== "audioText")) return null;
  syncFieldFromDom(cellEl);
  var row = S.state.rows[idx];
  var html = row[field] || "";
  if (/<img|video-embed-card/.test(html)) return null;
  var sel = cellSelection(cellEl);
  breakUndoCoalescing();
  return { rowId: rowId, field: field, html: html, sel: sel };
}

export function closeCellEdit(cellEl, next, sel) {
  cellEl.innerHTML = next;
  ensureTrailingCaretSpot(cellEl);
  syncFieldFromDom(cellEl);
  cellEl.focus({ preventScroll: true });
  if (sel) setCellSelection(cellEl, sel.from, sel.to);
  flushEdits();
  breakUndoCoalescing();
  return cellEl;
}

export function editCell(cellEl, fn) {
  var open = openCellEdit(cellEl);
  if (!open) return null;
  var out = fn(fromHtml(open.html), open.sel);
  if (!out || !out.cell) return null;
  var next = toHtml(out.cell);
  if (next !== open.html) {
    var outcome = runCommand(cellTextCommand(open.rowId, open.field, cellRuns(out.cell), sessionTextPorts, out.records));
    if (outcome.kind === "failed") throw outcome.error;
    if (outcome.kind === "rejected") return null;
  }
  return closeCellEdit(cellEl, next, out.sel);
}

export function __init() {}
