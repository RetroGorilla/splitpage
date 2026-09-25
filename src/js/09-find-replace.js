import { S } from "./_state.js";
import { revealRow } from "./01b-hide-shot.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { cssAttr, inertBody, sanitizeHtml } from "./04-richtext.js";
import { cellOf, projection, replaceText, toHtml } from "./04c-doc-model.js";
import { render } from "./05-render.js";
import { registryTagHooks } from "./07-production-tags.js";
import { BROLL_MARKER_RE } from "./08c-broll.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { reviewBlocked } from "./13-hosted.js";
import { queueAutoSave } from "./14-export.js";

/* ================= find & replace =================

   Matching happens on a cell's TEXT as the document model reads it
   (cellOf, 04c-doc-model.js, #85) — its projection, the plain text with a
   b-roll key as one character — never on the HTML string. Running a regex
   over the markup would happily rewrite the inside of an attribute — a
   tag's stored name, a link's href, a comment anchor's id — and corrupt the
   document in ways that only show up much later. Replacing is the model's
   replaceText(), so formatting, links, tags and anchors all survive a
   replace, and the cell is written back as toHtml() of the result.

   Because the text is the projection rather than one text node at a time,
   a match may run across a formatting boundary ("wid<strong>get</strong>")
   or into and out of a comment. It may NOT touch a tagged word or a b-roll
   key: those are atomic everywhere else in the app (you cannot type inside
   one — see the contenteditable="false" note), and rewriting a tag's words
   here would leave the visible text saying one thing while the tag still
   tracked another. Renaming a tag is the Production panel's job, which
   changes both halves together. Words inside a comment ARE replaceable:
   the comment card compares its quote with the anchor's live text and says
   so with a "Changed" tag (10-comments.js), so the panel never shows a
   quote as current when it is not. */

export var findOpen = false;
S.findMatchCase = false;
var findMatches = [];      /* [{rowId, field, nth}] in document order */
var findIndex = -1;
var findInTags = 0;        /* occurrences inside tags: shown, never matched */

function findNeedle() {
  return document.getElementById("find-input").value || "";
}

function escapeRegExpLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* Every match-finding function below used to lowercase a copy of the
   haystack with String#toLowerCase() and hunt through it with
   String#indexOf(), then apply the resulting index straight to the
   ORIGINAL string. That breaks for the handful of characters whose
   lowercase form is a different length from the character itself — "İ"
   (Latin capital I with dot above) becomes the two-character "i̇" under
   toLowerCase(), so every index found in the lowercased copy from that
   point on is off by one in the real string. On a match, that shifted
   index landed replaceInHtml's slice points somewhere mid-run of
   surrounding text, splicing the replacement into the wrong place and
   corrupting the row's content.

   A case-insensitive regex sidesteps the whole problem: it compares
   characters against the untouched original string one at a time (no
   transformed copy ever exists), so match indices are always correct
   positions in `text`, and a literal pattern's match is always exactly
   needle.length characters long. */
function findAllMatches(text, needle, matchCase) {
  if (!needle) return [];
  var re = new RegExp(escapeRegExpLiteral(needle), matchCase ? "g" : "gi");
  var out = [], m;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/* A cell cut into what a search may and may not touch, each piece with its
   offset into the cell's projection: `free` is every stretch of text with
   no tag on it, running across formatting and comments; `tagged` is each
   tag's own words, one piece per tag. A b-roll key belongs to neither and
   ends the stretch it sits in, so no match can reach across it. */
function searchablePieces(cell) {
  var free = [], tagged = [];
  var pos = 0, cur = null, curTag = null;
  cell.forEach(function (r) {
    if (r.atom) { cur = null; curTag = null; pos += 1; return; }
    var tag = r.marks.tag;
    if (tag) {
      cur = null;
      if (curTag && curTag.tag === tag) curTag.text += r.text;
      else tagged.push(curTag = { tag: tag, start: pos, text: r.text });
    } else {
      curTag = null;
      if (cur) cur.text += r.text;
      else free.push(cur = { start: pos, text: r.text });
    }
    pos += r.text.length;
  });
  return { free: free, tagged: tagged };
}

/* Every match in a cell, as {from, to} offsets into its projection, in
   order. */
export function findInCell(cell, needle, matchCase) {
  if (!needle) return [];
  return matchesInPieces(searchablePieces(cell), needle, matchCase);
}

function matchesInPieces(pieces, needle, matchCase) {
  var out = [];
  pieces.free.forEach(function (p) {
    findAllMatches(p.text, needle, matchCase).forEach(function (m) {
      out.push({ from: p.start + m.start, to: p.start + m.end });
    });
  });
  return out;
}

/* How many occurrences sit inside tags and so cannot be replaced — used
   only to explain the difference rather than leave it mysterious. */
export function countInTags(cell, needle, matchCase) {
  if (!needle) return 0;
  return countInPieces(searchablePieces(cell), needle, matchCase);
}

function countInPieces(pieces, needle, matchCase) {
  return pieces.tagged.reduce(function (n, p) {
    return n + findAllMatches(p.text, needle, matchCase).length;
  }, 0);
}

/* The whole document's matches, [{rowId, field, nth}] in document order,
   and how many more occurrences sit inside tags. Both come from the one
   cut of each cell, so the in-tag count costs the find count no second
   pass over the document (HANDOFF invariant #6). The in-tag number is for
   display only: nothing ever selects or replaces one. */
export function findInRows(rows, needle, matchCase) {
  var matches = [], inTags = 0;
  if (!needle) return { matches: matches, inTags: inTags };
  (rows || []).forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      var pieces = searchablePieces(cellOf(row[field]));
      var n = matchesInPieces(pieces, needle, matchCase).length;
      for (var i = 0; i < n; i++) matches.push({ rowId: row.id, field: field, nth: i });
      inTags += countInPieces(pieces, needle, matchCase);
    });
  });
  return { matches: matches, inTags: inTags };
}

/* What the find bar's count says when nothing can be stepped to: plain
   "No matches", or — when the only occurrences are inside tags — how many,
   so a search for a tagged word does not look like a miss. */
export function noMatchLabel(inTags) {
  if (!inTags) return "No matches";
  return "No matches · " + (inTags === 1 ? "1 in a tag" : inTags + " in tags");
}

/* ---- the projection in a DOM ----

   Where each character of a cell's projection lives in a DOM holding the
   cell's HTML — the live cell on screen, or an inert parse of the stored
   string. This walks the DOM the way fromHtml() reads it, so the offsets
   find works in land on the characters they were found in:
     - text is one character per character, except that a run of line
       feeds / carriage returns is ONE (it shows as one space), and a
       zero-width space (ensureTrailingCaretSpot's caret spot), the other C0
       controls and U+FFFC are none;
     - <br> is one ("\n"), and so is the end of a <div>/<p> (the sanitiser
       turns each into a line break, and a blank one into just that);
     - a b-roll key is one, the atom;
     - a picture or a video card is none (design D7).
   Each entry is {text, sc, so, ec, eo}: the character, and where it
   starts and ends as DOM boundary points. */
export function domProjection(root) {
  var out = [];
  function at(node, index) { return { sc: node, so: index, ec: node, eo: index + 1 }; }
  function push(ch, pos) { pos.text = ch; out.push(pos); }
  (function walk(parent) {
    for (var i = 0; i < parent.childNodes.length; i++) {
      var child = parent.childNodes[i];
      if (child.nodeType === 3) {
        var v = child.nodeValue || "";
        for (var k = 0; k < v.length; k++) {
          var c = v[k];
          if (c === "\n" || c === "\r") {
            var e = k + 1;
            while (e < v.length && (v[e] === "\n" || v[e] === "\r")) e++;
            push(" ", { sc: child, so: k, ec: child, eo: e });
            k = e - 1;
          } else if (!DROPPED_CHAR_RE.test(c)) {
            push(c, at(child, k));
          }
        }
        continue;
      }
      if (child.nodeType !== 1) continue;
      var tag = child.tagName;
      var cls = child.classList;
      if (tag === "BR") { push("\n", at(parent, i)); continue; }
      if (tag === "IMG") continue;
      if (tag === "A" && cls && cls.contains("video-embed-card")) continue;
      if (tag === "SPAN" && cls && cls.contains("broll-key") &&
          BROLL_MARKER_RE.test((child.textContent || "").replace(DROPPED_CHARS_RE, "").trim())) {
        push(OBJ, at(parent, i));
        continue;
      }
      if (tag === "DIV" || tag === "P") {
        var blank = child.childNodes.length === 1 && child.firstChild.nodeType === 1 && child.firstChild.tagName === "BR";
        if (!blank) walk(child);
        push("\n", { sc: parent, so: i + 1, ec: parent, eo: i + 1 });
        continue;
      }
      walk(child);
    }
  })(root);
  return out;
}

/* eslint-disable-next-line no-control-regex -- the characters cleanText() (04c-doc-model.js) drops. */
var DROPPED_CHAR_RE = /[\u0000-\u0008\u000B-\u001F\u200B\uFFFC]/;
/* eslint-disable-next-line no-control-regex -- the same set, for a whole string. */
var DROPPED_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u200B\uFFFC]/g;
var OBJ = "\uFFFC";

/* A DOM Range over projection offsets [from, to) of a cell whose DOM is
   `root`, or null when the DOM does not hold the text `expect` says it
   should (the cell on screen is not the stored one) — a range over the
   wrong words is worse than none. */
export function domRangeFor(root, from, to, expect) {
  var chars = domProjection(root);
  var text = chars.map(function (c) { return c.text; }).join("");
  if (text !== expect || from >= to || to > chars.length) return null;
  var range = (root.ownerDocument || document).createRange();
  range.setStart(chars[from].sc, chars[from].so);
  range.setEnd(chars[to - 1].ec, chars[to - 1].eo);
  return range;
}

/* Replace the nth match in one field (nth === -1 means every one),
   returning the new HTML and how many were changed. `hooks` is
   registryTagHooks() of the registry, for writing tags back.

   The replacement takes the marks of the first character it replaces
   (replaceText), so a word replaced in bold stays bold and one inside a
   comment stays inside it. The cell is then written as toHtml(): one
   canonical nesting, so a replaced cell's HTML can differ from before in
   how its elements nest — never in what they say.

   The one exception is a cell holding a pasted picture or video card
   (reachable only by pasting HTML): the model has no place for either
   (design D7) and writing it back would silently delete them, so that
   cell is edited in place instead — the same offsets, mapped onto an inert
   parse of its HTML, the replacement typed where the first replaced
   character was — and sanitised as before. */
export function replaceInHtml(html, needle, replacement, nth, matchCase, hooks) {
  var cell = cellOf(html);
  var matches = findInCell(cell, needle, matchCase);
  if (nth !== -1) matches = matches[nth] ? [matches[nth]] : [];
  if (!matches.length) return { html: html, changed: 0 };
  var text = replacement == null ? "" : String(replacement);
  /* last first, so every earlier offset still points where it did */
  var todo = matches.slice().reverse();
  if (/<img[\s>]|video-embed-card/i.test(html || "")) {
    var body = inertBody(html);
    var expect = projection(cell);
    for (var i = 0; i < todo.length; i++) {
      var range = domRangeFor(body, todo[i].from, todo[i].to, expect);
      if (!range) return { html: html, changed: 0 };
      range.deleteContents();
      if (text) range.insertNode(body.ownerDocument.createTextNode(text));
      expect = expect.slice(0, todo[i].from) + text + expect.slice(todo[i].to);
    }
    /* a match that ended inside an element leaves that element empty (the
       range keeps what it only partly covered); the model writes no empty
       elements, so neither does this */
    Array.prototype.forEach.call(body.querySelectorAll("strong, em, u, s, mark, a, span.cmt-anchor, span.stage-dir"), function (el) {
      if (el.parentNode && !el.textContent && !el.querySelector("img, br")) el.parentNode.removeChild(el);
    });
    return { html: sanitizeHtml(body.innerHTML), changed: matches.length };
  }
  todo.forEach(function (m) { cell = replaceText(cell, m.from, m.to, text); });
  return { html: toHtml(cell, hooks), changed: matches.length };
}

export function refreshFindMatches(keepIndex) {
  var found = findInRows(S.state ? S.state.rows : [], findNeedle(), S.findMatchCase);
  findMatches = found.matches;
  findInTags = found.inTags;
  if (!findMatches.length) findIndex = -1;
  else if (!keepIndex || findIndex < 0) findIndex = 0;
  else if (findIndex >= findMatches.length) findIndex = findMatches.length - 1;
  updateFindCount();
}

function updateFindCount() {
  var el = document.getElementById("find-count");
  if (!el) return;
  var needle = findNeedle();
  el.removeAttribute("title");
  if (!needle) { el.textContent = ""; el.classList.remove("none"); return; }
  if (!findMatches.length) {
    el.textContent = noMatchLabel(findInTags);
    if (findInTags) el.title = "Find never changes a tag's words — rename it in Production instead.";
    el.classList.add("none");
    return;
  }
  el.classList.remove("none");
  el.textContent = (findIndex + 1) + " of " + findMatches.length;
}

/* Select the match in the live DOM rather than marking it up: the browser's
   own selection highlight costs no document changes, and it leaves the
   caret exactly where Replace needs to act. The match's offsets are found
   in the stored cell and mapped onto the cell on screen, which is that
   same HTML rendered (plus, perhaps, a zero-width caret spot the mapping
   skips); a selection may start in one element and end in another. */
function revealFindMatch() {
  if (findIndex < 0 || !findMatches[findIndex]) return;
  var m = findMatches[findIndex];
  revealRow(m.rowId);
  var cell = document.querySelector('#rows .row[data-id="' + cssAttr(m.rowId) + '"] .cell-editable[data-field="' + m.field + '"]');
  if (!cell) return;
  var idx = findRowIndex(m.rowId);
  if (idx === -1) return;
  var model = cellOf(S.state.rows[idx][m.field]);
  var hit = findInCell(model, findNeedle(), S.findMatchCase)[m.nth];
  if (!hit) return;
  var range = domRangeFor(cell, hit.from, hit.to, projection(model));
  if (range) {
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  cell.focus();
  var row = cell.closest(".row");
  if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function stepFind(dir) {
  if (!findMatches.length) return;
  findIndex = (findIndex + dir + findMatches.length) % findMatches.length;
  updateFindCount();
  revealFindMatch();
}

export function replaceCurrent() {
  if (reviewBlocked()) return;   /* find still works; replacing is an edit */
  var needle = findNeedle();
  if (!needle || findIndex < 0 || !findMatches[findIndex]) return;
  var m = findMatches[findIndex];
  var idx = findRowIndex(m.rowId);
  if (idx === -1) return;
  var replacement = document.getElementById("replace-input").value || "";
  var res = replaceInHtml(S.state.rows[idx][m.field], needle, replacement, m.nth, S.findMatchCase,
    registryTagHooks(S.state.productionTags));
  if (!res.changed) return;
  S.state.rows[idx][m.field] = res.html;
  stampRow(S.state.rows[idx]);
  markDirty();
  render();
  refreshFindMatches(true);
  revealFindMatch();
  queueAutoSave();
}

export function replaceAll() {
  if (reviewBlocked()) return;
  var needle = findNeedle();
  if (!needle) return;
  var replacement = document.getElementById("replace-input").value || "";
  var hooks = registryTagHooks(S.state.productionTags);
  var total = 0;
  S.state.rows.forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      var res = replaceInHtml(row[field], needle, replacement, -1, S.findMatchCase, hooks);
      if (!res.changed) return;
      total += res.changed;
      row[field] = res.html;
      stampRow(row);
    });
  });
  var inTags = S.state.rows.reduce(function (n, row) {
    return n + countInTags(cellOf(row.visualText), needle, S.findMatchCase) +
               countInTags(cellOf(row.audioText), needle, S.findMatchCase);
  }, 0);
  var tagNote = inTags
    ? " · " + inTags + " left inside tag" + (inTags === 1 ? "" : "s") + " — rename those in Production"
    : "";
  if (!total) {
    showToast(inTags
      ? "Only found inside tags — rename it in Production instead."
      : "Nothing to replace.", "warn");
    return;
  }
  markDirty();
  render();
  refreshFindMatches(false);
  queueAutoSave();
  showToast("Replaced " + total + " match" + (total === 1 ? "" : "es") + tagNote, "ok");
}

export function openFindBar() {
  findOpen = true;
  document.getElementById("findbar").hidden = false;
  var input = document.getElementById("find-input");
  /* seed from the selection, the way every other editor does */
  var sel = window.getSelection();
  var picked = sel && !sel.isCollapsed ? String(sel).trim() : "";
  if (picked && picked.length <= 200 && picked.indexOf("\n") === -1) input.value = picked;
  input.focus();
  input.select();
  refreshFindMatches(false);
}

export function closeFindBar() {
  findOpen = false;
  document.getElementById("findbar").hidden = true;
  findMatches = [];
  findIndex = -1;
  findInTags = 0;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
