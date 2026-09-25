import { escapeHtml } from "./02-state.js";
import { storedHtmlFromDom } from "./04-richtext.js";
import { fromHtml, namedTagId, projection, replaceText, replaceWithTag } from "./04c-doc-model.js";
import { cellSelection, domToPos, editCell, setCellSelection } from "./05b-cell-edit.js";
import {
  isInsideTagOrLink,
  registerProductionTag,
  registryEntry,
  tagCategory,
  updateTagBadges
} from "./07-production-tags.js";
import { renderProduction } from "./08-production-panels.js";

/* ================= plain-language tagging (#210) =================

   THE CONVENTION — agreed with Adam on 2026-09-24. It is a typing
   convention, and every one of those needs his sign-off: change none of
   this (no new name, short form, trigger or key) without asking him first.

   1. The trigger is a category name followed by a colon, typed in the
      Visual column: "Prop:", "Location:", "Cast:", "VFX:", "Gear:", and
      "SFX:" or "Music:" (both Music/SFX). The ONLY short form is "Loc:"
      for Location. Any case: "vfx:", "Vfx:" and "VFX:" all work. No other
      names, no other short forms, and never in the Audio column (spoken
      words never start a tag).
   2. The keyword disappears the moment its colon is typed, and an open tag
      of that category starts where it was: drawn faintly in the category's
      colour, growing as you type, so it is plain what Tab will wrap.
   3. Tab wraps everything from where the keyword was up to the caret as one
      tag. The keyword is not part of it.
   4. Esc cancels the open tag and puts the plain "VFX:" back. Ctrl+Z after
      Tab takes back just the tag, the way it does for brackets: the typed
      words come back as they were typed, "VFX: lens flare", and nothing is
      tagged.
   5. Tab order: an open plain-language tag first, then the tag ghost, then
      the untagged-mention prompt (21-events.js onRootKeydown). Brackets are
      untouched by any of this.

   And Adam's answers to the questions building it raised (2026-09-24):
   6. A tap (or click) on the open tag's note under the cell (#tag-open-hint)
      closes it exactly as Tab does — the phone has no Tab key. It takes
      neither the focus nor the caret (pointerdown, 21-events.js).
   7. While a tag is open, a second keyword is just words; it neither
      closes the first nor starts another.
   8. Shift+Tab closes an open tag too, as it takes the ghost and the
      prompt. Intended.
   9. A bracket typed inside an open tag ("VFX: glow [zeb") is wrapped with
      the rest of the words: the open tag has Tab before the ghost.

   HOW. The keyword is never taken out of the document: until Tab, the
   document holds exactly what was typed. It is only hidden on screen, by
   wrapping its characters in a span app.css does not display
   (.plain-tag-keyword). The sanitiser unwraps an unknown span and keeps its
   text, so syncFieldFromDom stores "VFX: lens flare" as plain words, and a
   save, an autosave or a hosted peer only ever sees those — never a tag and
   never a half-open one. That is what makes every way out simple:

   - Tab is one model edit (editCell): the keyword and the words after it
     become the words, tagged. One undo entry after the typing's, the same
     shape as a closing bracket, so one Ctrl+Z gives back the typed text.
   - Esc, or anything else that ends the tag without Tab, unwraps the span
     — the screen goes back to what the document already says. No edit, no
     undo entry, nothing dirty.
   - A repaint of the cell from state (an undo, a remote change pulled in, a
     bracket or b-roll shortcut, a line break, any model edit) replaces the
     span along with everything else, and the keyword is back as the plain
     text it always was in state. The open tag is simply forgotten.

   What ends an open tag without Tab (decided building #210; each one leaves
   the plain typed text, keyword included):
   - the caret leaving it: moving before where the keyword was, into other
     text in the cell, a selection being made, focus leaving the cell (a
     click elsewhere, another scene, the Audio column);
   - Backspace with nothing typed after the keyword: the keyword comes back
     and that Backspace deletes its colon, as it would have;
   - anything that repaints the cell: a line break, a bracket shortcut
     closing inside it, an undo, a remote edit;
   - Tab with nothing but spaces typed after the keyword (nothing to tag).
   While a tag is open, a second keyword is just words (7 above).

   The painted part is a CSS Custom Highlight (::highlight(splitpage-open-
   tag-<cat>), app.css) over a live Range — like the untagged mentions
   (§3.8), a remark about the text rather than markup in it — and a small
   note under the cell (#tag-open-hint) naming the category and the key,
   which a tap closes as Tab does (6 above). */

/* Lower-case keyword -> category id. The whole vocabulary; see above. */
export var PLAIN_TAG_KEYWORDS = {
  prop: "prop",
  location: "location",
  loc: "location",
  cast: "cast",
  vfx: "vfx",
  gear: "gear",
  sfx: "sound",
  music: "sound"
};

var KEYWORD_AT_END_RE = /(prop|location|loc|cast|vfx|gear|sfx|music):$/i;
/* the same test for "part of a word" the tagger uses (TAG_WORD_CHAR_RE) */
var WORD_CHAR_RE = /[\p{L}\p{N}]/u;
/* the zero-width caret spot (ensureTrailingCaretSpot's), never stored,
   and the no-break space; spelled as code points so neither hides in the
   source */
var ZWSP = String.fromCharCode(0x200B);
var ZWSP_RE = new RegExp(ZWSP, "g");
var NBSP = String.fromCharCode(0xA0);
/* the composer's (applyTag) and the sanitiser's cap on a tag's name */
var NAME_MAX = 80;

/* `before` is the text of the cell up to the caret, the colon just typed
   last. Returns {cat, keyword, length} when it ends in one of the keywords
   standing as a word of its own — at the start, or after anything that is
   not a letter or a digit: "myVFX:" and "2VFX:" are not triggers, "(VFX:"
   and a line starting "VFX:" are. `keyword` is as typed, colon included,
   and `length` is its length. */
export function matchPlainTagKeyword(before) {
  var s = String(before == null ? "" : before);
  var m = KEYWORD_AT_END_RE.exec(s);
  if (!m) return null;
  var start = s.length - m[0].length;
  if (start > 0 && WORD_CHAR_RE.test(s.charAt(start - 1))) return null;
  var cat = PLAIN_TAG_KEYWORDS[m[1].toLowerCase()];
  if (!cat) return null;
  return { cat: cat, keyword: m[0], length: m[0].length };
}

/* What Tab makes of the words typed after the keyword: the spaces either
   side stay outside the tag (the one after the colon goes with the
   keyword, one typed before Tab stays where it is, after the tag), the
   words are the tag's text, and its name is those words on one line and
   at most 80 characters, as the Tag button names one. Null when there is
   nothing but spaces to tag. */
export function plainTagPhrase(typed) {
  var s = String(typed == null ? "" : typed).replace(ZWSP_RE, "");
  var text = s.trim();
  if (!text) return null;
  var lead = s.length - s.replace(/^\s+/, "").length;
  var trail = s.length - s.replace(/\s+$/, "").length;
  var name = text.replace(/\s+/g, " ").slice(0, NAME_MAX).trim();
  return { lead: lead, text: text, trail: trail, name: name };
}

/* The Tab edit on the model: the cell's words from..to are a keyword and
   what was typed after it; the keyword and the spaces round the words go,
   and the words become a tag of the keyword's category (the one `cat`
   says, checked against the keyword), named `name` or the words' own.
   The same mark every other typed route puts on (namedTagId, as
   tagTextRange does), so a Cast or Music/SFX tag made this way is the one
   the Tag button makes. Returns {cell, caret, name, cat} — caret just
   after the tag and any space typed after it — or null when the words
   there are not that. */
export function applyPlainTag(cell, from, to, cat, name) {
  var words = projection(cell).slice(from, to);
  var colon = words.indexOf(":");
  if (colon === -1) return null;
  var kw = matchPlainTagKeyword(words.slice(0, colon + 1));
  if (!kw || kw.length !== colon + 1 || kw.cat !== cat) return null;
  var p = plainTagPhrase(words.slice(colon + 1));
  if (!p) return null;
  var tagName = name || p.name;
  var r = replaceWithTag(cell, from, to - p.trail, p.text, namedTagId(cat, tagName));
  var out = r.cell;
  /* A space typed before Tab at the very end of the cell stays, as a
     no-break space — what the browser itself types there. A plain one is
     collapsed once the cell is repainted, and the next word typed would
     run straight on from the tag. (It can be plain: typed in front of the
     caret spot a tag at the end of a cell keeps after itself.) */
  var after = projection(out).slice(r.end);
  if (p.trail && after.length === p.trail && after.indexOf(" ") !== -1) {
    out = replaceText(out, r.end, r.end + p.trail, after.replace(/ /g, NBSP));
  }
  return { cell: out, caret: r.end + p.trail, name: tagName, cat: cat };
}

/* ---- the open tag, on screen ---- */

/* { cellEl, span, tail, cat, keyword }: span holds the hidden keyword,
   tail is the text node after it the words are typed into. */
var open = null;
var HL_PREFIX = "splitpage-open-tag-";

function highlightApiOk() {
  return !!(window.CSS && CSS.highlights && window.Highlight);
}

function hintEl() { return document.getElementById("tag-open-hint"); }

/* Is a plain-language tag open (in `cellEl`, when given)? Read by the Tab,
   Escape and Backspace branches in onRootKeydown and by the untagged
   prompt, which stays away while one is. */
export function plainTagOpen(cellEl) {
  if (!open || !stillThere(open)) return false;
  return !cellEl || open.cellEl === cellEl;
}

function stillThere(o) {
  return o.cellEl.isConnected && o.span.isConnected && o.cellEl.contains(o.span) &&
    o.tail.isConnected && o.tail.previousSibling === o.span;
}

/* The caret, when it is somewhere the open tag can grow from: collapsed, in
   the text node after the keyword. Null otherwise. */
function caretInOpen(o) {
  if (document.activeElement !== o.cellEl) return null;
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
  var r = sel.getRangeAt(0);
  if (r.startContainer !== o.tail) return null;
  return r.startOffset;
}

function clearPaint() {
  if (highlightApiOk()) {
    try {
      Object.keys(PLAIN_TAG_KEYWORDS).forEach(function (k) { CSS.highlights.delete(HL_PREFIX + PLAIN_TAG_KEYWORDS[k]); });
    } catch (e) { /* a partial implementation — nothing was painted */ }
  }
  var el = hintEl();
  if (el) el.classList.remove("is-visible");
}

function paint(o, offset) {
  if (highlightApiOk()) {
    try {
      /* from the first word, not the space after the colon: exactly what
         Tab would wrap (plainTagPhrase) */
      var from = 0, data = o.tail.data;
      while (from < offset && (data.charAt(from) === ZWSP || /\s/.test(data.charAt(from)))) from++;
      var range = document.createRange();
      range.setStart(o.tail, from);
      range.setEnd(o.tail, offset);
      CSS.highlights.set(HL_PREFIX + o.cat, new Highlight(range));
    } catch (e) { /* go without the tint; the note below still says it is open */ }
  }
  var el = hintEl();
  if (!el) return;
  var cat = tagCategory(o.cat);
  if (el.getAttribute("data-cat") !== o.cat) {
    el.setAttribute("data-cat", o.cat);
    el.innerHTML = '<span class="tag-cat-dot" data-tag-cat="' + cat.id + '" style="--dot: ' + cat.color + '"></span>' +
      '<b>' + escapeHtml(cat.label) + '</b>' +
      '<span class="tag-suggest-cat">tag</span><kbd>Tab</kbd>';
  }
  el.classList.add("is-visible");
  /* under the cell, where the untagged prompt goes (which stays away while
     this is up), lined up with where the keyword was */
  var w = el.offsetWidth, h = el.offsetHeight;
  var at = document.createRange();
  at.setStart(o.tail, 0);
  at.collapse(true);
  var rect = at.getClientRects()[0] || o.cellEl.getBoundingClientRect();
  var cellRect = o.cellEl.getBoundingClientRect();
  var top = cellRect.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, cellRect.top - h - 6);
  el.style.left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - w - 8)) + "px";
  el.style.top = top + "px";
}

/* Put the keyword back on screen: the span unwrapped and the caret spot
   this put after it taken out again. The document already says exactly
   this, so nothing is stored and nothing is recorded. The selection is
   kept by its model positions, which unwrapping does not move. */
function unwrap(o) {
  if (!o.span.isConnected) return;
  var sel = o.cellEl.isConnected ? cellSelection(o.cellEl) : null;
  var parent = o.span.parentNode;
  if (o.tail.isConnected && o.tail.previousSibling === o.span && o.tail.data.charAt(0) === ZWSP) {
    o.tail.deleteData(0, 1);
  }
  while (o.span.firstChild) parent.insertBefore(o.span.firstChild, o.span);
  parent.removeChild(o.span);
  parent.normalize();
  if (sel && document.activeElement === o.cellEl) setCellSelection(o.cellEl, sel.from, sel.to);
}

/* Ends the open tag without tagging: the plain typed text again. */
export function cancelPlainTag() {
  var o = open;
  open = null;
  clearPaint();
  if (o) unwrap(o);
}

/* Follows the caret: called after every keystroke in a script cell, on
   every selection change, and on scroll and resize. Anything that has
   taken the caret out of the open tag, or repainted it away, ends it. */
export function refreshPlainTag() {
  var o = open;
  if (!o) return;
  if (!stillThere(o)) { open = null; clearPaint(); return; }
  var at = caretInOpen(o);
  if (at === null) { cancelPlainTag(); return; }
  paint(o, at);
}

/* Is the caret at the very start of the open tag, nothing typed after the
   keyword yet (or all of it deleted again)? Backspace there cancels. */
export function plainTagEmptyAtCaret() {
  var o = open;
  if (!o || !stillThere(o)) return false;
  var at = caretInOpen(o);
  return at !== null && !o.tail.data.slice(0, at).replace(ZWSP_RE, "");
}

/* onRootInput, for a typed colon: a keyword just finished in a Visual cell
   opens a tag. Only live typing (insertText), like the bracket shortcuts,
   so a paste, an import or a merge never opens one. */
export function maybeOpenPlainTag(e, cellEl) {
  if (e.inputType !== "insertText" || !e.data || e.data.charAt(e.data.length - 1) !== ":") return;
  if (cellEl.getAttribute("data-field") !== "visualText" || !cellEl.closest("#rows")) return;
  if (plainTagOpen()) return;
  if (open) { open = null; clearPaint(); }
  var sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  var range = sel.getRangeAt(0);
  var node = range.startContainer;
  var offset = range.startOffset;
  if (node.nodeType !== 3 || !cellEl.contains(node)) return;
  if (isInsideTagOrLink(node.parentNode)) return;

  var raw = node.data.slice(0, offset);
  var tail = KEYWORD_AT_END_RE.exec(raw);
  if (!tail) return;
  var kwStart = offset - tail[0].length;
  /* what comes before the keyword in the cell, for the word test: in this
     text node, or — at its start — the character before it in the cell
     (another run of formatting, a line break, a tag's words) */
  var before = raw.slice(0, kwStart).replace(ZWSP_RE, "");
  if (!before) before = charBeforeNode(cellEl, node);
  var kw = matchPlainTagKeyword(before + tail[0]);
  if (!kw) return;

  var rest = node.splitText(offset);
  var kwNode = node.splitText(kwStart);
  var span = document.createElement("span");
  span.className = "plain-tag-keyword";
  span.setAttribute("contenteditable", "false");
  kwNode.parentNode.insertBefore(span, kwNode);
  span.appendChild(kwNode);
  /* a caret spot of its own after the hidden keyword, so the caret — and
     every character typed at it — lands after it and not before it */
  rest.insertData(0, ZWSP);
  var r = document.createRange();
  r.setStart(rest, 1);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  open = { cellEl: cellEl, span: span, tail: rest, cat: kw.cat, keyword: kwNode.data };
  paint(open, 1);
}

function charBeforeNode(cellEl, node) {
  var pos = domToPos(cellEl, node, 0);
  if (!pos) return "";
  var html = storedHtmlFromDom(cellEl.innerHTML.replace(ZWSP_RE, ""));
  return projection(fromHtml(html)).charAt(pos - 1);
}

/* Tab: wrap the open tag, or — with nothing typed after the keyword — put
   the keyword back. Either way the Tab is spent here. */
export function closePlainTag() {
  var o = open;
  if (!o || !stillThere(o)) { open = null; clearPaint(); return false; }
  var at = caretInOpen(o);
  var typed = at === null ? "" : o.tail.data.slice(0, at);
  var phrase = at === null ? null : plainTagPhrase(typed);
  if (!phrase) { cancelPlainTag(); return true; }
  open = null;
  clearPaint();
  /* an item already tracked under these words keeps its own spelling —
     the words keep theirs (acceptUntaggedMention does the same) */
  var entry = registryEntry(o.cat, phrase.name);
  var name = entry ? entry.name : phrase.name;
  var done = editCell(o.cellEl, function (cell) {
    var from = domToPos(o.cellEl, o.span.firstChild, 0), to = domToPos(o.cellEl, o.tail, at);
    if (from === null || to === null) return null;
    if (projection(cell).slice(from, to) !== o.keyword + typed.replace(ZWSP_RE, "")) return null;
    var res = applyPlainTag(cell, from, to, o.cat, name);
    if (!res) return null;
    registerProductionTag(o.cat, res.name);
    return { cell: res.cell, sel: { from: res.caret, to: res.caret } };
  });
  /* Not taken — the model did not read the same words there: the words
     stay the plain words they are, keyword and all. */
  if (!done) { unwrap(o); return true; }
  updateTagBadges();
  renderProduction();
  return true;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
