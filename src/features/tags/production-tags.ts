import type { ProductionTagPorts } from "./ports.ts";
import type { TagCategoryLook } from "../../core/production/looks.ts";
import type { PresentedProductionEntry, TagRecordsPlan } from "../../core/production/index.ts";
import type { FieldHtml, ProductionRow, FieldTag } from "../../core/production/ports.ts";
import type { Run, TextRun } from "../../core/text/runs.ts";
import type { TextSpan } from "../../core/text/edits.ts";
import type { DeepReadonly, DocumentView, Stamp } from "../../application/session/document-session.ts";
import type { CellRewrite } from "../../application/commands/document-edit.ts";

type TagShortcut = { open: string; close: string; cat: string };
type TagCompletion = Pick<PresentedProductionEntry, "name" | "mentions" | "cat">;
type TagGhostState = { cellEl: Element; node: Text; openAt: number; offset: number; phrase: string; entry: TagCompletion };
type UntaggedMention = { cellEl: Element; range: Range; entry: TagCompletion; text: string };
type UntaggedIndex = { re: RegExp; byName: Record<string, TagCompletion>; boundedInPattern: boolean };
type TagComposerContext = { quotedText: string; cat?: string; rowId?: string; field?: string; occurrenceIndex?: number };
type TagProductionOwner = ReturnType<ProductionTagPorts["production"]>;
type TagReadonlyArgs<A extends readonly unknown[]> = { [K in keyof A]: DeepReadonly<A[K]> };
type TagProductionRead<K extends "entries" | "current" | "recordsPlan"> =
  (...args: TagReadonlyArgs<Parameters<TagProductionOwner[K]>>) => ReturnType<TagProductionOwner[K]>;
import { plainTagOpen } from "./plain-tags.ts";
import { isInsideProtectedTagOrLink, isInsideTagOrLink } from "../common/dom.ts";
import { exposeTestHook } from "../common/test-hooks.ts";
import { domToPos } from "../common/cell-dom.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import { domRangeFor } from "../common/find-dom.ts";
import { idMap } from "../../core/document/id-map.ts";
import { cappedText, codePointPrefix, escapeHtml, safeId as safeIdFrom } from "../../core/document/text-policy.ts";
import { TAG_CATEGORIES, tagCategory } from "../../core/production/looks.ts";
import {
  bulkTagCell as bulkTagCellWith,
  collectTagsFromRows as collectTagGroups,
  isBlankTagName,
  tagFieldOccurrences as tagFieldOccurrencesWith,
  tagOccurrences
} from "../../core/production/tags.ts";
import { deleteRange, replaceText, replaceWithTag, setMark } from "../../core/text/edits.ts";
import { namedTagId, projection } from "../../core/text/runs.ts";
import { changeSet } from "../../application/session/change-set.ts";
import { addPersonCommand, registerTagCommand, tagCellsCommand } from "../../application/commands/production-records.ts";
import { personNamed, registryEntryById as registryEntryByIdIn } from "../../core/production/records.ts";

let currentDocument: ProductionTagPorts["document"]["current"] | null;
let sharedCommands: ProductionTagPorts["sharedCommands"] | null;
let readSession: ProductionTagPorts["document"]["read"] | null;
let requestRefresh: ProductionTagPorts["refresh"]["request"] | null;
let runDocumentEdit: ProductionTagPorts["edits"]["edit"] | null;
let sessionStamps: ProductionTagPorts["edits"]["stamps"] | null;
let stampDocument: ProductionTagPorts["stamping"]["stamp"] | null;
let cellOf: ProductionTagPorts["text"]["cellOf"] | null;
let inertBody: ProductionTagPorts["text"]["inertBody"] | null;
let sanitizeHtml: ProductionTagPorts["text"]["sanitizeHtml"] | null;
let productionReaders: ProductionTagPorts["text"]["productionReaders"] | null;
let productionIndex: ProductionTagPorts["production"] | null;
let cellEditing: ProductionTagPorts["editing"]["cells"] | null;
let focusMemory: ProductionTagPorts["editing"]["focus"] | null;
let breakUndoCoalescing: ProductionTagPorts["undo"]["breakCoalescing"] | null;
let viewFlags: ProductionTagPorts["view"] | null;
let showToast: ProductionTagPorts["notices"]["show"] | null;
let randomIds: ProductionTagPorts["ids"] | null;

function safeId(id: unknown, prefix: string) { return safeIdFrom(id, prefix, (randomIds as NonNullable<typeof randomIds>)); }

let TAG_SHORTCUT_CHARS: string | null;


export function tagIconSvg(cat: Pick<TagCategoryLook, "icon">) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + cat.icon + '</svg>';
}

export function tagIconCss() {
  return TAG_CATEGORIES.map(function (c) {
    return '[data-tag-cat="' + c.id + '"]{--tag-icon:url("data:image/svg+xml,' + encodeURIComponent(tagIconSvg(c)) + '")}';
  }).join("\n");
}


const TAG_SHORTCUTS: TagShortcut[] = [
  { open: "[", close: "]", cat: "prop" },
  { open: "{", close: "}", cat: "location" },
  { open: "~", close: "~", cat: "vfx" },
  { open: "<", close: ">", cat: "gear" }
];

function hasShortcutChar(s: string) {
  for (let i = 0; i < s.length; i++) {
    if ((TAG_SHORTCUT_CHARS as NonNullable<typeof TAG_SHORTCUT_CHARS>).indexOf(s.charAt(i)) !== -1) return true;
  }
  return false;
}


export let tagsInField: ProductionTagPorts["text"]["productionReaders"]["tagsInField"] | null;

export function collectTagsFromRows(rows: readonly ProductionRow[] | null | undefined) {
  return collectTagGroups(rows, (productionReaders as NonNullable<typeof productionReaders>)).map(function (g) {
    return { key: g.key, cat: tagCategory(g.catId), name: g.name, mentions: g.mentions };
  });
}

export function registerProductionTag(cat: string, name: unknown) {
  return (runDocumentEdit as NonNullable<typeof runDocumentEdit>)(registerTagCommand({ cat: cat, name: String(name == null ? "" : name) }));
}

export function registryEntryById(id: string) {
  return (readSession as NonNullable<typeof readSession>)(function (doc) { return registryEntryByIdIn(doc, id); });
}

export function findOrAddPerson(name: string) {
  (runDocumentEdit as NonNullable<typeof runDocumentEdit>)(addPersonCommand(name, (randomIds as NonNullable<typeof randomIds>)));
  const person = (readSession as NonNullable<typeof readSession>)(function (doc) { return personNamed(doc, name); });
  return person ? person.id : "";
}


function productionEntries() {
  return ((productionIndex as NonNullable<typeof productionIndex>)().entries as TagProductionRead<"entries">)((currentDocument as NonNullable<typeof currentDocument>)());
}

function currentProductionIndex() {
  return ((productionIndex as NonNullable<typeof productionIndex>)().current as TagProductionRead<"current">)((currentDocument as NonNullable<typeof currentDocument>)());
}

function tagRecordsPlan(doc: DocumentView | null) {
  return ((productionIndex as NonNullable<typeof productionIndex>)().recordsPlan as TagProductionRead<"recordsPlan">)(doc, (currentDocument as NonNullable<typeof currentDocument>)());
}

const REGISTRY_CHANGE = changeSet({ docFields: ["productionTags"] });

function registryHealingStamp(plan: TagRecordsPlan, counted: (count: number) => void): Stamp {
  return {
    name: "stamp-tag-registry",
    plan: function () {
      return { changes: REGISTRY_CHANGE, apply: function (live) { counted((plan.apply as NonNullable<typeof plan.apply>)(live)); } };
    }
  };
}

export function healTagRegistry() {
  const plan = tagRecordsPlan((currentDocument as NonNullable<typeof currentDocument>)());
  if (!plan) return 0;
  let count = 0;
  const outcome = plan.apply ? (stampDocument as NonNullable<typeof stampDocument>)(registryHealingStamp(plan, function (n) { count = n; })) : null;
  if (!outcome || outcome.kind === "applied") plan.commit();
  return count;
}

export function productionIndexStats() {
  return { derived: (productionIndex as NonNullable<typeof productionIndex>)().derived(), flushes: idleFlushes };
}

export function resetProductionIndexStats() {
  (productionIndex as NonNullable<typeof productionIndex>)().resetDerived();
  idleFlushes = 0;
}

let idleFlushes = 0;

export function scheduleIdleRefresh(job: string) {
  (requestRefresh as NonNullable<typeof requestRefresh>)(job);
}

export function runIdleRefresh(jobs: ReadonlySet<string>) {
  if (!(currentDocument as NonNullable<typeof currentDocument>)()) return;
  idleFlushes++;
  if (jobs.has("untagged")) scanUntaggedMentions();
}

let taggedListeners: (() => void)[] = [];

export function onTagged(listener: () => void) {
  const listeners = taggedListeners;
  listeners.push(listener);
  return function () {
    const at = listeners.indexOf(listener);
    if (at !== -1) listeners.splice(at, 1);
  };
}

export function announceTagged() {
  taggedListeners.slice().forEach(function (listener) { listener(); });
}

export function scheduleProductionRefresh() {
  scheduleIdleRefresh("production");
}

const AUTO_TAG_MAX_LEN = 60;

export function maybeAutoTagShortcut(e: { inputType?: string; data?: string | null }, cellEl: Element) {
  if (e.inputType !== "insertText" || !e.data) return;
  const typed = e.data.charAt(e.data.length - 1);
  let rule: TagShortcut | null = null;
  for (let i = 0; i < TAG_SHORTCUTS.length; i++) {
    if ((TAG_SHORTCUTS[i] as TagShortcut).close === typed) { rule = (TAG_SHORTCUTS[i] as TagShortcut); break; }
  }
  if (!rule) return;
  const sel = (window.getSelection() as Selection);
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer as Text;
  const offset = range.startOffset;
  if (node.nodeType !== 3 || offset < 2 || node.data[offset - 1] !== rule.close) return;
  if (isInsideProtectedTagOrLink(node.parentNode as Element | null)) return;

  const openAt = node.data.lastIndexOf(rule.open, offset - 2);
  if (openAt === -1) return;
  if (rule.open === rule.close && node.data.charAt(openAt - 1) === rule.open) return;
  const phrase = node.data.slice(openAt + 1, offset - 1);
  const trimmed = phrase.trim();
  if (isBlankTagName(trimmed) || phrase.length > AUTO_TAG_MAX_LEN || hasShortcutChar(phrase)) return;

  tagTextRange(cellEl, node, openAt, offset, trimmed, (rule as TagShortcut).cat, trimmed);
  announceTagged();
}

function tagTextRange(cellEl: Element, node: Text, a: number, b: number, text: string, cat: string, name: string) {
  (cellEditing as NonNullable<typeof cellEditing>)().edit(cellEl, function (cell) {
    const from = domToPos(cellEl, node, a), to = domToPos(cellEl, node, b);
    if (from === null || to === null) return null;
    if (projection(cell).slice(from, to) !== node.data.slice(a, b).replace(/\u200B/g, "")) return null;
    const id = namedTagId(cat, name);
    const reopened = (node.parentElement as Element | null)?.closest("[data-tag-editing]");
    const filled = reopened ? replaceText(cell, from + 1, to, text) : null;
    const r = filled ? {
      cell: deleteRange(setMark(filled, from + 1, from + 1 + text.length, "tag", id), from, from + 1),
      end: from + text.length
    } : replaceWithTag(cell, from, to, text, id);
    return { cell: r.cell, sel: { from: r.end, to: r.end }, records: { tags: [{ cat: cat, name: name }] } };
  });
}

export let tagGhost: TagGhostState | null = null;

function tagGhostEl() { return document.getElementById("tag-ghost"); }

export function hideTagGhost() {
  tagGhost = null;
  const el = tagGhostEl();
  if (el) el.classList.remove("is-visible");
}

function tagCompletionBeats(a: TagCompletion, b: TagCompletion | null | undefined) {
  if (!b) return true;
  if (a.mentions.length !== b.mentions.length) return a.mentions.length > b.mentions.length;
  if (a.name.length !== b.name.length) return a.name.length < b.name.length;
  return a.name.localeCompare(b.name) < 0;
}

function bestTagCompletion(phrase: string, preferCat: string): TagCompletion | null {
  const needle = phrase.toLowerCase();
  let inCat: TagCompletion | null = null, anyCat: TagCompletion | null = null;
  productionEntries().forEach(function (t) {
    if (t.name.toLowerCase().indexOf(needle) !== 0) return;
    if (t.name.length <= phrase.length) return;
    if (t.cat.id === preferCat && tagCompletionBeats(t, inCat)) inCat = t;
    if (tagCompletionBeats(t, anyCat)) anyCat = t;
  });
  return inCat || anyCat;
}

export function updateTagGhost(cellEl: Element) {
  hideTagGhost();
  const sel = (window.getSelection() as Selection);
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer as Text;
  const offset = range.startOffset;
  if (node.nodeType !== 3 || !cellEl.contains(node)) return;
  if (isInsideProtectedTagOrLink(node.parentNode as Element | null)) return;

  let rule: TagShortcut | null = null, openAt = -1;
  TAG_SHORTCUTS.forEach(function (r) {
    const at = node.data.lastIndexOf(r.open, offset - 1);
    if (at > openAt) { openAt = at; rule = r; }
  });
  if (!rule || openAt === -1) return;
  const phrase = node.data.slice(openAt + 1, offset);
  if (!phrase || phrase.length > AUTO_TAG_MAX_LEN || hasShortcutChar(phrase)) return;

  const entry = bestTagCompletion(phrase, (rule as TagShortcut).cat);
  if (!entry) return;

  const rect = range.getClientRects()[0];
  if (!rect) return;
  const el = tagGhostEl();
  if (!el) return;
  const cs = getComputedStyle(cellEl);
  el.style.font = cs.font;
  el.style.left = rect.right + "px";
  el.style.top = rect.top + "px";
  el.style.lineHeight = cs.lineHeight;
  el.innerHTML = escapeHtml(entry.name.slice(phrase.length)) +
    (entry.cat.id === (rule as TagShortcut).cat ? "" :
      '<span class="tag-ghost-cat">' + escapeHtml(entry.cat.label) + '</span>');
  el.classList.add("is-visible");

  tagGhost = { cellEl: cellEl, node: node, openAt: openAt, offset: offset, phrase: phrase, entry: entry };
}

export function acceptTagGhost() {
  const g = tagGhost;
  if (!g) return false;
  const sel = (window.getSelection() as Selection);
  if (!sel.rangeCount || !sel.isCollapsed) { hideTagGhost(); return false; }
  const r = sel.getRangeAt(0);
  if (r.startContainer !== g.node || r.startOffset !== g.offset) { hideTagGhost(); return false; }

  hideTagGhost();
  tagTextRange(g.cellEl, g.node, g.openAt, g.offset, g.entry.name, g.entry.cat.id, g.entry.name);
  announceTagged();
  return true;
}

const UNTAGGED_HL = "splitpage-untagged";
let untaggedList: UntaggedMention[] = [];
export let untaggedSuggestion: UntaggedMention | null = null;

function highlightApiOk() {
  return !!(window.CSS && CSS.highlights && window.Highlight);
}

function buildUntaggedIndex(entries: readonly TagCompletion[]): UntaggedIndex | null {
  const names: string[] = [], byName: Record<string, TagCompletion> = Object.create(null);
  entries.forEach(function (e) {
    const n = (e.name || "").trim();
    if (!n) return;
    const k = n.toLowerCase();
    if (byName[k]) {
      if (tagCompletionBeats(e, byName[k])) byName[k] = e;
      return;
    }
    names.push(n);
    byName[k] = e;
  });
  if (!names.length) return null;
  const alt = names.sort(function (a, b) { return b.length - a.length; })
    .map(function (n) { return n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); })
    .join("|");

  try {
    return {
      re: new RegExp("(?<![\\p{L}\\p{N}])(" + alt + ")(?![\\p{L}\\p{N}])", "giu"),
      byName: byName,
      boundedInPattern: true
    };
  } catch (e) {
    return { re: new RegExp("(" + alt + ")", "gi"), byName: byName, boundedInPattern: false };
  }
}

function eachPlainTextNode(root: Node, fn: (node: Text) => void) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      return isInsideTagOrLink(node.parentNode as Element | null)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  let node;
  while ((node = walker.nextNode())) fn(node as Text);
}

function collectUntaggedInCell(cellEl: Element, index: UntaggedIndex, out: UntaggedMention[]) {
  eachPlainTextNode(cellEl, function (node) {
    const text = node.nodeValue || "";
    if (!text) return;
    index.re.lastIndex = 0;
    let m;
    while ((m = index.re.exec(text))) {
      const start = m.index, len = m[0].length;
      if (!index.boundedInPattern) {
        const before = start === 0 ? "" : text.charAt(start - 1);
        const after = text.charAt(start + len);
        if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;
      }
      const entry = index.byName[m[0].toLowerCase()];
      if (!entry) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + len);
      out.push({ cellEl: cellEl, range: range, entry: entry, text: m[0] });
    }
  });
}

function paintUntagged() {
  if (!highlightApiOk()) return;
  try {
    if (!untaggedList.length) { CSS.highlights.delete(UNTAGGED_HL); return; }
    const hl = new Highlight();
    untaggedList.forEach(function (item) { hl.add(item.range); });
    CSS.highlights.set(UNTAGGED_HL, hl);
  } catch (e) { }
}

function scanUntaggedMentions(entries?: readonly TagCompletion[]) {
  if (!(currentDocument as NonNullable<typeof currentDocument>)()) return;
  untaggedList = [];
  const index = (viewFlags as NonNullable<typeof viewFlags>)().writerOpen() ? null : buildUntaggedIndex(entries || productionEntries());
  if (index) {
    const cells = document.querySelectorAll('#rows .visual-cell .cell-editable');
    Array.prototype.forEach.call(cells, function (cellEl: Element) {
      collectUntaggedInCell(cellEl, index, untaggedList);
    });
  }
  paintUntagged();
  updateUntaggedPrompt();
}

export function scheduleUntaggedScan() {
  scheduleIdleRefresh("untagged");
}

export function hideUntaggedPrompt() {
  untaggedSuggestion = null;
  const el = document.getElementById("tag-suggest");
  if (el) el.classList.remove("is-visible");
}

export function updateUntaggedPrompt() {
  const el = document.getElementById("tag-suggest");
  if (!el) return;
  const active = document.activeElement;
  const cellEl = (active && active.classList && active.classList.contains("cell-editable") &&
    active.getAttribute("data-field") === "visualText" && active.closest("#rows")) ? active : null;
  if (!cellEl || (focusMemory as NonNullable<typeof focusMemory>)().promptMutedFor() === cellEl) { hideUntaggedPrompt(); return; }
  if (plainTagOpen(cellEl)) { hideUntaggedPrompt(); return; }

  const here = untaggedList.filter(function (i) { return i.cellEl === cellEl; });
  if (!here.length) { hideUntaggedPrompt(); return; }

  let pick = (here[0] as UntaggedMention);
  const sel = (window.getSelection() as Selection);
  if (sel.rangeCount && sel.isCollapsed) {
    const caret = sel.getRangeAt(0);
    for (let i = 0; i < here.length; i++) {
      try {
        if ((here[i] as UntaggedMention).range.compareBoundaryPoints(Range.START_TO_START, caret) <= 0) pick = (here[i] as UntaggedMention);
      } catch (e) { }
    }
  }

  const rect = pick.range.getClientRects()[0] || pick.range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) { hideUntaggedPrompt(); return; }

  el.innerHTML = 'Tag <b>' + escapeHtml(pick.text) + '</b>' +
    '<span class="tag-suggest-cat">' + escapeHtml(pick.entry.cat.label) + '</span>' +
    '<kbd>Tab</kbd>';
  el.classList.add("is-visible");
  const w = el.offsetWidth, h = el.offsetHeight;
  const cellRect = cellEl.getBoundingClientRect();
  let top = cellRect.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, cellRect.top - h - 6);
  el.style.left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - w - 8)) + "px";
  el.style.top = top + "px";
  untaggedSuggestion = pick;
}

export function acceptUntaggedMention() {
  const s = untaggedSuggestion;
  if (!s || !s.cellEl.isConnected) { hideUntaggedPrompt(); return false; }
  if (String(s.range) !== s.text) {
    hideUntaggedPrompt();
    scheduleUntaggedScan();
    return false;
  }
  const node = s.range.startContainer as Text;
  if (node.nodeType !== 3 || s.range.endContainer !== node) { hideUntaggedPrompt(); return false; }

  hideUntaggedPrompt();
  tagTextRange(s.cellEl, node, s.range.startOffset, s.range.endOffset, s.text, s.entry.cat.id, s.entry.name);
  announceTagged();
  scanUntaggedMentions();
  return true;
}

function wrapTagInHtml(html: string, cell: readonly Run[], found: readonly TextSpan[], cat: string, name: string) {
  const body = (inertBody as NonNullable<typeof inertBody>)(html);
  const doc = body.ownerDocument;
  const expect = projection(cell);
  for (let i = found.length - 1; i >= 0; i--) {
    const range = domRangeFor(body, (found[i] as TextSpan).from, (found[i] as TextSpan).to, expect);
    if (!range) return null;
    const span = doc.createElement("span");
    span.className = "tag-anchor";
    span.setAttribute("data-tag-cat", cat);
    span.setAttribute("data-tag-name", name);
    span.appendChild(range.extractContents());
    range.insertNode(span);
  }
  Array.prototype.forEach.call(body.querySelectorAll("strong, em, u, s, mark"), function (el: Element) {
    if (el.parentNode && !el.textContent && !el.querySelector("img, br")) el.parentNode.removeChild(el);
  });
  return (sanitizeHtml as NonNullable<typeof sanitizeHtml>)(body.innerHTML);
}

export function tagFieldOccurrences(html: FieldHtml, phrase: unknown, cat: string, name: unknown, countOnly: unknown, onlyOccurrence?: number) {
  return tagFieldOccurrencesWith(html, phrase, cat, name, countOnly, onlyOccurrence, (productionReaders as NonNullable<typeof productionReaders>), wrapTagInHtml);
}

export function bulkTagCell(html: FieldHtml, phrase: unknown, cat: string, name: unknown, matchCase: unknown, countOnly: unknown) {
  return bulkTagCellWith(html, phrase, cat, name, matchCase, countOnly, (productionReaders as NonNullable<typeof productionReaders>), wrapTagInHtml);
}

function allOccurrencesTagged(doc: DocumentView | null, phrase: unknown, cat: string, name: string) {
  const needle = String(phrase || "").trim();
  const out: { hits: number; rewrites: CellRewrite[] } = { hits: 0, rewrites: [] };
  if (!needle || !doc) return out;
  doc.rows.forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      const res = tagFieldOccurrences(row[field] as FieldHtml, needle, cat, name, false);
      if (!res.hits) return;
      out.hits += res.hits;
      out.rewrites.push({ rowId: row.id, field: field, html: res.html as string });
    });
  });
  return out;
}

function countPhraseMatches(phrase: unknown) {
  const needle = String(phrase || "").trim();
  if (!needle || !(currentDocument as NonNullable<typeof currentDocument>)()) return 0;
  let total = 0;
  ((currentDocument as NonNullable<typeof currentDocument>)() as DocumentView).rows.forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      total += tagOccurrences((cellOf as NonNullable<typeof cellOf>)(row[field] as FieldHtml), needle).length;
    });
  });
  return total;
}

let pendingTag: TagComposerContext | null = null;
const composerFocusTimers = new Set<ReturnType<typeof setTimeout>>();
export function renderTagCategories(selected: string | null) {
  (document.getElementById("tag-cats") as HTMLElement).innerHTML = TAG_CATEGORIES.map(function (c) {
    return '<button type="button" class="tag-cat-btn' + (c.id === selected ? ' is-active' : '') +
      '" style="--dot:' + c.color + '" data-tag-cat="' + c.id + '" role="radio" aria-checked="' +
      (c.id === selected ? 'true' : 'false') + '">' +
      '<span class="tag-cat-dot" aria-hidden="true"></span>' + escapeHtml(c.label) + '</button>';
  }).join("");
}

function refreshTagNameList() {
  const names = idMap<boolean>();
  productionEntries().forEach(function (t) { names[t.name] = true; });
  (document.getElementById("tag-name-list") as HTMLElement).innerHTML =
    Object.keys(names).sort().map(function (n) {
      return '<option value="' + escapeHtml(n) + '"></option>';
    }).join("");
}

function updateTagHint() {
  const hint = (document.getElementById("tag-hint") as HTMLElement);
  if (!pendingTag) { hint.textContent = ""; return; }
  const n = countPhraseMatches(pendingTag.quotedText);
  const box = (document.getElementById("tag-all") as HTMLInputElement);
  if (n > 1) {
    box.disabled = false;
    hint.textContent = '"' + pendingTag.quotedText + '" appears ' + n + " times in the script.";
  } else {
    box.disabled = true;
    box.checked = false;
    hint.textContent = "";
  }
}

export function openTagComposer(ctx: TagComposerContext) {
  const selection = window.getSelection();
  if (selection?.rangeCount && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    const cell = element?.closest("#rows .cell-editable, #writer-doc .wr-beat");
    if (cell && cell.getAttribute("data-id") === ctx.rowId && cell.getAttribute("data-field") === ctx.field &&
      cell.contains(range.endContainer) && Array.from(cell.querySelectorAll(".tag-anchor")).some(tag => range.intersectsNode(tag))) {
      (showToast as NonNullable<typeof showToast>)("That selection includes an existing tag. Select only untagged words.", "warn");
      return;
    }
  }
  pendingTag = ctx;
  (document.getElementById("tag-quote") as HTMLElement).textContent = ctx.quotedText;
  const nameInput = (document.getElementById("tag-name") as HTMLInputElement);
  nameInput.value = codePointPrefix(ctx.quotedText, 80);
  renderTagCategories(ctx.cat || "prop");
  refreshTagNameList();
  (document.getElementById("tag-all") as HTMLInputElement).checked = false;
  updateTagHint();
  (document.getElementById("tag-modal") as HTMLElement).hidden = false;
  const focusTimer = setTimeout(function () {
    if (!composerFocusTimers.delete(focusTimer)) return;
    nameInput.focus(); nameInput.select();
  }, 0);
  composerFocusTimers.add(focusTimer);
}

export function closeTagComposer() {
  (document.getElementById("tag-modal") as HTMLElement).hidden = true;
  pendingTag = null;
}

function selectedTagCategory() {
  const active = document.querySelector("#tag-cats .tag-cat-btn.is-active");
  return active ? active.getAttribute("data-tag-cat") : "prop";
}

export function applyTag() {
  if (!pendingTag) return;
  if ((sharedCommands as NonNullable<typeof sharedCommands>).refuseUnsupported()) return;
  const cat = (selectedTagCategory() as string);
  const name = cappedText((document.getElementById("tag-name") as HTMLInputElement).value, 80);
  if (isBlankTagName(name)) { (showToast as NonNullable<typeof showToast>)("Give the label a name first.", "warn"); return; }

  const all = (document.getElementById("tag-all") as HTMLInputElement).checked;
  const phrase = pendingTag.quotedText;
  const ctx = pendingTag;
  closeTagComposer();

  if (all) {
    (breakUndoCoalescing as NonNullable<typeof breakUndoCoalescing>)();
    const n = (readSession as NonNullable<typeof readSession>)(function (doc) { return allOccurrencesTagged(doc, phrase, cat, name).hits; });
    (runDocumentEdit as NonNullable<typeof runDocumentEdit>)(tagCellsCommand("tag-all-occurrences", function (doc) {
      return allOccurrencesTagged(doc, phrase, cat, name).rewrites;
    }, { cat: cat, name: name }, (sessionStamps as NonNullable<typeof sessionStamps>), true));
    (breakUndoCoalescing as NonNullable<typeof breakUndoCoalescing>)();
    (showToast as NonNullable<typeof showToast>)("Labelled " + n + " mention" + (n === 1 ? "" : "s") + " of " + name, "ok");
    return;
  }

  const flow = document.getElementById("writer")?.hidden === false;
  const cellEl = flow ? document.querySelector('#writer-doc .wr-beat[data-id="' + safeId(ctx.rowId, "r") + '"]')
    : document.querySelector('#rows .row[data-id="' + safeId(ctx.rowId, "r") +
      '"] .' + (ctx.field === "visualText" ? "visual" : "audio") + '-cell .cell-editable');
  if (!cellEl) { (showToast as NonNullable<typeof showToast>)("That beat is no longer here.", "warn"); return; }

  const idx = (readSession as NonNullable<typeof readSession>)(function (doc) { return rowIndexOf(doc, (ctx.rowId as NonNullable<typeof ctx.rowId>)); });
  if (idx === -1) return;
  (cellEditing as NonNullable<typeof cellEditing>)().sync(cellEl);
  (breakUndoCoalescing as NonNullable<typeof breakUndoCoalescing>)();
  function tagged(doc: DocumentView | null): CellRewrite[] {
    const row = doc ? doc.rows[rowIndexOf(doc, (ctx.rowId as NonNullable<typeof ctx.rowId>))] : null;
    const res = row ? tagFieldOccurrences(row[(ctx.field as NonNullable<typeof ctx.field>)] as FieldHtml, phrase, cat, name, false, ctx.occurrenceIndex || 0) : null;
    return res && res.hits ? [{ rowId: (ctx.rowId as NonNullable<typeof ctx.rowId>), field: (ctx.field as NonNullable<typeof ctx.field>), html: res.html as string }] : [];
  }
  if (!(readSession as NonNullable<typeof readSession>)(tagged).length) { (showToast as NonNullable<typeof showToast>)("Could not find that text any more.", "warn"); return; }
  (runDocumentEdit as NonNullable<typeof runDocumentEdit>)(tagCellsCommand("tag-occurrence", tagged, { cat: cat, name: name }, (sessionStamps as NonNullable<typeof sessionStamps>), true));
  (breakUndoCoalescing as NonNullable<typeof breakUndoCoalescing>)();
  (showToast as NonNullable<typeof showToast>)("Labelled as " + name, "ok");
}

export function startProductionTags(ports: ProductionTagPorts) {
  sharedCommands = ports.sharedCommands;
  let cancelRefresh: ProductionTagPorts["refresh"]["cancel"] | null = ports.refresh.cancel;
  currentDocument = ports.document.current;
  readSession = ports.document.read;
  requestRefresh = ports.refresh.request;
  runDocumentEdit = ports.edits.edit;
  sessionStamps = ports.edits.stamps;
  stampDocument = ports.stamping.stamp;
  cellOf = ports.text.cellOf;
  inertBody = ports.text.inertBody;
  sanitizeHtml = ports.text.sanitizeHtml;
  productionReaders = ports.text.productionReaders;
  tagsInField = (productionReaders as NonNullable<typeof productionReaders>).tagsInField;
  productionIndex = ports.production;
  cellEditing = ports.editing.cells;
  focusMemory = ports.editing.focus;
  breakUndoCoalescing = ports.undo.breakCoalescing;
  viewFlags = ports.view;
  showToast = ports.notices.show;
  randomIds = ports.ids;
  TAG_SHORTCUT_CHARS = (function () {
    let s = "";
    TAG_SHORTCUTS.forEach(function (r) {
      if (s.indexOf(r.open) === -1) s += r.open;
      if (s.indexOf(r.close) === -1) s += r.close;
    });
    return s;
  })();

  const iconStyle = document.createElement("style");
  iconStyle.id = "tag-icon-style";
  iconStyle.textContent = tagIconCss();
  document.head.appendChild(iconStyle);

  let disposed = false;
  let withdrawHook: (() => void) | null = null;
  exposeTestHook("__cacheTest", function () { return {
    index: function () { return disposed ? null : currentProductionIndex(); },
    frozen: function () {
      if (disposed) return [];
      const html = "Put the " + '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="kettle">kettle</span> on.';
      return [(cellOf as NonNullable<typeof cellOf>)(html), (productionReaders as NonNullable<typeof productionReaders>).tagsInField(html), (productionReaders as NonNullable<typeof productionReaders>).cueNamesInField(html), currentProductionIndex()]
        .map(function (v) { return !!v && Object.isFrozen(v); });
    },
    writes: function () {
      if (disposed) return [];
      const html = '<strong>Probe</strong> the <span class="tag-anchor" data-tag-cat="prop" data-tag-name="probe lamp">lamp</span>.';
      const cell = (cellOf as NonNullable<typeof cellOf>)(html), tags = (productionReaders as NonNullable<typeof productionReaders>).tagsInField(html);
      return [
        function () { (cell[0] as TextRun).text = "x"; },
        function () { delete ((cell[0] as Run).marks as TextRun["marks"]).b; },
        function () { (cell as Run[]).length = 0; },
        function () { (tags[0] as FieldTag).name = "x"; },
        function () { Object.defineProperty(tags[0], "text", { value: "x" }); }
      ].map(function (write) {
        try { write(); return false; } catch (e) { return e instanceof TypeError; }
      });
    }
  }; }, function (withdraw) { withdrawHook = withdraw; });

  return {
    onTagged: function (listener: () => void) { return disposed ? function () {} : onTagged(listener); },
    refresh: function (jobs: ReadonlySet<string>) { if (!disposed) runIdleRefresh(jobs); },
    dispose: function () {
      if (disposed) return;
      disposed = true;
      try {
        (cancelRefresh as NonNullable<typeof cancelRefresh>)(["untagged", "production"]);
      } finally {
        composerFocusTimers.forEach(clearTimeout);
        composerFocusTimers.clear();
        iconStyle.remove();
        hideTagGhost();
        hideUntaggedPrompt();
        if (document.getElementById("tag-modal")) closeTagComposer();
        pendingTag = null;
        taggedListeners = [];
        untaggedList = [];
        idleFlushes = 0;
        if (window.CSS && window.CSS.highlights) window.CSS.highlights.delete(UNTAGGED_HL);
        if (withdrawHook) withdrawHook();
        currentDocument = readSession = requestRefresh = runDocumentEdit = sessionStamps = stampDocument = null;
        sharedCommands = null;
        cellOf = inertBody = sanitizeHtml = productionReaders = null;
        productionIndex = cellEditing = focusMemory = breakUndoCoalescing = viewFlags = showToast = randomIds = null;
        tagsInField = TAG_SHORTCUT_CHARS = cancelRefresh = null;
      }
    }
  };
}
