import { tagCategory } from "../../core/production/looks.ts";
import type { TagCategoryLook } from "../../core/production/looks.ts";
import { isBlankTagName } from "../../core/production/tags.ts";
import { domToPos } from "../common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../common/cell-selection.ts";
import { isInsideTagOrLink } from "../common/dom.ts";
import { cappedName, escapeHtml } from "../../core/document/text-policy.ts";
import { insertText, replaceText, replaceWithTag } from "../../core/text/edits.ts";
import { namedTagId, projection } from "../../core/text/runs.ts";
import { registryEntryOf } from "../../core/production/records.ts";
import type { Marks, Run } from "../../core/text/runs.ts";
import type { TagCategoryId } from "../../core/document/tags.ts";
import type { PlainTagMount, PlainTagPorts } from "./ports.ts";

export const PLAIN_TAG_KEYWORDS: Record<string, TagCategoryId> = {
  prop: "prop",
  location: "location",
  loc: "location",
  cast: "cast",
  vfx: "vfx",
  gear: "gear",
  sfx: "sound",
  music: "sound"
};

const KEYWORD_AT_END_RE = /(prop|location|loc|cast|vfx|gear|sfx|music):$/i;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const ZWSP = String.fromCharCode(0x200B);
const ZWSP_RE = new RegExp(ZWSP, "g");
const NBSP = String.fromCharCode(0xA0);
const NAME_MAX = 80;

export function matchPlainTagKeyword(before: unknown) {
  const s = String(before == null ? "" : before);
  const m = KEYWORD_AT_END_RE.exec(s);
  if (!m) return null;
  const start = s.length - m[0].length;
  if (start > 0 && WORD_CHAR_RE.test(s.charAt(start - 1))) return null;
  const cat = PLAIN_TAG_KEYWORDS[(m[1] as string).toLowerCase()];
  if (!cat) return null;
  return { cat: cat, keyword: m[0], length: m[0].length };
}

export function plainTagPhrase(typed: unknown) {
  const s = String(typed == null ? "" : typed).replace(ZWSP_RE, "");
  const text = s.trim();
  if (isBlankTagName(text)) return null;
  const lead = s.length - s.replace(/^\s+/, "").length;
  const trail = s.length - s.replace(/\s+$/, "").length;
  const name = cappedName(text.replace(/\s+/g, " "), NAME_MAX);
  return { lead: lead, text: text, trail: trail, name: name };
}

export function applyPlainTag(cell: readonly Run[], from: number, to: number, cat: string, name?: string) {
  const words = projection(cell).slice(from, to);
  const colon = words.indexOf(":");
  if (colon === -1) return null;
  const kw = matchPlainTagKeyword(words.slice(0, colon + 1));
  if (!kw || kw.length !== colon + 1 || kw.cat !== cat) return null;
  const p = plainTagPhrase(words.slice(colon + 1));
  if (!p) return null;
  const tagName = name || p.name;
  const r = replaceWithTag(cell, from, to - p.trail, p.text, namedTagId(cat, tagName));
  let out = r.cell;
  const after = projection(out).slice(r.end);
  if (p.trail && after.length === p.trail && after.indexOf(" ") !== -1) {
    out = replaceText(out, r.end, r.end + p.trail, after.replace(/ /g, NBSP));
  }
  return { cell: out, caret: r.end + p.trail, name: tagName, cat: cat };
}

interface OpenPlainTag {
  cellEl: Element;
  span: HTMLSpanElement;
  tail: Text;
  cat: TagCategoryId;
  keyword: string;
}

let ports: PlainTagPorts | null = null;
let open: OpenPlainTag | null = null;
const HL_PREFIX = "splitpage-open-tag-";

function tagPorts(): PlainTagPorts {
  if (!ports) throw new TypeError("Plain tags are not mounted");
  return ports;
}
interface TagCategoryCaret {
  cellEl: HTMLElement;
  range: Range;
  node: Node;
  offset: number;
  html: string;
  marks: Marks;
}

let categoryCaret: TagCategoryCaret | null = null;

function tagCaret(cellEl: Element): Range | null {
  if (cellEl.getAttribute("data-field") !== "visualText" || !cellEl.closest("#rows") || plainTagOpen()) return null;
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (!cellEl.contains(node)) return null;
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  if (isInsideTagOrLink(element)) return null;
  const pos = domToPos(cellEl, node, range.startOffset);
  if (pos === null) return null;
  if (!ports) return null;
  const html = ports.text.storedHtmlFromDom(cellEl.innerHTML.replace(ZWSP_RE, ""));
  const before = projection(ports.text.fromHtml(html)).slice(0, pos);
  return matchPlainTagKeyword(before + "prop:") ? range : null;
}

function openCategoryAtCaret(cellEl: HTMLElement, marks: Marks): boolean {
  const range = tagCaret(cellEl);
  const modal = document.getElementById("tag-modal");
  if (!range || !modal || !modal.hidden || !ports) return false;
  categoryCaret = { cellEl, range: range.cloneRange(), node: range.startContainer, offset: range.startOffset, html: cellEl.innerHTML, marks };
  ports.renderCategories(null);
  modal.classList.add("is-category-only");
  modal.hidden = false;
  modal.querySelector<HTMLElement>(".tag-cat-btn")?.focus();
  return true;
}

function categoryCaretStillThere(saved: TagCategoryCaret): boolean {
  return saved.cellEl.isConnected && saved.cellEl.innerHTML === saved.html && saved.cellEl.contains(saved.node) &&
    saved.range.startContainer === saved.node && saved.range.startOffset === saved.offset;
}

function cancelCategory(): boolean {
  const saved = categoryCaret;
  if (!saved) return false;
  categoryCaret = null;
  const modal = document.getElementById("tag-modal");
  if (modal) {
    modal.hidden = true;
    modal.classList.remove("is-category-only");
  }
  if (categoryCaretStillThere(saved)) {
    saved.cellEl.focus();
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(saved.range);
  }
  return true;
}

function chooseCategory(cat: string | null): boolean {
  const saved = categoryCaret;
  if (!saved) return false;
  cancelCategory();
  if (!categoryCaretStillThere(saved) || !tagCategory(cat)) return true;
  if (!tagCaret(saved.cellEl) || !ports) return true;
  const keyword = (cat === "sound" ? "sfx" : cat) + ":";
  const cellEl = ports.cells.edit(saved.cellEl, function (cell, selection) {
    if (!selection || selection.from !== selection.to) return null;
    const end = selection.from + keyword.length;
    return { cell: insertText(cell, selection.from, keyword, saved.marks), sel: { from: end, to: end } };
  });
  if (cellEl) maybeOpenPlainTag({ inputType: "insertText", data: ":" }, cellEl);
  return true;
}

function highlightApiOk() {
  return !!(window.CSS && CSS.highlights && window.Highlight);
}

function hintEl() { return document.getElementById("tag-open-hint"); }

export function plainTagOpen(cellEl?: Element | null) {
  if (!open || !stillThere(open)) return false;
  return !cellEl || open.cellEl === cellEl;
}

function stillThere(o: OpenPlainTag) {
  return o.cellEl.isConnected && o.span.isConnected && o.cellEl.contains(o.span) &&
    o.tail.isConnected && o.tail.previousSibling === o.span;
}

function caretInOpen(o: OpenPlainTag) {
  if (document.activeElement !== o.cellEl) return null;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (r.startContainer !== o.tail) return null;
  return r.startOffset;
}

function clearPaint() {
  if (highlightApiOk()) {
    try {
      Object.keys(PLAIN_TAG_KEYWORDS).forEach(function (k) { CSS.highlights.delete(HL_PREFIX + PLAIN_TAG_KEYWORDS[k]); });
    } catch (e) { }
  }
  const el = hintEl();
  if (el) el.classList.remove("is-visible");
}

function paint(o: OpenPlainTag, offset: number) {
  if (highlightApiOk()) {
    try {
      let from = 0;
      const data = o.tail.data;
      while (from < offset && (data.charAt(from) === ZWSP || /\s/.test(data.charAt(from)))) from++;
      const range = document.createRange();
      range.setStart(o.tail, from);
      range.setEnd(o.tail, offset);
      CSS.highlights.set(HL_PREFIX + o.cat, new Highlight(range));
    } catch (e) { }
  }
  const el = hintEl();
  if (!el) return;
  const cat = tagCategory(o.cat) as TagCategoryLook;
  if (el.getAttribute("data-cat") !== o.cat) {
    el.setAttribute("data-cat", o.cat);
    el.innerHTML = '<span class="tag-cat-dot" data-tag-cat="' + cat.id + '" style="--dot: ' + cat.color + '"></span>' +
      '<b>' + escapeHtml(cat.label) + '</b>' +
      '<span class="tag-suggest-cat">tag</span><kbd>Tab</kbd>';
  }
  el.classList.add("is-visible");
  const w = el.offsetWidth, h = el.offsetHeight;
  const at = document.createRange();
  at.setStart(o.tail, 0);
  at.collapse(true);
  const rect = at.getClientRects()[0] || o.cellEl.getBoundingClientRect();
  const cellRect = o.cellEl.getBoundingClientRect();
  let top = cellRect.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, cellRect.top - h - 6);
  el.style.left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - w - 8)) + "px";
  el.style.top = top + "px";
}

function unwrap(o: OpenPlainTag) {
  if (!o.span.isConnected) return;
  const sel = o.cellEl.isConnected ? cellSelection(o.cellEl) : null;
  const parent = o.span.parentNode as ParentNode;
  if (o.tail.isConnected && o.tail.previousSibling === o.span && o.tail.data.charAt(0) === ZWSP) {
    o.tail.deleteData(0, 1);
  }
  while (o.span.firstChild) parent.insertBefore(o.span.firstChild, o.span);
  parent.removeChild(o.span);
  parent.normalize();
  if (sel && document.activeElement === o.cellEl) setCellSelection(o.cellEl, sel.from, sel.to);
}

export function cancelPlainTag() {
  const o = open;
  open = null;
  clearPaint();
  if (o) unwrap(o);
}

export function refreshPlainTag() {
  const o = open;
  if (!o) return;
  if (!stillThere(o)) { open = null; clearPaint(); return; }
  const at = caretInOpen(o);
  if (at === null) { cancelPlainTag(); return; }
  paint(o, at);
}

function plainTagEmptyAtCaret() {
  const o = open;
  if (!o || !stillThere(o)) return false;
  const at = caretInOpen(o);
  return at !== null && !o.tail.data.slice(0, at).replace(ZWSP_RE, "");
}

export function maybeOpenPlainTag(e: { inputType?: string; data?: string | null }, cellEl: Element) {
  if (e.inputType !== "insertText" || !e.data || e.data.charAt(e.data.length - 1) !== ":") return;
  if (cellEl.getAttribute("data-field") !== "visualText" || !cellEl.closest("#rows")) return;
  if (plainTagOpen()) return;
  if (open) { open = null; clearPaint(); }
  const sel = window.getSelection() as Selection;
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer as Text;
  const offset = range.startOffset;
  if (node.nodeType !== 3 || !cellEl.contains(node)) return;
  if (isInsideTagOrLink(node.parentElement)) return;

  const raw = node.data.slice(0, offset);
  const tail = KEYWORD_AT_END_RE.exec(raw);
  if (!tail) return;
  const kwStart = offset - tail[0].length;
  let before = raw.slice(0, kwStart).replace(ZWSP_RE, "");
  if (!before) before = charBeforeNode(cellEl, node);
  const kw = matchPlainTagKeyword(before + tail[0]);
  if (!kw) return;

  const rest = node.splitText(offset);
  const kwNode = node.splitText(kwStart);
  const span = document.createElement("span");
  span.className = "plain-tag-keyword";
  span.setAttribute("contenteditable", "false");
  (kwNode.parentNode as ParentNode).insertBefore(span, kwNode);
  span.appendChild(kwNode);
  rest.insertData(0, ZWSP);
  const r = document.createRange();
  r.setStart(rest, 1);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  open = { cellEl: cellEl, span: span, tail: rest, cat: kw.cat, keyword: kwNode.data };
  paint(open, 1);
}

function charBeforeNode(cellEl: Element, node: Node) {
  const pos = domToPos(cellEl, node, 0);
  if (!pos) return "";
  const html = tagPorts().text.storedHtmlFromDom(cellEl.innerHTML.replace(ZWSP_RE, ""));
  return projection(tagPorts().text.fromHtml(html)).charAt(pos - 1);
}

const plainTaggedListeners: (() => void)[] = [];

function onPlainTagged(listener: () => void) {
  plainTaggedListeners.push(listener);
  return function () {
    const at = plainTaggedListeners.indexOf(listener);
    if (at !== -1) plainTaggedListeners.splice(at, 1);
  };
}

function existingPlainTagEnd(cell: readonly Run[], from: number) {
  let pos = 0;
  for (const run of cell) {
    const end = pos + (run.atom ? 1 : run.text.length);
    if (end <= from) { pos = end; continue; }
    if (run.atom || run.marks.tag || run.marks.href) return Math.max(from, pos);
    const lineEnd = run.text.indexOf("\n", Math.max(0, from - pos));
    if (lineEnd !== -1) return pos + lineEnd;
    pos = end;
  }
  return pos;
}

export function closePlainTag() {
  const o = open;
  if (!o || !stillThere(o)) { open = null; clearPaint(); return false; }
  const at = caretInOpen(o);
  let to = at === null ? null : domToPos(o.cellEl, o.tail, at);
  let typed = at === null ? "" : o.tail.data.slice(0, at);
  if (at === 1 && to !== null) {
    const html = tagPorts().text.storedHtmlFromDom(o.cellEl.innerHTML.replace(ZWSP_RE, ""));
    const cell = tagPorts().text.fromHtml(html, { media: true });
    const end = existingPlainTagEnd(cell, to);
    typed = projection(cell).slice(to, end);
    to = end;
  }
  const phrase = at === null ? null : plainTagPhrase(typed);
  if (!phrase) { cancelPlainTag(); return true; }
  open = null;
  clearPaint();
  const entry = registryEntryOf(tagPorts().document.current(), o.cat, phrase.name);
  const name = entry ? entry.name : phrase.name;
  const done = tagPorts().cells.edit(o.cellEl, function (cell) {
    const from = domToPos(o.cellEl, o.span.firstChild as Node, 0);
    if (from === null || to === null) return null;
    if (projection(cell).slice(from, to) !== o.keyword + typed.replace(ZWSP_RE, "")) return null;
    const res = applyPlainTag(cell, from, to, o.cat, name);
    if (!res) return null;
    return { cell: res.cell, sel: { from: res.caret, to: res.caret }, records: { tags: [{ cat: o.cat, name: res.name }] } };
  });
  if (!done) { unwrap(o); return true; }
  plainTaggedListeners.slice().forEach(function (listener) { listener(); });
  return true;
}

export function startPlainTags(given: PlainTagPorts): PlainTagMount {
  ports = given;
  let disposed = false;
  return {
    openCategoryAtCaret,
    chooseCategory,
    cancelCategory,
    maybeOpen: maybeOpenPlainTag,
    refresh: refreshPlainTag,
    cancel: cancelPlainTag,
    close: closePlainTag,
    isOpen: plainTagOpen,
    emptyAtCaret: plainTagEmptyAtCaret,
    onTagged: onPlainTagged,
    dispose: function () {
      if (disposed) return;
      disposed = true;
      cancelCategory();
      cancelPlainTag();
      ports = null;
    }
  };
}
