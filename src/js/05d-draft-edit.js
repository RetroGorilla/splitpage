import { inertBody, sanitizeHtml, storedHtmlFromDom } from "./04-richtext.js";
import {
  cellLength,
  deleteRange,
  fromHtml,
  insertText,
  joinCells,
  markThroughout,
  normalizeCell,
  projection,
  setMark,
  sliceCell,
  toHtml
} from "./04c-doc-model.js";
import { cellSelection, setCellSelection } from "./05b-cell-edit.js";

/* ================= editing a comment or reply draft (#85, design §10 step 7) =================

   The comment composer and every reply box are contenteditable boxes like a
   script cell, but with no row behind them and room for what a script cell
   may not hold: pictures and video cards. They used to be edited with the
   browser's execCommand, whose one virtue was that its edits went on the
   browser's own undo stack. Now they are edited the way a script cell is —
   plain typing is the browser's (composition, dead keys, spellcheck), and
   everything structural (B/I/U/S, highlight, a link, Enter, a paste, a
   picture, a video) goes through the document model — with two differences:

   PICTURES. The model has no place for a picture or a video card (design
   D7). So each one is lifted out before the box is read as a cell: it
   becomes one private-use character (U+E000..U+F8FF, never one the box
   already holds), which the model treats as a letter, and goes back in as
   itself when the cell is written out. The DOM walk (05b-cell-edit.js
   walkCell) counts a picture or a video card as one position, so the
   selection lines up with those characters. A picture or a card never
   carries formatting or a link (stripMediaMarks) — a card is an <a>, and
   one inside a link would not survive being parsed again — and never
   counts toward whether a selection is "bold throughout".

   UNDO. A box's history is its own (a draft is not the document, and the
   document's undo, 12a-undo.js, never sees it): a stack of snapshots, each
   the box's stored HTML and its selection as model positions. A structural
   edit is one entry. Typing is left to the browser and recorded after the
   fact: the first input of a burst notes where it began, and the burst is
   closed — one entry — by a pause, by switching between typing and
   deleting, by the caret jumping elsewhere, or by the next structural edit,
   undo or redo. Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y and the browser's own
   historyUndo / historyRedo (a menu's Undo) answer from it (21-events.js),
   so the browser's own undo never runs in a draft box: after an edit it did
   not make, it would not know what to do. Nothing is recorded during an IME
   composition; it is one burst, closed once it ends. */

var PUA_FIRST = 0xE000;
var PUA_LAST = 0xF8FF;
var PUA_RE = /[\uE000-\uF8FF]/g;
var HISTORY_LIMIT = 200;
var TYPING_PAUSE_MS = 800;

/* ---- pictures as placeholder characters (pure) ---- */

function isMediaEl(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.tagName === "IMG") return true;
  return node.tagName === "A" && !!node.classList && node.classList.contains("video-embed-card");
}

/* A table of the placeholders one edit uses. `texts`: every string that
   will pass through it (the box's HTML, a paste's HTML and text), so no
   character already in any of them is ever taken for a placeholder. */
export function mediaTable(texts) {
  var reserved = {};
  (texts || []).forEach(function (t) {
    String(t == null ? "" : t).replace(PUA_RE, function (ch) { reserved[ch] = true; return ch; });
  });
  var next = PUA_FIRST;
  var table = {
    media: {},
    /* a picture's or a card's stored HTML -> its placeholder character */
    add: function (html) {
      while (next <= PUA_LAST && reserved[String.fromCharCode(next)]) next++;
      if (next > PUA_LAST) return "";
      var ch = String.fromCharCode(next++);
      reserved[ch] = true;
      table.media[ch] = html;
      return ch;
    },
    isMedia: function (ch) { return Object.prototype.hasOwnProperty.call(table.media, ch); },
    /* any HTML, through the sanitiser, as a cell with its pictures lifted */
    cell: function (html) { return fromHtml(liftMedia(html, table)); },
    /* the cell written back out, each placeholder its picture again */
    html: function (cell) { return dropMedia(toHtml(stripMediaMarks(cell, table.isMedia)), table); },
    markThroughout: function (cell, from, to, name) { return markThroughoutText(cell, from, to, name, table.isMedia); },
    toggleMark: function (cell, from, to, name) {
      return setMark(cell, from, to, name, !markThroughoutText(cell, from, to, name, table.isMedia));
    }
  };
  return table;
}

/* The sanitised HTML with each picture and video card replaced by a fresh
   placeholder from `table`. */
export function liftMedia(html, table) {
  var body = inertBody(sanitizeHtml(html == null ? "" : String(html)));
  var found = [];
  (function walk(node) {
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (isMediaEl(c)) found.push(c);
      else if (c.nodeType === 1) walk(c);
    }
  })(body);
  found.forEach(function (el) {
    var ch = table.add(el.outerHTML);
    if (ch) el.parentNode.replaceChild(body.ownerDocument.createTextNode(ch), el);
    else el.parentNode.removeChild(el);
  });
  return body.innerHTML;
}

function dropMedia(html, table) {
  return html.replace(PUA_RE, function (ch) { return table.isMedia(ch) ? table.media[ch] : ch; });
}

/* Every placeholder on its own, with no marks: a picture is never bold,
   linked or highlighted. */
export function stripMediaMarks(cell, isMedia) {
  var out = [];
  normalizeCell(cell).forEach(function (r) {
    if (r.atom) { out.push(r); return; }
    var buf = "";
    for (var i = 0; i < r.text.length; i++) {
      var ch = r.text[i];
      if (!isMedia(ch)) { buf += ch; continue; }
      if (buf) out.push({ text: buf, marks: r.marks });
      buf = "";
      out.push({ text: ch, marks: {} });
    }
    if (buf) out.push({ text: buf, marks: r.marks });
  });
  return normalizeCell(out);
}

/* markThroughout with the pictures left out, the way it already leaves out
   line breaks: every stretch of words between them must carry the mark,
   and at least one stretch must hold a word. */
export function markThroughoutText(cell, from, to, name, isMedia) {
  var a = Math.min(from, to), b = Math.max(from, to);
  var proj = projection(cell);
  var seen = false, start = a;
  for (var i = a; i <= b; i++) {
    if (i < b && !isMedia(proj[i])) continue;
    if (i > start) {
      var words = proj.slice(start, i).replace(/[\n\uFFFC]/g, "");
      if (words) {
        if (!markThroughout(cell, start, i, name)) return false;
        seen = true;
      }
    }
    start = i + 1;
  }
  return seen;
}

/* ---- the history (pure) ----

   {stack: [{html, sel}], index, pending}: stack[index] is the box as the
   last entry left it; pending means typing has changed it since. */

export function newHistory(snap) {
  return { stack: [snap], index: 0, pending: false, kind: null, lastSel: null };
}

/* Close a burst of typing: the box as it is now becomes an entry. */
export function historyCommit(h, snap) {
  if (!h.pending) return false;
  h.pending = false;
  h.kind = null;
  if (snap.html === h.stack[h.index].html) {
    h.stack[h.index].sel = snap.sel;
    return false;
  }
  historyPush(h, snap);
  return true;
}

/* A structural edit's result, as an entry of its own. Anything that was
   undone is gone. */
export function historyPush(h, snap) {
  h.stack.length = h.index + 1;
  h.stack.push(snap);
  if (h.stack.length > HISTORY_LIMIT) h.stack.splice(0, h.stack.length - HISTORY_LIMIT);
  h.index = h.stack.length - 1;
  h.pending = false;
  h.kind = null;
}

/* The selection an entry puts back: where it was when the next change
   began, so an undo leaves the caret where that change was made. */
export function historyNoteSelection(h, sel) {
  if (!h.pending && sel) h.stack[h.index].sel = sel;
}

/* `now` is the box as it is. Returns the entry to put on screen, or null
   when there is nothing to undo. */
export function historyUndo(h, now) {
  historyCommit(h, now);
  if (h.index === 0) return null;
  h.index--;
  return h.stack[h.index];
}

export function historyRedo(h, now) {
  /* typing since the last undo ended the redo branch, as it does anywhere */
  if (h.pending) { historyCommit(h, now); return null; }
  if (h.index >= h.stack.length - 1) return null;
  h.index++;
  return h.stack[h.index];
}

/* ---- the live box ---- */

var histories = new WeakMap();
var timers = new WeakMap();
var composing = new WeakSet();

/* A comment's composer or a reply box: an editable .cell-editable that is
   not a script cell (a row field in #rows or the writer). */
export function isDraftBox(el) {
  return !!(el && el.classList && el.classList.contains("cell-editable") &&
    el.getAttribute("contenteditable") === "true" && !el.closest("#rows, #writer-doc"));
}

function boxHtml(box) {
  var html = box.innerHTML;
  if (html.indexOf("\u200B") !== -1) html = html.replace(/\u200B/g, "");
  return storedHtmlFromDom(html);
}

function snapshot(box) {
  return { html: boxHtml(box), sel: cellSelection(box) };
}

function historyFor(box) {
  var h = histories.get(box);
  if (!h) {
    h = newHistory(snapshot(box));
    histories.set(box, h);
  }
  return h;
}

function clearTimer(box) {
  var t = timers.get(box);
  if (t) clearTimeout(t);
  timers.delete(box);
}

function commitTyping(box) {
  clearTimer(box);
  var h = histories.get(box);
  if (h && h.pending) historyCommit(h, snapshot(box));
}

/* The box was emptied or filled for a new draft (the composer opening,
   posting, cancelling): what it held before is not this draft's to undo. */
export function resetDraftHistory(box) {
  if (!box) return;
  clearTimer(box);
  histories.delete(box);
}

/* The box as a cell, with its pictures lifted — what the toolbar reads. */
export function draftModel(box, reserve) {
  var html = boxHtml(box);
  var table = mediaTable([html].concat(reserve || []));
  return { cell: table.cell(html), media: table, html: html };
}

/* fn(cell, sel, media) -> {cell, sel: {from, to}} to change the box, or null
   to leave it — editCell's contract (05b-cell-edit.js), plus `media`, the
   placeholder table: media.add(html) for a new picture, media.cell(html)
   for pasted HTML, media.toggleMark / markThroughout that leave pictures
   out. `reserve`: strings the edit will bring in (a paste), so no
   placeholder collides with a character in them. Returns the box, or null
   when fn declined. One undo entry of the box's own. */
export function editDraft(box, fn, reserve) {
  if (!isDraftBox(box)) return null;
  var h = historyFor(box);
  commitTyping(box);
  var sel = cellSelection(box);
  historyNoteSelection(h, sel);
  var m = draftModel(box, reserve);
  var out = fn(m.cell, sel, m.media);
  if (!out || !out.cell) return null;
  var next = m.media.html(out.cell);
  if (next !== m.html) box.innerHTML = next;
  box.focus({ preventScroll: true });
  if (out.sel) setCellSelection(box, out.sel.from, out.sel.to);
  /* the box as it now reads back, so a later snapshot of it compares
     equal to this entry however the browser serialises what was written */
  if (next !== m.html) historyPush(h, { html: boxHtml(box), sel: out.sel || null });
  else historyNoteSelection(h, out.sel || null);
  return box;
}

function restore(box, snap) {
  box.innerHTML = snap.html;
  box.focus({ preventScroll: true });
  if (snap.sel) setCellSelection(box, snap.sel.from, snap.sel.to);
  else {
    var r = document.createRange();
    r.selectNodeContents(box);
    r.collapse(false);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
}

export function draftUndo(box) {
  if (!isDraftBox(box) || composing.has(box)) return false;
  clearTimer(box);
  var snap = historyUndo(historyFor(box), snapshot(box));
  if (snap) restore(box, snap);
  return !!snap;
}

export function draftRedo(box) {
  if (!isDraftBox(box) || composing.has(box)) return false;
  clearTimer(box);
  var snap = historyRedo(historyFor(box), snapshot(box));
  if (snap) restore(box, snap);
  return !!snap;
}

/* ---- typing, recorded after the browser has done it ---- */

/* beforeinput, for anything the browser is about to do to the box itself
   (not an undo or a redo, which 21-events.js answers). The DOM is still as
   it was: this is where a burst begins, or where the previous one ends. */
export function noteDraftBeforeInput(box, e) {
  if (!isDraftBox(box)) return;
  var h = historyFor(box);
  if (e.isComposing || composing.has(box)) return;
  var kind = /^delete/.test(e.inputType || "") ? "delete" : "insert";
  var sel = cellSelection(box);
  if (h.pending) {
    var jumped = !sel || !h.lastSel || sel.from !== h.lastSel.to || sel.to !== h.lastSel.to;
    if (kind !== h.kind || jumped) {
      clearTimer(box);
      historyCommit(h, { html: boxHtml(box), sel: sel });
    }
  } else {
    historyNoteSelection(h, sel);
  }
  h.kind = kind;
}

/* input: the browser has changed the box. The burst stays open until a
   pause closes it. */
export function noteDraftInput(box) {
  if (!isDraftBox(box)) return;
  var h = historyFor(box);
  h.pending = true;
  h.lastSel = cellSelection(box);
  schedulePauseCommit(box);
}

function schedulePauseCommit(box) {
  clearTimer(box);
  timers.set(box, setTimeout(function () {
    timers.delete(box);
    if (composing.has(box)) return;
    commitTyping(box);
  }, TYPING_PAUSE_MS));
}

export function noteDraftComposition(box, on) {
  if (!isDraftBox(box)) return;
  if (on) {
    /* the typing before it is an entry of its own; the DOM is not yet
       changed, so reading it is safe */
    var hs = historyFor(box);
    commitTyping(box);
    historyNoteSelection(hs, cellSelection(box));
    composing.add(box);
  } else {
    composing.delete(box);
    var h = histories.get(box);
    if (h && h.pending) schedulePauseCommit(box);
  }
}

/* focus: the box as it is before anything is typed is the history's first
   entry, whatever the first change turns out to be */
export function noteDraftFocus(box) {
  if (isDraftBox(box)) historyFor(box);
}

/* ---- the structural edits a draft has that a script cell does not ---- */

/* A paste (or a drop) into the box, replacing the selection: the
   clipboard's HTML through the sanitiser — pictures and video cards welcome
   here, unlike in the script — else its text. */
export function pasteIntoDraft(box, html, text) {
  var clean = html ? sanitizeHtml(html) : "";
  if (!clean && !text) return null;
  return editDraft(box, function (cell, sel, media) {
    var from = sel ? sel.from : cellLength(cell);
    var rest = sel ? deleteRange(cell, sel.from, sel.to) : cell;
    var next = clean
      ? joinCells(joinCells(sliceCell(rest, 0, from), media.cell(clean)), sliceCell(rest, from))
      : insertText(rest, from, text);
    var at = from + cellLength(next) - cellLength(rest);
    return { cell: next, sel: { from: at, to: at } };
  }, [clean, text]);
}

/* A picture or a video card (its stored HTML) on a line of its own at the
   end of the box, as the Image and Video buttons have always put one. The
   caret stays where it was, or goes just past it. */
export function appendDraftMedia(box, mediaHtml) {
  return editDraft(box, function (cell, sel, media) {
    var ch = media.add(mediaHtml);
    if (!ch) return null;
    var n = cellLength(cell);
    return { cell: insertText(cell, n, "\n" + ch + "\n", {}), sel: sel || { from: n + 2, to: n + 2 } };
  }, [mediaHtml]);
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
