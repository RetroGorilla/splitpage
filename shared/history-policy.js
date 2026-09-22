"use strict";
/* ---------------------------------------------------------------------
 * shared/history-policy.js: what version history keeps and what it throws
 * away — the one copy of it (issue #76).
 *
 * Version history is stored in three different places (IndexedDB in a
 * browser, <userData>/history on the desktop, and an in-memory fake for the
 * browser suites), but WHAT is kept must not depend on where it is kept: the
 * same document, opened in the browser and in the desktop app, has to expire,
 * trim and evict identically, and a meta has to mean the same thing on both
 * sides of the desktop bridge. Until #76 planHistoryEviction existed twice,
 * line for line, in src/js/03a-history-store.js and desktop/main.js, and was
 * kept honest only by a smoke test that compared the two over CDP. This file
 * is that comparison made unnecessary.
 *
 * WHY COMMONJS, when the repo root's package.json says "type": "module".
 * Three consumers, three module systems, and only one format all three can
 * load without a build step or an async import:
 *
 *   1. the browser bundle — src/js/*.js are ES modules that esbuild bundles
 *      into one IIFE inlined in index.html (build.mjs). esbuild reads this
 *      file's CommonJS and hands the app its named exports; nothing about
 *      the single self-contained page changes.
 *   2. desktop/main.js — CommonJS in Electron's main process, which requires
 *      this synchronously at startup, before `app` is ready. An ESM module
 *      could only be reached there through an await.
 *   3. node --test — src/test/*.test.mjs import it directly (node reads the
 *      named exports off `module.exports` below), the same way
 *      desktop/test/drafts.test.mjs reaches desktop/drafts.js.
 *
 * The package.json beside this file is what makes that true: `.js` here would
 * otherwise be ESM, because node resolves the NEAREST package.json and the
 * repo root's says "type": "module". It is the same trick, for the same
 * reason, as server/package.json.
 *
 * PURE, and that is load-bearing (#92). Nothing here touches the DOM,
 * Electron, the filesystem, a clock or a global: every function takes what it
 * needs as an argument. There is no __init() and nothing to call before
 * these work — a module that silently depended on one would work in the
 * browser, where _entry.js always runs first, and throw everywhere else.
 * --------------------------------------------------------------------- */

/* A document keeps its 50 newest snapshots. */
var HISTORY_PER_DOC = 50;
/* The bucket key for the one-time migration of the old shared list ("Older
   history (before per-document history)"). It is never accepted as a docId —
   a hostile file claiming docId "_older" fails DOC_ID_RE — so the bucket is
   reachable only through {older:true} on the browser side and through
   historyIsBucket() on the desktop one. */
var HISTORY_OLDER_KEY = "_older";
var HISTORY_SNAP_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
/* Orchestrator override §2 (Adam confirms): the Older bucket expires as a
   WHOLE, 90 days after the migration that created it. Counting from each
   legacy entry's own date would empty it on day one — they are old already. */
var HISTORY_OLDER_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function historyClip(v, n) {
  return String(v == null ? "" : v).slice(0, n);
}

/* SnapshotMeta (HISTORY-STORAGE), rebuilt from plain values with every
   length clamped. Returns null when the id is unusable, which is what makes
   an invalid meta a rejected put on either backend. Deliberately carries no
   document id: in the desktop store the folder is the document, and in the
   browser one the bucket is. sizeBytes is set by the backend from the body
   it actually stores. */
function sanitizeHistoryMeta(m) {
  if (!m || typeof m !== "object") return null;
  var id = typeof m.id === "string" ? m.id : "";
  if (!HISTORY_SNAP_ID_RE.test(id)) return null;
  var atMs = Number(m.atMs);
  /* Date.parse of a string that is not a date is NaN, and NaN || 0 is 0 —
     so atMs is always a finite number by the time it is stamped below. */
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

/* WHY a put re-stamps atMs (orchestrator override §2b). Trims and the
   eviction planner call the largest atMs a document's NEWEST snapshot.
   captureSnapshot keeps atMs increasing only within one page, so after the
   system clock is corrected backwards (a dual-boot machine starting hours
   ahead, then NTP) every new capture would otherwise sort below snapshots
   stamped in the "future": each save's trim would delete the previous real
   snapshot and keep the stale ones, and eviction would guard a stale one as
   the newest. So a put stamps strictly after the newest snapshot already
   stored in its bucket; `at` keeps the wall-clock text the user saw. copy and
   import-older keep their source atMs — they are not new work. */
function historyStampAfter(m, newestAtMs) {
  var n = Number(newestAtMs);
  if (newestAtMs != null && Number.isFinite(n) && !(m.atMs > n)) m.atMs = n + 1;
  return m;
}

/* ---- eviction planner ----

   PURE: it is handed the whole shape of the store and answers what to
   delete, so it can be run against a fixture with no disk, no database and
   no process state at all (src/test/history-eviction.test.mjs does exactly
   that).

     docs      [{docId, lastOpenedAt (ms or ISO), expiresAt? (ms or ISO),
                 snapshots: [{id, atMs, sizeBytes}]}] — any order
     capBytes  total budget; not a finite number ≥ 0 → no budget
     nowMs     the clock (Older expiry)
     opts      {perDoc = 50, olderKey = '_older', protect = []}
               protect: [{docId, id}] that no step below ever deletes —
               the snapshot a restore is reading while its backup is
               written (protectHistorySnapshot)

   Order, applied until the total fits:
     1. the Older bucket once expired (always, cap or not) — as a whole,
        except a protected entry, which the next sweep takes
     2. every document trimmed to perDoc (always)
     3. Older, oldest first
     4. documents by lastOpenedAt ascending (ties by docId), each one's
        oldest snapshot first, while it still has more than one
     5. a document's newest snapshot is never deleted; if nothing more can
        go, overCap is reported
   → {deletes: [{docId, id}], totalBefore, totalAfter, overCap} */
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
  /* Deletes entry's oldest snapshot that is not protected — never its
     newest one when keepNewest. false when nothing there may go. */
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
  if (older && older.expiresAt > 0 && now >= older.expiresAt) {
    while (dropOldest(older, false)) { /* the whole bucket */ }
  }
  list.forEach(function (e) {
    while (e.snaps.length > perDoc && dropOldest(e, true)) { /* newest perDoc stay */ }
  });
  if (older) {
    while (total > cap && dropOldest(older, false)) { /* Older before any document */ }
  }
  list.sort(function (a, b) {
    return (a.lastOpenedAt - b.lastOpenedAt) || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0);
  });
  for (var i = 0; i < list.length && total > cap; i++) {
    while (total > cap && dropOldest(list[i], true)) { /* its newest stays */ }
  }
  return { deletes: deletes, totalBefore: totalBefore, totalAfter: total, overCap: total > cap };
}

module.exports = {
  HISTORY_OLDER_KEY,
  HISTORY_OLDER_TTL_MS,
  HISTORY_PER_DOC,
  HISTORY_SNAP_ID_RE,
  historyClip,
  historyStampAfter,
  planHistoryEviction,
  sanitizeHistoryMeta
};
