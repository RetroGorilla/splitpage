import { S } from "./_state.js";
import { updateScriptStats } from "./01-scene-status.js";
import { escapeHtml, makeId } from "./02-state.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import {
  inertBody,
  plainText,
  safeId,
  sanitizeHtml
} from "./04-richtext.js";
import {
  cellOf,
  cuesInCell,
  editCues,
  namedTagId,
  projection,
  replaceWithTag,
  retag,
  setMark,
  tagIds,
  tagNameOf,
  toHtml
} from "./04c-doc-model.js";
import { render, syncFieldFromDom } from "./05-render.js";
import { domToPos, editCell } from "./05b-cell-edit.js";
import { plainTagOpen } from "./07b-plain-tags.js";
import { renderProduction, updateGearCount } from "./08-production-panels.js";
import { brollPropsRenamed, runBrollRefresh, updateBrollBadge } from "./08c-broll.js";
import { domRangeFor } from "./09-find-replace.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { breakUndoCoalescing } from "./12a-undo.js";
import { queueAutoSave } from "./14-export.js";
import { updateWriterStats, writerOpen } from "./19-writer.js";
import { contentMemo } from "../core/document/memo.ts";
import {
  TAG_CATEGORY_IDS,
  TAG_STATUS_IDS,
  ensureTagIds,
  isTagId,
  mintTagId,
  nextTagStatus,
  normalizeTagName,
  registryKey,
  registryTagHooks,
  tagKey,
  tagStatusRank
} from "../core/document/tags.ts";
export {
  contentMemo,
  ensureTagIds,
  isTagId,
  mintTagId,
  nextTagStatus,
  normalizeTagName,
  registryKey,
  registryTagHooks,
  tagKey,
  tagStatusRank
};

var TAG_SHORTCUT_CHARS;

var TAG_ICON_PATHS = {
  prop: '<path d="M20.5 7.5L12 3 3.5 7.5v9L12 21l8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/>',
  location: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.25"/>',
  cast: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  vfx: '<path d="M11 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z"/><path d="M19 15.5v5M16.5 18h5"/>',
  sound: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  gear: '<rect x="3" y="6.5" width="12.5" height="11" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3z"/>'
};

var TAG_CATEGORY_LOOKS = {
  prop:     { label: "Prop",      plural: "Props & set dressing", color: "var(--tag-prop)",     icon: TAG_ICON_PATHS.prop },
  location: { label: "Location",  plural: "Locations & shots",    color: "var(--tag-location)", icon: TAG_ICON_PATHS.location },
  cast:     { label: "Cast",      plural: "Cast & wardrobe",      color: "var(--tag-cast)",     icon: TAG_ICON_PATHS.cast },
  vfx:      { label: "VFX",       plural: "VFX & graphics",       color: "var(--tag-vfx)",      icon: TAG_ICON_PATHS.vfx },
  sound:    { label: "Music/SFX", plural: "Music & SFX",          color: "var(--tag-sound)",    icon: TAG_ICON_PATHS.sound },
  gear:     { label: "Gear",      plural: "Gear",                 color: "var(--tag-gear)",     icon: TAG_ICON_PATHS.gear }
};

export var TAG_CATEGORIES = TAG_CATEGORY_IDS.map(function (id) {
  var look = TAG_CATEGORY_LOOKS[id];
  return { id: id, label: look.label, plural: look.plural, color: look.color, icon: look.icon };
});

export function tagIconSvg(cat) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + cat.icon + '</svg>';
}

export function tagIconCss() {
  return TAG_CATEGORIES.map(function (c) {
    return '[data-tag-cat="' + c.id + '"]{--tag-icon:url("data:image/svg+xml,' + encodeURIComponent(tagIconSvg(c)) + '")}';
  }).join("\n");
}

var TAG_STATUS_LOOKS = {
  needed:   { label: "Needed",   color: "var(--text-faint)" },
  sourcing: { label: "Sourcing", color: "var(--audio)" },
  have:     { label: "Have it",  color: "var(--text)" },
  returned: { label: "Returned", color: "var(--text-faint)" }
};

export var TAG_STATUSES = TAG_STATUS_IDS.map(function (id) {
  var look = TAG_STATUS_LOOKS[id];
  return { id: id, label: look.label, color: look.color };
});

export function tagStatusLampHtml(id) {
  var st = tagStatus(id) || TAG_STATUSES[0];
  if (st.id === "returned") {
    return '<svg class="item-lamp is-returned" aria-hidden="true" focusable="false"><use href="#i-return"/></svg>';
  }
  return '<span class="item-lamp is-' + st.id + '" aria-hidden="true"></span>';
}

export function tagStatus(id) {
  for (var i = 0; i < TAG_STATUSES.length; i++) {
    if (TAG_STATUSES[i].id === id) return TAG_STATUSES[i];
  }
  return null;
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

export function tagCategory(id) {
  for (var i = 0; i < TAG_CATEGORIES.length; i++) {
    if (TAG_CATEGORIES[i].id === id) return TAG_CATEGORIES[i];
  }
  return null;
}

export function isInsideTagOrLink(el) {
  return !!(el && el.closest && el.closest(".tag-anchor, a"));
}

export var tagsInField = contentMemo(function (html) {
  var out = [];
  var last = null;
  cellOf(html).forEach(function (r) {
    var id = r.atom ? null : r.marks.tag;
    if (id && last && last.id === id) { last.text += r.text; return; }
    last = null;
    var t = id ? tagNameOf(id) : null;
    var name = t ? t.name.trim() : "";
    if (!name) return;
    last = { id: id, catId: t.cat, name: name, text: r.text };
    out.push(last);
  });
  var found = out.map(function (m) { return { catId: m.catId, name: m.name, text: m.text.trim() }; });
  if (html.indexOf("audio-cue") !== -1) {
    cuesInCell(cellOf(html)).forEach(function (c) {
      var name = c.name.slice(0, 80).trim();
      if (name) found.push({ catId: "sound", name: name, text: c.text });
    });
  }
  return found;
});

export function collectTagsFromRows(rows) {
  var groups = {}, order = [];
  (rows || []).forEach(function (row, rowIndex) {
    ["visualText", "audioText"].forEach(function (field) {
      tagsInField(row[field]).forEach(function (found) {
        var cat = tagCategory(found.catId);
        if (!cat) return;
        var key = tagKey(cat.id, found.name);
        if (!groups[key]) {
          groups[key] = { key: key, cat: cat, name: found.name, mentions: [] };
          order.push(key);
        }
        groups[key].mentions.push({
          rowId: row.id,
          rowIndex: rowIndex,
          field: field,
          text: found.text
        });
      });
    });
  });
  return order.map(function (k) { return groups[k]; });
}

function collectTags() {
  return collectTagsFromRows(S.state.rows);
}

export function registryEntry(cat, name) {
  var key = registryKey(cat, name);
  for (var i = 0; i < S.state.productionTags.length; i++) {
    if (registryKey(S.state.productionTags[i].cat, S.state.productionTags[i].name) === key) {
      return S.state.productionTags[i];
    }
  }
  return null;
}

export function registerProductionTag(cat, name) {
  if (registryEntry(cat, name)) return;
  S.state.productionTags.push({ id: mintTagId(cat, name, S.state.productionTags), cat: cat, name: name,
                                owner: "", notes: "", status: TAG_STATUSES[0].id });
}

export function registryEntryById(id) {
  for (var i = 0; i < S.state.productionTags.length; i++) {
    var t = S.state.productionTags[i];
    if (t && t.id === id) return t;
  }
  return null;
}

export function personById(id) {
  if (!id) return null;
  for (var i = 0; i < S.state.people.length; i++) {
    if (S.state.people[i].id === id) return S.state.people[i];
  }
  return null;
}

export function findOrAddPerson(name) {
  var clean = plainText(name).trim().slice(0, 60);
  if (!clean) return "";
  var norm = normalizeTagName(clean);
  for (var i = 0; i < S.state.people.length; i++) {
    if (normalizeTagName(S.state.people[i].name) === norm) return S.state.people[i].id;
  }
  var person = { id: makeId("p"), name: clean };
  S.state.people.push(person);
  return person.id;
}

export function deletePerson(id) {
  S.state.people = S.state.people.filter(function (p) { return p.id !== id; });
  S.state.productionTags.forEach(function (t) { if (t.owner === id) t.owner = ""; });
}

export function deleteProductionTagEntry(cat, name) {
  var key = registryKey(cat, name);
  var before = S.state.productionTags.length;
  S.state.productionTags = S.state.productionTags.filter(function (t) { return registryKey(t.cat, t.name) !== key; });
  return before !== S.state.productionTags.length;
}

var prodIndex = null;
var prodIndexDerived = 0;

function registrySignature(tags) {
  var sig = [];
  tags.forEach(function (t) {
    if (!t) { sig.push(null, null, null, null, null, null); return; }
    sig.push(t.cat, t.name, t.owner, t.notes, t.status, t.id);
  });
  return sig;
}

function sameFieldTags(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i].catId !== b[i].catId || a[i].name !== b[i].name || a[i].text !== b[i].text) return false;
  }
  return true;
}

var ROW_SIG_SLOTS = 5;

function prodIndexFresh(ix) {
  var rows = S.state.rows, tags = S.state.productionTags;
  if (ix.rowCount !== rows.length || ix.tagSig.length !== tags.length * 6) return false;
  var rs = ix.rowSig;
  for (var i = 0, j = 0; i < rows.length; i++, j += ROW_SIG_SLOTS) {
    var r = rows[i];
    if (rs[j] !== r.id) return false;
    if (rs[j + 1] !== r.visualText) {
      var vTags = tagsInField(r.visualText);
      if (!sameFieldTags(rs[j + 3], vTags)) return false;
      rs[j + 1] = r.visualText;
      rs[j + 3] = vTags;
    }
    if (rs[j + 2] !== r.audioText) {
      var aTags = tagsInField(r.audioText);
      if (!sameFieldTags(rs[j + 4], aTags)) return false;
      rs[j + 2] = r.audioText;
      rs[j + 4] = aTags;
    }
  }
  var ts = ix.tagSig;
  for (i = 0, j = 0; i < tags.length; i++, j += 6) {
    var t = tags[i];
    if (!t) { if (ts[j] !== null) return false; continue; }
    if (ts[j] !== t.cat || ts[j + 1] !== t.name || ts[j + 2] !== t.owner ||
        ts[j + 3] !== t.notes || ts[j + 4] !== t.status || ts[j + 5] !== t.id) return false;
  }
  return true;
}

function deriveProductionIndex() {
  var rows = S.state.rows;
  var live = collectTags();
  var liveByKey = {};
  live.forEach(function (t) { liveByKey[registryKey(t.cat.id, t.name)] = t; });

  var seen = {}, out = [], unregistered = [];
  S.state.productionTags.forEach(function (t) {
    if (!t) return;
    var cat = tagCategory(t.cat);
    if (!cat) return;
    var key = registryKey(cat.id, t.name);
    if (seen[key]) return;
    seen[key] = true;
    var liveMatch = liveByKey[key];
    out.push({
      key: key,
      id: t.id || null,
      cat: cat,
      name: liveMatch ? liveMatch.name : t.name,
      mentions: liveMatch ? liveMatch.mentions : [],
      orphaned: !liveMatch,
      owner: t.owner || "",
      notes: t.notes || "",
      status: (tagStatus(t.status) || TAG_STATUSES[0]).id
    });
  });
  live.forEach(function (t) {
    var key = registryKey(t.cat.id, t.name);
    if (seen[key]) return;
    seen[key] = true;
    unregistered.push(t);
    out.push({ key: key, id: null, cat: t.cat, name: t.name, mentions: t.mentions,
               orphaned: false, owner: "", notes: "", status: TAG_STATUSES[0].id });
  });

  var rowSig = new Array(rows.length * ROW_SIG_SLOTS);
  rows.forEach(function (r, i) {
    var j = i * ROW_SIG_SLOTS;
    rowSig[j] = r.id;
    rowSig[j + 1] = r.visualText;
    rowSig[j + 2] = r.audioText;
    rowSig[j + 3] = tagsInField(r.visualText);
    rowSig[j + 4] = tagsInField(r.audioText);
  });
  return {
    entries: out,
    unregistered: unregistered,
    rowCount: rows.length,
    rowSig: rowSig,
    tagSig: registrySignature(S.state.productionTags)
  };
}

function productionIndex() {
  if (prodIndex && prodIndex.state === S.state && prodIndexFresh(prodIndex)) return prodIndex;
  prodIndexDerived++;
  prodIndex = deriveProductionIndex();
  prodIndex.state = S.state;
  return prodIndex;
}

export function productionEntries() {
  return productionIndex().entries.slice();
}

export function healTagRegistry() {
  if (!S.state) return 0;
  var ix = productionIndex();
  var cuesWere = cueSnapshot;
  cueSnapshot = snapshotCues();
  if (!ix.unregistered.length) return 0;
  var n = ix.unregistered.length;
  var retitled = retitleEditedCues(cuesWere, cueSnapshot, ix);
  ix.unregistered.forEach(function (t) {
    registerProductionTag(t.cat.id, t.name);
    var reg = registryEntry(t.cat.id, t.name);
    ix.entries.forEach(function (e) { if (e.key === registryKey(t.cat.id, t.name) && reg) e.id = reg.id; });
  });
  ix.unregistered = [];
  ix.tagSig = registrySignature(S.state.productionTags);
  if (retitled) prodIndex = null;
  return n;
}

var cueSnapshot = null;

var cueNamesInField = contentMemo(function (html) {
  if (html.indexOf("audio-cue") === -1) return [];
  return cuesInCell(cellOf(html)).map(function (c) { return c.name.slice(0, 80).trim(); }).filter(Boolean);
});

function snapshotCues() {
  var cells = {};
  S.state.rows.forEach(function (r) {
    var names = cueNamesInField(r.audioText);
    if (names.length) cells[r.id] = names;
  });
  return { docId: S.state.docId, cells: cells };
}

function retitleEditedCues(was, now, ix) {
  if (!was || was.docId !== now.docId) return 0;
  var fresh = {}, orphan = {};
  ix.unregistered.forEach(function (t) { if (t.cat.id === "sound") fresh[registryKey("sound", t.name)] = true; });
  ix.entries.forEach(function (e) { if (e.orphaned && e.cat.id === "sound") orphan[e.key] = true; });
  var n = 0;
  Object.keys(now.cells).forEach(function (rowId) {
    var before = was.cells[rowId];
    if (!before) return;
    var after = now.cells[rowId];
    var gone = before.filter(function (name) { return after.indexOf(name) === -1; });
    var came = after.filter(function (name) { return before.indexOf(name) === -1; });
    for (var i = 0; i < gone.length && i < came.length; i++) {
      var oldKey = registryKey("sound", gone[i]), newKey = registryKey("sound", came[i]);
      if (!fresh[newKey] || !orphan[oldKey]) continue;
      var entry = registryEntry("sound", gone[i]);
      if (!entry) continue;
      entry.name = came[i];
      delete fresh[newKey];
      delete orphan[oldKey];
      n++;
    }
  });
  return n;
}

export function missingRegistryTags(rows, registry) {
  var have = Object.create(null);
  (registry || []).forEach(function (t) { if (t && t.name) have[registryKey(t.cat, t.name)] = true; });
  var out = [];
  collectTagsFromRows(rows).forEach(function (t) {
    var name = plainText(t.name).trim().slice(0, 80);
    if (!name) return;
    var key = registryKey(t.cat.id, name);
    if (have[key]) return;
    have[key] = true;
    out.push({ cat: t.cat.id, name: name, owner: "", notes: "", status: TAG_STATUSES[0].id });
  });
  return out;
}

export function productionIndexStats() {
  return { derived: prodIndexDerived, flushes: idleFlushes };
}

export function resetProductionIndexStats() {
  prodIndexDerived = 0;
  idleFlushes = 0;
}

export function tagsByCategory(all) {
  all = all || productionEntries();
  return TAG_CATEGORIES.map(function (cat) {
    var items = all.filter(function (t) { return t.cat.id === cat.id; });
    items.sort(function (a, b) {
      if (!!a.orphaned !== !!b.orphaned) return a.orphaned ? 1 : -1;
      if (b.mentions.length !== a.mentions.length) return b.mentions.length - a.mentions.length;
      return a.name.localeCompare(b.name);
    });
    return { cat: cat, items: items };
  }).filter(function (g) { return g.items.length; });
}

var IDLE_REFRESH_MS = 180;
var IDLE_REFRESH_MAX_MS = 1000;
var idlePending = { production: false, writerStats: false, untagged: false, broll: false };
var idleTimer = null;
var idleSince = 0;
var idleFlushes = 0;

export function scheduleIdleRefresh(job) {
  idlePending[job] = true;
  var now = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  else idleSince = now;
  var wait = Math.max(0, Math.min(IDLE_REFRESH_MS, idleSince + IDLE_REFRESH_MAX_MS - now));
  idleTimer = setTimeout(runIdleRefresh, wait);
}

function runIdleRefresh() {
  idleTimer = null;
  var p = idlePending;
  idlePending = { production: false, writerStats: false, untagged: false, broll: false };
  if (!S.state) return;
  idleFlushes++;
  if (p.production) refreshProductionNow();
  if (p.writerStats) updateWriterStats();
  if (p.untagged) scanUntaggedMentions();
  if (p.broll) runBrollRefresh();
}

function refreshProductionNow() {
  healTagRegistry();
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
  updateProductionBadge(S.state ? productionEntries().length : 0);
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
  if (!trimmed || phrase.length > AUTO_TAG_MAX_LEN || hasShortcutChar(phrase)) return;

  tagTextRange(cellEl, node, openAt, offset, trimmed, rule.cat, trimmed);
  updateTagBadges();
  renderProduction();
}

function tagTextRange(cellEl, node, a, b, text, cat, name) {
  editCell(cellEl, function (cell) {
    var from = domToPos(cellEl, node, a), to = domToPos(cellEl, node, b);
    if (from === null || to === null) return null;
    if (projection(cell).slice(from, to) !== node.data.slice(a, b).replace(/\u200B/g, "")) return null;
    var r = replaceWithTag(cell, from, to, text, namedTagId(cat, name));
    registerProductionTag(cat, name);
    return { cell: r.cell, sel: { from: r.end, to: r.end } };
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
S.untaggedMutedFor = null;

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
  if (!S.state) return;
  untaggedList = [];
  var index = writerOpen ? null : buildUntaggedIndex(entries || productionEntries());
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
  if (!cellEl || S.untaggedMutedFor === cellEl) { hideUntaggedPrompt(); return; }
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

var TAG_WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function foldCaseKeepLength(s) {
  var lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i).toLowerCase();
    out += c.length === 1 ? c : s.charAt(i);
  }
  return out;
}

function sameCmt(a, b) {
  return (a || []).join("\u0000") === (b || []).join("\u0000");
}

export function tagOccurrences(cell, phrase) {
  var needle = foldCaseKeepLength(String(phrase == null ? "" : phrase));
  var out = [];
  if (!needle) return out;
  var text = "", marks = [];
  (cell || []).forEach(function (r) {
    if (r.atom) { text += "￼"; marks.push(null); return; }
    text += r.text;
    for (var i = 0; i < r.text.length; i++) marks.push(r.marks);
  });
  var hay = foldCaseKeepLength(text);
  var at = hay.indexOf(needle);
  while (at !== -1) {
    var end = at + needle.length;
    var ok = true;
    for (var i = at; i < end && ok; i++) {
      var m = marks[i];
      ok = !!m && !m.tag && !m.href && text.charAt(i) !== "\n" && sameCmt(m.cmt, marks[at].cmt);
    }
    if (!ok) { at = hay.indexOf(needle, at + 1); continue; }
    if (!TAG_WORD_CHAR_RE.test(text.charAt(at - 1)) && !TAG_WORD_CHAR_RE.test(text.charAt(end))) {
      out.push({ from: at, to: end });
    }
    at = hay.indexOf(needle, end);
  }
  return out;
}

function holdsMedia(html) {
  return /<img[\s>]|video-embed-card/i.test(html || "");
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
  var cell = cellOf(html);
  var found = tagOccurrences(cell, phrase);
  if (countOnly) return { hits: found.length, html: html };
  if (onlyOccurrence !== undefined) found = found[onlyOccurrence] ? [found[onlyOccurrence]] : [];
  return writeTags(html, cell, found, cat, name);
}

function writeTags(html, cell, found, cat, name) {
  if (!found.length) return { hits: 0, html: html };
  var clean = plainText(name).trim().slice(0, 80);
  if (holdsMedia(html)) {
    var wrapped = wrapTagInHtml(html, cell, found, cat, clean);
    return wrapped === null ? { hits: 0, html: html } : { hits: found.length, html: wrapped };
  }
  var id = namedTagId(cat, clean);
  found.forEach(function (m) { cell = setMark(cell, m.from, m.to, "tag", id); });
  return { hits: found.length, html: toHtml(cell) };
}

function wholeWordHits(text, needle, matchCase) {
  var hay = matchCase ? text : foldCaseKeepLength(text);
  var find = matchCase ? needle : foldCaseKeepLength(needle);
  var out = [];
  if (!find) return out;
  var at = hay.indexOf(find);
  while (at !== -1) {
    var end = at + find.length;
    if (!TAG_WORD_CHAR_RE.test(text.charAt(at - 1)) && !TAG_WORD_CHAR_RE.test(text.charAt(end))) {
      out.push({ from: at, to: end });
      at = hay.indexOf(find, end);
    } else {
      at = hay.indexOf(find, at + 1);
    }
  }
  return out;
}

export function bulkTagCell(html, phrase, cat, name, matchCase, countOnly) {
  var needle = String(phrase == null ? "" : phrase).trim();
  var none = { hits: 0, inTags: 0, skipped: 0, html: html };
  if (!needle) return none;
  var cell = cellOf(html);
  var text = "", tagged = [];
  cell.forEach(function (r) {
    if (r.atom) { text += "\uFFFC"; tagged.push(false); return; }
    text += r.text;
    for (var i = 0; i < r.text.length; i++) tagged.push(!!r.marks.tag);
  });
  var found = tagOccurrences(cell, needle).filter(function (m) {
    return !matchCase || text.slice(m.from, m.to) === needle;
  });
  var taking = {};
  found.forEach(function (m) { taking[m.from] = true; });
  var inTags = 0, skipped = 0;
  wholeWordHits(text, needle, matchCase).forEach(function (h) {
    if (taking[h.from]) return;
    if (tagged.slice(h.from, h.to).indexOf(true) !== -1) inTags++;
    else skipped++;
  });
  if (countOnly || !found.length) {
    return { hits: found.length, inTags: inTags, skipped: skipped, html: html };
  }
  var res = writeTags(html, cell, found, cat, name);
  return { hits: res.hits, inTags: inTags, skipped: skipped + found.length - res.hits, html: res.html };
}

export function bulkTagRows(rows, phrase, cat, name, matchCase, countOnly) {
  var total = { hits: 0, inTags: 0, skipped: 0 };
  (rows || []).forEach(function (row) {
    var res = bulkTagCell(row.visualText, phrase, cat, name, matchCase, countOnly);
    total.hits += res.hits;
    total.inTags += res.inTags;
    total.skipped += res.skipped;
    if (!countOnly && res.hits && res.html !== row.visualText) {
      row.visualText = res.html;
      stampRow(row);
    }
  });
  return total;
}

function tagAllOccurrences(phrase, cat, name) {
  var needle = String(phrase || "").trim();
  if (!needle) return 0;
  var total = 0;
  S.state.rows.forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      var res = tagFieldOccurrences(row[field], needle, cat, name, false);
      if (res.hits) {
        total += res.hits;
        row[field] = res.html;
        stampRow(row);
      }
    });
  });
  return total;
}

function countPhraseMatches(phrase) {
  var needle = String(phrase || "").trim();
  if (!needle || !S.state) return 0;
  var total = 0;
  S.state.rows.forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      total += tagOccurrences(cellOf(row[field]), needle).length;
    });
  });
  return total;
}

function eachTaggedField(cat, name, toName) {
  var target = normalizeTagName(name);
  var toId = toName === null ? null : namedTagId(cat, toName);
  var changed = 0;
  S.state.rows.forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      var html = row[field];
      var mentions = tagsInField(html).filter(function (t) {
        return t.catId === cat && normalizeTagName(t.name) === target;
      }).length;
      if (!mentions) return;
      changed += mentions;
      row[field] = holdsMedia(html) ? retagInHtml(html, cat, target, toName) : retagCell(html, cat, target, toId);
      stampRow(row);
    });
  });
  return changed;
}

function retagCell(html, cat, target, toId) {
  var cell = cellOf(html);
  tagIds(cell).forEach(function (id) {
    var t = tagNameOf(id);
    if (t && t.cat === cat && normalizeTagName(t.name) === target) cell = retag(cell, id, toId);
  });
  if (cat === "sound" && html.indexOf("audio-cue") !== -1) {
    cell = editCues(cell, function (name) { return normalizeTagName(name.slice(0, 80)) === target; },
      toId === null ? null : tagNameOf(toId).name);
  }
  return toHtml(cell);
}

function retagInHtml(html, cat, target, toName) {
  var body = inertBody(html);
  Array.prototype.forEach.call(body.querySelectorAll(".tag-anchor"), function (el) {
    if (el.getAttribute("data-tag-cat") !== cat) return;
    if (normalizeTagName(el.getAttribute("data-tag-name")) !== target) return;
    if (toName !== null) { el.setAttribute("data-tag-name", toName); return; }
    while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
    el.parentNode.removeChild(el);
  });
  return sanitizeHtml(body.innerHTML);
}

export function renameTag(cat, oldName, newName) {
  var clean = plainText(newName).trim().slice(0, 80);
  if (!clean) return false;
  if (registryKey(cat, clean) !== registryKey(cat, oldName)) {
    var collision = registryEntry(cat, clean);
    var oldEntry = registryEntry(cat, oldName);
    if (collision && oldEntry && collision !== oldEntry) {
      if (!collision.owner && oldEntry.owner) collision.owner = oldEntry.owner;
      if (!collision.notes && oldEntry.notes) collision.notes = oldEntry.notes;
      if (tagStatusRank(oldEntry.status) > tagStatusRank(collision.status)) {
        collision.status = oldEntry.status;
      }
      var oi = S.state.productionTags.indexOf(oldEntry);
      if (oi !== -1) S.state.productionTags.splice(oi, 1);
      brollPropsRenamed(oldEntry.id, cat === "prop" ? oldEntry.name : "", collision.id, collision.name);
    }
  }
  var spanCount = eachTaggedField(cat, oldName, clean);
  var entry = registryEntry(cat, oldName);
  if (entry) {
    entry.name = clean;
    brollPropsRenamed(entry.id, cat === "prop" ? oldName : "", entry.id, clean);
  }
  return spanCount > 0 || !!entry;
}

export function removeTag(cat, name) {
  return eachTaggedField(cat, name, null);
}

var pendingTag = null;
S.tagRenaming = null;
S.tagDeleteArmId = null;
S.tagDeleteArmTimer = null;
S.productionGroupBy = "cat";
S.tagExpanded = null;
S.tagAddingPersonFor = null;

export var productionSelection = {};
S.selectionAnchorKey = null;
export var bulkDeleteArmed = false;
var bulkDeleteArmTimer = null;

export function selectedKeys() { return Object.keys(productionSelection); }

export function armBulkDelete() {
  bulkDeleteArmed = true;
  clearTimeout(bulkDeleteArmTimer);
  bulkDeleteArmTimer = setTimeout(function () {
    bulkDeleteArmed = false;
    renderProduction();
  }, 2800);
}

export function disarmBulkDelete() {
  clearTimeout(bulkDeleteArmTimer);
  bulkDeleteArmed = false;
}

export function clearProductionSelection() {
  productionSelection = {};
  S.selectionAnchorKey = null;
  disarmBulkDelete();
}

export function pruneProductionSelection(entries) {
  var live = {};
  entries.forEach(function (e) { live[e.key] = true; });
  var dropped = false;
  selectedKeys().forEach(function (k) {
    if (!live[k]) { delete productionSelection[k]; dropped = true; }
  });
  if (dropped) disarmBulkDelete();
  if (S.selectionAnchorKey && !live[S.selectionAnchorKey]) S.selectionAnchorKey = null;
}

export function resetProductionPanelState() {
  S.tagRenaming = null;
  S.tagExpanded = null;
  S.tagAddingPersonFor = null;
  S.productionGroupBy = "cat";
  clearTimeout(S.tagDeleteArmTimer);
  S.tagDeleteArmId = null;
  clearProductionSelection();
}

export function renderTagCategories(selected) {
  document.getElementById("tag-cats").innerHTML = TAG_CATEGORIES.map(function (c) {
    return '<button type="button" class="tag-cat-btn' + (c.id === selected ? ' is-active' : '') +
      '" style="--dot:' + c.color + '" data-tag-cat="' + c.id + '" role="radio" aria-checked="' +
      (c.id === selected ? 'true' : 'false') + '">' +
      '<span class="tag-cat-dot" aria-hidden="true"></span>' + escapeHtml(c.label) + '</button>';
  }).join("");
}

function refreshTagNameList() {
  var names = {};
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
  nameInput.value = ctx.quotedText.slice(0, 80);
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
  var name = plainText(document.getElementById("tag-name").value).trim().slice(0, 80);
  if (!name) { showToast("Give the label a name first.", "warn"); return; }

  var all = document.getElementById("tag-all").checked;
  var phrase = pendingTag.quotedText;
  var ctx = pendingTag;
  closeTagComposer();

  if (all) {
    breakUndoCoalescing();
    var n = tagAllOccurrences(phrase, cat, name);
    registerProductionTag(cat, name);
    markDirty();
    breakUndoCoalescing();
    render();
    queueAutoSave();
    showToast("Labelled " + n + " mention" + (n === 1 ? "" : "s") + " of " + name, "ok");
    return;
  }

  var cellEl = document.querySelector('#rows .row[data-id="' + safeId(ctx.rowId, "r") +
    '"] .' + (ctx.field === "visualText" ? "visual" : "audio") + '-cell .cell-editable');
  if (!cellEl) { showToast("That scene is no longer here.", "warn"); return; }

  var idx = findRowIndex(ctx.rowId);
  if (idx === -1) return;
  syncFieldFromDom(cellEl);
  breakUndoCoalescing();
  var row = S.state.rows[idx];
  var res = tagFieldOccurrences(row[ctx.field], phrase, cat, name, false, ctx.occurrenceIndex || 0);
  if (!res.hits) { showToast("Could not find that text any more.", "warn"); return; }
  row[ctx.field] = res.html;
  stampRow(row);
  registerProductionTag(cat, name);
  markDirty();
  breakUndoCoalescing();
  render();
  queueAutoSave();
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

}
