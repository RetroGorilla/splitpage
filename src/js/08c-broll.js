import { S } from "./_state.js";
import { findRowIndex } from "./03-sync.js";
import {
  ensureTrailingCaretSpot,
  inertBody,
  plainText,
  sanitizeHtml
} from "./04-richtext.js";
import { render } from "./05-render.js";
import { domToPos, editCell } from "./05b-cell-edit.js";
import {
  isInsideTagOrLink,
  normalizeTagName,
  productionReaders,
  registerProductionTag,
  registryEntry,
  scheduleIdleRefresh
} from "./07-production-tags.js";
import { renderBrollViews } from "./08d-broll-panel.js";
import { markDirty } from "./12-dirty-toast.js";
import { htmlToPlainText } from "./14-export.js";
import { makeId, randomIds } from "../adapters/identity/ids.ts";
import {
  BROLL_CLOSERS,
  BROLL_MARKER_RE,
  BROLL_NAME_MAX,
  BROLL_PROP_NAME_MAX,
  BROLL_PROPS_MAX,
  BROLL_STATUS_IDS,
  BROLL_TEXT_MAX,
  brollPropKey,
  normalizeBrollProps
} from "../core/document/broll.ts";
import { escapeHtml } from "../core/document/text-policy.ts";
import {
  anchorBrollCell,
  brollAnchorTodo,
  brollEntries as readBrollEntries,
  brollInCell,
  brollMarkerLines,
  brollPropsInCell,
  brollPropsRenamed as renamedBrollProps,
  brollSeedLocation,
  brollSeedRef,
  brollSortedForList,
  planBrollAnchors
} from "../core/production/broll.ts";
import { holdsMedia } from "../core/production/tags.ts";
import { deleteRange, insertBrollKey, insertText, replaceWithBrollKey } from "../core/text/edits.ts";
import { toHtml } from "../core/text/html.ts";
import { projection } from "../core/text/runs.ts";
import { cellOf } from "../legacy/richtext.ts";
export {
  BROLL_MARKER_RE,
  BROLL_NAME_MAX,
  BROLL_PROPS_MAX,
  BROLL_TEXT_MAX,
  brollInCell,
  brollPropKey,
  brollPropsInCell,
  brollSortedForList,
  normalizeBrollProps
};

var brollAnchorDeclined;

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

function brollHtmlLines(body) {
  hoistNestedBrs(body);
  var kids = Array.prototype.slice.call(body.childNodes);
  var lines = [], start = 0;
  kids.forEach(function (n, i) {
    if (n.nodeType === 1 && n.tagName === "BR") {
      lines.push({ nodes: kids.slice(start, i), br: n });
      start = i + 1;
    }
  });
  lines.push({ nodes: kids.slice(start), br: null });
  return lines;
}

function hoistNestedBrs(body) {
  var guard = 0;
  while (guard++ < 1000) {
    var brs = body.getElementsByTagName("br");
    var br = null;
    for (var i = 0; i < brs.length; i++) {
      if (brs[i].parentNode !== body) { br = brs[i]; break; }
    }
    if (!br) return;
    var parent = br.parentNode;
    var grand = parent.parentNode;
    if (!grand) return;
    var tail = parent.cloneNode(false);
    while (br.nextSibling) tail.appendChild(br.nextSibling);
    parent.removeChild(br);
    var ref = parent.nextSibling;
    grand.insertBefore(br, ref);
    if (tail.childNodes.length) grand.insertBefore(tail, ref);
  }
}

function brollHtmlLineText(nodes) {
  return nodes.map(function (n) { return n.textContent || ""; }).join("");
}

export function brollCountInRow(row) {
  return row && row.visualText ? productionReaders.brollInField(row.visualText).length : 0;
}

function brollRow(rowId) {
  var i = rowId ? findRowIndex(rowId) : -1;
  return i === -1 ? null : S.state.rows[i];
}

function seedRef(row) {
  return brollSeedRef(row, htmlToPlainText);
}

function seedLocation(row) {
  return brollSeedLocation(row, productionReaders);
}

export function brollRecord(id) {
  if (!id) return null;
  for (var i = 0; i < S.state.brollShots.length; i++) {
    if (S.state.brollShots[i].id === id) return S.state.brollShots[i];
  }
  return null;
}

export function newBrollRecord(fields) {
  var rec = {
    id: makeId("bs"),
    name: "", desc: "",
    status: BROLL_STATUSES[0].id,
    reshoot: false,
    notes: "",
    owner: "",
    audioRef: "",
    location: "",
    props: [],
    origin: "script"
  };
  Object.keys(fields || {}).forEach(function (k) { rec[k] = fields[k]; });
  S.state.brollShots.push(rec);
  return rec;
}

export function recordPastedBroll(rowId, cell, ids) {
  if (!S.state || !ids || !ids.length) return;
  var row = brollRow(rowId);
  brollInCell(cell).forEach(function (found) {
    if (!found.id || ids.indexOf(found.id) === -1 || brollRecord(found.id)) return;
    newBrollRecord({
      id: found.id, name: found.name, desc: found.desc,
      audioRef: seedRef(row), location: seedLocation(row)
    });
  });
}

export function deleteBrollRecord(id) {
  var before = S.state.brollShots.length;
  S.state.brollShots = S.state.brollShots.filter(function (r) { return r.id !== id; });
  return before !== S.state.brollShots.length;
}

function applyBrollPlan(read) {
  read.plan.create.forEach(function (c) {
    S.state.brollShots.push(c.shot);
    read.entries[c.entry].rec = c.shot;
  });
  read.plan.rename.forEach(function (r) {
    var rec = S.state.brollShots[r.at];
    rec.name = r.name;
    rec.desc = r.desc;
  });
}

export function brollEntries(readOnly) {
  var read = readBrollEntries(S.state, productionReaders, randomIds, htmlToPlainText, !readOnly);
  if (!readOnly) applyBrollPlan(read);
  return read.entries;
}

export function addBrollProp(shotId, rawName) {
  var rec = brollRecord(shotId);
  var name = plainText(rawName).trim().slice(0, BROLL_PROP_NAME_MAX);
  if (!rec || !name) return false;
  var entry = registryEntry("prop", name);
  if (!entry) {
    registerProductionTag("prop", name);
    entry = registryEntry("prop", name);
  }
  if (!entry) return false;
  rec.props = normalizeBrollProps(rec.props, S.state.productionTags);
  var key = brollPropKey(entry.id, entry.name);
  var already = rec.props.some(function (p) {
    return brollPropKey(p.id, p.name) === key || (!p.id && normalizeTagName(p.name) === normalizeTagName(entry.name));
  });
  if (already || rec.props.length >= BROLL_PROPS_MAX) return false;
  rec.props.push({ id: entry.id, name: entry.name });
  return true;
}

export function removeBrollProp(shotId, ref) {
  var rec = brollRecord(shotId);
  if (!rec || !ref || !Array.isArray(rec.props)) return false;
  var before = rec.props.length;
  rec.props = rec.props.filter(function (p) { return brollPropKey(p.id, p.name) !== ref; });
  return rec.props.length !== before;
}

export function brollPropsRenamed(fromId, oldName, toId, toName) {
  renamedBrollProps(S.state, fromId, oldName, toId, toName).forEach(function (c) {
    S.state.brollShots[c.at].props = c.props;
  });
}

export function brollShotsByProp() {
  var out = Object.create(null);
  if (!S.state || !S.state.brollShots) return out;
  brollSortedForList(brollEntries(true)).forEach(function (e) {
    e.props.forEach(function (p) {
      var k = "prop " + normalizeTagName(p.name);
      if (!out[k]) out[k] = [];
      out[k].push(e.name || "Untitled shot");
    });
  });
  return out;
}

function brollUnshotCount() {
  if (!S.state || !S.state.brollShots) return 0;
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
  editCell(cellEl, function (cell) {
    var from = domToPos(cellEl, node, 0), to = domToPos(cellEl, node, offset);
    if (from === null || to === null) return null;
    if (projection(cell).slice(from, to) !== head.replace(/\u200B/g, "")) return null;
    var r = replaceWithBrollKey(cell, from, to, id, keyText);
    var row = brollRow(cellEl.getAttribute("data-id"));
    newBrollRecord({ id: id, audioRef: seedRef(row), location: seedLocation(row) });
    return { cell: r.cell, sel: { from: r.end, to: r.end } };
  });
  scheduleBrollRefresh();
}

function brollKeyHtml(id, text) {
  return '<span class="broll-key" data-broll-id="' + escapeHtml(id) +
    '" contenteditable="false">' + escapeHtml(text) + '</span>';
}

function brollLineTextNodes(nodes) {
  var out = [];
  (function walk(list) {
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.nodeType === 3) out.push(n);
      else if (n.nodeType === 1) walk(n.childNodes);
    }
  })(nodes);
  return out;
}

function brollPruneEmpty(el, body) {
  while (el && el !== body && el.parentNode && !el.childNodes.length) {
    var parent = el.parentNode;
    parent.removeChild(el);
    el = parent;
  }
}

function brollWrapHtmlLine(body, line, id) {
  var m = BROLL_MARKER_RE.exec(brollHtmlLineText(line.nodes));
  if (!m) return false;
  var left = m[0].length;
  brollLineTextNodes(line.nodes).forEach(function (t) {
    if (left <= 0) return;
    var val = t.nodeValue || "";
    if (val.length > left) { t.nodeValue = val.slice(left); left = 0; return; }
    left -= val.length;
    var parent = t.parentNode;
    if (!parent) return;
    parent.removeChild(t);
    brollPruneEmpty(parent, body);
  });

  var ref = null;
  for (var i = 0; i < line.nodes.length && !ref; i++) {
    if (line.nodes[i].parentNode === body) ref = line.nodes[i];
  }
  if (!ref) ref = line.br;
  var holder = document.createElement("div");
  holder.innerHTML = brollKeyHtml(id, m[1] + m[2]) + " ";
  Array.prototype.slice.call(holder.childNodes).forEach(function (n) {
    body.insertBefore(n, ref);
  });
  return true;
}

function brollRekeyHtmlLine(line, id) {
  for (var i = 0; i < line.nodes.length; i++) {
    var n = line.nodes[i];
    if (n.nodeType !== 1) continue;
    var key = n.classList.contains("broll-key") ? n : n.querySelector(".broll-key");
    if (key) { key.setAttribute("data-broll-id", id); return true; }
  }
  return false;
}

export function declineBrollAnchoring(rows) {
  (rows || []).forEach(function (row) { brollAnchorDeclined[row.id] = true; });
}

export function anchorBrollInRows(rows) {
  if (!S.state || !rows || !rows.length) return 0;
  var plan = planBrollAnchors(S.state, productionReaders, randomIds);
  var total = 0;
  rows.forEach(function (row) {
    if (brollAnchorDeclined[row.id]) return;
    var html = row.visualText;
    var cell = cellOf(html);
    var todo = brollAnchorTodo(cell, row.id, plan);
    if (!todo.length) return;
    var n = 0;
    if (holdsMedia(html)) {
      var body = inertBody(html);
      var htmlLines = brollHtmlLines(body);
      todo.forEach(function (t) {
        var line = htmlLines[t.found.index];
        if (!line) return;
        if (t.found.marker.key ? brollRekeyHtmlLine(line, t.id) : brollWrapHtmlLine(body, line, t.id)) n++;
      });
      if (n) row.visualText = sanitizeHtml(body.innerHTML);
    } else {
      var anchored = anchorBrollCell(cell, todo);
      n = anchored.anchored;
      if (n) row.visualText = toHtml(anchored.cell);
    }
    total += n;
  });
  return total;
}

function brollAnchoringIdle() {
  var el = document.activeElement;
  return !(el && el.isContentEditable);
}

function maybeAnchorBroll() {
  if (!S.state || !brollAnchoringIdle()) return 0;
  var n = anchorBrollInRows(S.state.rows);
  if (!n) return 0;
  markDirty();
  render();
  return n;
}

export function anchorBrollInLeftCell(cellEl) {
  if (!S.state || cellEl.getAttribute("data-field") !== "visualText") return 0;
  var row = brollRow(cellEl.getAttribute("data-id"));
  if (!row) return 0;
  var n = anchorBrollInRows([row]);
  if (!n) return 0;
  cellEl.innerHTML = row.visualText;
  ensureTrailingCaretSpot(cellEl);
  markDirty();
  scheduleBrollRefresh();
  return n;
}

export function renameBrollInScript(entry, newName) {
  var row = brollRow(entry.rowId);
  if (!row) return false;
  var html = row.visualText;
  var target = entry.ordinal >= 0 ? brollMarkerLines(cellOf(html))[entry.ordinal] : null;
  if (!target) return false;
  var keyText = target.marker.key ? (target.marker.key.text || "B-roll:") : "B-roll:";

  if (holdsMedia(html)) {
    var body = inertBody(html);
    var line = brollHtmlLines(body)[target.index];
    if (!line) return false;
    var holder = document.createElement("div");
    holder.innerHTML = brollKeyHtml(entry.id, keyText) + " " + escapeHtml(newName);
    line.nodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    Array.prototype.slice.call(holder.childNodes).forEach(function (n) {
      body.insertBefore(n, line.br);
    });
    row.visualText = sanitizeHtml(body.innerHTML);
    return true;
  }

  var at = target.line.start;
  var cell = deleteRange(cellOf(html), at, target.line.end);
  cell = insertBrollKey(cell, at, entry.id, keyText, {});
  cell = insertText(cell, at + 1, " " + newName, {});
  row.visualText = toHtml(cell);
  return true;
}

export function updateBrollBadge() {
  var badge = document.getElementById("broll-badge");
  if (!badge || !S.state) return;
  var n = brollUnshotCount();
  if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
  else badge.hidden = true;
}

export function scheduleBrollRefresh() {
  scheduleIdleRefresh("broll");
}

export function runBrollRefresh() {
  maybeAnchorBroll();
  updateBrollBadge();
  renderBrollViews();
}

export function __init() {
  brollAnchorDeclined = Object.create(null);
}
