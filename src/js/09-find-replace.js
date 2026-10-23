import { normalizeTagName, registryTagHooks } from "../core/document/tags.ts";
import { isBlankTagName } from "../core/production/tags.ts";
import { TAG_CATEGORIES, tagCategory } from "../core/production/looks.ts";
import { revealRow } from "./01b-hide-shot.js";
import { rowIndexOf } from "../core/document/rows.ts";
import { currentDocument, readSession, runDocumentEdit, sessionStamps } from "../legacy/session-bridge.ts";
import { rewriteCellsCommand, rewrittenCopies } from "../application/commands/document-edit.ts";
import { tagCellsCommand } from "../application/commands/production-records.ts";
import { cssAttr, inertBody, sanitizeHtml } from "./04-richtext.js";
import { bulkTagRows } from "./07-production-tags.js";
import { breakUndoCoalescing } from "./12a-undo.js";
import { BROLL_MARKER_RE } from "../core/document/broll.ts";
import { idMap } from "../core/document/id-map.ts";
import { escapeHtml, withoutLoneSurrogates } from "../core/document/text-policy.ts";
import { replaceText } from "../core/text/edits.ts";
import { toHtml } from "../core/text/html.ts";
import { projection } from "../core/text/runs.ts";
import { cellOf } from "../legacy/richtext.ts";
import { showToast } from "../legacy/effects-bridge.ts";
import { findMatchesCase } from "../application/find-options.ts";
import { viewFlags } from "../legacy/preferences-bridge.ts";
import { reviewBlocked } from "../legacy/location-bridge.ts";

var findMatches = [];
var findIndex = -1;
var findInTags = 0;

function findNeedle() {
  return document.getElementById("find-input").value || "";
}

function escapeRegExpLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findAllMatches(text, needle, matchCase) {
  needle = withoutLoneSurrogates(needle);
  if (!needle) return [];
  var re = new RegExp(escapeRegExpLiteral(needle), matchCase ? "g" : "gi");
  var out = [], m;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

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

export function countInTags(cell, needle, matchCase) {
  if (!needle) return 0;
  return countInPieces(searchablePieces(cell), needle, matchCase);
}

function countInPieces(pieces, needle, matchCase) {
  return pieces.tagged.reduce(function (n, p) {
    return n + findAllMatches(p.text, needle, matchCase).length;
  }, 0);
}

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

export function noMatchLabel(inTags) {
  if (!inTags) return "No matches";
  return "No matches · " + (inTags === 1 ? "1 in a tag" : inTags + " in tags");
}

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

var DROPPED_CHAR_RE = /[\u0000-\u0008\u000B-\u001F\u200B\uFFFC]/;
var DROPPED_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u200B\uFFFC]/g;
var OBJ = "\uFFFC";

export function domRangeFor(root, from, to, expect) {
  var chars = domProjection(root);
  var text = chars.map(function (c) { return c.text; }).join("");
  if (text !== expect || from >= to || to > chars.length) return null;
  var range = (root.ownerDocument || document).createRange();
  range.setStart(chars[from].sc, chars[from].so);
  range.setEnd(chars[to - 1].ec, chars[to - 1].eo);
  return range;
}

export function replaceInHtml(html, needle, replacement, nth, matchCase, hooks) {
  var cell = cellOf(html);
  var matches = findInCell(cell, needle, matchCase);
  if (nth !== -1) matches = matches[nth] ? [matches[nth]] : [];
  if (!matches.length) return { html: html, changed: 0 };
  var text = replacement == null ? "" : String(replacement);
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
    Array.prototype.forEach.call(body.querySelectorAll("strong, em, u, s, mark, a, span.cmt-anchor, span.stage-dir"), function (el) {
      if (el.parentNode && !el.textContent && !el.querySelector("img, br")) el.parentNode.removeChild(el);
    });
    return { html: sanitizeHtml(body.innerHTML), changed: matches.length };
  }
  todo.forEach(function (m) { cell = replaceText(cell, m.from, m.to, text); });
  return { html: toHtml(cell, hooks), changed: matches.length };
}

export function refreshFindMatches(keepIndex) {
  var found = findInRows(currentDocument()?.rows ?? [], findNeedle(), findMatchesCase());
  findMatches = found.matches;
  findInTags = found.inTags;
  if (!findMatches.length) findIndex = -1;
  else if (!keepIndex || findIndex < 0) findIndex = 0;
  else if (findIndex >= findMatches.length) findIndex = findMatches.length - 1;
  updateFindCount();
  refreshBulkTagRow();
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

function currentMatchRange() {
  if (findIndex < 0 || !findMatches[findIndex]) return null;
  var m = findMatches[findIndex];
  var cell = document.querySelector('#rows .row[data-id="' + cssAttr(m.rowId) + '"] .cell-editable[data-field="' + m.field + '"]');
  if (!cell) return null;
  var idx = readSession(function (doc) { return rowIndexOf(doc, m.rowId); });
  if (idx === -1) return null;
  var model = cellOf(currentDocument().rows[idx][m.field]);
  var hit = findInCell(model, findNeedle(), findMatchesCase())[m.nth];
  if (!hit) return null;
  var range = domRangeFor(cell, hit.from, hit.to, projection(model));
  return range ? { cell: cell, range: range } : null;
}

var FIND_HL = "splitpage-find-match";

function highlightsSupported() {
  return !!(window.CSS && CSS.highlights && window.Highlight);
}

function revealFindMatch() {
  var m = findMatches[findIndex];
  if (m) revealRow(m.rowId);
  var hit = currentMatchRange();
  if (highlightsSupported()) {
    if (hit) CSS.highlights.set(FIND_HL, new Highlight(hit.range));
    else CSS.highlights.delete(FIND_HL);
  }
  if (!hit) return;
  var row = hit.cell.closest(".row");
  if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function findQueryChanged() {
  refreshFindMatches(false);
  revealFindMatch();
}

export function stepFind(dir) {
  if (!findMatches.length) return;
  findIndex = (findIndex + dir + findMatches.length) % findMatches.length;
  updateFindCount();
  revealFindMatch();
}

export function replaceCurrent() {
  if (reviewBlocked()) return;
  var needle = findNeedle();
  if (!needle || findIndex < 0 || !findMatches[findIndex]) return;
  var m = findMatches[findIndex];
  var idx = readSession(function (doc) { return rowIndexOf(doc, m.rowId); });
  if (idx === -1) return;
  var replacement = document.getElementById("replace-input").value || "";
  var matchCase = findMatchesCase();
  function replaced(doc) {
    var row = doc.rows[rowIndexOf(doc, m.rowId)];
    if (!row) return [];
    var res = replaceInHtml(row[m.field], needle, replacement, m.nth, matchCase, registryTagHooks(doc.productionTags));
    return res.changed ? [{ rowId: m.rowId, field: m.field, html: res.html }] : [];
  }
  if (!runDocumentEdit(rewriteCellsCommand("replace-match", replaced, sessionStamps, { needs: "edit", stamped: true }))) return;
  refreshFindMatches(true);
  revealFindMatch();
}

export function replaceAll() {
  if (reviewBlocked()) return;
  var needle = findNeedle();
  if (!needle) return;
  var replacement = document.getElementById("replace-input").value || "";
  var matchCase = findMatchesCase();
  function replacedAll(doc) {
    var hooks = registryTagHooks(doc.productionTags);
    var out = { total: 0, rewrites: [] };
    doc.rows.forEach(function (row) {
      ["visualText", "audioText"].forEach(function (field) {
        var res = replaceInHtml(row[field], needle, replacement, -1, matchCase, hooks);
        if (!res.changed) return;
        out.total += res.changed;
        out.rewrites.push({ rowId: row.id, field: field, html: res.html });
      });
    });
    return out;
  }
  var total = readSession(replacedAll).total;
  var inTags = currentDocument().rows.reduce(function (n, row) {
    return n + countInTags(cellOf(row.visualText), needle, findMatchesCase()) +
               countInTags(cellOf(row.audioText), needle, findMatchesCase());
  }, 0);
  var tagNote = inTags
    ? " · " + inTags + " left inside tag" + (inTags === 1 ? "" : "s") + " — rename those in Production"
    : "";
  if (!total || !runDocumentEdit(rewriteCellsCommand("replace-all", function (doc) { return replacedAll(doc).rewrites; }, sessionStamps, { needs: "edit", stamped: true }))) {
    showToast(inTags
      ? "Only found inside tags — rename it in Production instead."
      : "Nothing to replace.", "warn");
    return;
  }
  refreshFindMatches(false);
  revealFindMatch();
  showToast("Replaced " + total + " match" + (total === 1 ? "" : "es") + tagNote, "ok");
}

var bulkTagCat = null;

function bulkTagNeedle() {
  return withoutLoneSurrogates(findNeedle()).trim();
}

function bulkTagRowEl() { return document.getElementById("find-tag-row"); }

export function bulkTagOpen() {
  var row = bulkTagRowEl();
  return !!(row && !row.hidden);
}

export function closeBulkTag() {
  var row = bulkTagRowEl();
  if (row) row.hidden = true;
  var btn = document.getElementById("find-tag");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function bulkTagRefusal(needle, plan) {
  if (isBlankTagName(needle)) return "Type the words to tag in the Find box first.";
  if (needle.length > 80) return "That is too long to be a tag's name.";
  if (plan.hits) return "";
  if (plan.inTags) return "Every mention of \u201c" + needle + "\u201d in the Visual column is tagged already.";
  if (plan.skipped) return "No mention of \u201c" + needle + "\u201d in the Visual column can be tagged as it stands.";
  return "No whole-word mention of \u201c" + needle + "\u201d in the Visual column.";
}

function renderBulkTagRow() {
  var needle = bulkTagNeedle();
  var plan = bulkTagRows(currentDocument()?.rows ?? [], needle, bulkTagCat, needle, findMatchesCase(), true);
  var why = bulkTagRefusal(needle, plan);
  var ask = document.getElementById("find-tag-ask");
  var go = document.getElementById("find-tag-go");
  var cat = tagCategory(bulkTagCat) || TAG_CATEGORIES[0];
  document.getElementById("find-tag-cats").innerHTML = TAG_CATEGORIES.map(function (c) {
    var on = c.id === cat.id;
    return '<button type="button" class="tag-cat-btn' + (on ? ' is-active' : '') +
      '" style="--dot:' + c.color + '" data-tag-cat="' + c.id + '" role="radio" aria-checked="' +
      (on ? 'true' : 'false') + '">' +
      '<span class="tag-cat-dot" aria-hidden="true"></span>' + escapeHtml(c.label) + '</button>';
  }).join("");
  if (why) {
    ask.textContent = why;
  } else {
    var not = [];
    if (plan.inTags) not.push(plan.inTags + " already tagged");
    if (plan.skipped) not.push(plan.skipped + " can\u2019t be tagged");
    ask.innerHTML = "Tag " + plan.hits + " mention" + (plan.hits === 1 ? "" : "s") + " of <em>" +
      escapeHtml(needle) + "</em> as " + escapeHtml(cat.label) + "?" +
      (not.length ? ' <span class="find-tag-note">(' + escapeHtml(not.join(" \u00b7 ")) + ")</span>" : "");
  }
  go.disabled = !!why;
  return plan;
}

function defaultBulkTagCat(needle) {
  var key = normalizeTagName(needle);
  var tags = currentDocument()?.productionTags || [];
  for (var i = 0; i < tags.length; i++) {
    if (normalizeTagName(tags[i].name) === key && tagCategory(tags[i].cat)) return tags[i].cat;
  }
  return bulkTagCat || TAG_CATEGORIES[0].id;
}

export function openBulkTag() {
  if (reviewBlocked()) return;
  if (!currentDocument()) return;
  bulkTagCat = defaultBulkTagCat(bulkTagNeedle());
  var row = bulkTagRowEl();
  row.hidden = false;
  document.getElementById("find-tag").setAttribute("aria-expanded", "true");
  renderBulkTagRow();
  var active = row.querySelector(".tag-cat-btn.is-active");
  if (active) active.focus();
}

export function toggleBulkTag() {
  if (bulkTagOpen()) closeBulkTag();
  else openBulkTag();
}

export function pickBulkTagCat(cat) {
  if (!tagCategory(cat)) return;
  bulkTagCat = cat;
  renderBulkTagRow();
  var btn = document.querySelector('#find-tag-cats .tag-cat-btn[data-tag-cat="' + cssAttr(cat) + '"]');
  if (btn) btn.focus();
}

function refreshBulkTagRow() {
  if (bulkTagOpen()) renderBulkTagRow();
}

export function runBulkTag() {
  if (reviewBlocked()) return;
  var doc = currentDocument();
  if (!doc) return;
  var needle = bulkTagNeedle();
  var cat = tagCategory(bulkTagCat) || TAG_CATEGORIES[0];
  var plan = bulkTagRows(doc.rows, needle, cat.id, needle, findMatchesCase(), true);
  var why = bulkTagRefusal(needle, plan);
  if (why) { showToast(why, "warn"); return; }
  breakUndoCoalescing();
  var done = plan;
  var matchCase = findMatchesCase();
  var tagged = rewrittenCopies(["visualText"], function (rows) { bulkTagRows(rows, needle, cat.id, needle, matchCase, false); });
  if (!done.hits || !runDocumentEdit(tagCellsCommand("bulk-tag", tagged, { cat: cat.id, name: needle }, sessionStamps))) {
    showToast(bulkTagRefusal(needle, done) || "Nothing to tag.", "warn");
    return;
  }
  breakUndoCoalescing();
  closeBulkTag();
  refreshFindMatches(false);
  revealFindMatch();
  var note = "";
  if (done.inTags) note += " \u00b7 " + done.inTags + " already tagged";
  if (done.skipped) note += " \u00b7 " + done.skipped + " skipped";
  showToast("Tagged " + done.hits + " as " + cat.label + note, "ok");
}

export function openFindBar() {
  viewFlags().setFindOpen(true);
  document.getElementById("findbar").hidden = false;
  var input = document.getElementById("find-input");
  var sel = window.getSelection();
  var picked = sel && !sel.isCollapsed ? String(sel).trim() : "";
  if (picked && picked.length <= 200 && picked.indexOf("\n") === -1) input.value = picked;
  var from = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  input.focus();
  input.select();
  refreshFindMatches(false);
  if (findMatches.length) {
    findIndex = firstMatchFrom(from);
    updateFindCount();
  }
  revealFindMatch();
}

function firstMatchFrom(range) {
  if (!range || !findMatches.length) return 0;
  var node = range.startContainer;
  var el = node.nodeType === 1 ? node : node.parentNode;
  var cell = el && el.closest ? el.closest("#rows .cell-editable[data-field]") : null;
  var rowEl = cell && cell.closest(".row");
  var rowIdx = rowEl ? readSession(function (doc) { return rowIndexOf(doc, rowEl.getAttribute("data-id")); }) : -1;
  if (rowIdx === -1) return 0;
  var field = cell.getAttribute("data-field");
  var rows = currentDocument().rows;
  var model = cellOf(rows[rowIdx][field]);
  var expect = projection(model);
  var hits = findInCell(model, findNeedle(), findMatchesCase());
  var nth = 0;
  while (nth < hits.length) {
    var r = domRangeFor(cell, hits[nth].from, hits[nth].to, expect);
    if (r && r.compareBoundaryPoints(Range.START_TO_START, range) >= 0) break;
    nth++;
  }
  var order = idMap();
  rows.forEach(function (row, i) { order[row.id] = i; });
  var at = field === "visualText" ? 0 : 1;
  for (var i = 0; i < findMatches.length; i++) {
    var m = findMatches[i], mi = order[m.rowId], mf = m.field === "visualText" ? 0 : 1;
    if (mi > rowIdx || (mi === rowIdx && (mf > at || (mf === at && m.nth >= nth)))) return i;
  }
  return 0;
}

export function closeFindBar() {
  viewFlags().setFindOpen(false);
  document.getElementById("findbar").hidden = true;
  findMatches = [];
  findIndex = -1;
  findInTags = 0;
  closeBulkTag();
  if (highlightsSupported()) CSS.highlights.delete(FIND_HL);
}

export function leaveFindAtMatch() {
  var hit = currentMatchRange();
  closeFindBar();
  if (!hit) return;
  hit.cell.focus();
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(hit.range);
}

export function __init() {}
