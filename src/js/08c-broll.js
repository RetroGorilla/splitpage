import { productionReaders } from "../legacy/document-ports.ts";
import { normalizeTagName } from "../core/document/tags.ts";
import { domToPos } from "../features/editing/cell-dom.ts";
import { rowIndexOf } from "../core/document/rows.ts";
import {
  ensureTrailingCaretSpot,
  inertBody,
  sanitizeHtml
} from "./04-richtext.js";
import { cellEditing } from "../legacy/editor-bridge.ts";
import {
  isInsideTagOrLink,
  scheduleIdleRefresh
} from "./07-production-tags.js";
import { renderBrollViews } from "./08d-broll-panel.js";
import { makeId, randomIds } from "../adapters/identity/ids.ts";
import {
  BROLL_CLOSERS,
  BROLL_MARKER_RE,
  BROLL_PROPS_MAX,
  BROLL_STATUS_IDS,
  brollPropKey,
  newBrollShot,
} from "../core/document/broll.ts";
import { escapeHtml } from "../core/document/text-policy.ts";
import { cellRuns, cellTextCommand } from "../application/commands/cell-text.ts";
import {
  applyBrollRecords,
  brollEntries as readBrollEntries,
  brollInCell,
  brollMarkerLines,
  brollPropsInCell,
  brollSeedLocation,
  brollSeedRef,
  brollSortedForList,
  hasBrollRecordWork,
  planBrollRecords
} from "../core/production/broll.ts";
import { holdsMedia } from "../core/production/tags.ts";
import { deleteRange, insertBrollKey, insertText, replaceWithBrollKey } from "../core/text/edits.ts";
import { toHtml } from "../core/text/html.ts";
import { projection } from "../core/text/runs.ts";
import { htmlToPlainText } from "../legacy/plain-text.ts";
import { cellOf, scriptCellOf } from "../legacy/richtext.ts";
import { currentDocument, heldDocument, readSession, runCommand, runDocumentEdit, sessionStamps, sessionTextPorts } from "../legacy/session-bridge.ts";
import { addShotPropCommand } from "../application/commands/broll-records.ts";
import { rewriteCellsCommand } from "../application/commands/document-edit.ts";
import { addBrollRecord, brollRecord } from "../core/production/records.ts";
import { productionIndex } from "../legacy/production-index-bridge.ts";
import { anchorBrollInRows, brollHtmlLines, brollKeyHtml } from "../adapters/production/broll-anchors.ts";
import { declineBrollRows, resetBrollAnchoring } from "../application/broll-anchoring.ts";
export {
  BROLL_MARKER_RE,
  BROLL_PROPS_MAX,
  brollInCell,
  brollPropKey,
  brollPropsInCell
};

const brollAnchorPorts = { readers: productionReaders, ids: randomIds, cellOf: cellOf, inertBody: inertBody, sanitize: sanitizeHtml };

var BROLL_STATUS_LOOKS = {
  unshot: { label: "To shoot", color: "var(--text-dim)" },
  shot:   { label: "Shot",     color: "var(--ok)" }
};

export var BROLL_STATUSES = BROLL_STATUS_IDS.map(function (id) {
  var look = BROLL_STATUS_LOOKS[id];
  return { id: id, label: look.label, color: look.color };
});

export function brollStatus(id) {
  for (var i = 0; i < BROLL_STATUSES.length; i++) {
    if (BROLL_STATUSES[i].id === id) return BROLL_STATUSES[i];
  }
  return null;
}


function brollRow(rowId) {
  var i = rowId ? readSession(function (doc) { return rowIndexOf(doc, rowId); }) : -1;
  const doc = currentDocument();
  return i === -1 || !doc ? null : doc.rows[i];
}

function seedRef(row) {
  return brollSeedRef(row, htmlToPlainText);
}

function seedLocation(row) {
  return brollSeedLocation(row, productionReaders);
}

export function brollSeedOf(row) {
  return { audioRef: seedRef(row), location: seedLocation(row) };
}

export function recordPastedBroll(doc, rowId, cell, ids) {
  if (!doc || !ids || !ids.length) return;
  var row = doc.rows[rowIndexOf(doc, rowId)] || null;
  brollInCell(cell).forEach(function (found) {
    if (!found.id || ids.indexOf(found.id) === -1 || brollRecord(doc, found.id)) return;
    addBrollRecord(doc, newBrollShot(makeId("bs"), {
      id: found.id, name: found.name, desc: found.desc,
      audioRef: seedRef(row), location: seedLocation(row)
    }));
  });
}

export function brollEntries() {
  const doc = currentDocument();
  return doc ? readBrollEntries(doc, productionReaders, randomIds, htmlToPlainText) : [];
}

function unkeyedScope(changes) {
  if (changes.whole) return null;
  var inserted = Object.create(null);
  changes.rowsInserted.forEach(function (id) { inserted[id] = true; });
  return function (rowId) { return !!inserted[rowId]; };
}

export function derivedRecordsPlan(doc, changes) {
  if (!doc || doc !== heldDocument()) return null;
  var tags = productionIndex().recordsPlan(doc, currentDocument());
  var shots = planBrollRecords(doc, productionReaders, randomIds, htmlToPlainText, unkeyedScope(changes));
  var fields = [];
  if (tags && tags.apply) fields.push("productionTags");
  if (hasBrollRecordWork(shots)) fields.push("brollShots");
  if (!fields.length && !tags) return null;
  return {
    fields: fields,
    apply: function (into) {
      if (tags && tags.apply) tags.apply(into);
      applyBrollRecords(into.brollShots, shots);
    },
    commit: tags ? tags.commit : undefined
  };
}

export function addBrollProp(shotId, rawName) {
  return runDocumentEdit(addShotPropCommand(shotId, rawName));
}

export function brollShotsByProp() {
  var out = Object.create(null);
  if (!currentDocument()?.brollShots) return out;
  brollSortedForList(brollEntries()).forEach(function (e) {
    e.props.forEach(function (p) {
      var k = "prop " + normalizeTagName(p.name);
      if (!out[k]) out[k] = [];
      out[k].push(e.name || "Untitled shot");
    });
  });
  return out;
}

function brollUnshotCount() {
  if (!currentDocument()?.brollShots) return 0;
  return brollEntries().filter(function (e) { return e.status !== "shot"; }).length;
}

function brollAtLineStart(node) {
  if (node.nodeType !== 3) return false;
  var cell = node.parentNode && node.parentNode.closest
    ? node.parentNode.closest(".cell-editable") : null;
  if (!cell) return false;

  var n = node;
  while (true) {
    var prev = n.previousSibling;
    while (prev && prev.nodeType === 3 && !(prev.nodeValue || "").trim()) prev = prev.previousSibling;
    if (prev) return prev.nodeType === 1 && prev.tagName === "BR";
    var parent = n.parentNode;
    if (parent === cell) return true;
    if (!parent || parent.nodeType !== 1) return false;
    n = parent;
  }
}

export function maybeCaptureBroll(e, cellEl) {
  if (e.inputType !== "insertText" || !e.data) return;
  if (cellEl.getAttribute("data-field") !== "visualText") return;
  if (BROLL_CLOSERS.indexOf(e.data.charAt(e.data.length - 1)) === -1) return;
  var sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  var range = sel.getRangeAt(0);
  var node = range.startContainer;
  var offset = range.startOffset;
  if (!brollAtLineStart(node)) return;
  if (isInsideTagOrLink(node.parentNode)) return;
  var head = node.data.slice(0, offset);
  var m = BROLL_MARKER_RE.exec(head);
  if (!m || m[0].length !== head.length) return;

  var id = makeId("bs"), keyText = m[1] + m[2];
  cellEditing().edit(cellEl, function (cell) {
    var from = domToPos(cellEl, node, 0), to = domToPos(cellEl, node, offset);
    if (from === null || to === null) return null;
    if (projection(cell).slice(from, to) !== head.replace(/\u200B/g, "")) return null;
    var r = replaceWithBrollKey(cell, from, to, id, keyText);
    var row = brollRow(cellEl.getAttribute("data-id"));
    return { cell: r.cell, sel: { from: r.end, to: r.end }, records: { shots: [{ id: id, audioRef: seedRef(row), location: seedLocation(row) }] } };
  });
  scheduleBrollRefresh();
}


export function declineBrollAnchoring(rows) {
  declineBrollRows(rows);
}


export function anchorBrollInLeftCell(cellEl) {
  if (!currentDocument() || cellEl.getAttribute("data-field") !== "visualText") return 0;
  var row = brollRow(cellEl.getAttribute("data-id"));
  if (!row) return 0;
  var copy = { id: row.id, visualText: row.visualText };
  var n = readSession(function (doc) { return anchorBrollInRows(doc, [copy], brollAnchorPorts); });
  if (!n) return 0;
  var outcome = runCommand(cellTextCommand(row.id, "visualText", cellRuns(scriptCellOf(copy.visualText)), sessionTextPorts));
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind !== "applied" && outcome.kind !== "committed") return 0;
  cellEl.innerHTML = row.visualText;
  ensureTrailingCaretSpot(cellEl);
  scheduleBrollRefresh();
  return n;
}

function brollRenamed(doc, entry, newName) {
  var row = doc.rows[rowIndexOf(doc, entry.rowId)];
  if (!row) return [];
  var html = row.visualText;
  var target = entry.ordinal >= 0 ? brollMarkerLines(cellOf(html))[entry.ordinal] : null;
  if (!target) return [];
  var keyText = target.marker.key ? (target.marker.key.text || "B-roll:") : "B-roll:";

  if (holdsMedia(html)) {
    var body = inertBody(html);
    var line = brollHtmlLines(body)[target.index];
    if (!line) return [];
    var holder = document.createElement("div");
    holder.innerHTML = brollKeyHtml(entry.id, keyText) + " " + escapeHtml(newName);
    line.nodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    Array.prototype.slice.call(holder.childNodes).forEach(function (n) {
      body.insertBefore(n, line.br);
    });
    return [{ rowId: row.id, field: "visualText", html: sanitizeHtml(body.innerHTML) }];
  }

  var at = target.line.start;
  var cell = deleteRange(cellOf(html), at, target.line.end);
  cell = insertBrollKey(cell, at, entry.id, keyText, {});
  cell = insertText(cell, at + 1, " " + newName, {});
  return [{ rowId: row.id, field: "visualText", html: toHtml(cell) }];
}

export function renameBrollInScript(entry, newName) {
  var planned = readSession(function (doc) { return doc ? brollRenamed(doc, entry, newName) : []; });
  if (!planned.length) return false;
  runDocumentEdit(rewriteCellsCommand("rename-broll-shot", function (doc) { return brollRenamed(doc, entry, newName); }, sessionStamps, { needs: "edit", stamped: false }));
  return true;
}

export function updateBrollBadge() {
  var badge = document.getElementById("broll-badge");
  if (!badge || !currentDocument()) return;
  var n = brollUnshotCount();
  if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
  else badge.hidden = true;
}

export function scheduleBrollRefresh() {
  scheduleIdleRefresh("broll");
}

export function runBrollRefresh() {
  updateBrollBadge();
  renderBrollViews();
}

export function __init() {
  resetBrollAnchoring();
}
