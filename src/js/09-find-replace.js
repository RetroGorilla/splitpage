import { S } from "./_state.js";
import { revealRow } from "./01b-hide-shot.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { cssAttr, inertBody, sanitizeHtml } from "./04-richtext.js";
import { render } from "./05-render.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { reviewBlocked } from "./13-hosted.js";
import { queueAutoSave } from "./14-export.js";

/* ================= find & replace =================

   Matching and replacing both happen in TEXT NODES ONLY, never on the HTML
   string. Running a regex over the markup would happily rewrite the inside
   of an attribute — a tag's stored name, a link's href, a comment anchor's
   id — and corrupt the document in ways that only show up much later.
   Walking text nodes means formatting, links, tags and anchors all survive
   a replace untouched. */

export var findOpen = false;
S.findMatchCase = false;
var findMatches = [];      /* [{rowId, field, nth}] in document order */
var findIndex = -1;

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
function findAllMatches(text, needle) {
  if (!needle) return [];
  var re = new RegExp(escapeRegExpLiteral(needle), S.findMatchCase ? "g" : "gi");
  var out = [], m;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/* Text a search is allowed to touch. Anything inside a .tag-anchor is
   skipped: those spans are atomic everywhere else in the app (you cannot
   type inside one — see the contenteditable="false" note), and rewriting
   their words here would leave the visible text saying one thing while the
   tag still tracked another. Renaming a tag is the Production panel's job,
   which changes both halves together.

   .cmt-anchor gets the same exclusion, for the same reason: it isn't
   atomic (a comment's quoted phrase stays plain editable text, unlike a
   tag), but a comment's cached quotedText is only ever set once, at
   creation — there is no equivalent "rename this quote" step that keeps
   it in sync afterward. A global replace rewriting the words inside an
   anchor used to leave the panel showing a quote that no longer exists
   anywhere in the script, with the comment never flagged orphaned since
   the span itself survives untouched. */
function editableTextNodes(root) {
  var doc = root.ownerDocument || document;
  var out = [], walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  var n;
  while ((n = walker.nextNode())) {
    var p = n.parentNode;
    if (p && p.closest && (p.closest(".tag-anchor") || p.closest(".cmt-anchor"))) continue;
    out.push(n);
  }
  return out;
}

/* Counted per text node, the same way navigating and replacing walk them,
   so the number shown is always the number you can actually reach. (A
   match split across a formatting boundary — "wid<strong>get</strong>" —
   is therefore not found, consistently, rather than counted but
   unreachable.) */
function countMatchesInHtml(html, needle) {
  if (!needle) return 0;
  var body = inertBody(html || "");
  var count = 0;
  editableTextNodes(body).forEach(function (node) {
    count += findAllMatches(node.nodeValue || "", needle).length;
  });
  return count;
}

/* How many occurrences are sitting inside tags and so cannot be replaced —
   used only to explain the difference rather than leave it mysterious. */
function countMatchesInsideTags(html, needle) {
  if (!needle) return 0;
  var body = inertBody(html || "");
  var count = 0;
  Array.prototype.forEach.call(body.querySelectorAll(".tag-anchor"), function (el) {
    count += findAllMatches(el.textContent || "", needle).length;
  });
  return count;
}

export function refreshFindMatches(keepIndex) {
  var needle = findNeedle();
  findMatches = [];
  if (needle && S.state) {
    S.state.rows.forEach(function (row) {
      ["visualText", "audioText"].forEach(function (field) {
        var n = countMatchesInHtml(row[field], needle);
        for (var i = 0; i < n; i++) findMatches.push({ rowId: row.id, field: field, nth: i });
      });
    });
  }
  if (!findMatches.length) findIndex = -1;
  else if (!keepIndex || findIndex < 0) findIndex = 0;
  else if (findIndex >= findMatches.length) findIndex = findMatches.length - 1;
  updateFindCount();
}

function updateFindCount() {
  var el = document.getElementById("find-count");
  if (!el) return;
  var needle = findNeedle();
  if (!needle) { el.textContent = ""; el.classList.remove("none"); return; }
  if (!findMatches.length) { el.textContent = "No matches"; el.classList.add("none"); return; }
  el.classList.remove("none");
  el.textContent = (findIndex + 1) + " of " + findMatches.length;
}

/* Select the match in the live DOM rather than marking it up: the browser's
   own selection highlight costs no document changes, and it leaves the
   caret exactly where Replace needs to act. */
function revealFindMatch() {
  if (findIndex < 0 || !findMatches[findIndex]) return;
  var m = findMatches[findIndex];
  revealRow(m.rowId);
  var cell = document.querySelector('#rows .row[data-id="' + cssAttr(m.rowId) + '"] .cell-editable[data-field="' + m.field + '"]');
  if (!cell) return;
  var needle = findNeedle();
  var nodes = editableTextNodes(cell);
  var seen = 0;
  for (var i = 0; i < nodes.length; i++) {
    var raw = nodes[i].nodeValue || "";
    var matches = findAllMatches(raw, needle);
    for (var j = 0; j < matches.length; j++) {
      if (seen === m.nth) {
        var range = document.createRange();
        range.setStart(nodes[i], matches[j].start);
        range.setEnd(nodes[i], matches[j].end);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        cell.focus();
        var row = cell.closest(".row");
        if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      seen++;
    }
  }
}

export function stepFind(dir) {
  if (!findMatches.length) return;
  findIndex = (findIndex + dir + findMatches.length) % findMatches.length;
  updateFindCount();
  revealFindMatch();
}

/* Replace the nth occurrence in one field (nth === -1 means every one),
   returning the new HTML and how many were changed. */
function replaceInHtml(html, needle, replacement, nth) {
  var body = inertBody(html || "");
  var nodes = editableTextNodes(body);
  var seen = 0, changed = 0;
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var raw = node.nodeValue || "";
    var matches = findAllMatches(raw, needle);
    if (!matches.length) continue;
    var out = "", cursor = 0, nodeChanged = false;
    for (var j = 0; j < matches.length; j++) {
      var mm = matches[j];
      var take = (nth === -1 || seen === nth);
      if (take) {
        out += raw.slice(cursor, mm.start) + replacement;
        cursor = mm.end;
        changed++;
        nodeChanged = true;
      }
      seen++;
      if (nth !== -1 && changed) break;
    }
    if (nodeChanged) {
      node.nodeValue = out + raw.slice(cursor);
      if (nth !== -1) break;
    }
  }
  return { html: body.innerHTML, changed: changed };
}

export function replaceCurrent() {
  if (reviewBlocked()) return;   /* find still works; replacing is an edit */
  var needle = findNeedle();
  if (!needle || findIndex < 0 || !findMatches[findIndex]) return;
  var m = findMatches[findIndex];
  var idx = findRowIndex(m.rowId);
  if (idx === -1) return;
  var replacement = document.getElementById("replace-input").value || "";
  var res = replaceInHtml(S.state.rows[idx][m.field], needle, replacement, m.nth);
  if (!res.changed) return;
  S.state.rows[idx][m.field] = sanitizeHtml(res.html);
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
  var total = 0;
  S.state.rows.forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      var res = replaceInHtml(row[field], needle, replacement, -1);
      if (!res.changed) return;
      total += res.changed;
      row[field] = sanitizeHtml(res.html);
      stampRow(row);
    });
  });
  var inTags = S.state.rows.reduce(function (n, row) {
    return n + countMatchesInsideTags(row.visualText, needle) +
               countMatchesInsideTags(row.audioText, needle);
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
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
