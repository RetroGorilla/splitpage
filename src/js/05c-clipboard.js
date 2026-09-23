import { S } from "./_state.js";
import { randomHexBytes } from "./02b-doc-id.js";
import { findRowIndex } from "./03-sync.js";
import { inertBody, storedHtmlFromDom } from "./04-richtext.js";
import {
  cellLength,
  commentIds,
  deleteRange,
  fromHtml,
  insertText,
  joinCells,
  normalizeCell,
  projection,
  sliceCell,
  syncCommentAnchors,
  toHtml
} from "./04c-doc-model.js";
import { cellSelection, editCell } from "./05b-cell-edit.js";

/* ================= copy, cut, paste and drop in a script cell (#85, design §5) =================

   What a script cell puts on the clipboard, and what it takes off it, goes
   through the document model (04c-doc-model.js) rather than the browser's
   own contenteditable copy and execCommand("insertHTML"):

   - COPY puts the selected slice of the cell on the clipboard as the
     model's own HTML (toHtml) and its plain text. It never carries a
     comment (design D6): a comment is one conversation about one place in
     the script, and a copy of its words is not that place.
   - CUT then PASTE in the same tab MOVES a comment with its words (D6).
     The cut keeps the comment marks and tags its HTML with a nonce only
     this tab knows, held in memory here and nowhere else. A paste keeps
     comment marks only from HTML carrying the live nonce, and only for
     comments this document still has; everything else pasted — another
     tab's cut, another app, a second paste of the same cut — lands with
     no comment. The moved comment's rowId/field follow its marks
     (syncCommentAnchors, 04c-doc-model.js), so its card and its "jump to"
     point at the new place.
   - PASTE and DROP read the HTML flavour (else the plain text), turn it
     into a cell with fromHtml — the sanitiser first, so nothing foreign
     gets in — and replace the selection with it as one model edit
     (editCell): one undo entry, the caret after what was pasted. Pictures
     and video cards are dropped (D7): a script cell holds words, and a
     comment or the scene picture is where a picture goes.

   The pure half (what goes on the clipboard, what comes off it) is
   exported for src/test/clipboard.test.mjs; the DOM half is called from
   21-events.js, which keeps everything around it (the refresh of the
   breakdown, the b-roll list and the counters, the caret kept in view). */

var CUT_ATTR = "data-splitpage-cut";

/* ---- the pure half ---- */

function never() { return false; }
function always() { return true; }

/* The cell with every comment mark gone. */
export function stripComments(cell) {
  return normalizeCell(cell, { hasComment: never });
}

/* What a copy or cut of `cell` (a slice) puts on the clipboard: {html,
   text}. opts.keepComments keeps its comment marks (a cut); opts.nonce
   tags the HTML as this tab's cut. The plain text is the words as they
   read, a line break as "\n", a b-roll key as its letters. */
export function clipboardOfCell(cell, opts) {
  opts = opts || {};
  var c = opts.keepComments ? normalizeCell(cell) : stripComments(cell);
  var html = toHtml(c);
  if (opts.nonce) html = "<span " + CUT_ATTR + '="' + String(opts.nonce).replace(/[^A-Za-z0-9]/g, "") + '">' + html + "</span>";
  var text = "";
  c.forEach(function (r) { text += r.text; });
  return { html: html, text: text.replace(/\u00a0/g, " ") };
}

/* The cut nonce clipboard HTML carries, or null. Read off the raw HTML,
   before the sanitiser (which drops the attribute). */
export function cutNonceIn(html) {
  var m = new RegExp(CUT_ATTR + "\\s*=\\s*[\"']?([A-Za-z0-9]+)").exec(String(html == null ? "" : html));
  return m ? m[1] : null;
}

/* The clipboard's HTML without its pictures and video cards, counted, and
   whether it ends in a paragraph. Taken out BEFORE the sanitiser sees
   them: it would intern an inline data: picture (hash it, queue its bytes
   for storage) only for the model to drop it. */
function prepareHtml(html) {
  var body = inertBody(html);
  var media = 0;
  Array.prototype.forEach.call(body.querySelectorAll("img, picture, video, a.video-embed-card"), function (el) {
    if (!el.parentNode) return;
    if (el.tagName === "IMG" || el.tagName === "A") media++;
    el.parentNode.removeChild(el);
  });
  /* What a word processor or a page puts on the clipboard beside the
     words — a style sheet, a script, a title — is not words anyone
     copied; the sanitiser would keep its text as if it were. */
  Array.prototype.forEach.call(body.querySelectorAll("style, script, template, noscript, title, meta, link"), function (el) {
    if (el.parentNode) el.parentNode.removeChild(el);
  });
  /* A copy from a web page or a word processor ends in a paragraph, and
     the sanitiser reads each paragraph as its text plus a line break — so
     one pasted sentence would land with a line break after it. The last
     block's own break is dropped; a blank line copied after it stays.
     Whitespace and HTML comments after it show nothing, and go. */
  var last = body.lastChild;
  while (last && (last.nodeType === 8 || (last.nodeType === 3 && !/\S/.test(last.nodeValue)))) {
    body.removeChild(last);
    last = body.lastChild;
  }
  var endsInBlock = !!(last && last.nodeType === 1 && (last.tagName === "P" || last.tagName === "DIV"));
  return { html: body.innerHTML, media: media, endsInBlock: endsInBlock };
}

/* What a paste or a drop inserts, from the clipboard's HTML (or, when
   that gives nothing, its plain text):
     {cell, text, media, fromCut, comments}
   text is non-null when it came from the plain text, which is inserted as
   typing is (taking on the formatting where it lands); cell is what goes
   in otherwise. media is how many pictures and video cards were dropped.
   fromCut: the HTML is this tab's live cut (opts.nonce), and only then do
   comment marks survive — the ones opts.hasComment(id) knows, listed in
   comments. */
export function cellFromClipboard(html, text, opts) {
  opts = opts || {};
  var media = 0;
  if (html) {
    var raw = String(html);
    var fromCut = !!(opts.nonce && cutNonceIn(raw) === opts.nonce);
    var prep = prepareHtml(raw);
    media = prep.media;
    var cell = fromHtml(prep.html, { hasComment: fromCut ? (opts.hasComment || always) : never });
    if (prep.endsInBlock && projection(cell).slice(-1) === "\n") cell = sliceCell(cell, 0, cellLength(cell) - 1);
    if (cellLength(cell)) {
      return { cell: cell, text: null, media: media, fromCut: fromCut, comments: fromCut ? commentIds(cell) : [] };
    }
  }
  var t = text == null ? "" : String(text);
  return { cell: normalizeCell([{ text: t, marks: {} }]), text: t, media: media, fromCut: false, comments: [] };
}

/* ---- the DOM half ---- */

/* This tab's live cut: set by a cut, spent by the paste that uses it. */
var cutNonce = null;

function isTextField(field) {
  return field === "visualText" || field === "audioText";
}

/* A comment this document has, named by the id its anchor spans carry. */
function commentAnchoredAs(id) {
  return !!S.state && (S.state.comments || []).some(function (c) {
    return c.kind !== "conflict" && (c.anchorId || c.id) === id;
  });
}

/* The cell's model as it is on screen right now — what syncFieldFromDom
   would store — without storing it: a copy changes nothing. */
function liveCellHtml(cellEl) {
  var html = cellEl.innerHTML;
  if (html.indexOf("\u200B") !== -1) html = html.replace(/\u200B/g, "");
  return storedHtmlFromDom(html);
}

/* A copy (cut false) or cut of the selection inside one script cell.
   Returns false when it is not one this handles — nothing selected, a
   selection reaching outside the cell, a cell still holding a picture —
   and the browser's own copy runs; otherwise the clipboard is written
   and, for a cut, the selection deleted as one model edit. readOnly (a
   review session) makes a cut a copy: nothing there may be deleted. */
export function copyFromCell(e, cellEl, cut, readOnly) {
  var cd = e.clipboardData;
  var field = cellEl.getAttribute("data-field");
  if (!cd || !S.state || !isTextField(field) || findRowIndex(cellEl.getAttribute("data-id")) === -1) return false;
  var html = liveCellHtml(cellEl);
  if (/<img|video-embed-card/.test(html)) return false;
  var sel = cellSelection(cellEl);
  if (!sel || sel.from === sel.to) return false;
  var moving = cut && !readOnly;
  var nonce = moving ? randomHexBytes(16) : null;
  var out = clipboardOfCell(sliceCell(fromHtml(html), sel.from, sel.to), { keepComments: moving, nonce: nonce });
  cd.setData("text/html", out.html);
  cd.setData("text/plain", out.text);
  e.preventDefault();
  if (!moving) return true;
  cutNonce = nonce;
  editCell(cellEl, function (cell, s) {
    if (!s || s.from === s.to) return null;
    return { cell: deleteRange(cell, s.from, s.to), sel: { from: s.from, to: s.from } };
  });
  return true;
}

/* A paste or a drop into a script cell, replacing the selection (or at the
   end of the cell when the selection is elsewhere). Returns
     {done, cellEl, media, movedComments, fallback}
   done false means the cell still holds a picture or a video card, which
   editCell does not edit (05b-cell-edit.js): the caller inserts
   `fallback` — {html} or {text}, already sanitised and with no comment —
   the way it used to. */
export function pasteIntoCell(cellEl, html, text) {
  var got = cellFromClipboard(html, text, { nonce: cutNonce, hasComment: commentAnchoredAs });
  var result = { done: true, cellEl: cellEl, media: got.media, movedComments: false, fallback: null };
  if (!cellLength(got.cell)) return result;
  var fresh = editCell(cellEl, function (cell, sel) {
    var from = sel ? sel.from : cellLength(cell);
    var rest = sel ? deleteRange(cell, sel.from, sel.to) : cell;
    var next = got.text !== null
      ? insertText(rest, from, got.text)
      : joinCells(joinCells(sliceCell(rest, 0, from), got.cell), sliceCell(rest, from));
    var at = from + cellLength(next) - cellLength(rest);
    /* The comment moving is part of the same paste, so it goes in with the
       cell as one undo entry (editCell's also, run once the pasted cell is
       in state, where syncCommentAnchors finds its marks). A cut of part
       of a comment's words leaves the rest marked where they were, and the
       comment points at whichever comes first in the script. */
    var also = null;
    if (got.fromCut) {
      also = function () {
        cutNonce = null;
        if (got.comments.length) syncCommentAnchors(S.state);
        result.movedComments = got.comments.length > 0;
      };
    }
    return { cell: next, sel: { from: at, to: at }, also: also };
  });
  if (!fresh) {
    result.done = false;
    result.fallback = got.text !== null ? { text: got.text } : { html: toHtml(stripComments(got.cell)) };
    return result;
  }
  result.cellEl = fresh;
  return result;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
