import { domToPos } from "../features/editing/cell-dom.ts";
import { updateScriptStats } from "./01-scene-status.js";
import { rowIndexOf } from "../core/document/rows.ts";
import { stampRow } from "./03-sync.js";
import {
  inertBody,
  safeId,
  sanitizeHtml
} from "./04-richtext.js";
import { render } from "./05-render.js";
import { plainTagOpen } from "./07b-plain-tags.js";
import { renderProduction, updateGearCount } from "./08-production-panels.js";
import { runBrollRefresh, updateBrollBadge } from "./08c-broll.js";
import { domRangeFor } from "./09-find-replace.js";
import { breakUndoCoalescing } from "./12a-undo.js";
import { updateWriterStats } from "./19-writer.js";
import { randomIds } from "../adapters/identity/ids.ts";
import { idMap } from "../core/document/id-map.ts";
import { contentMemo } from "../core/document/memo.ts";
import {
  ensureTagIds,
  isTagId,
  tagKey,
  tagStatusRank
} from "../core/document/tags.ts";
import { cappedText, codePointPrefix, escapeHtml } from "../core/document/text-policy.ts";
import { TAG_CATEGORIES, TAG_STATUSES, tagCategory, tagStatus } from "../core/production/looks.ts";
import { productionIndexFor } from "../core/production/index.js";
import {
  bulkTagCell as bulkTagCellWith,
  collectTagsFromRows as collectTagGroups,
  isBlankTagName,
  missingRegistryTags as missingRegistryTagsIn,
  tagFieldOccurrences as tagFieldOccurrencesWith,
  tagOccurrences
} from "../core/production/tags.ts";
import { replaceWithTag } from "../core/text/edits.ts";
import { namedTagId, projection } from "../core/text/runs.ts";
import { cacheSeal } from "../legacy/cache-freeze.ts";
import { productionReaders } from "../legacy/document-ports.ts";
import { cellOf } from "../legacy/richtext.ts";
import { currentDocument, readSession, requestRefresh, runDocumentEdit, sessionStamps, stampDocument } from "../legacy/session-bridge.ts";
import { changeSet } from "../application/session/change-set.ts";
import { addPersonCommand, registerTagCommand, tagCellsCommand } from "../application/commands/production-records.ts";
import { bindBulkTagRows } from "../application/commands/bulk-tags.js";
import { personNamed, registryEntryById as registryEntryByIdIn } from "../core/production/records.ts";
import { cellEditing, focusMemory } from "../legacy/editor-bridge.ts";
import { showToast } from "../legacy/effects-bridge.ts";
import { viewFlags } from "../legacy/preferences-bridge.ts";
export {
  contentMemo,
  ensureTagIds,
  isTagId,
  tagKey,
  tagOccurrences,
  tagStatusRank
};

var TAG_SHORTCUT_CHARS;

bindBulkTagRows({ cell: bulkTagCell, stamp: stampRow });

export function tagIconSvg(cat) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + cat.icon + '</svg>';
}

export function tagIconCss() {
  return TAG_CATEGORIES.map(function (c) {
    return '[data-tag-cat="' + c.id + '"]{--tag-icon:url("data:image/svg+xml,' + encodeURIComponent(tagIconSvg(c)) + '")}';
  }).join("\n");
}

export function tagStatusLampHtml(id) {
  var st = tagStatus(id) || TAG_STATUSES[0];
  if (st.id === "returned") {
    return '<svg class="item-lamp is-returned" aria-hidden="true" focusable="false"><use href="#i-return"/></svg>';
  }
  return '<span class="item-lamp is-' + st.id + '" aria-hidden="true"></span>';
}

var TAG_SHORTCUTS = [
  { open: "[", close: "]", cat: "prop" },
  { open: "{", close: "}", cat: "location" },
  { open: "~", close: "~", cat: "vfx" },
  { open: "<", close: ">", cat: "gear" }
];

function hasShortcutChar(s) {
  for (var i = 0; i < s.length; i++) {
    if (TAG_SHORTCUT_CHARS.indexOf(s.charAt(i)) !== -1) return true;
  }
  return false;
}

export function isInsideTagOrLink(el) {
  return !!(el && el.closest && el.closest(".tag-anchor, a"));
}


export var tagsInField = productionReaders.tagsInField;

export function collectTagsFromRows(rows) {
  return collectTagGroups(rows, productionReaders).map(function (g) {
    return { key: g.key, cat: tagCategory(g.catId), name: g.name, mentions: g.mentions };
  });
}

export function registerProductionTag(cat, name) {
  return runDocumentEdit(registerTagCommand({ cat: cat, name: String(name == null ? "" : name) }));
}

export function registryEntryById(id) {
  return readSession(function (doc) { return registryEntryByIdIn(doc, id); });
}

export function findOrAddPerson(name) {
  runDocumentEdit(addPersonCommand(name, randomIds));
  var person = readSession(function (doc) { return personNamed(doc, name); });
  return person ? person.id : "";
}

const productionIndex = productionIndexFor(productionReaders, cacheSeal);

function productionEntries() {
  return productionIndex.entries(currentDocument());
}

function currentProductionIndex() {
  return productionIndex.current(currentDocument());
}

function tagRecordsPlan(doc) {
  return productionIndex.recordsPlan(doc, currentDocument());
}

const REGISTRY_CHANGE = changeSet({ docFields: ["productionTags"] });

function registryHealingStamp(plan, counted) {
  return {
    name: "stamp-tag-registry",
    plan: function () {
      return { changes: REGISTRY_CHANGE, apply: function (live) { counted(plan.apply(live)); } };
    }
  };
}

export function healTagRegistry() {
  const plan = tagRecordsPlan(currentDocument());
  if (!plan) return 0;
  let count = 0;
  if (plan.apply) stampDocument(registryHealingStamp(plan, function (n) { count = n; }));
  plan.commit();
  return count;
}

export function missingRegistryTags(rows, registry) {
  return missingRegistryTagsIn(rows, registry, productionReaders);
}

export function productionIndexStats() {
  return { derived: productionIndex.derived(), flushes: idleFlushes };
}

export function resetProductionIndexStats() {
  productionIndex.resetDerived();
  idleFlushes = 0;
}

var idleFlushes = 0;

export function scheduleIdleRefresh(job) {
  requestRefresh(job);
}

export function runIdleRefresh(jobs) {
  if (!currentDocument()) return;
  idleFlushes++;
  if (jobs.has("production")) refreshProductionNow();
  if (jobs.has("writerStats")) updateWriterStats();
  if (jobs.has("untagged")) scanUntaggedMentions();
  if (jobs.has("broll")) runBrollRefresh();
}

function refreshProductionNow() {
  var panel = document.getElementById("production-panel");
  var gearPanel = document.getElementById("gear-panel");
  if ((panel && !panel.hidden) || (gearPanel && !gearPanel.hidden)) renderProduction();
  else updateTagBadges();
  updateScriptStats();
}

export function scheduleProductionRefresh() {
  scheduleIdleRefresh("production");
}

export function updateProductionBadge(n) {
  var badge = document.getElementById("production-badge");
  if (!badge) return;
  if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
  else badge.hidden = true;
}

function updateProductionCount() {
  updateProductionBadge(currentDocument() ? productionEntries().length : 0);
}

export function updateTagBadges() {
  updateProductionCount();
  updateGearCount();
  updateBrollBadge();
}

var AUTO_TAG_MAX_LEN = 60;

export function maybeAutoTagShortcut(e, cellEl) {
  if (e.inputType !== "insertText" || !e.data) return;
  var typed = e.data.charAt(e.data.length - 1);
  var rule = null;
  for (var i = 0; i < TAG_SHORTCUTS.length; i++) {
    if (TAG_SHORTCUTS[i].close === typed) { rule = TAG_SHORTCUTS[i]; break; }
  }
  if (!rule) return;
  var sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  var range = sel.getRangeAt(0);
  var node = range.startContainer;
  var offset = range.startOffset;
  if (node.nodeType !== 3 || offset < 2 || node.data[offset - 1] !== rule.close) return;
  if (isInsideTagOrLink(node.parentNode)) return;

  var openAt = node.data.lastIndexOf(rule.open, offset - 2);
  if (openAt === -1) return;
  if (rule.open === rule.close && node.data.charAt(openAt - 1) === rule.open) return;
  var phrase = node.data.slice(openAt + 1, offset - 1);
  var trimmed = phrase.trim();
  if (isBlankTagName(trimmed) || phrase.length > AUTO_TAG_MAX_LEN || hasShortcutChar(phrase)) return;

  tagTextRange(cellEl, node, openAt, offset, trimmed, rule.cat, trimmed);
  updateTagBadges();
  renderProduction();
}

function tagTextRange(cellEl, node, a, b, text, cat, name) {
  cellEditing().edit(cellEl, function (cell) {
    var from = domToPos(cellEl, node, a), to = domToPos(cellEl, node, b);
    if (from === null || to === null) return null;
    if (projection(cell).slice(from, to) !== node.data.slice(a, b).replace(/\u200B/g, "")) return null;
    var r = replaceWithTag(cell, from, to, text, namedTagId(cat, name));
    return { cell: r.cell, sel: { from: r.end, to: r.end }, records: { tags: [{ cat: cat, name: name }] } };
  });
}

export var tagGhost = null;

function tagGhostEl() { return document.getElementById("tag-ghost"); }

export function hideTagGhost() {
  tagGhost = null;
  var el = tagGhostEl();
  if (el) el.classList.remove("is-visible");
}

function tagCompletionBeats(a, b) {
  if (!b) return true;
  if (a.mentions.length !== b.mentions.length) return a.mentions.length > b.mentions.length;
  if (a.name.length !== b.name.length) return a.name.length < b.name.length;
  return a.name.localeCompare(b.name) < 0;
}

function bestTagCompletion(phrase, preferCat) {
  var needle = phrase.toLowerCase();
  var inCat = null, anyCat = null;
  productionEntries().forEach(function (t) {
    if (t.name.toLowerCase().indexOf(needle) !== 0) return;
    if (t.name.length <= phrase.length) return;
    if (t.cat.id === preferCat && tagCompletionBeats(t, inCat)) inCat = t;
    if (tagCompletionBeats(t, anyCat)) anyCat = t;
  });
  return inCat || anyCat;
}

export function updateTagGhost(cellEl) {
  hideTagGhost();
  var sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  var range = sel.getRangeAt(0);
  var node = range.startContainer;
  var offset = range.startOffset;
  if (node.nodeType !== 3 || !cellEl.contains(node)) return;
  if (isInsideTagOrLink(node.parentNode)) return;

  var rule = null, openAt = -1;
  TAG_SHORTCUTS.forEach(function (r) {
    var at = node.data.lastIndexOf(r.open, offset - 1);
    if (at > openAt) { openAt = at; rule = r; }
  });
  if (!rule || openAt === -1) return;
  var phrase = node.data.slice(openAt + 1, offset);
  if (!phrase || phrase.length > AUTO_TAG_MAX_LEN || hasShortcutChar(phrase)) return;

  var entry = bestTagCompletion(phrase, rule.cat);
  if (!entry) return;

  var rect = range.getClientRects()[0];
  if (!rect) return;
  var el = tagGhostEl();
  if (!el) return;
  var cs = getComputedStyle(cellEl);
  el.style.font = cs.font;
  el.style.left = rect.right + "px";
  el.style.top = rect.top + "px";
  el.style.lineHeight = cs.lineHeight;
  el.innerHTML = escapeHtml(entry.name.slice(phrase.length)) +
    (entry.cat.id === rule.cat ? "" :
      '<span class="tag-ghost-cat">' + escapeHtml(entry.cat.label) + '</span>');
  el.classList.add("is-visible");

  tagGhost = { cellEl: cellEl, node: node, openAt: openAt, offset: offset, phrase: phrase, entry: entry };
}

export function acceptTagGhost() {
  var g = tagGhost;
  if (!g) return false;
  var sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) { hideTagGhost(); return false; }
  var r = sel.getRangeAt(0);
  if (r.startContainer !== g.node || r.startOffset !== g.offset) { hideTagGhost(); return false; }

  hideTagGhost();
  tagTextRange(g.cellEl, g.node, g.openAt, g.offset, g.entry.name, g.entry.cat.id, g.entry.name);
  updateTagBadges();
  renderProduction();
  return true;
}

var UNTAGGED_HL = "splitpage-untagged";
var untaggedList = [];
export var untaggedSuggestion = null;

function highlightApiOk() {
  return !!(window.CSS && CSS.highlights && window.Highlight);
}

function buildUntaggedIndex(entries) {
  var names = [], byName = Object.create(null);
  entries.forEach(function (e) {
    var n = (e.name || "").trim();
    if (!n) return;
    var k = n.toLowerCase();
    if (byName[k]) {
      if (tagCompletionBeats(e, byName[k])) byName[k] = e;
      return;
    }
    names.push(n);
    byName[k] = e;
  });
  if (!names.length) return null;
  var alt = names.sort(function (a, b) { return b.length - a.length; })
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

function eachPlainTextNode(root, fn) {
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      return isInsideTagOrLink(node.parentNode)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  var node;
  while ((node = walker.nextNode())) fn(node);
}

function collectUntaggedInCell(cellEl, index, out) {
  eachPlainTextNode(cellEl, function (node) {
    var text = node.nodeValue || "";
    if (!text) return;
    index.re.lastIndex = 0;
    var m;
    while ((m = index.re.exec(text))) {
      var start = m.index, len = m[0].length;
      if (!index.boundedInPattern) {
        var before = start === 0 ? "" : text.charAt(start - 1);
        var after = text.charAt(start + len);
        if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;
      }
      var entry = index.byName[m[0].toLowerCase()];
      if (!entry) continue;
      var range = document.createRange();
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
    var hl = new Highlight();
    untaggedList.forEach(function (item) { hl.add(item.range); });
    CSS.highlights.set(UNTAGGED_HL, hl);
  } catch (e) { }
}

function scanUntaggedMentions(entries) {
  if (!currentDocument()) return;
  untaggedList = [];
  var index = viewFlags().writerOpen() ? null : buildUntaggedIndex(entries || productionEntries());
  if (index) {
    var cells = document.querySelectorAll('#rows .visual-cell .cell-editable');
    Array.prototype.forEach.call(cells, function (cellEl) {
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
  var el = document.getElementById("tag-suggest");
  if (el) el.classList.remove("is-visible");
}

export function updateUntaggedPrompt() {
  var el = document.getElementById("tag-suggest");
  if (!el) return;
  var active = document.activeElement;
  var cellEl = (active && active.classList && active.classList.contains("cell-editable") &&
    active.getAttribute("data-field") === "visualText" && active.closest("#rows")) ? active : null;
  if (!cellEl || focusMemory().promptMutedFor() === cellEl) { hideUntaggedPrompt(); return; }
  if (plainTagOpen(cellEl)) { hideUntaggedPrompt(); return; }

  var here = untaggedList.filter(function (i) { return i.cellEl === cellEl; });
  if (!here.length) { hideUntaggedPrompt(); return; }

  var pick = here[0];
  var sel = window.getSelection();
  if (sel.rangeCount && sel.isCollapsed) {
    var caret = sel.getRangeAt(0);
    for (var i = 0; i < here.length; i++) {
      try {
        if (here[i].range.compareBoundaryPoints(Range.START_TO_START, caret) <= 0) pick = here[i];
      } catch (e) { }
    }
  }

  var rect = pick.range.getClientRects()[0] || pick.range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) { hideUntaggedPrompt(); return; }

  el.innerHTML = 'Tag <b>' + escapeHtml(pick.text) + '</b>' +
    '<span class="tag-suggest-cat">' + escapeHtml(pick.entry.cat.label) + '</span>' +
    '<kbd>Tab</kbd>';
  el.classList.add("is-visible");
  var w = el.offsetWidth, h = el.offsetHeight;
  var cellRect = cellEl.getBoundingClientRect();
  var top = cellRect.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, cellRect.top - h - 6);
  el.style.left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - w - 8)) + "px";
  el.style.top = top + "px";
  untaggedSuggestion = pick;
}

export function acceptUntaggedMention() {
  var s = untaggedSuggestion;
  if (!s || !s.cellEl.isConnected) { hideUntaggedPrompt(); return false; }
  if (String(s.range) !== s.text) {
    hideUntaggedPrompt();
    scheduleUntaggedScan();
    return false;
  }
  var node = s.range.startContainer;
  if (node.nodeType !== 3 || s.range.endContainer !== node) { hideUntaggedPrompt(); return false; }

  hideUntaggedPrompt();
  tagTextRange(s.cellEl, node, s.range.startOffset, s.range.endOffset, s.text, s.entry.cat.id, s.entry.name);
  updateTagBadges();
  renderProduction();
  scanUntaggedMentions();
  return true;
}

function wrapTagInHtml(html, cell, found, cat, name) {
  var body = inertBody(html);
  var doc = body.ownerDocument;
  var expect = projection(cell);
  for (var i = found.length - 1; i >= 0; i--) {
    var range = domRangeFor(body, found[i].from, found[i].to, expect);
    if (!range) return null;
    var span = doc.createElement("span");
    span.className = "tag-anchor";
    span.setAttribute("data-tag-cat", cat);
    span.setAttribute("data-tag-name", name);
    span.appendChild(range.extractContents());
    range.insertNode(span);
  }
  Array.prototype.forEach.call(body.querySelectorAll("strong, em, u, s, mark"), function (el) {
    if (el.parentNode && !el.textContent && !el.querySelector("img, br")) el.parentNode.removeChild(el);
  });
  return sanitizeHtml(body.innerHTML);
}

export function tagFieldOccurrences(html, phrase, cat, name, countOnly, onlyOccurrence) {
  return tagFieldOccurrencesWith(html, phrase, cat, name, countOnly, onlyOccurrence, productionReaders, wrapTagInHtml);
}

export function bulkTagCell(html, phrase, cat, name, matchCase, countOnly) {
  return bulkTagCellWith(html, phrase, cat, name, matchCase, countOnly, productionReaders, wrapTagInHtml);
}

function allOccurrencesTagged(doc, phrase, cat, name) {
  var needle = String(phrase || "").trim();
  var out = { hits: 0, rewrites: [] };
  if (!needle || !doc) return out;
  doc.rows.forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      var res = tagFieldOccurrences(row[field], needle, cat, name, false);
      if (!res.hits) return;
      out.hits += res.hits;
      out.rewrites.push({ rowId: row.id, field: field, html: res.html });
    });
  });
  return out;
}

function countPhraseMatches(phrase) {
  var needle = String(phrase || "").trim();
  if (!needle || !currentDocument()) return 0;
  var total = 0;
  currentDocument().rows.forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      total += tagOccurrences(cellOf(row[field]), needle).length;
    });
  });
  return total;
}

var pendingTag = null;
export function renderTagCategories(selected) {
  document.getElementById("tag-cats").innerHTML = TAG_CATEGORIES.map(function (c) {
    return '<button type="button" class="tag-cat-btn' + (c.id === selected ? ' is-active' : '') +
      '" style="--dot:' + c.color + '" data-tag-cat="' + c.id + '" role="radio" aria-checked="' +
      (c.id === selected ? 'true' : 'false') + '">' +
      '<span class="tag-cat-dot" aria-hidden="true"></span>' + escapeHtml(c.label) + '</button>';
  }).join("");
}

function refreshTagNameList() {
  var names = idMap();
  productionEntries().forEach(function (t) { names[t.name] = true; });
  document.getElementById("tag-name-list").innerHTML =
    Object.keys(names).sort().map(function (n) {
      return '<option value="' + escapeHtml(n) + '"></option>';
    }).join("");
}

function updateTagHint() {
  var hint = document.getElementById("tag-hint");
  if (!pendingTag) { hint.textContent = ""; return; }
  var n = countPhraseMatches(pendingTag.quotedText);
  var box = document.getElementById("tag-all");
  if (n > 1) {
    box.disabled = false;
    hint.textContent = '"' + pendingTag.quotedText + '" appears ' + n + " times in the script.";
  } else {
    box.disabled = true;
    box.checked = false;
    hint.textContent = "";
  }
}

export function openTagComposer(ctx) {
  pendingTag = ctx;
  document.getElementById("tag-quote").textContent = ctx.quotedText;
  var nameInput = document.getElementById("tag-name");
  nameInput.value = codePointPrefix(ctx.quotedText, 80);
  renderTagCategories(ctx.cat || "prop");
  refreshTagNameList();
  document.getElementById("tag-all").checked = false;
  updateTagHint();
  document.getElementById("tag-modal").hidden = false;
  setTimeout(function () { nameInput.focus(); nameInput.select(); }, 0);
}

export function closeTagComposer() {
  document.getElementById("tag-modal").hidden = true;
  pendingTag = null;
}

function selectedTagCategory() {
  var active = document.querySelector("#tag-cats .tag-cat-btn.is-active");
  return active ? active.getAttribute("data-tag-cat") : "prop";
}

export function applyTag() {
  if (!pendingTag) return;
  var cat = selectedTagCategory();
  var name = cappedText(document.getElementById("tag-name").value, 80);
  if (isBlankTagName(name)) { showToast("Give the label a name first.", "warn"); return; }

  var all = document.getElementById("tag-all").checked;
  var phrase = pendingTag.quotedText;
  var ctx = pendingTag;
  closeTagComposer();

  if (all) {
    breakUndoCoalescing();
    var n = readSession(function (doc) { return allOccurrencesTagged(doc, phrase, cat, name).hits; });
    runDocumentEdit(tagCellsCommand("tag-all-occurrences", function (doc) {
      return allOccurrencesTagged(doc, phrase, cat, name).rewrites;
    }, { cat: cat, name: name }, sessionStamps, true));
    breakUndoCoalescing();
    render();
    showToast("Labelled " + n + " mention" + (n === 1 ? "" : "s") + " of " + name, "ok");
    return;
  }

  var cellEl = document.querySelector('#rows .row[data-id="' + safeId(ctx.rowId, "r") +
    '"] .' + (ctx.field === "visualText" ? "visual" : "audio") + '-cell .cell-editable');
  if (!cellEl) { showToast("That scene is no longer here.", "warn"); return; }

  var idx = readSession(function (doc) { return rowIndexOf(doc, ctx.rowId); });
  if (idx === -1) return;
  cellEditing().sync(cellEl);
  breakUndoCoalescing();
  function tagged(doc) {
    var row = doc ? doc.rows[rowIndexOf(doc, ctx.rowId)] : null;
    var res = row ? tagFieldOccurrences(row[ctx.field], phrase, cat, name, false, ctx.occurrenceIndex || 0) : null;
    return res && res.hits ? [{ rowId: ctx.rowId, field: ctx.field, html: res.html }] : [];
  }
  if (!readSession(tagged).length) { showToast("Could not find that text any more.", "warn"); return; }
  runDocumentEdit(tagCellsCommand("tag-occurrence", tagged, { cat: cat, name: name }, sessionStamps, true));
  breakUndoCoalescing();
  render();
  showToast("Labelled as " + name, "ok");
}

export function __init() {
  TAG_SHORTCUT_CHARS = (function () {
    var s = "";
    TAG_SHORTCUTS.forEach(function (r) {
      if (s.indexOf(r.open) === -1) s += r.open;
      if (s.indexOf(r.close) === -1) s += r.close;
    });
    return s;
  })();

  var iconStyle = document.createElement("style");
  iconStyle.id = "tag-icon-style";
  iconStyle.textContent = tagIconCss();
  document.head.appendChild(iconStyle);

  window.__cacheTest = {
    index: currentProductionIndex,
    frozen: function () {
      var html = "Put the " + '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="kettle">kettle</span> on.';
      return [cellOf(html), productionReaders.tagsInField(html), productionReaders.cueNamesInField(html), currentProductionIndex()]
        .map(function (v) { return !!v && Object.isFrozen(v); });
    },
    writes: function () {
      var html = '<strong>Probe</strong> the <span class="tag-anchor" data-tag-cat="prop" data-tag-name="probe lamp">lamp</span>.';
      var cell = cellOf(html), tags = productionReaders.tagsInField(html);
      return [
        function () { cell[0].text = "x"; },
        function () { delete cell[0].marks.b; },
        function () { cell.length = 0; },
        function () { tags[0].name = "x"; },
        function () { Object.defineProperty(tags[0], "text", { value: "x" }); }
      ].map(function (write) {
        try { write(); return false; } catch (e) { return e instanceof TypeError; }
      });
    }
  };

}
