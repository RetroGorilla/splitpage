import { S } from "./_state.js";
import { findRowIndex } from "./03-sync.js";
import { cssAttr, ensureTrailingCaretSpot } from "./04-richtext.js";
import { screenIsStale, syncFieldFromDom } from "./05-render.js";
import { breakUndoCoalescing, flushEdits } from "./12a-undo.js";
import { toHtml } from "../core/text/html.ts";
import { cellKeys, isSelectionField } from "../core/text/selection.ts";
import { createSelectionModel } from "../application/editing/selection.ts";
import { cellRuns, cellTextCommand } from "../application/commands/cell-text.ts";
import { domKeys, domToPos, placeSelection, posToDom, readSelection } from "../features/editing/cell-dom.ts";
import { cellOf, fromHtml } from "../legacy/richtext.ts";
import { liveSession, runCommand, sessionTextPorts } from "../legacy/session-bridge.ts";

export { domToPos, posToDom };

var editorSelection = createSelectionModel({
  epoch: function () { return liveSession().epoch(); },
  order: function () { return S.state ? S.state.rows.map(function (r) { return r.id; }) : []; },
  keys: function (rowId, field) {
    var idx = S.state ? findRowIndex(rowId) : -1;
    return idx === -1 ? null : cellKeys(cellOf(S.state.rows[idx][field] || ""));
  }
});

var paintedEpochs = new WeakMap();

export function notePaintedEpoch(rootEl) {
  if (rootEl) paintedEpochs.set(rootEl, liveSession().epoch());
}

function shownOrder(rootEl, field) {
  return Array.prototype.map.call(rootEl.querySelectorAll('.cell-editable[data-id][data-field="' + field + '"]'), function (el) {
    return el.getAttribute("data-id");
  });
}

export function rememberCellSelection(cellEl) {
  var rootEl = cellEl && cellEl.isConnected ? cellEl.closest("#rows, #writer-doc") : null;
  if (!rootEl) {
    editorSelection.forget();
    return null;
  }
  var rowId = cellEl.getAttribute("data-id");
  var field = cellEl.getAttribute("data-field");
  var points = rowId && isSelectionField(field) ? readSelection(cellEl, window.getSelection()) : null;
  if (!points) {
    editorSelection.forget();
    return null;
  }
  return editorSelection.remember({
    epoch: paintedEpochs.has(rootEl) ? paintedEpochs.get(rootEl) : liveSession().epoch(),
    order: shownOrder(rootEl, field),
    rowId: rowId,
    field: field,
    anchor: points.anchor,
    head: points.head,
    affinity: points.affinity,
    keys: domKeys(cellEl)
  });
}

export function placeEditorSelection(rootEl) {
  var sel = editorSelection.resolve();
  if (!sel || !rootEl) return null;
  var cellEl = rootEl.querySelector('.cell-editable[data-id="' + cssAttr(sel.rowId) + '"][data-field="' + sel.field + '"]');
  if (!cellEl) return null;
  cellEl.focus({ preventScroll: true });
  placeSelection(cellEl, window.getSelection(), sel);
  return cellEl;
}

export function cellSelection(cellEl) {
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  var r = sel.getRangeAt(0);
  if (!cellEl.contains(r.startContainer) || !cellEl.contains(r.endContainer)) return null;
  var a = domToPos(cellEl, r.startContainer, r.startOffset);
  var b = domToPos(cellEl, r.endContainer, r.endOffset);
  if (a === null || b === null) return null;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

export function setCellSelection(cellEl, from, to) {
  var a = posToDom(cellEl, from);
  var b = to === undefined || to === from ? a : posToDom(cellEl, to);
  var range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

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
