"use strict";

var HISTORY_PER_DOC = 50;
// Never a valid docId; only reachable via older flag.
var HISTORY_OLDER_KEY = "_older";
var HISTORY_SNAP_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
// Older bucket expires as a whole, counted from migration.
var HISTORY_OLDER_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function historyClip(v, n) {
  return String(v == null ? "" : v).slice(0, n);
}

function historyUtf8Length(str) {
  var n = 0, c, i;
  for (i = 0; i < str.length; i++) {
    c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length &&
             str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// expiresAt <= 0 means unstamped, not expired.
function historyOlderExpired(rec, nowMs) {
  if (!rec || rec.expiresAt == null) return false;
  var expiresAt = Number(rec.expiresAt);
  if (!isFinite(expiresAt) || expiresAt <= 0) return false;
  var now = Number(nowMs);
  return isFinite(now) && now >= expiresAt;
}

function sanitizeHistoryMeta(m) {
  if (!m || typeof m !== "object") return null;
  var id = typeof m.id === "string" ? m.id : "";
  if (!HISTORY_SNAP_ID_RE.test(id)) return null;
  var atMs = Number(m.atMs);
  if (!Number.isFinite(atMs)) atMs = Date.parse(m.at) || 0;
  var out = {
    id: id,
    label: historyClip(m.label, 300),
    at: typeof m.at === "string" && m.at ? historyClip(m.at, 40) : new Date(atMs).toISOString(),
    atMs: atMs,
    by: historyClip(m.by, 100),
    rows: Math.max(0, Math.floor(Number(m.rows) || 0)),
    title: historyClip(m.title, 300),
    sizeBytes: Math.max(0, Math.floor(Number(m.sizeBytes) || 0)),
    kind: m.kind === "legacy" ? "legacy" : "snapshot",
    formatVersion: 1
  };
  if (m.legacyId != null) out.legacyId = historyClip(m.legacyId, 100);
  return out;
}

// Re-stamp keeps newest monotonic after backward clock corrections.
function historyStampAfter(m, newestAtMs) {
  var n = Number(newestAtMs);
  if (newestAtMs != null && Number.isFinite(n) && !(m.atMs > n)) m.atMs = n + 1;
  return m;
}

// Pure: newest snapshot per doc never deleted; protect entries skipped.
function planHistoryEviction(docs, capBytes, nowMs, opts) {
  opts = opts || {};
  var perDoc = Number(opts.perDoc) > 0 ? Math.floor(Number(opts.perDoc)) : HISTORY_PER_DOC;
  var olderKey = typeof opts.olderKey === "string" ? opts.olderKey : HISTORY_OLDER_KEY;
  var cap = (typeof capBytes === "number" && capBytes >= 0) ? capBytes : Infinity;
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : 0;
  var protect = Object.create(null);
  (Array.isArray(opts.protect) ? opts.protect : []).forEach(function (p) {
    if (p && typeof p.docId === "string" && typeof p.id === "string") protect[p.docId + "\n" + p.id] = true;
  });
  function toMs(v) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    if (typeof v === "string" && v) { var p = Date.parse(v); return isFinite(p) ? p : 0; }
    return 0;
  }
  var list = [], older = null, total = 0, deletes = [];
  (Array.isArray(docs) ? docs : []).forEach(function (d) {
    if (!d || typeof d.docId !== "string") return;
    var snaps = [];
    (Array.isArray(d.snapshots) ? d.snapshots : []).forEach(function (s) {
      if (!s || typeof s.id !== "string") return;
      var size = Number(s.sizeBytes);
      snaps.push({ id: s.id, atMs: toMs(s.atMs), size: isFinite(size) && size > 0 ? size : 0 });
    });
    snaps.sort(function (a, b) { return (a.atMs - b.atMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    snaps.forEach(function (s) { total += s.size; });
    var entry = { docId: d.docId, lastOpenedAt: toMs(d.lastOpenedAt), expiresAt: toMs(d.expiresAt), snaps: snaps };
    if (d.docId === olderKey) older = entry; else list.push(entry);
  });
  var totalBefore = total;
  function dropOldest(entry, keepNewest) {
    var end = keepNewest ? entry.snaps.length - 1 : entry.snaps.length;
    for (var j = 0; j < end; j++) {
      var s = entry.snaps[j];
      if (protect[entry.docId + "\n" + s.id]) continue;
      entry.snaps.splice(j, 1);
      total -= s.size;
      deletes.push({ docId: entry.docId, id: s.id });
      return true;
    }
    return false;
  }
  if (older && historyOlderExpired(older, now)) {
    while (dropOldest(older, false)) { /* condition does the work */ }
  }
  list.forEach(function (e) {
    while (e.snaps.length > perDoc && dropOldest(e, true)) { /* condition does the work */ }
  });
  if (older) {
    while (total > cap && dropOldest(older, false)) { /* condition does the work */ }
  }
  list.sort(function (a, b) {
    return (a.lastOpenedAt - b.lastOpenedAt) || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0);
  });
  for (var i = 0; i < list.length && total > cap; i++) {
    while (total > cap && dropOldest(list[i], true)) { /* condition does the work */ }
  }
  return { deletes: deletes, totalBefore: totalBefore, totalAfter: total, overCap: total > cap };
}

module.exports = {
  HISTORY_OLDER_KEY,
  HISTORY_OLDER_TTL_MS,
  HISTORY_PER_DOC,
  HISTORY_SNAP_ID_RE,
  historyClip,
  historyOlderExpired,
  historyStampAfter,
  historyUtf8Length,
  planHistoryEviction,
  sanitizeHistoryMeta
};
