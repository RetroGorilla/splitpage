import { cellSelection, domToPos, editCell, setCellSelection } from "./05b-cell-edit.js";
import {
  isBlankTagName,
  isInsideTagOrLink,
  registryEntry,
  tagCategory,
  updateTagBadges
} from "./07-production-tags.js";
import { renderProduction } from "./08-production-panels.js";
import { cappedName, escapeHtml } from "../core/document/text-policy.ts";
import { replaceText, replaceWithTag } from "../core/text/edits.ts";
import { namedTagId, projection } from "../core/text/runs.ts";
import { fromHtml, storedHtmlFromDom } from "../legacy/richtext.ts";

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
var WORD_CHAR_RE = /[\p{L}\p{N}]/u;
var ZWSP = String.fromCharCode(0x200B);
var ZWSP_RE = new RegExp(ZWSP, "g");
var NBSP = String.fromCharCode(0xA0);
var NAME_MAX = 80;

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

export function plainTagPhrase(typed) {
  var s = String(typed == null ? "" : typed).replace(ZWSP_RE, "");
  var text = s.trim();
  if (isBlankTagName(text)) return null;
  var lead = s.length - s.replace(/^\s+/, "").length;
  var trail = s.length - s.replace(/\s+$/, "").length;
  var name = cappedName(text.replace(/\s+/g, " "), NAME_MAX);
  return { lead: lead, text: text, trail: trail, name: name };
}

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
  var after = projection(out).slice(r.end);
  if (p.trail && after.length === p.trail && after.indexOf(" ") !== -1) {
    out = replaceText(out, r.end, r.end + p.trail, after.replace(/ /g, NBSP));
  }
  return { cell: out, caret: r.end + p.trail, name: tagName, cat: cat };
}

var open = null;
var HL_PREFIX = "splitpage-open-tag-";

function highlightApiOk() {
  return !!(window.CSS && CSS.highlights && window.Highlight);
}

function hintEl() { return document.getElementById("tag-open-hint"); }

export function plainTagOpen(cellEl) {
  if (!open || !stillThere(open)) return false;
  return !cellEl || open.cellEl === cellEl;
}

function stillThere(o) {
  return o.cellEl.isConnected && o.span.isConnected && o.cellEl.contains(o.span) &&
    o.tail.isConnected && o.tail.previousSibling === o.span;
}

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
    } catch (e) { }
  }
  var el = hintEl();
  if (el) el.classList.remove("is-visible");
}

function paint(o, offset) {
  if (highlightApiOk()) {
    try {
      var from = 0, data = o.tail.data;
      while (from < offset && (data.charAt(from) === ZWSP || /\s/.test(data.charAt(from)))) from++;
      var range = document.createRange();
      range.setStart(o.tail, from);
      range.setEnd(o.tail, offset);
      CSS.highlights.set(HL_PREFIX + o.cat, new Highlight(range));
    } catch (e) { }
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

export function cancelPlainTag() {
  var o = open;
  open = null;
  clearPaint();
  if (o) unwrap(o);
}

export function refreshPlainTag() {
  var o = open;
  if (!o) return;
  if (!stillThere(o)) { open = null; clearPaint(); return; }
  var at = caretInOpen(o);
  if (at === null) { cancelPlainTag(); return; }
  paint(o, at);
}

export function plainTagEmptyAtCaret() {
  var o = open;
  if (!o || !stillThere(o)) return false;
  var at = caretInOpen(o);
  return at !== null && !o.tail.data.slice(0, at).replace(ZWSP_RE, "");
}

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

export function closePlainTag() {
  var o = open;
  if (!o || !stillThere(o)) { open = null; clearPaint(); return false; }
  var at = caretInOpen(o);
  var typed = at === null ? "" : o.tail.data.slice(0, at);
  var phrase = at === null ? null : plainTagPhrase(typed);
  if (!phrase) { cancelPlainTag(); return true; }
  open = null;
  clearPaint();
  var entry = registryEntry(o.cat, phrase.name);
  var name = entry ? entry.name : phrase.name;
  var done = editCell(o.cellEl, function (cell) {
    var from = domToPos(o.cellEl, o.span.firstChild, 0), to = domToPos(o.cellEl, o.tail, at);
    if (from === null || to === null) return null;
    if (projection(cell).slice(from, to) !== o.keyword + typed.replace(ZWSP_RE, "")) return null;
    var res = applyPlainTag(cell, from, to, o.cat, name);
    if (!res) return null;
    return { cell: res.cell, sel: { from: res.caret, to: res.caret }, records: { tags: [{ cat: o.cat, name: res.name }] } };
  });
  if (!done) { unwrap(o); return true; }
  updateTagBadges();
  renderProduction();
  return true;
}

export function __init() {}
