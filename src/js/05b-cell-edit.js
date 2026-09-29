import { S } from "./_state.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { ensureTrailingCaretSpot } from "./04-richtext.js";
import { fromHtml, toHtml } from "./04c-doc-model.js";
import { syncFieldFromDom } from "./05-render.js";
import { markDirty } from "./12-dirty-toast.js";
import { breakUndoCoalescing, flushEdits } from "./12a-undo.js";

var ATOM_SELECTOR = ".broll-key, .video-embed-card";

function isAtomEl(node) {
  if (node.nodeType !== 1) return false;
  if (node.tagName === "IMG") return true;
  return !!(node.classList && (node.classList.contains("broll-key") || node.classList.contains("video-embed-card")));
}

function isBlankPara(node) {
  return node.childNodes.length === 1 && node.firstChild.nodeType === 1 && node.firstChild.tagName === "BR";
}

function walkCell(cellEl, visit) {
  var stop = false;
  (function walk(parent) {
    for (var c = parent.firstChild; c && !stop; c = c.nextSibling) {
      if (c.nodeType === 3) {
        if (visit("text", c, c.nodeValue.replace(/\u200B/g, "").length)) stop = true;
      } else if (c.nodeType === 1) {
        if (c.tagName === "BR") { if (visit("br", c, 1)) stop = true; continue; }
        if (isAtomEl(c)) { if (visit("atom", c, 1)) stop = true; continue; }
        if (c.tagName === "DIV" || c.tagName === "P") {
          if (!isBlankPara(c)) walk(c);
          if (!stop && visit("end", c, 1)) stop = true;
          continue;
        }
        walk(c);
      }
    }
  })(cellEl);
}

function textCount(node, offset) {
  return node.nodeValue.slice(0, offset).replace(/\u200B/g, "").length;
}

function atOrAfter(kind, n, c) {
  if (n === c || c.contains(n)) return true;
  if (kind === "end" && n.contains(c)) return true;
  return !!(c.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function posBefore(cellEl, c) {
  var p = 0, result = null;
  walkCell(cellEl, function (kind, n, len) {
    if (atOrAfter(kind, n, c)) { result = p; return true; }
    p += len;
    return false;
  });
  return result === null ? p : result;
}

function posAfterNode(cellEl, c) {
  var p = 0, result = null;
  walkCell(cellEl, function (kind, n, len) {
    var inside = n === c ? kind !== "end" : c.contains(n);
    if (!inside && atOrAfter(kind, n, c)) { result = p; return true; }
    p += len;
    return false;
  });
  return result === null ? p : result;
}

export function domToPos(cellEl, node, offset) {
  if (node !== cellEl && !cellEl.contains(node)) return null;
  var key = node.nodeType === 3 ? node.parentNode : node;
  var atom = key && key.closest ? key.closest(ATOM_SELECTOR) : null;
  if (atom && cellEl.contains(atom)) {
    var atStart = offset === 0 && (node === atom || node === atom.firstChild);
    return atStart ? posBefore(cellEl, atom) : posAfterNode(cellEl, atom);
  }
  if (node.nodeType === 3) return posBefore(cellEl, node) + textCount(node, offset);
  if (offset < node.childNodes.length) return posBefore(cellEl, node.childNodes[offset]);
  return posAfterNode(cellEl, node);
}

// Never inside contenteditable=false tag or b-roll key
export function posToDom(cellEl, pos) {
  var p = 0, result = null, last = null;
  walkCell(cellEl, function (kind, n, len) {
    last = { kind: kind, node: n };
    if (kind === "text") {
      if (pos <= p + len) {
        var tag = n.parentNode && n.parentNode.closest && n.parentNode.closest(".tag-anchor");
        if (tag && cellEl.contains(tag)) {
          result = pos === p && tag.firstChild === n ? before(tag) : after(tag);
          return true;
        }
        var raw = n.nodeValue, seen = 0, i = 0;
        while (i < raw.length && seen < pos - p) { if (raw[i] !== "\u200B") seen++; i++; }
        result = { node: n, offset: i };
        return true;
      }
    } else if (pos <= p) {
      result = kind === "end" ? endOf(n) : before(n);
      return true;
    }
    p += len;
    return false;
  });
  if (result) return result;
  if (last && last.kind === "atom") return after(last.node);
  return { node: cellEl, offset: cellEl.childNodes.length };
}

function before(node) {
  return { node: node.parentNode, offset: Array.prototype.indexOf.call(node.parentNode.childNodes, node) };
}
function after(node) {
  return { node: node.parentNode, offset: Array.prototype.indexOf.call(node.parentNode.childNodes, node) + 1 };
}
function endOf(el) {
  return { node: el, offset: el.childNodes.length };
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

export function editCell(cellEl, fn) {
  var rowId = cellEl.getAttribute("data-id");
  var field = cellEl.getAttribute("data-field");
  var idx = findRowIndex(rowId);
  if (idx === -1 || (field !== "visualText" && field !== "audioText")) return null;
  syncFieldFromDom(cellEl);
  var row = S.state.rows[idx];
  var html = row[field] || "";
  if (/<img|video-embed-card/.test(html)) return null;
  var sel = cellSelection(cellEl);
  // Close prior entry first; fn's registry changes join this one
  breakUndoCoalescing();
  var out = fn(fromHtml(html), sel);
  if (!out || !out.cell) return null;
  var next = toHtml(out.cell);
  if (next !== html) {
    row[field] = next;
    stampRow(row);
    markDirty();
  }
  if (out.also) {
    out.also();
    markDirty();
  }
  // In place; replacing element steals focus and fires stale focusout
  cellEl.innerHTML = next;
  ensureTrailingCaretSpot(cellEl);
  syncFieldFromDom(cellEl);
  cellEl.focus({ preventScroll: true });
  if (out.sel) setCellSelection(cellEl, out.sel.from, out.sel.to);
  flushEdits();
  breakUndoCoalescing();
  return cellEl;
}

export function __init() {}
