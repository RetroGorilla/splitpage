import { S } from "./_state.js";
import { escapeHtml, makeId } from "./02-state.js";
import { findRowIndex } from "./03-sync.js";
import {
  ensureTrailingCaretSpot,
  inertBody,
  plainText,
  sanitizeHtml
} from "./04-richtext.js";
import {
  cellOf,
  deleteRange,
  insertBrollKey,
  insertText,
  projection,
  replaceWithBrollKey,
  tagNameOf,
  toHtml
} from "./04c-doc-model.js";
import { render } from "./05-render.js";
import { domToPos, editCell } from "./05b-cell-edit.js";
import {
  TAG_STATUSES,
  contentMemo,
  isInsideTagOrLink,
  isTagId,
  normalizeTagName,
  registerProductionTag,
  registryEntry,
  scheduleIdleRefresh,
  tagStatus,
  tagsInField
} from "./07-production-tags.js";
import { renderBrollViews } from "./08d-broll-panel.js";
import { markDirty } from "./12-dirty-toast.js";
import { htmlToPlainText } from "./14-export.js";

// Built lazily in brollField(); assigned in __init()
var brollInField;
var brollPropsInField;
var brollAnchorDeclined;

export var BROLL_STATUSES = [
  { id: "unshot", label: "To shoot", color: "var(--text-dim)" },
  { id: "shot",   label: "Shot",     color: "var(--ok)" }
];

export function brollStatus(id) {
  for (var i = 0; i < BROLL_STATUSES.length; i++) {
    if (BROLL_STATUSES[i].id === id) return BROLL_STATUSES[i];
  }
  return null;
}

// Anchored: a marker must start its line; mid-sentence stays prose
export var BROLL_MARKER_RE = /^[ \t]*(b[ \t]?-?[ \t]?roll)[ \t]*([:—–-])[ \t]*/i;
var BROLL_CLOSERS = ":—–-";

export var BROLL_NAME_MAX = 200;
export var BROLL_TEXT_MAX = 2000;
// Cap only so a broken file cannot flood the panel
var BROLL_PROP_NAME_MAX = 80;
export var BROLL_PROPS_MAX = 40;

function brollCellLines(cell) {
  var lines = [{ start: 0, end: 0, items: [] }];
  var pos = 0;
  cell.forEach(function (r) {
    if (r.atom) {
      lines[lines.length - 1].items.push({ atom: r, text: r.text, marks: r.marks, pos: pos });
      pos++;
      return;
    }
    r.text.split("\n").forEach(function (part, i) {
      if (i > 0) {
        lines[lines.length - 1].end = pos;
        pos++;
        lines.push({ start: pos, end: pos, items: [] });
      }
      if (part) {
        lines[lines.length - 1].items.push({ text: part, marks: r.marks, pos: pos });
        pos += part.length;
      }
    });
  });
  lines[lines.length - 1].end = pos;
  return lines;
}

function brollLineText(items) {
  return items.map(function (it) { return it.text; }).join("");
}

function hasNoMarks(marks) {
  return !marks || !Object.keys(marks).length;
}

function brollLineMarker(items) {
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it.atom && hasNoMarks(it.marks) && !it.text.trim()) continue;
    if (it.atom && hasNoMarks(it.marks)) return { id: it.atom.id || "", key: it, rest: items.slice(i + 1) };
    break;
  }
  var m = BROLL_MARKER_RE.exec(brollLineText(items));
  return m ? { id: "", key: null, rest: null, strip: m[0].length } : null;
}

export function brollInCell(cell) {
  var out = [], open = null;
  brollCellLines(cell).forEach(function (line) {
    var marker = brollLineMarker(line.items);
    if (marker) {
      var name = marker.rest
        ? brollLineText(marker.rest)
        : brollLineText(line.items).slice(marker.strip);
      open = { id: marker.id, name: name.trim().slice(0, BROLL_NAME_MAX), desc: [] };
      out.push(open);
      return;
    }
    if (open) open.desc.push(brollLineText(line.items));
  });
  out.forEach(function (item) {
    item.desc = item.desc.join("\n").replace(/\s+$/, "").slice(0, BROLL_TEXT_MAX);
  });
  return out;
}

export function brollPropsInCell(cell) {
  var out = [], open = null, seen = null;
  brollCellLines(cell).forEach(function (line) {
    if (brollLineMarker(line.items)) {
      open = [];
      seen = Object.create(null);
      out.push(open);
    }
    if (!open) return;
    line.items.forEach(function (it) {
      var t = !it.atom && it.marks && it.marks.tag ? tagNameOf(it.marks.tag) : null;
      if (!t || t.cat !== "prop") return;
      var name = t.name.trim().slice(0, BROLL_PROP_NAME_MAX);
      var key = normalizeTagName(name);
      if (!name || seen[key]) return;
      seen[key] = true;
      open.push(name);
    });
  });
  return out;
}

function brollMarkerLines(cell) {
  var out = [];
  brollCellLines(cell).forEach(function (line, index) {
    var marker = brollLineMarker(line.items);
    if (marker) out.push({ line: line, index: index, marker: marker });
  });
  return out;
}

// Legacy media cells skip the model; use DOM path
function holdsMedia(html) {
  return /<img[\s>]|video-embed-card/i.test(html || "");
}

function brollHtmlLines(body) {
  hoistNestedBrs(body);
  var kids = Array.prototype.slice.call(body.childNodes);
  var lines = [], start = 0;
  kids.forEach(function (n, i) {
    if (n.nodeType === 1 && n.tagName === "BR") {
      lines.push({ nodes: kids.slice(start, i), br: n });
      start = i + 1;
    }
  });
  lines.push({ nodes: kids.slice(start), br: null });
  return lines;
}

// Enter inside bold leaves <br> a child of formatting
function hoistNestedBrs(body) {
  var guard = 0;
  while (guard++ < 1000) {
    var brs = body.getElementsByTagName("br");
    var br = null;
    for (var i = 0; i < brs.length; i++) {
      if (brs[i].parentNode !== body) { br = brs[i]; break; }
    }
    if (!br) return;
    var parent = br.parentNode;
    var grand = parent.parentNode;
    if (!grand) return;
    var tail = parent.cloneNode(false);
    while (br.nextSibling) tail.appendChild(br.nextSibling);
    parent.removeChild(br);
    var ref = parent.nextSibling;
    grand.insertBefore(br, ref);
    if (tail.childNodes.length) grand.insertBefore(tail, ref);
  }
}

function brollHtmlLineText(nodes) {
  return nodes.map(function (n) { return n.textContent || ""; }).join("");
}

// Visual cells only; the audio column is read aloud
function collectBrollFromRows(rows) {
  var out = [];
  var seen = Object.create(null);
  (rows || []).forEach(function (row, rowIndex) {
    var props = brollPropsField(row.visualText);
    brollField(row.visualText).forEach(function (found, ordinal) {
      var id = found.id && !seen[found.id] ? found.id : "";
      if (id) seen[id] = true;
      out.push({
        id: id, name: found.name, desc: found.desc,
        rowId: row.id, rowIndex: rowIndex, ordinal: ordinal,
        autoProps: props[ordinal] || []
      });
    });
  });
  return out;
}

// Memoised and shared across callers: read, never mutate
function brollField(html) {
  if (!brollInField) brollInField = contentMemo(function (h) { return brollInCell(cellOf(h)); });
  return brollInField(html);
}

export function brollCountInRow(row) {
  return row && row.visualText ? brollField(row.visualText).length : 0;
}

function brollPropsField(html) {
  if (!brollPropsInField) brollPropsInField = contentMemo(function (h) { return brollPropsInCell(cellOf(h)); });
  return brollPropsInField(html);
}

function brollRow(rowId) {
  var i = rowId ? findRowIndex(rowId) : -1;
  return i === -1 ? null : S.state.rows[i];
}

function brollSeedRef(row) {
  return row ? htmlToPlainText(row.audioText).trim().slice(0, BROLL_TEXT_MAX) : "";
}

function brollSeedLocation(row) {
  if (!row) return "";
  var found = "";
  ["visualText", "audioText"].forEach(function (field) {
    tagsInField(row[field]).forEach(function (t) {
      if (!found && t.catId === "location") found = t.name;
    });
  });
  return found.slice(0, 80);
}

export function brollRecord(id) {
  if (!id) return null;
  for (var i = 0; i < S.state.brollShots.length; i++) {
    if (S.state.brollShots[i].id === id) return S.state.brollShots[i];
  }
  return null;
}

export function newBrollRecord(fields) {
  var rec = {
    id: makeId("bs"),
    name: "", desc: "",
    status: BROLL_STATUSES[0].id,
    reshoot: false,
    notes: "",
    owner: "",
    audioRef: "",
    location: "",
    props: [],
    origin: "script"
  };
  Object.keys(fields || {}).forEach(function (k) { rec[k] = fields[k]; });
  S.state.brollShots.push(rec);
  return rec;
}

export function recordPastedBroll(rowId, cell, ids) {
  if (!S.state || !ids || !ids.length) return;
  var row = brollRow(rowId);
  brollInCell(cell).forEach(function (found) {
    if (!found.id || ids.indexOf(found.id) === -1 || brollRecord(found.id)) return;
    newBrollRecord({
      id: found.id, name: found.name, desc: found.desc,
      audioRef: brollSeedRef(row), location: brollSeedLocation(row)
    });
  });
}

export function deleteBrollRecord(id) {
  var before = S.state.brollShots.length;
  S.state.brollShots = S.state.brollShots.filter(function (r) { return r.id !== id; });
  return before !== S.state.brollShots.length;
}

// Anchoring pass must ask id-then-name in this exact order
function brollMatchRecord(found, claimed, byId, held) {
  var rec = found.id ? byId[found.id] : null;
  if (rec && !claimed[rec.id]) return rec;
  var norm = normalizeTagName(found.name);
  for (var i = 0; i < S.state.brollShots.length && norm; i++) {
    var cand = S.state.brollShots[i];
    if (claimed[cand.id] || held[cand.id]) continue;
    if (normalizeTagName(cand.name) !== norm) continue;
    return cand;
  }
  return null;
}

function brollHeldIds(live) {
  var held = Object.create(null);
  live.forEach(function (found) { if (found.id) held[found.id] = true; });
  return held;
}

export function brollEntries(readOnly) {
  var live = collectBrollFromRows(S.state.rows);
  var claimed = Object.create(null);
  var byId = Object.create(null);
  var held = brollHeldIds(live);
  S.state.brollShots.forEach(function (r) { byId[r.id] = r; });
  var out = [];

  live.forEach(function (found) {
    var rec = brollMatchRecord(found, claimed, byId, held);
    if (!rec) {
      var row = brollRow(found.rowId);
      var fields = {
        id: found.id || makeId("bs"),
        name: found.name,
        desc: found.desc,
        audioRef: brollSeedRef(row),
        location: brollSeedLocation(row)
      };
      rec = readOnly ? Object.assign({ status: BROLL_STATUSES[0].id, props: [], origin: "script" }, fields)
        : newBrollRecord(fields);
    }
    claimed[rec.id] = true;
    if (!readOnly) {
      rec.name = found.name;
      rec.desc = found.desc;
    }
    out.push(brollEntryFrom(rec, found));
  });

  S.state.brollShots.forEach(function (rec) {
    if (!claimed[rec.id]) out.push(brollEntryFrom(rec, null));
  });

  return out;
}

function brollEntryFrom(rec, found) {
  return {
    rec: rec,
    id: rec.id,
    name: found ? found.name : rec.name,
    desc: found ? found.desc : (rec.desc || ""),
    rowId: found ? found.rowId : null,
    rowIndex: found ? found.rowIndex : -1,
    ordinal: found ? found.ordinal : -1,
    markerless: !!found && !found.id,
    orphaned: !found && rec.origin === "script",
    status: brollStatus(rec.status) ? rec.status : BROLL_STATUSES[0].id,
    reshoot: !!rec.reshoot,
    notes: rec.notes || "",
    owner: rec.owner || "",
    audioRef: rec.audioRef || "",
    location: rec.location || "",
    props: brollEntryProps(rec, found),
    origin: rec.origin
  };
}

// Tolerates garbage: stored lists come from files and merges
export function normalizeBrollProps(list, registry) {
  var byId = Object.create(null), byName = Object.create(null);
  (registry || []).forEach(function (t) {
    if (!t || !t.id || !t.name) return;
    byId[t.id] = t;
    if (t.cat === "prop" && !byName[normalizeTagName(t.name)]) byName[normalizeTagName(t.name)] = t;
  });
  var out = [], seen = Object.create(null);
  (Array.isArray(list) ? list : []).forEach(function (p) {
    if (out.length >= BROLL_PROPS_MAX) return;
    if (typeof p === "string") p = { name: p };
    if (!p || typeof p !== "object") return;
    var id = isTagId(p.id) ? p.id : "";
    var name = typeof p.name === "string" || typeof p.name === "number" ? plainText(p.name).trim() : "";
    if (!id && name && byName[normalizeTagName(name)]) id = byName[normalizeTagName(name)].id;
    if (id && byId[id]) name = byId[id].name;
    name = name.slice(0, BROLL_PROP_NAME_MAX);
    if (!name) return;
    var key = brollPropKey(id, name);
    if (seen[key]) return;
    seen[key] = true;
    out.push({ id: id, name: name });
  });
  return out;
}

export function brollPropKey(id, name) {
  return id ? id : "n:" + normalizeTagName(name);
}

function brollPropEntry(p) {
  if (!S.state) return null;
  if (p.id) {
    for (var i = 0; i < S.state.productionTags.length; i++) {
      if (S.state.productionTags[i].id === p.id) return S.state.productionTags[i];
    }
  }
  return registryEntry("prop", p.name);
}

function brollEntryProps(rec, found) {
  var out = [], byKey = Object.create(null);
  function add(entry, name, ref) {
    var shown = entry ? entry.name : name;
    var key = entry ? "t:" + entry.id : "n:" + normalizeTagName(shown);
    var had = byKey[key];
    if (had) {
      if (ref) { had.hand = true; had.ref = had.ref || ref; } else had.auto = true;
      return;
    }
    byKey[key] = {
      key: key, id: entry ? entry.id : "", name: shown,
      status: entry ? (tagStatus(entry.status) || TAG_STATUSES[0]).id : "",
      auto: !ref, hand: !!ref, tracked: !!entry, ref: ref
    };
    out.push(byKey[key]);
  }
  ((found && found.autoProps) || []).forEach(function (name) {
    add(registryEntry("prop", name), name, "");
  });
  (rec.props || []).forEach(function (p) {
    if (p && p.name) add(brollPropEntry(p), p.name, brollPropKey(p.id, p.name));
  });
  return out;
}

export function addBrollProp(shotId, rawName) {
  var rec = brollRecord(shotId);
  var name = plainText(rawName).trim().slice(0, BROLL_PROP_NAME_MAX);
  if (!rec || !name) return false;
  var entry = registryEntry("prop", name);
  if (!entry) {
    registerProductionTag("prop", name);
    entry = registryEntry("prop", name);
  }
  if (!entry) return false;
  rec.props = normalizeBrollProps(rec.props, S.state.productionTags);
  var key = brollPropKey(entry.id, entry.name);
  var already = rec.props.some(function (p) {
    return brollPropKey(p.id, p.name) === key || (!p.id && normalizeTagName(p.name) === normalizeTagName(entry.name));
  });
  if (already || rec.props.length >= BROLL_PROPS_MAX) return false;
  rec.props.push({ id: entry.id, name: entry.name });
  return true;
}

export function removeBrollProp(shotId, ref) {
  var rec = brollRecord(shotId);
  if (!rec || !ref || !Array.isArray(rec.props)) return false;
  var before = rec.props.length;
  rec.props = rec.props.filter(function (p) { return brollPropKey(p.id, p.name) !== ref; });
  return rec.props.length !== before;
}

export function brollPropsRenamed(fromId, oldName, toId, toName) {
  if (!S.state || !Array.isArray(S.state.brollShots)) return;
  var oldNorm = normalizeTagName(oldName);
  S.state.brollShots.forEach(function (rec) {
    if (!Array.isArray(rec.props) || !rec.props.length) return;
    var changed = false;
    rec.props.forEach(function (p) {
      if (!p) return;
      if ((fromId && p.id === fromId) || (oldNorm && !p.id && normalizeTagName(p.name) === oldNorm)) {
        p.id = toId || p.id;
        p.name = toName;
        changed = true;
      }
    });
    if (changed) rec.props = normalizeBrollProps(rec.props, S.state.productionTags);
  });
}

export function brollShotsByProp() {
  var out = Object.create(null);
  if (!S.state || !S.state.brollShots) return out;
  brollSortedForList(brollEntries(true)).forEach(function (e) {
    e.props.forEach(function (p) {
      var k = "prop " + normalizeTagName(p.name);
      if (!out[k]) out[k] = [];
      out[k].push(e.name || "Untitled shot");
    });
  });
  return out;
}

function brollUnshotCount() {
  if (!S.state || !S.state.brollShots) return 0;
  return brollEntries().filter(function (e) { return e.status !== "shot"; }).length;
}

function brollAtLineStart(node) {
  if (node.nodeType !== 3) return false;
  var cell = node.parentNode && node.parentNode.closest
    ? node.parentNode.closest(".cell-editable") : null;
  if (!cell) return false;

  var n = node;
  while (true) {
    var prev = n.previousSibling;
    while (prev && prev.nodeType === 3 && !(prev.nodeValue || "").trim()) prev = prev.previousSibling;
    if (prev) return prev.nodeType === 1 && prev.tagName === "BR";
    var parent = n.parentNode;
    if (parent === cell) return true;
    if (!parent || parent.nodeType !== 1) return false;
    n = parent;
  }
}

export function maybeCaptureBroll(e, cellEl) {
  if (e.inputType !== "insertText" || !e.data) return;
  if (cellEl.getAttribute("data-field") !== "visualText") return;
  if (BROLL_CLOSERS.indexOf(e.data.charAt(e.data.length - 1)) === -1) return;
  var sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  var range = sel.getRangeAt(0);
  var node = range.startContainer;
  var offset = range.startOffset;
  if (!brollAtLineStart(node)) return;
  if (isInsideTagOrLink(node.parentNode)) return;
  var head = node.data.slice(0, offset);
  var m = BROLL_MARKER_RE.exec(head);
  if (!m || m[0].length !== head.length) return;

  // Caret goes outside the contenteditable=false key span
  var id = makeId("bs"), keyText = m[1] + m[2];
  editCell(cellEl, function (cell) {
    var from = domToPos(cellEl, node, 0), to = domToPos(cellEl, node, offset);
    if (from === null || to === null) return null;
    if (projection(cell).slice(from, to) !== head.replace(/\u200B/g, "")) return null;
    var r = replaceWithBrollKey(cell, from, to, id, keyText);
    var row = brollRow(cellEl.getAttribute("data-id"));
    newBrollRecord({ id: id, audioRef: brollSeedRef(row), location: brollSeedLocation(row) });
    return { cell: r.cell, sel: { from: r.end, to: r.end } };
  });
  scheduleBrollRefresh();
}

// contenteditable=false so the caret cannot edit into the marker
function brollKeyHtml(id, text) {
  return '<span class="broll-key" data-broll-id="' + escapeHtml(id) +
    '" contenteditable="false">' + escapeHtml(text) + '</span>';
}

function brollAnchorLine(cell, line, id) {
  var m = BROLL_MARKER_RE.exec(brollLineText(line.items));
  if (!m) return null;
  var left = m[0].length, to = line.start;
  for (var i = 0; i < line.items.length && left > 0; i++) {
    var it = line.items[i];
    if (it.atom) {
      if (it.text.length > left) return null;
      left -= it.text.length;
      to = it.pos + 1;
    } else {
      var take = Math.min(left, it.text.length);
      left -= take;
      to = it.pos + take;
    }
  }
  var r = replaceWithBrollKey(cell, line.start, to, id, m[1] + m[2]);
  return insertText(r.cell, r.end, " ", {});
}

function brollLineTextNodes(nodes) {
  var out = [];
  (function walk(list) {
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.nodeType === 3) out.push(n);
      else if (n.nodeType === 1) walk(n.childNodes);
    }
  })(nodes);
  return out;
}

function brollPruneEmpty(el, body) {
  while (el && el !== body && el.parentNode && !el.childNodes.length) {
    var parent = el.parentNode;
    parent.removeChild(el);
    el = parent;
  }
}

function brollWrapHtmlLine(body, line, id) {
  var m = BROLL_MARKER_RE.exec(brollHtmlLineText(line.nodes));
  if (!m) return false;
  var left = m[0].length;
  brollLineTextNodes(line.nodes).forEach(function (t) {
    if (left <= 0) return;
    var val = t.nodeValue || "";
    if (val.length > left) { t.nodeValue = val.slice(left); left = 0; return; }
    left -= val.length;
    var parent = t.parentNode;
    if (!parent) return;
    parent.removeChild(t);
    brollPruneEmpty(parent, body);
  });

  var ref = null;
  for (var i = 0; i < line.nodes.length && !ref; i++) {
    if (line.nodes[i].parentNode === body) ref = line.nodes[i];
  }
  if (!ref) ref = line.br;
  var holder = document.createElement("div");
  holder.innerHTML = brollKeyHtml(id, m[1] + m[2]) + " ";
  Array.prototype.slice.call(holder.childNodes).forEach(function (n) {
    body.insertBefore(n, ref);
  });
  return true;
}

function brollRekeyLine(cell, key, id) {
  var next = deleteRange(cell, key.pos, key.pos + 1);
  return insertBrollKey(next, key.pos, id, key.text, {});
}

function brollRekeyHtmlLine(line, id) {
  for (var i = 0; i < line.nodes.length; i++) {
    var n = line.nodes[i];
    if (n.nodeType !== 1) continue;
    var key = n.classList.contains("broll-key") ? n : n.querySelector(".broll-key");
    if (key) { key.setAttribute("data-broll-id", id); return true; }
  }
  return false;
}

// Reuse ids brollEntries assigned; fresh ones would orphan records
function brollAnchorPlan() {
  var claimed = Object.create(null);
  var byId = Object.create(null);
  S.state.brollShots.forEach(function (r) { byId[r.id] = r; });
  var plan = Object.create(null);
  var live = collectBrollFromRows(S.state.rows);
  var held = brollHeldIds(live);
  live.forEach(function (found) {
    var rec = brollMatchRecord(found, claimed, byId, held);
    if (rec) claimed[rec.id] = true;
    if (!found.id) plan[brollLineKey(found.rowId, found.ordinal)] = rec ? rec.id : makeId("bs");
  });
  return plan;
}

function brollLineKey(rowId, ordinal) {
  // Escape, not raw NUL: HTML parser rewrites it in scripts
  return rowId + "\u0000" + ordinal;
}

export function declineBrollAnchoring(rows) {
  (rows || []).forEach(function (row) { brollAnchorDeclined[row.id] = true; });
}

export function anchorBrollInRows(rows) {
  if (!S.state || !rows || !rows.length) return 0;
  var plan = brollAnchorPlan();
  var total = 0;
  rows.forEach(function (row) {
    if (brollAnchorDeclined[row.id]) return;
    var html = row.visualText;
    var cell = cellOf(html);
    var todo = [];
    brollMarkerLines(cell).forEach(function (found, ordinal) {
      var id = plan[brollLineKey(row.id, ordinal)];
      if (id) todo.push({ found: found, id: id });
    });
    if (!todo.length) return;
    var n = 0;
    if (holdsMedia(html)) {
      var body = inertBody(html);
      var htmlLines = brollHtmlLines(body);
      todo.forEach(function (t) {
        var line = htmlLines[t.found.index];
        if (!line) return;
        if (t.found.marker.key ? brollRekeyHtmlLine(line, t.id) : brollWrapHtmlLine(body, line, t.id)) n++;
      });
      if (n) row.visualText = sanitizeHtml(body.innerHTML);
    } else {
      // Last line first so earlier lines stay put
      for (var i = todo.length - 1; i >= 0; i--) {
        var t = todo[i];
        var next = t.found.marker.key
          ? brollRekeyLine(cell, t.found.marker.key, t.id)
          : brollAnchorLine(cell, t.found.line, t.id);
        if (next) { cell = next; n++; }
      }
      if (n) row.visualText = toHtml(cell);
    }
    total += n;
  });
  return total;
}

// Rewriting a field holding the caret would lose the caret
function brollAnchoringIdle() {
  var el = document.activeElement;
  return !(el && el.isContentEditable);
}

function maybeAnchorBroll() {
  if (!S.state || !brollAnchoringIdle()) return 0;
  var n = anchorBrollInRows(S.state.rows);
  if (!n) return 0;
  markDirty();
  render();
  return n;
}

export function anchorBrollInLeftCell(cellEl) {
  if (!S.state || cellEl.getAttribute("data-field") !== "visualText") return 0;
  var row = brollRow(cellEl.getAttribute("data-id"));
  if (!row) return 0;
  var n = anchorBrollInRows([row]);
  if (!n) return 0;
  cellEl.innerHTML = row.visualText;
  ensureTrailingCaretSpot(cellEl);
  markDirty();
  scheduleBrollRefresh();
  return n;
}

export function renameBrollInScript(entry, newName) {
  var row = brollRow(entry.rowId);
  if (!row) return false;
  var html = row.visualText;
  var target = entry.ordinal >= 0 ? brollMarkerLines(cellOf(html))[entry.ordinal] : null;
  if (!target) return false;
  var keyText = target.marker.key ? (target.marker.key.text || "B-roll:") : "B-roll:";

  if (holdsMedia(html)) {
    var body = inertBody(html);
    var line = brollHtmlLines(body)[target.index];
    if (!line) return false;
    var holder = document.createElement("div");
    holder.innerHTML = brollKeyHtml(entry.id, keyText) + " " + escapeHtml(newName);
    line.nodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    Array.prototype.slice.call(holder.childNodes).forEach(function (n) {
      body.insertBefore(n, line.br);
    });
    row.visualText = sanitizeHtml(body.innerHTML);
    return true;
  }

  var at = target.line.start;
  var cell = deleteRange(cellOf(html), at, target.line.end);
  cell = insertBrollKey(cell, at, entry.id, keyText, {});
  cell = insertText(cell, at + 1, " " + newName, {});
  row.visualText = toHtml(cell);
  return true;
}

export function brollSortedForList(entries) {
  return entries.slice().sort(function (a, b) {
    var an = a.rowIndex === -1, bn = b.rowIndex === -1;
    if (an !== bn) return an ? 1 : -1;
    if (an) return (a.name || "").localeCompare(b.name || "");
    if (a.rowIndex !== b.rowIndex) return a.rowIndex - b.rowIndex;
    return a.ordinal - b.ordinal;
  });
}

export function updateBrollBadge() {
  var badge = document.getElementById("broll-badge");
  if (!badge || !S.state) return;
  var n = brollUnshotCount();
  if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
  else badge.hidden = true;
}

export function scheduleBrollRefresh() {
  scheduleIdleRefresh("broll");
}

export function runBrollRefresh() {
  maybeAnchorBroll();
  updateBrollBadge();
  renderBrollViews();
}

export function __init() {
  // Import-scoped browser state, never stored in the document
  brollAnchorDeclined = Object.create(null);
}
