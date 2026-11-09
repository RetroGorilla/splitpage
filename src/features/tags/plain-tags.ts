import { tagCategory } from "../../core/production/looks.ts";
import type { TagCategoryLook } from "../../core/production/looks.ts";
import { isBlankTagName } from "../../core/production/tags.ts";
import { domToPos, posToDom } from "../common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../common/cell-selection.ts";
import { isInsideProtectedTagOrLink as isInsideTagOrLink } from "../common/dom.ts";
import { cappedName, escapeHtml } from "../../core/document/text-policy.ts";
import { deleteRange, insertText, marksAt, replaceText, setMark, sliceCell, typingMarks } from "../../core/text/edits.ts";
import { toHtml } from "../../core/text/html.ts";
import { FORMAT_MARKS, namedTagId, projection, tagStack, withTagStack } from "../../core/text/runs.ts";
import { registryCompletion, registryCompletionOf, registryEntryOf } from "../../core/production/records.ts";
import type { RegistryCompletion } from "../../core/production/records.ts";
import type { Marks, Run } from "../../core/text/runs.ts";
import type { TagCategoryId } from "../../core/document/tags.ts";
import type { PlainTagMount, PlainTagPorts, TagCaretRefusal } from "./ports.ts";
import { showToolbarTagPicker } from "./toolbar-picker.ts";
import { createTagOccurrenceEditor } from "./occurrence-editor.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";

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
  const start = from + colon + 1 + p.lead;
  const end = to - p.trail;
  let out = setMark(cell, start, end, "tag", namedTagId(cat, tagName));
  out = deleteRange(out, from, start);
  const at = from + p.text.length;
  const after = projection(out).slice(at);
  if (p.trail && after.length === p.trail && after.indexOf(" ") !== -1) {
    out = replaceText(out, at, at + p.trail, after.replace(/ /g, NBSP));
  }
  return { cell: out, caret: at + p.trail, name: tagName, cat: cat };
}

interface OpenPlainTag {
  cellEl: Element;
  span: HTMLSpanElement;
  tail: Text;
  cat: TagCategoryId;
  keyword: string;
  silent: SilentTag | null;
  suggestion: RegistryCompletion | null;
  dismissed: string | null;
}

interface SilentTag {
  marks: Marks;
  wrappers: Node[];
  pending: boolean;
  initialHtml: string;
}

let ports: PlainTagPorts | null = null;
let open: OpenPlainTag | null = null;
let occurrence: ReturnType<typeof createTagOccurrenceEditor> | null = null;
const HL_PREFIX = "splitpage-open-tag-";

function tagPorts(): PlainTagPorts {
  if (!ports) throw new TypeError("Plain tags are not mounted");
  return ports;
}
interface TagCaretSnapshot {
  cellEl: HTMLElement;
  range: Range;
  node: Node;
  offset: number;
  html: string;
  marks: Marks;
}

let categoryCaret: TagCaretSnapshot | null = null;
let closeCategoryPicker: (() => void) | null = null;

function tagCaret(cellEl: Element): Range | TagCaretRefusal {
  const field = cellEl.getAttribute("data-field");
  if (field === "audioText" && window.getSelection()?.isCollapsed !== false) return "audio";
  if ((field !== "visualText" && field !== "audioText") || !cellEl.closest("#rows, .wr-flow-visual-box")) return "elsewhere";
  if (plainTagOpen()) return "open";
  const sel = window.getSelection();
  if (!sel?.rangeCount) return "elsewhere";
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (!cellEl.contains(node) || !cellEl.contains(range.endContainer)) return "elsewhere";
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  if (isInsideTagOrLink(element) && !element?.closest("a")) return "tag";
  if (element?.closest("a")) return "link";
  if (!range.collapsed) {
    const selection = cellSelection(cellEl);
    if (selection) {
      const cell = tagPorts().text.fromHtml(tagPorts().text.storedHtmlFromDom(cellEl.innerHTML));
      const existing = new Set(cell.flatMap(run => tagStack(run.marks)));
      let probe = namedTagId("prop", "selection probe");
      while (existing.has(probe)) probe += "x";
      if (toHtml(setMark(cell, selection.from, selection.to, "tag", probe)) === toHtml(cell)) return "tag-selection";
    }
    if (Array.from(cellEl.querySelectorAll("a")).some(link => range.intersectsNode(link))) return "link";
  }
  return domToPos(cellEl, node, range.startOffset) === null ? "elsewhere" : range;
}

function openCategoryAtCaret(cellEl: HTMLElement, marks: Marks): TagCaretRefusal | null {
  if (categoryCaret?.cellEl === cellEl) { cancelCategory(); return null; }
  cancelCategory(false);
  const range = tagCaret(cellEl);
  if (typeof range === "string") return range;
  if (!ports) return "elsewhere";
  categoryCaret = { cellEl, range: range.cloneRange(), node: range.startContainer, offset: range.startOffset, html: cellEl.innerHTML, marks };
  closeCategoryPicker = showToolbarTagPicker(cellEl, chooseCategory, cancelCategory);
  if (!closeCategoryPicker) { categoryCaret = null; return "elsewhere"; }
  return null;
}

function categoryCaretStillThere(saved: TagCaretSnapshot): boolean {
  return saved.cellEl.isConnected && saved.cellEl.innerHTML === saved.html && saved.cellEl.contains(saved.node) &&
    saved.range.startContainer === saved.node && saved.range.startOffset === saved.offset;
}

function cancelCategory(restore = true): boolean {
  const saved = categoryCaret;
  if (!saved) return false;
  categoryCaret = null;
  closeCategoryPicker?.();
  closeCategoryPicker = null;
  if (restore && categoryCaretStillThere(saved)) {
    saved.cellEl.focus();
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(saved.range);
  }
  return true;
}

function afterOrInsideWord(saved: TagCaretSnapshot): boolean {
  if (!ports) return false;
  const pos = domToPos(saved.cellEl, saved.node, saved.offset);
  if (pos === null) return false;
  const html = ports.text.storedHtmlFromDom(saved.cellEl.innerHTML.replace(ZWSP_RE, ""));
  return !matchPlainTagKeyword(projection(ports.text.fromHtml(html)).slice(0, pos) + "prop:");
}

function sameMarks(a: Marks, b: Marks): boolean {
  const key = (m: Marks) => JSON.stringify(Object.entries(m).sort(([x], [y]) => x < y ? -1 : 1));
  return key(a) === key(b);
}

function openSilentTag(saved: TagCaretSnapshot, cat: TagCategoryId, keyword: string): void {
  if (!ports || !ports.cells.open(saved.cellEl, false) || !categoryCaretStillThere(saved)) return;
  const { node, offset, cellEl } = saved;
  const pos = domToPos(cellEl, node, offset);
  if (pos === null) return;
  const sel = window.getSelection();
  if (!sel) return;
  const current = ports.text.fromHtml(ports.text.storedHtmlFromDom(cellEl.innerHTML.replace(ZWSP_RE, "")));
  const rest = node.nodeType === 3
    ? (node as Text).splitText(offset)
    : node.insertBefore(document.createTextNode(""), node.childNodes[offset] ?? null) as Text;
  const span = document.createElement("span");
  span.className = "plain-tag-keyword";
  span.setAttribute("contenteditable", "false");
  let tail = rest;
  let wrappers: Node[] = [];
  const parent = rest.parentNode as Node;
  if (sameMarks(typingMarks(current, pos), saved.marks)) {
    parent.insertBefore(span, rest);
  } else {
    const holder = document.createElement("template");
    holder.innerHTML = toHtml(insertText([], 0, "x", saved.marks));
    wrappers = Array.from(holder.content.childNodes);
    let inner: Node | null = wrappers[wrappers.length - 1] ?? null;
    while (inner?.lastChild) inner = inner.lastChild;
    if (!inner || inner.nodeType !== 3) { cellEl.normalize(); return; }
    tail = inner as Text;
    tail.data = "";
    (tail.parentNode as Node).insertBefore(span, tail);
    parent.insertBefore(holder.content, rest);
  }
  tail.insertData(0, ZWSP);
  const caret = document.createRange();
  caret.setStart(tail, 1);
  caret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caret);
  open = { cellEl: cellEl, span: span, tail: tail, cat: cat, keyword: keyword,
    silent: { marks: saved.marks, wrappers: wrappers, pending: true, initialHtml: toHtml(current) },
    suggestion: null, dismissed: null };
  paint(open);
}

function labelSelection(cellEl: Element, cell: readonly Run[], from: number, to: number, id: string): Run[] {
  const opened = cellEl.querySelector("[data-tag-editing]");
  if (!opened || domToPos(cellEl, opened, 0) !== from || domToPos(cellEl, opened, opened.childNodes.length) !== to) {
    return setMark(cell, from, to, "tag", id);
  }
  const path: string[] = [];
  for (let tag: Element | null = opened; tag; tag = tag.parentElement?.closest(".tag-anchor") ?? null) {
    path.unshift(namedTagId(tag.getAttribute("data-tag-cat") as string, tag.getAttribute("data-tag-name") as string));
  }
  // why: the temporary boundary keeps an equal-extent label inside the opened occurrence using model containment
  const bounded = insertText(cell, from, " ", withTagStack(marksAt(cell, from + 1), path));
  return deleteRange(setMark(bounded, from + 1, to + 1, "tag", id), from, from + 1);
}

function chooseCategory(cat: string | null): boolean {
  const saved = categoryCaret;
  if (!saved) return false;
  cancelCategory();
  const look = tagCategory(cat);
  if (!categoryCaretStillThere(saved) || !look) return true;
  if (typeof tagCaret(saved.cellEl) === "string" || !ports) return true;
  if (!saved.range.collapsed) {
    tagPorts().undo.breakCoalescing();
    const done = tagPorts().cells.edit(saved.cellEl, function (cell, selection) {
      if (!selection || selection.from === selection.to) return null;
      const phrase = plainTagPhrase(projection(cell).slice(selection.from, selection.to));
      if (!phrase) return null;
      const name = registryEntryOf(tagPorts().document.current(), look.id, phrase.name)?.name || phrase.name;
      return {
        cell: labelSelection(saved.cellEl, cell, selection.from + phrase.lead, selection.to - phrase.trail, namedTagId(look.id, name)),
        sel: { from: selection.to, to: selection.to }, records: { tags: [{ cat: look.id, name }] }
      };
    });
    tagPorts().undo.breakCoalescing();
    if (done) plainTaggedListeners.slice().forEach(listener => { listener(); });
    return true;
  }
  const keyword = (cat === "sound" ? "sfx" : cat) + ":";
  if (afterOrInsideWord(saved)) {
    openSilentTag(saved, look.id, keyword);
    return true;
  }
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

function ghostEl() { return document.getElementById("tag-open-ghost"); }

function starterEl() { return document.getElementById("tag-open-starter"); }

function caretRange(): Range | null {
  const sel = window.getSelection();
  return sel && sel.rangeCount ? sel.getRangeAt(0) : null;
}

function typedInOpen(o: OpenPlainTag, caret: Range): string {
  const range = document.createRange();
  range.setStartAfter(o.span);
  range.setEnd(caret.startContainer, caret.startOffset);
  return range.toString().replace(ZWSP_RE, "");
}

function suggestionFor(o: OpenPlainTag, typed: string): RegistryCompletion | null {
  if (o.dismissed !== null) {
    if (o.dismissed === typed) return null;
    o.dismissed = null;
  }
  return ports ? registryCompletion(ports.document.current(), o.cat, typed) : null;
}

function dismissSuggestion(): boolean {
  const o = open;
  const caret = caretRange();
  if (!o || !o.suggestion || !caret || !stillThere(o)) return false;
  o.dismissed = typedInOpen(o, caret);
  paint(o);
  return true;
}

export function plainTagOpen(cellEl?: Element | null) {
  if (!open || !stillThere(open)) return false;
  return !cellEl || open.cellEl === cellEl;
}

function stillThere(o: OpenPlainTag) {
  return o.cellEl.isConnected && o.span.isConnected && o.cellEl.contains(o.span);
}

function caretInOpen(o: OpenPlainTag) {
  if (document.activeElement !== o.cellEl && !o.cellEl.contains(document.activeElement)) return null;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const start = domToPos(o.cellEl, o.span, o.span.childNodes.length);
  const end = domToPos(o.cellEl, r.startContainer, r.startOffset);
  if (start === null || end === null || end < start) return null;
  return end - start + 1;
}

function notePlainTagInput(cellEl: Element): void {
  const o = open;
  if (!o || o.cellEl !== cellEl || !o.silent?.pending || !stillThere(o)) return;
  const html = tagPorts().text.storedHtmlFromDom(cellEl.innerHTML.replace(ZWSP_RE, ""));
  if (toHtml(tagPorts().text.fromHtml(html)) === o.silent.initialHtml) return;
  o.silent.pending = false;
  tagPorts().undo.breakCoalescing();
}

function restorePlainTag(cellEl: Element): (() => void) | null {
  const o = open;
  if (!o || o.cellEl !== cellEl || !stillThere(o) || caretInOpen(o) === null) return null;
  const from = domToPos(cellEl, o.span, 0);
  if (from === null) return null;
  const width = o.silent ? 0 : o.keyword.length;
  return function () {
    if (open !== o) return;
    const sel = cellSelection(cellEl);
    const cell = tagPorts().text.fromHtml(tagPorts().text.storedHtmlFromDom(cellEl.innerHTML));
    const start = from + width;
    if (!sel || sel.from !== sel.to || sel.from < start || existingPlainTagEnd(cell, start, true) < sel.to ||
      (!o.silent && projection(cell).slice(from, start) !== o.keyword)) {
      cancelPlainTag();
      return;
    }
    const a = posToDom(cellEl, from), b = posToDom(cellEl, start);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    range.deleteContents();
    range.insertNode(o.span);
    o.tail = document.createTextNode(ZWSP);
    o.span.after(o.tail);
    if (o.silent) { o.silent.pending = false; o.silent.wrappers = []; }
    setCellSelection(cellEl, sel.from, sel.to);
    paint(o);
  };
}

function beforePlainTagWrite(cellEl: Element): ((selection?: CellRange | null) => void) | null {
  const restoreOccurrence = occurrence?.beforeWrite(cellEl);
  const restoreDraft = restorePlainTag(cellEl);
  if (!restoreOccurrence && !restoreDraft) return null;
  return selection => {
    restoreOccurrence?.();
    if (selection) setCellSelection(cellEl, selection.from, selection.to);
    restoreDraft?.();
  };
}

function clearPaint() {
  if (highlightApiOk()) {
    try {
      Object.keys(PLAIN_TAG_KEYWORDS).forEach(function (k) { CSS.highlights.delete(HL_PREFIX + PLAIN_TAG_KEYWORDS[k]); });
    } catch (e) { }
  }
  const el = hintEl();
  if (el) el.classList.remove("is-visible");
  const ghost = ghostEl();
  if (ghost) ghost.classList.remove("is-visible");
  starterEl()?.classList.remove("is-visible");
}

function paint(o: OpenPlainTag) {
  const caret = caretRange();
  const typed = caret ? typedInOpen(o, caret) : "";
  if (highlightApiOk()) {
    try {
      const range = document.createRange();
      range.setStartAfter(o.span);
      const end = window.getSelection()?.getRangeAt(0);
      if (!end) return;
      range.setEnd(end.startContainer, end.startOffset);
      const leading = (typed.match(/^\s*/) || [""])[0].length;
      const start = domToPos(o.cellEl, o.span, o.span.childNodes.length);
      if (leading && start !== null) {
        const point = posToDom(o.cellEl, start + leading);
        range.setStart(point.node, point.offset);
      }
      CSS.highlights.set(HL_PREFIX + o.cat, new Highlight(range));
    } catch (e) { }
  }
  const starter = starterEl();
  const starterRect = starter && caret && !typed.trim() ? caret.getClientRects()[0] : undefined;
  const starterFont = starterRect ? window.getComputedStyle(o.cellEl).font : "";
  const suggestion = caret && !completedInnerTag(o, caret) ? suggestionFor(o, typed) : null;
  o.suggestion = suggestion;
  const el = hintEl();
  const ghost = ghostEl();
  if (el) writeHint(el, o.cat, suggestion ? suggestion.name : "");
  const caretRect = ghost && suggestion && caret ? caret.getClientRects()[0] : undefined;
  const cs = caretRect ? getComputedStyle(o.cellEl) : null;
  const hintAt = el ? hintPlace(o, el) : null;
  if (starter && starterRect) {
    starter.style.font = starterFont;
    starter.style.left = starterRect.left + "px";
    starter.style.top = (starterRect.bottom + 2) + "px";
    starter.setAttribute("data-cat", o.cat);
    if (!starter.classList.contains("is-visible")) starter.classList.add("is-visible");
  } else if (starter?.classList.contains("is-visible")) starter.classList.remove("is-visible");
  if (el && hintAt) {
    el.style.left = hintAt.left + "px";
    el.style.top = hintAt.top + "px";
  }
  if (!ghost) return;
  if (!suggestion || !caretRect || !cs) { ghost.classList.remove("is-visible"); return; }
  ghost.style.font = cs.font;
  ghost.style.lineHeight = cs.lineHeight;
  ghost.style.left = caretRect.right + "px";
  ghost.style.top = caretRect.top + "px";
  ghost.textContent = suggestion.rest;
  ghost.classList.add("is-visible");
}

function writeHint(el: HTMLElement, catId: TagCategoryId, name: string) {
  const cat = tagCategory(catId) as TagCategoryLook;
  if (el.getAttribute("data-cat") !== catId || el.getAttribute("data-name") !== name) {
    el.setAttribute("data-cat", catId);
    el.setAttribute("data-name", name);
    el.innerHTML = '<span class="tag-cat-dot" data-tag-cat="' + cat.id + '" style="--dot: ' + cat.color + '"></span>' +
      (name ? '<b>' + escapeHtml(cat.label) + ':</b><span>' + escapeHtml(name) + '</span>'
        : '<b>' + escapeHtml(cat.label) + '</b><span class="tag-suggest-cat">tag</span>') + '<kbd>Tab</kbd>';
  }
  el.classList.add("is-visible");
}

function hintPlace(o: OpenPlainTag, el: HTMLElement) {
  const w = el.offsetWidth, h = el.offsetHeight;
  const at = document.createRange();
  at.setStartAfter(o.span);
  at.collapse(true);
  const rect = at.getClientRects()[0] || o.cellEl.getBoundingClientRect();
  const cellRect = o.cellEl.getBoundingClientRect();
  let top = cellRect.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, cellRect.top - h - 6);
  return { left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - w - 8)), top: top };
}

function dropSilent(o: OpenPlainTag, silent: SilentTag) {
  const cellEl = o.cellEl;
  const sel = cellEl.isConnected ? cellSelection(cellEl) : null;
  if (o.tail.isConnected && o.tail.data.charAt(0) === ZWSP) o.tail.deleteData(0, 1);
  o.span.remove();
  silent.wrappers.forEach(function (n) { if (n.isConnected && !n.textContent) n.parentNode?.removeChild(n); });
  cellEl.normalize();
  if (sel && document.activeElement === cellEl) setCellSelection(cellEl, sel.from, sel.to);
}
function unwrap(o: OpenPlainTag) {
  if (!o.span.isConnected) return;
  if (o.silent) { dropSilent(o, o.silent); return; }
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
  occurrence?.refresh();
  const o = open;
  if (!o) return;
  if (!stillThere(o)) { open = null; clearPaint(); return; }
  const at = caretInOpen(o);
  if (at === null) { cancelPlainTag(); return; }
  paint(o);
}

function cancelOnBackspace(): boolean {
  const silent = !!open?.silent;
  cancelPlainTag();
  return silent;
}

function plainTagEmptyAtCaret() {
  const o = open;
  if (!o || !stillThere(o)) return false;
  const at = caretInOpen(o);
  return at === 1;
}

export function maybeOpenPlainTag(e: { inputType?: string; data?: string | null }, cellEl: Element) {
  if (e.inputType !== "insertText" || !e.data || e.data.charAt(e.data.length - 1) !== ":") return;
  if (cellEl.getAttribute("data-field") !== "visualText" || !cellEl.closest("#rows, .wr-flow-visual-box")) return;
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
  open = { cellEl: cellEl, span: span, tail: rest, cat: kw.cat, keyword: kwNode.data, silent: null, suggestion: null, dismissed: null };
  paint(open);
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

function plainTagBoundaryMarks(marks: Marks, nested = false) {
  const visual: readonly string[] = FORMAT_MARKS;
  return JSON.stringify(Object.keys(marks).filter(name => !visual.includes(name) && (!nested || (name !== "tag" && name !== "innerTags"))).sort()
    .map(name => [name, marks[name as keyof Marks]]));
}

function existingPlainTagEnd(cell: readonly Run[], from: number, nested = false) {
  const boundary = plainTagBoundaryMarks(marksAt(cell, from), nested);
  let pos = 0;
  for (const run of cell) {
    const end = pos + (run.atom ? 1 : run.text.length);
    if (end <= from) { pos = end; continue; }
    if (run.atom || (!nested && run.marks.tag) || run.marks.href) return Math.max(from, pos);
    if (plainTagBoundaryMarks(run.marks, nested) !== boundary) return Math.max(from, pos);
    const lineEnd = run.text.indexOf("\n", Math.max(0, from - pos));
    if (lineEnd !== -1) return pos + lineEnd;
    pos = end;
  }
  return pos;
}

function completedInnerTag(o: OpenPlainTag, caret: Range): boolean {
  const range = document.createRange();
  range.setStartAfter(o.span);
  range.setEnd(caret.startContainer, caret.startOffset);
  return Array.from(o.cellEl.querySelectorAll(".tag-anchor")).some(tag => range.intersectsNode(tag) && !tag.contains(o.span));
}

export function closePlainTag() {
  const o = open;
  if (!o || !stillThere(o)) { open = null; clearPaint(); return false; }
  const at = caretInOpen(o);
  const start = domToPos(o.cellEl, o.span, o.span.childNodes.length);
  let to = at === null || start === null ? null : start + at - 1;
  const html = tagPorts().text.storedHtmlFromDom(o.cellEl.innerHTML.replace(ZWSP_RE, ""));
  const current = tagPorts().text.fromHtml(html, { media: true });
  if (start !== null && to !== null && existingPlainTagEnd(current, start, true) < to) {
    cancelPlainTag();
    return true;
  }
  let typed = to === null || start === null ? "" : projection(current).slice(start, to);
  if (at === 1 && to !== null) {
    const end = existingPlainTagEnd(current, to);
    typed = projection(current).slice(to, end);
    to = end;
  }
  const phrase = at === null ? null : plainTagPhrase(typed);
  if (!phrase) { cancelPlainTag(); return true; }
  const baseDepth = start === null ? 0 : tagStack(marksAt(current, start)).length;
  const nested = start !== null && to !== null && sliceCell(current, start, to).some(run => tagStack(run.marks).length > baseDepth);
  const shown = nested ? null : o.suggestion;
  const accepted = shown ? registryCompletionOf(tagPorts().document.current(), o.cat, typed, shown.name) : null;
  // why: the shown record is gone or no longer matches; show what is there now
  if (shown && !accepted) { paint(o); return true; }
  open = null;
  clearPaint();
  const entry = accepted ? null : registryEntryOf(tagPorts().document.current(), o.cat, phrase.name);
  const name = accepted || (entry ? entry.name : phrase.name);
  const done = tagPorts().cells.edit(o.cellEl, function (cell) {
    const from = domToPos(o.cellEl, o.silent ? o.span : o.span.firstChild as Node, 0);
    if (from === null || to === null) return null;
    const written = typed.replace(ZWSP_RE, "");
    if (projection(cell).slice(from, to) !== (o.silent ? "" : o.keyword) + written) return null;
    const base = o.silent
      ? insertText(cell, from, o.keyword, written ? typingMarks(cell, from + 1) : o.silent.marks)
      : cell;
    const end = o.silent ? to + o.keyword.length : to;
    const typedFrom = from + o.keyword.length + phrase.lead;
    const filled = accepted ? replaceText(base, typedFrom, end, accepted) : base;
    const res = applyPlainTag(filled, from, accepted ? typedFrom + accepted.length : end, o.cat, name);
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
    mountEditing: () => {
      occurrence?.dispose();
      const editor = createTagOccurrenceEditor(cell => {
        const selection = cellSelection(cell);
        const model = given.text.fromHtml(given.text.storedHtmlFromDom(cell.innerHTML));
        openCategoryAtCaret(cell, selection ? marksAt(model, selection.from) : {});
      }, () => { if (plainTagOpen()) closePlainTag(); given.undo.breakCoalescing(); }, () => {
        given.undo.breakCoalescing();
        given.panels.close("production-panel");
      });
      occurrence = editor;
      return () => {
        cancelCategory(false);
        cancelPlainTag();
        editor.dispose();
        if (occurrence === editor) occurrence = null;
      };
    },
    openCategoryAtCaret,
    chooseCategory,
    cancelCategory,
    maybeOpen: maybeOpenPlainTag,
    refresh: refreshPlainTag,
    beforeWrite: beforePlainTagWrite,
    finishEditing: () => occurrence?.finish() ?? false,
    noteInput: notePlainTagInput,
    cancel: cancelPlainTag,
    close: closePlainTag,
    isOpen: plainTagOpen,
    emptyAtCaret: plainTagEmptyAtCaret,
    cancelOnBackspace,
    dismissSuggestion,
    onTagged: onPlainTagged,
    dispose: function () {
      if (disposed) return;
      disposed = true;
      cancelCategory();
      cancelPlainTag();
      occurrence?.dispose();
      occurrence = null;
      ports = null;
    }
  };
}
