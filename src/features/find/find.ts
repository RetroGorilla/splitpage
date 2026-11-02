import type { FindControls, FindPorts } from "./ports.ts";
import type { FindOptions } from "../../application/find-options.ts";
import type { BulkTagTotals } from "../../application/commands/bulk-tags.ts";
import type { CellRewrite } from "../../application/commands/document-edit.ts";
import type { DocumentView } from "../../application/session/document-session.ts";
import type { DocumentRow, DocumentTag } from "../../core/document/validated.ts";
import type { Run } from "../../core/text/runs.ts";

type FindDocumentView = { readonly rows: DocumentView["rows"]; readonly productionTags: DocumentView["productionTags"] };
type FindRuntimePorts = { readonly [K in Exclude<keyof FindPorts, "document">]: FindPorts[K] } & {
  readonly document: {
    readonly current: () => FindDocumentView | null;
    readonly read: <T>(select: (doc: FindDocumentView | null) => T) => T;
  };
};

type SearchPiece = { start: number; text: string };
type TaggedPiece = SearchPiece & { tag: string };
type SearchPieces = { free: SearchPiece[]; tagged: TaggedPiece[] };
type FindMatch = { rowId: string; field: string; nth: number };

import { domRangeFor } from "../common/find-dom.ts";
import { mountFind } from "./mount.ts";
import { normalizeTagName, registryTagHooks } from "../../core/document/tags.ts";
import { isBlankTagName } from "../../core/production/tags.ts";
import { TAG_CATEGORIES, tagCategory } from "../../core/production/looks.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import { rewriteCellsCommand, rewrittenCopies } from "../../application/commands/document-edit.ts";
import { tagCellsCommand } from "../../application/commands/production-records.ts";
import { cssAttr } from "../common/dom.ts";
import { idMap } from "../../core/document/id-map.ts";
import { escapeHtml, withoutLoneSurrogates } from "../../core/document/text-policy.ts";
import { replaceText } from "../../core/text/edits.ts";
import { toHtml } from "../../core/text/html.ts";
import { projection } from "../../core/text/runs.ts";
import { presentFindRanges } from "./present-ranges.ts";

let ports: FindRuntimePorts | null = null;

let findMatches: FindMatch[] = [];
let findIndex = -1;
let findInTags = 0;
let presentRanges: Range[] = [];
let stopViewChange: (() => void) | null = null;

function findingInPresent() {
  return !!document.getElementById("findbar")?.classList.contains("is-present");
}

function matchCount() {
  return findingInPresent() ? presentRanges.length : findMatches.length;
}

function findNeedle() {
  return (document.getElementById("find-input") as HTMLInputElement).value || "";
}

function escapeRegExpLiteral(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findAllMatches(text: string, needle: string, matchCase: boolean) {
  needle = withoutLoneSurrogates(needle);
  if (!needle) return [];
  const re = new RegExp(escapeRegExpLiteral(needle), matchCase ? "g" : "gi");
  const out: { start: number; end: number }[] = [];
  let m;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

function searchablePieces(cell: readonly Run[]) {
  const free: SearchPiece[] = [], tagged: TaggedPiece[] = [];
  let pos = 0, cur: SearchPiece | null = null, curTag: TaggedPiece | null = null;
  cell.forEach(function (r) {
    if (r.atom) { cur = null; curTag = null; pos += 1; return; }
    const tag = r.marks.tag;
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

export function findInCell(cell: readonly Run[], needle: string, matchCase: boolean) {
  if (!needle) return [];
  return matchesInPieces(searchablePieces(cell), needle, matchCase);
}

function matchesInPieces(pieces: SearchPieces, needle: string, matchCase: boolean) {
  const out: { from: number; to: number }[] = [];
  pieces.free.forEach(function (p) {
    findAllMatches(p.text, needle, matchCase).forEach(function (m) {
      out.push({ from: p.start + m.start, to: p.start + m.end });
    });
  });
  return out;
}

export function countInTags(cell: readonly Run[], needle: string, matchCase: boolean) {
  if (!needle) return 0;
  return countInPieces(searchablePieces(cell), needle, matchCase);
}

function countInPieces(pieces: SearchPieces, needle: string, matchCase: boolean) {
  return pieces.tagged.reduce(function (n, p) {
    return n + findAllMatches(p.text, needle, matchCase).length;
  }, 0);
}

export function findInRows(rows: readonly DocumentRow[] | null | undefined, needle: string, matchCase: boolean) {
  const matches: FindMatch[] = [];
  let inTags = 0;
  if (!needle) return { matches: matches, inTags: inTags };
  (rows || []).forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      const pieces = searchablePieces((ports as FindRuntimePorts).text.cellOf(row[field]));
      const n = matchesInPieces(pieces, needle, matchCase).length;
      for (let i = 0; i < n; i++) matches.push({ rowId: row.id, field: field, nth: i });
      inTags += countInPieces(pieces, needle, matchCase);
    });
  });
  return { matches: matches, inTags: inTags };
}

export function noMatchLabel(inTags: number) {
  if (!inTags) return "No matches";
  return "No matches · " + (inTags === 1 ? "1 in a tag" : inTags + " in tags");
}

export function replaceInHtml(html: string, needle: string, replacement: unknown, nth: number, matchCase: boolean, hooks?: Parameters<typeof toHtml>[1]) {
  let cell = (ports as FindRuntimePorts).text.cellOf(html);
  let matches = findInCell(cell, needle, matchCase);
  if (nth !== -1) matches = matches[nth] ? [matches[nth]] : [];
  if (!matches.length) return { html: html, changed: 0 };
  const text = replacement == null ? "" : String(replacement);
  const todo = matches.slice().reverse();
  if (/<img[\s>]|video-embed-card/i.test(html || "")) {
    const body = (ports as FindRuntimePorts).text.inertBody(html);
    let expect = projection(cell);
    for (let i = 0; i < todo.length; i++) {
      const range = domRangeFor(body, (todo[i] as { from: number; to: number; }).from, (todo[i] as { from: number; to: number; }).to, expect);
      if (!range) return { html: html, changed: 0 };
      range.deleteContents();
      if (text) range.insertNode(body.ownerDocument.createTextNode(text));
      expect = expect.slice(0, (todo[i] as { from: number; to: number; }).from) + text + expect.slice((todo[i] as { from: number; to: number; }).to);
    }
    Array.prototype.forEach.call(body.querySelectorAll("strong, em, u, s, mark, a, span.cmt-anchor, span.stage-dir"), function (el: Element) {
      if (el.parentNode && !el.textContent && !el.querySelector("img, br")) el.parentNode.removeChild(el);
    });
    return { html: (ports as FindRuntimePorts).text.sanitizeHtml(body.innerHTML), changed: matches.length };
  }
  todo.forEach(function (m) { cell = replaceText(cell, m.from, m.to, text); });
  return { html: toHtml(cell, hooks), changed: matches.length };
}

function refreshFindMatches(keepIndex: boolean) {
  if (findingInPresent()) {
    findMatches = [];
    presentRanges = presentFindRanges(document.getElementById("prompter-content") as HTMLElement, findNeedle(), (ports as FindRuntimePorts).options.matchesCase());
    findInTags = 0;
    findIndex = presentRanges.length ? (keepIndex ? Math.max(0, Math.min(findIndex, presentRanges.length - 1)) : 0) : -1;
    if (highlightsSupported()) {
      const highlight = new Highlight();
      for (const range of presentRanges) highlight.add(range);
      CSS.highlights.set(PRESENT_HL, highlight);
    }
    updateFindCount();
    return;
  }
  const found = findInRows((ports as FindRuntimePorts).document.current()?.rows ?? [], findNeedle(), (ports as FindRuntimePorts).options.matchesCase());
  findMatches = found.matches;
  findInTags = found.inTags;
  if (!findMatches.length) findIndex = -1;
  else if (!keepIndex || findIndex < 0) findIndex = 0;
  else if (findIndex >= findMatches.length) findIndex = findMatches.length - 1;
  updateFindCount();
  refreshBulkTagRow();
}

function updateFindCount() {
  const el = document.getElementById("find-count");
  if (!el) return;
  const needle = findNeedle();
  el.removeAttribute("title");
  if (!needle) { el.textContent = ""; el.classList.remove("none"); return; }
  if (!matchCount()) {
    el.textContent = noMatchLabel(findInTags);
    if (findInTags) el.title = "Find never changes a tag's words — rename it in Production instead.";
    el.classList.add("none");
    return;
  }
  el.classList.remove("none");
  el.textContent = (findIndex + 1) + " of " + matchCount();
}

function currentMatchRange() {
  if (findIndex < 0 || !findMatches[findIndex]) return null;
  const m = (findMatches[findIndex] as FindMatch);
  const cell = document.querySelector<HTMLElement>('#rows .row[data-id="' + cssAttr(m.rowId) + '"] .cell-editable[data-field="' + m.field + '"]');
  if (!cell) return null;
  const idx = (ports as FindRuntimePorts).document.read(function (doc) { return rowIndexOf(doc, m.rowId); });
  if (idx === -1) return null;
  const model = (ports as FindRuntimePorts).text.cellOf((((ports as FindRuntimePorts).document.current() as FindDocumentView).rows[idx] as DocumentRow)[m.field] as string);
  const hit = findInCell(model, findNeedle(), (ports as FindRuntimePorts).options.matchesCase())[m.nth];
  if (!hit) return null;
  const range = domRangeFor(cell, hit.from, hit.to, projection(model));
  return range ? { cell: cell, range: range } : null;
}

const FIND_HL = "splitpage-find-match";
const PRESENT_HL = "splitpage-present-matches";

function highlightsSupported() {
  return !!(window.CSS && CSS.highlights && window.Highlight);
}

function revealFindMatch() {
  if (findingInPresent()) {
    const range = presentRanges[findIndex];
    if (highlightsSupported()) {
      if (range) CSS.highlights.set(FIND_HL, new Highlight(range));
      else CSS.highlights.delete(FIND_HL);
    }
    return;
  }
  const m = (findMatches[findIndex] as FindMatch);
  if (m) (ports as FindRuntimePorts).shotHiding().reveal(m.rowId);
  const hit = currentMatchRange();
  if (highlightsSupported()) {
    if (hit) CSS.highlights.set(FIND_HL, new Highlight(hit.range));
    else CSS.highlights.delete(FIND_HL);
  }
  if (!hit) return;
  const row = hit.cell.closest(".row");
  if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function findQueryChanged() {
  refreshFindMatches(false);
  revealFindMatch();
}

function stepFind(dir: number) {
  const count = matchCount();
  if (!count) return;
  findIndex = (findIndex + dir + count) % count;
  updateFindCount();
  revealFindMatch();
  if (findingInPresent()) (ports as FindRuntimePorts).present.jump(presentRanges[findIndex] as Range);
}

function replaceCurrent() {
  if (findingInPresent()) return;
  const needle = findNeedle();
  if (!needle || findIndex < 0 || !findMatches[findIndex]) return;
  revealFindMatch();
  const m = (findMatches[findIndex] as FindMatch);
  const idx = (ports as FindRuntimePorts).document.read(function (doc) { return rowIndexOf(doc, m.rowId); });
  if (idx === -1) return;
  const replacement = (document.getElementById("replace-input") as HTMLInputElement).value || "";
  const matchCase = (ports as FindRuntimePorts).options.matchesCase();
  function replaced(doc: FindDocumentView) {
    const row = doc.rows[rowIndexOf(doc, m.rowId)];
    if (!row) return [];
    const res = replaceInHtml(row[m.field] as string, needle, replacement, m.nth, matchCase, registryTagHooks(doc.productionTags));
    return res.changed ? [{ rowId: m.rowId, field: m.field, html: res.html }] : [];
  }
  if (!(ports as FindRuntimePorts).edits.edit(rewriteCellsCommand("replace-match", replaced, (ports as FindRuntimePorts).edits.stamps, { needs: "edit", stamped: true }))) return;
  refreshFindMatches(true);
  revealFindMatch();
}

export function replaceAll() {
  if (findingInPresent()) return;
  const needle = findNeedle();
  if (!needle) return;
  const replacement = (document.getElementById("replace-input") as HTMLInputElement).value || "";
  const matchCase = (ports as FindRuntimePorts).options.matchesCase();
  function replacedAll(doc: FindDocumentView | null) {
    const hooks = registryTagHooks((doc as FindDocumentView).productionTags);
    const out: { total: number; rewrites: CellRewrite[] } = { total: 0, rewrites: [] };
    (doc as FindDocumentView).rows.forEach(function (row) {
      ["visualText", "audioText"].forEach(function (field) {
        const res = replaceInHtml(row[field] as string, needle, replacement, -1, matchCase, hooks);
        if (!res.changed) return;
        out.total += res.changed;
        out.rewrites.push({ rowId: row.id, field: field, html: res.html });
      });
    });
    return out;
  }
  const total = (ports as FindRuntimePorts).document.read(replacedAll).total;
  const inTags = ((ports as FindRuntimePorts).document.current() as FindDocumentView).rows.reduce(function (n, row) {
    return n + countInTags((ports as FindRuntimePorts).text.cellOf(row.visualText), needle, (ports as FindRuntimePorts).options.matchesCase()) +
               countInTags((ports as FindRuntimePorts).text.cellOf(row.audioText), needle, (ports as FindRuntimePorts).options.matchesCase());
  }, 0);
  const tagNote = inTags
    ? " · " + inTags + " left inside tag" + (inTags === 1 ? "" : "s") + " — rename those in Production"
    : "";
  if (!total || !(ports as FindRuntimePorts).edits.edit(rewriteCellsCommand("replace-all", function (doc) { return replacedAll(doc).rewrites; }, (ports as FindRuntimePorts).edits.stamps, { needs: "edit", stamped: true }))) {
    (ports as FindRuntimePorts).notices.show(inTags
      ? "Only found inside tags — rename it in Production instead."
      : "Nothing to replace.", "warn");
    return;
  }
  refreshFindMatches(false);
  revealFindMatch();
  (ports as FindRuntimePorts).notices.show("Replaced " + total + " match" + (total === 1 ? "" : "es") + tagNote, "ok");
}

let bulkTagCat: string | null = null;

function bulkTagNeedle() {
  return withoutLoneSurrogates(findNeedle()).trim();
}

function bulkTagRowEl() { return document.getElementById("find-tag-row"); }

function bulkTagOpen() {
  const row = bulkTagRowEl();
  return !!(row && !row.hidden);
}

export function closeBulkTag() {
  const row = bulkTagRowEl();
  if (row) row.hidden = true;
  const btn = (document.getElementById("find-tag") as HTMLElement);
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function bulkTagRefusal(needle: string, plan: BulkTagTotals) {
  if (isBlankTagName(needle)) return "Type the words to tag in the Find box first.";
  if (needle.length > 80) return "That is too long to be a tag's name.";
  if (plan.hits) return "";
  if (plan.inTags) return "Every mention of \u201c" + needle + "\u201d in the Visual column is tagged already.";
  if (plan.skipped) return "No mention of \u201c" + needle + "\u201d in the Visual column can be tagged as it stands.";
  return "No whole-word mention of \u201c" + needle + "\u201d in the Visual column.";
}

function renderBulkTagRow() {
  const needle = bulkTagNeedle();
  const plan = (ports as FindRuntimePorts).bulkTag((ports as FindRuntimePorts).document.current()?.rows ?? [], needle, (bulkTagCat as string), needle, (ports as FindRuntimePorts).options.matchesCase(), true);
  const why = bulkTagRefusal(needle, plan);
  const ask = (document.getElementById("find-tag-ask") as HTMLElement);
  const go = (document.getElementById("find-tag-go") as HTMLButtonElement);
  const cat = tagCategory(bulkTagCat) || (TAG_CATEGORIES[0] as NonNullable<ReturnType<typeof tagCategory>>);
  (document.getElementById("find-tag-cats") as HTMLElement).innerHTML = TAG_CATEGORIES.map(function (c) {
    const on = c.id === cat.id;
    return '<button type="button" class="tag-cat-btn' + (on ? ' is-active' : '') +
      '" style="--dot:' + c.color + '" data-tag-cat="' + c.id + '" role="radio" aria-checked="' +
      (on ? 'true' : 'false') + '">' +
      '<span class="tag-cat-dot" aria-hidden="true"></span>' + escapeHtml(c.label) + '</button>';
  }).join("");
  if (why) {
    ask.textContent = why;
  } else {
    const not: string[] = [];
    if (plan.inTags) not.push(plan.inTags + " already tagged");
    if (plan.skipped) not.push(plan.skipped + " can\u2019t be tagged");
    ask.innerHTML = "Tag " + plan.hits + " mention" + (plan.hits === 1 ? "" : "s") + " of <em>" +
      escapeHtml(needle) + "</em> as " + escapeHtml(cat.label) + "?" +
      (not.length ? ' <span class="find-tag-note">(' + escapeHtml(not.join(" \u00b7 ")) + ")</span>" : "");
  }
  go.disabled = !!why;
  return plan;
}

function defaultBulkTagCat(needle: string) {
  const key = normalizeTagName(needle);
  const tags = (ports as FindRuntimePorts).document.current()?.productionTags || [];
  for (let i = 0; i < tags.length; i++) {
    if (normalizeTagName((tags[i] as DocumentTag).name) === key && tagCategory((tags[i] as DocumentTag).cat)) return (tags[i] as DocumentTag).cat;
  }
  return bulkTagCat || (TAG_CATEGORIES[0] as NonNullable<ReturnType<typeof tagCategory>>).id;
}

export function openBulkTag() {
  if (findingInPresent()) return;
  if (!(ports as FindRuntimePorts).document.current()) return;
  bulkTagCat = defaultBulkTagCat(bulkTagNeedle());
  const row = bulkTagRowEl();
  (row as HTMLElement).hidden = false;
  (document.getElementById("find-tag") as HTMLElement).setAttribute("aria-expanded", "true");
  renderBulkTagRow();
  const active = (row as HTMLElement).querySelector<HTMLElement>(".tag-cat-btn.is-active");
  if (active) active.focus();
}

function toggleBulkTag() {
  if (bulkTagOpen()) closeBulkTag();
  else openBulkTag();
}

export function pickBulkTagCat(cat: string | null) {
  if (!tagCategory(cat)) return;
  bulkTagCat = cat;
  renderBulkTagRow();
  const btn = document.querySelector<HTMLElement>('#find-tag-cats .tag-cat-btn[data-tag-cat="' + cssAttr((cat as string)) + '"]');
  if (btn) btn.focus();
}

function refreshBulkTagRow() {
  if (bulkTagOpen()) renderBulkTagRow();
}

export function runBulkTag() {
  if (findingInPresent()) return;
  const doc = (ports as FindRuntimePorts).document.current();
  if (!doc) return;
  const needle = bulkTagNeedle();
  const cat = tagCategory(bulkTagCat) || (TAG_CATEGORIES[0] as NonNullable<ReturnType<typeof tagCategory>>);
  const plan = (ports as FindRuntimePorts).bulkTag(doc.rows, needle, cat.id, needle, (ports as FindRuntimePorts).options.matchesCase(), true);
  const why = bulkTagRefusal(needle, plan);
  if (why) { (ports as FindRuntimePorts).notices.show(why, "warn"); return; }
  (ports as FindRuntimePorts).undo.breakCoalescing();
  const done = plan;
  const matchCase = (ports as FindRuntimePorts).options.matchesCase();
  const tagged = rewrittenCopies(["visualText"], function (rows) { (ports as FindRuntimePorts).bulkTag(rows as DocumentRow[], needle, cat.id, needle, matchCase, false); });
  if (!done.hits || !(ports as FindRuntimePorts).edits.edit(tagCellsCommand("bulk-tag", tagged, { cat: cat.id, name: needle }, (ports as FindRuntimePorts).edits.stamps))) {
    (ports as FindRuntimePorts).notices.show(bulkTagRefusal(needle, done) || "Nothing to tag.", "warn");
    return;
  }
  (ports as FindRuntimePorts).undo.breakCoalescing();
  closeBulkTag();
  refreshFindMatches(false);
  revealFindMatch();
  let note = "";
  if (done.inTags) note += " \u00b7 " + done.inTags + " already tagged";
  if (done.skipped) note += " \u00b7 " + done.skipped + " skipped";
  (ports as FindRuntimePorts).notices.show("Tagged " + done.hits + " as " + cat.label + note, "ok");
}

export function openFindBar() {
  if (!stopViewChange) stopViewChange = (ports as FindRuntimePorts).present.onViewChange(function () {
    if ((ports as FindRuntimePorts).present.isOpen()) {
      if (!findingInPresent()) openFindBar();
      else findQueryChanged();
    } else if (findingInPresent()) closeFindBar();
  });
  (ports as FindRuntimePorts).flags.setFindOpen(true);
  const bar = document.getElementById("findbar") as HTMLElement;
  const present = (ports as FindRuntimePorts).present.isOpen();
  bar.classList.toggle("is-present", present);
  bar.hidden = false;
  if (present) {
    closeBulkTag();
    (ports as FindRuntimePorts).present.setSearching(true);
  }
  const input = (document.getElementById("find-input") as HTMLInputElement);
  const sel = window.getSelection();
  const picked = sel && !sel.isCollapsed ? String(sel).trim() : "";
  if (picked && picked.length <= 200 && picked.indexOf("\n") === -1) input.value = picked;
  const from = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  input.focus();
  input.select();
  refreshFindMatches(false);
  if (findMatches.length) {
    findIndex = firstMatchFrom(from);
    updateFindCount();
  }
  revealFindMatch();
}

function firstMatchFrom(range: Range | null) {
  if (!range || !findMatches.length) return 0;
  const node = range.startContainer;
  const el = node.nodeType === 1 ? node as Element : node.parentNode as Element | null;
  const cell = el && el.closest ? el.closest("#rows .cell-editable[data-field]") : null;
  const rowEl = cell && cell.closest(".row");
  const rowIdx = rowEl ? (ports as FindRuntimePorts).document.read(function (doc) { return rowIndexOf(doc, (rowEl as Element).getAttribute("data-id")); }) : -1;
  if (rowIdx === -1) return 0;
  const field = ((cell as Element).getAttribute("data-field") as string);
  const rows = ((ports as FindRuntimePorts).document.current() as FindDocumentView).rows;
  const model = (ports as FindRuntimePorts).text.cellOf((rows[rowIdx] as DocumentRow)[field] as string);
  const expect = projection(model);
  const hits = findInCell(model, findNeedle(), (ports as FindRuntimePorts).options.matchesCase());
  let nth = 0;
  while (nth < hits.length) {
    const r = domRangeFor((cell as Element), (hits[nth] as { from: number; to: number; }).from, (hits[nth] as { from: number; to: number; }).to, expect);
    if (r && r.compareBoundaryPoints(Range.START_TO_START, range) >= 0) break;
    nth++;
  }
  const order = idMap<number>();
  rows.forEach(function (row, i) { order[row.id] = i; });
  const at = field === "visualText" ? 0 : 1;
  for (let i = 0; i < findMatches.length; i++) {
    const m = (findMatches[i] as FindMatch), mi = (order[m.rowId] as number), mf = m.field === "visualText" ? 0 : 1;
    if (mi > rowIdx || (mi === rowIdx && (mf > at || (mf === at && m.nth >= nth)))) return i;
  }
  return 0;
}

export function closeFindBar() {
  const present = findingInPresent();
  const bar = document.getElementById("findbar") as HTMLElement;
  if (present && bar.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  stopViewChange?.();
  stopViewChange = null;
  if (present) (ports as FindRuntimePorts).present.setSearching(false);
  (ports as FindRuntimePorts).flags.setFindOpen(false);
  (document.getElementById("findbar") as HTMLElement).hidden = true;
  document.getElementById("findbar")?.classList.remove("is-present");
  presentRanges = [];
  findMatches = [];
  findIndex = -1;
  findInTags = 0;
  closeBulkTag();
  if (highlightsSupported()) CSS.highlights.delete(FIND_HL);
  if (highlightsSupported()) CSS.highlights.delete(PRESENT_HL);
  if (present && (ports as FindRuntimePorts).present.isOpen()) document.getElementById("pp-play")?.focus({ preventScroll: true });
}

function leaveFindAtMatch() {
  if (findingInPresent()) { closeFindBar(); return; }
  const hit = currentMatchRange();
  closeFindBar();
  if (!hit) return;
  hit.cell.focus();
  const sel = window.getSelection();
  (sel as Selection).removeAllRanges();
  (sel as Selection).addRange(hit.range);
}

export function startFind(given: FindPorts): FindControls {
  ports = given;
  let disposed = false;
  return {
    openFindBar,
    closeFindBar,
    dispose: function () {
      if (disposed) return;
      disposed = true;
      if ((document.getElementById("findbar") as HTMLElement)) closeFindBar();
      else {
        stopViewChange?.();
        stopViewChange = null;
        given.present.setSearching(false);
        (ports as FindRuntimePorts).flags.setFindOpen(false);
        findMatches = [];
        findIndex = -1;
        findInTags = 0;
        if (highlightsSupported()) CSS.highlights.delete(FIND_HL);
        if (highlightsSupported()) CSS.highlights.delete(PRESENT_HL);
        presentRanges = [];
      }
      bulkTagCat = null;
      ports = null;
    }
  };
}

export function mountFindEvents(options: Pick<FindOptions, "matchesCase" | "setMatchCase">) {
  return mountFind({ window: window, ports: {
    closeFindBar, stepFind, replaceCurrent, replaceAll, toggleBulkTag, runBulkTag,
    closeBulkTag, pickBulkTagCat, findQueryChanged, leaveFindAtMatch, bulkTagOpen,
    getFindMatchCase: options.matchesCase,
    setFindMatchCase: options.setMatchCase
  } });
}
