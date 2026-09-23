import { S } from "./_state.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { ensureTrailingCaretSpot } from "./04-richtext.js";
import { fromHtml, toHtml } from "./04c-doc-model.js";
import { renderRow, syncFieldFromDom } from "./05-render.js";
import { markDirty } from "./12-dirty-toast.js";
import { breakUndoCoalescing, flushEdits } from "./12a-undo.js";

/* ================= editing a cell through the model (#85, design §5) =================

   The hybrid editor: plain typing is the browser's (composition, dead
   keys, spellcheck — the parts a hand-made editor gets wrong), and
   everything structural — a format, a tag, a b-roll key, a line break, a
   paste — is an edit of the cell's model instead of an execCommand:

     editCell(cellEl, function (cell, sel) { return {cell: ..., sel: ...}; })

   reads the cell's text as the model (04c-doc-model.js) with the selection
   as model positions, lets the caller change both, writes the result into
   state as canonical HTML, repaints that one cell and puts the selection
   back. The change is one undo entry of its own (12a-undo.js).

   POSITIONS. The model's positions are offsets into the cell's
   projection: its text, with a line break one character and a b-roll key
   one character. domToPos / posToDom translate between those and a point
   in the rendered cell, walking the DOM the way the sanitiser reads it
   (04-richtext.js walkSanitize): a <br> is one line break, a <div>/<p> the
   browser may have made while typing ends in one, a zero-width caret spot
   is nothing, a b-roll key is one character whatever its letters.

   A cell still holding a picture or a video card (pasted before design D7
   kept them out of script text) is not edited through the model — the
   model has no place for them — and editCell answers null for it, so the
   caller keeps its old way for that cell. */

function isBrollKey(node) {
  return node.nodeType === 1 && node.classList && node.classList.contains("broll-key");
}

function isBlankPara(node) {
  return node.childNodes.length === 1 && node.firstChild.nodeType === 1 && node.firstChild.tagName === "BR";
}

/* Calls visit(kind, node, len) for every piece of the cell in reading
   order: "text" (a text node; len = its characters without zero-width
   spaces), "atom" (a b-roll key, len 1), "br" (len 1), "end" (the line
   break a <div>/<p> ends in, len 1; node = the element). Stops when visit
   returns true. */
function walkCell(cellEl, visit) {
  var stop = false;
  (function walk(parent) {
    for (var c = parent.firstChild; c && !stop; c = c.nextSibling) {
      if (c.nodeType === 3) {
        if (visit("text", c, c.nodeValue.replace(/\u200B/g, "").length)) stop = true;
      } else if (c.nodeType === 1) {
        if (c.tagName === "BR") { if (visit("br", c, 1)) stop = true; continue; }
        if (c.tagName === "IMG") continue;
        if (isBrollKey(c)) { if (visit("atom", c, 1)) stop = true; continue; }
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

/* Characters of a text node before `offset`, zero-width spaces not
   counted. */
function textCount(node, offset) {
  return node.nodeValue.slice(0, offset).replace(/\u200B/g, "").length;
}

/* Does piece (kind, n) of the walk come at or after the start of node c? */
function atOrAfter(kind, n, c) {
  if (n === c || c.contains(n)) return true;
  /* the line break a <div>/<p> ends in comes after everything inside it */
  if (kind === "end" && n.contains(c)) return true;
  return !!(c.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/* The position where node c starts: the count of every piece before it. */
function posBefore(cellEl, c) {
  var p = 0, result = null;
  walkCell(cellEl, function (kind, n, len) {
    if (atOrAfter(kind, n, c)) { result = p; return true; }
    p += len;
    return false;
  });
  return result === null ? p : result;
}

/* The position just past everything inside node c. */
function posAfterNode(cellEl, c) {
  var p = 0, result = null;
  walkCell(cellEl, function (kind, n, len) {
    /* a <div>/<p>'s own line break is after its end, not inside it */
    var inside = n === c ? kind !== "end" : c.contains(n);
    if (!inside && atOrAfter(kind, n, c)) { result = p; return true; }
    p += len;
    return false;
  });
  return result === null ? p : result;
}

/* A DOM point (as a Selection gives one) inside cellEl as a model position. */
export function domToPos(cellEl, node, offset) {
  if (node !== cellEl && !cellEl.contains(node)) return null;
  var key = node.nodeType === 3 ? node.parentNode : node;
  var atom = key && key.closest ? key.closest(".broll-key") : null;
  if (atom && cellEl.contains(atom)) {
    /* inside a b-roll key's letters: before it at its very start, after it
       anywhere else */
    var atStart = offset === 0 && (node === atom || node === atom.firstChild);
    return atStart ? posBefore(cellEl, atom) : posAfterNode(cellEl, atom);
  }
  if (node.nodeType === 3) return posBefore(cellEl, node) + textCount(node, offset);
  if (offset < node.childNodes.length) return posBefore(cellEl, node.childNodes[offset]);
  return posAfterNode(cellEl, node);
}

/* A model position as a DOM point inside cellEl: inside a text node where
   there is one, else before or after the element at that place. Never
   inside a tag (the caret cannot sit in a contenteditable=false span) or
   a b-roll key. */
export function posToDom(cellEl, pos) {
  var p = 0, result = null, last = null;
  walkCell(cellEl, function (kind, n, len) {
    last = { kind: kind, node: n };
    if (kind === "text") {
      if (pos <= p + len) {
        var tag = n.parentNode && n.parentNode.closest && n.parentNode.closest(".tag-anchor");
        if (tag && cellEl.contains(tag)) {
          /* inside a tag: before it at its very start, after it otherwise */
          result = pos === p && tag.firstChild === n ? before(tag) : after(tag);
          return true;
        }
        /* map a count of visible characters back to an offset in the node */
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

/* The selection, if it is inside cellEl, as {from, to} with from <= to. */
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

/* The cell element for (rowId, field) in the same view as `like` — #rows
   or the writer — after a repaint may have replaced it. */
function findCell(like, rowId, field) {
  var root = like.closest("#writer-doc") || like.closest("#rows") || document;
  var sel = '.cell-editable[data-id="' + String(rowId).replace(/"/g, '\\"') + '"][data-field="' + field + '"]';
  return (root && root.querySelector(sel)) || document.querySelector(sel);
}

/* fn(cell, sel) -> {cell, sel: {from, to}} to change the cell, or null to
   leave it. sel is null when the selection is not in this cell. Returns
   the (possibly new) cell element, or null when nothing was done — the
   cell holds a picture or a video card, or fn declined. */
export function editCell(cellEl, fn) {
  var rowId = cellEl.getAttribute("data-id");
  var field = cellEl.getAttribute("data-field");
  var idx = findRowIndex(rowId);
  if (idx === -1 || (field !== "visualText" && field !== "audioText")) return null;
  /* whatever was typed a moment ago goes in first, as its own entry */
  syncFieldFromDom(cellEl);
  var row = S.state.rows[idx];
  var html = row[field] || "";
  if (/<img|video-embed-card/.test(html)) return null;
  var sel = cellSelection(cellEl);
  var out = fn(fromHtml(html), sel);
  if (!out || !out.cell) return null;
  breakUndoCoalescing();
  var next = toHtml(out.cell);
  if (next !== html) {
    row[field] = next;
    stampRow(row);
    markDirty();
  }
  /* repaint this one cell. In #rows that replaces the focused cell, and
     Chrome fires its focusout while it is still in the page: read back
     then (syncFieldFromDom), it would put the text from before this edit
     over it. So nothing is read back until the new cell has focus — the
     same guard an undo's repaint uses. */
  var fresh = cellEl;
  S.undoApplying = true;
  try {
    if (cellEl.closest("#rows")) {
      renderRow(rowId);
      fresh = findCell(cellEl, rowId, field) || cellEl;
    } else {
      cellEl.innerHTML = next;
      ensureTrailingCaretSpot(cellEl);
    }
    fresh.focus({ preventScroll: true });
  } finally {
    S.undoApplying = false;
  }
  if (out.sel) setCellSelection(fresh, out.sel.from, out.sel.to);
  /* one entry of its own: the next keystroke starts another */
  flushEdits();
  breakUndoCoalescing();
  return fresh;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
