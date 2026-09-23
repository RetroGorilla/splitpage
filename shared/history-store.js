"use strict";
/* ---------------------------------------------------------------------
 * shared/history-store.js: the ONE version-history store (issue #83).
 *
 * Until #83 there were three: the browser's IndexedDB and memory backends
 * in src/js/03a-history-store.js, the desktop's folder tree in
 * desktop/main.js §8b, and a fake of the desktop bridge in
 * src/js/20f-desktop.js. shared/history-policy.js (#76) had already made
 * WHAT is kept one decision; this file makes HOW it is kept one piece of
 * code — put-if-absent, the stamp, the trim to 50, cap eviction, the quota
 * retry, the Older bucket's creation and expiry, holds, copy, and which
 * bodies may be deleted — over a small storage interface that each place
 * implements for itself (a memory backend is at the bottom of this file).
 *
 * CommonJS and PURE for the same reasons as history-policy.js (read its
 * header): the browser bundle, desktop/main.js and node --test all load
 * this file, so there is no clock, no hash, no timer, no global here. The
 * clock, the hash and the backend are handed in.
 *
 *   createHistoryStore({backend, now, hashText, capBytes, maxBodyBytes,
 *                       holds})
 *     backend       the storage interface below
 *     now()         → ms. The only clock this store reads.
 *     hashText(s)   → sha string of s's UTF-8 (or a promise of one). Run
 *                     BEFORE a transaction opens, never inside one.
 *     capBytes      a number, or (lastKnownTotalBytes|null) → number |
 *                   promise. Also read before a transaction opens; the
 *                   argument is the index total the store last saw (null
 *                   before its first read), which is what the browser's
 *                   storage.estimate() arithmetic needs. Not a finite
 *                   number ≥ 0 → no cap.
 *     maxBodyBytes  a put larger than this answers 'too-large' (default:
 *                   none; the desktop passes 256 MiB)
 *     holds()       optional → [{docId, id}] held from outside the store
 *                   (main's per-tab register). Unioned into EVERY eviction
 *                   with the store's own hold()s and the call's `protect`.
 *
 * ---- THE BACKEND INTERFACE ----
 *
 *   backend.name, backend.persistent, backend.readOnly (read at every call,
 *     so a backend may flip readOnly once it has read a newer FORMAT)
 *   backend.exclusive(fn, {write}) → promise of fn(tx)'s result, resolved
 *     only once the transaction's writes are durable/committed. Jobs never
 *     interleave. {write:false} is a hint that fn will not write.
 *   tx.list()            → {bucket: DocRecord}. The store NEVER mutates it
 *                          (a backend may hand out its cache).
 *   tx.get(sha)          → string | null (null = no such body)
 *   tx.put(sha, text)    idempotent; throws err.code 'quota' | 'enospc' |
 *                          'io' (or 'read-only')
 *   tx.commit(changes, droppedShas)
 *                        ONE atomic index write: changes = {bucket:
 *                        DocRecord | null}; droppedShas are bodies no index
 *                        entry names any more — the backend deletes them
 *                        once the new index is durable. At most once per tx.
 *
 *   DocRecord = {title, lastOpenedAt, migratedAt?, expiresAt?,
 *                snapshots: [SnapshotMeta + {sha}] oldest first}
 *
 *   THE RULE EVERY BACKEND AND EVERY LINE BELOW RELIES ON: inside
 *   exclusive(fn), fn awaits ONLY tx.* calls. That is IndexedDB's
 *   auto-commit rule — a transaction commits as soon as a task ends with no
 *   request pending, so awaiting a timer, a fetch, storage.estimate() or an
 *   async hash in the middle would commit half a job and fail the rest.
 *   That is why hashing and the cap are computed before exclusive() and
 *   passed in. The memory backend's strict mode enforces the rule in tests.
 *
 * ---- WHAT IT PROMISES ----
 *
 *   * Body before index (#52's ordering): a put writes its body (tx.put)
 *     before the commit that names it, and a body is dropped only in the
 *     commit that stops naming it. A crash between the two leaves an
 *     unnamed body (harmless), never a name with no body.
 *   * Bodies are content-addressed and SHARED: one body per sha, however
 *     many entries (in however many buckets) name it. Every capture still
 *     gets its own entry. A body is deletable only when no entry in any
 *     bucket names it — computed from the index, never counted.
 *   * copy() is index-only: it adds entries naming the same shas.
 *   * Totals are computed from the index (the sum of each entry's
 *     sizeBytes, the same sum the planner uses), never stored.
 *   * Writes (put, copy, touch, importOlder, evict) never reject; they
 *     answer a code. Reads (list, get, usage, listDocs) reject when the
 *     backend does, so a caller can tell "empty" from "could not read".
 *
 * The result shapes are the ones src/js/03a-history-store.js's backends
 * return, so its callers (03-sync.js, 20h-appdata.js, 02b-doc-id.js, the
 * history panel) do not change:
 *   put        {stored:true, evicted, overCap, duplicate?}
 *              | {stored:false, code, evicted?, overCap?}
 *   get        {meta, stateJson} | null
 *   list       {entries, older, olderExpiresAt}   (metas newest first,
 *                                                  each with its docId)
 *   copy       {ok, copied, code?}
 *   touch      undefined
 *   importOlder {ok, count, added, code?}
 *   usage      {totalBytes, capBytes, overCap, docCount, readOnly}
 *   listDocs   [{docId, title, lastOpenedAt}]      (Older excluded)
 *   evict      {evicted, overCap, totalBefore, totalAfter}
 * --------------------------------------------------------------------- */

var policy = require("./history-policy.js");
var DOC_ID_RE = require("./doc-id-policy.js").DOC_ID_RE;

var HISTORY_OLDER_KEY = policy.HISTORY_OLDER_KEY;
var HISTORY_OLDER_TTL_MS = policy.HISTORY_OLDER_TTL_MS;
var HISTORY_PER_DOC = policy.HISTORY_PER_DOC;
var HISTORY_SNAP_ID_RE = policy.HISTORY_SNAP_ID_RE;
var historyClip = policy.historyClip;
var historyOlderExpired = policy.historyOlderExpired;
var historyStampAfter = policy.historyStampAfter;
var historyUtf8Length = policy.historyUtf8Length;
var planHistoryEviction = policy.planHistoryEviction;
var sanitizeHistoryMeta = policy.sanitizeHistoryMeta;

function noop() {}

function isDocId(v) { return typeof v === "string" && DOC_ID_RE.test(v); }
function isBucket(v) { return v === HISTORY_OLDER_KEY || isDocId(v); }

function byAtAscending(a, b) {
  return (a.atMs - b.atMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function byAtDescending(a, b) {
  return (b.atMs - a.atMs) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/* A stored entry: the sanitized meta plus the sha of its body. */
function entryOf(meta, sha) {
  var m = sanitizeHistoryMeta(meta);
  if (!m) return null;
  m.sha = sha;
  return m;
}

/* A fresh record the store may change: scalars copied, a NEW snapshots
   array (the entries themselves are never mutated, only replaced). */
function cloneRecord(rec) {
  var out = {};
  Object.keys(rec).forEach(function (k) { if (k !== "snapshots") out[k] = rec[k]; });
  out.snapshots = Array.isArray(rec.snapshots) ? rec.snapshots.slice() : [];
  return out;
}

function snapshotsOf(rec) {
  return rec && Array.isArray(rec.snapshots) ? rec.snapshots : [];
}

function findEntry(rec, id) {
  var list = snapshotsOf(rec);
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
  return null;
}

function newestAtMs(rec) {
  var n = null;
  snapshotsOf(rec).forEach(function (s) {
    var v = Number(s && s.atMs);
    if (isFinite(v) && (n == null || v > n)) n = v;
  });
  return n;
}

function totalOf(index) {
  var total = 0;
  Object.keys(index || {}).forEach(function (b) {
    snapshotsOf(index[b]).forEach(function (s) { total += Number(s && s.sizeBytes) || 0; });
  });
  return total;
}

/* A meta as the callers see it: sanitized (so the sha never leaves the
   store) and carrying its bucket as docId, like 03a's backends did. */
function publicMeta(entry, bucket) {
  var m = sanitizeHistoryMeta(entry);
  if (m) m.docId = bucket;
  return m;
}

/* The backend's error → one of the codes a caller understands. 'quota'
   (a browser) and 'enospc' (a full disk) both mean "no room" and both take
   the quota retry below. */
function errorCode(e) {
  var c = e && e.code;
  if (c === "quota" || c === "enospc" || c === "io" || c === "read-only") return c;
  if (e && e.name === "QuotaExceededError") return "quota";
  if (c === "ENOSPC" || c === "EDQUOT") return "enospc";
  return "io";
}
function isNoRoom(code) { return code === "quota" || code === "enospc"; }

/* [{docId, id}] from anywhere → the valid ones. docId is a BUCKET here
   (a document, or HISTORY_OLDER_KEY), as the planner keys it. */
function protectList(list, out, seen) {
  (Array.isArray(list) ? list : []).forEach(function (p) {
    if (!p || typeof p !== "object") return;
    if (!isBucket(p.docId) || typeof p.id !== "string" || !HISTORY_SNAP_ID_RE.test(p.id)) return;
    var key = p.docId + "\n" + p.id;
    if (seen[key]) return;
    seen[key] = true;
    out.push({ docId: p.docId, id: p.id });
  });
  return out;
}

/* Every sha an index names. `changes` overlays it when given. */
function namedShas(index, changes) {
  var named = Object.create(null);
  var buckets = Object.keys(index || {});
  Object.keys(changes || {}).forEach(function (b) { if (!(b in (index || {}))) buckets.push(b); });
  buckets.forEach(function (b) {
    var rec = changes && Object.prototype.hasOwnProperty.call(changes, b) ? changes[b] : index[b];
    snapshotsOf(rec).forEach(function (s) { if (s && typeof s.sha === "string") named[s.sha] = true; });
  });
  return named;
}

/* The planner run over `index` with `changes` already applied, and its
   deletes folded into those changes. → {changes, dropped, evicted,
   overCap, totalBefore, totalAfter}. dropped = every sha the old index (or
   this job's own puts) named that the new one does not: the unreferenced
   bodies, and nothing else. Pure; mutates only records in `changes`, which
   are the caller's own clones. */
function planChanges(index, changes, capBytes, nowMs, protect, putShas) {
  var out = {};
  Object.keys(changes).forEach(function (b) { out[b] = changes[b]; });
  var docs = [];
  var buckets = Object.keys(index);
  Object.keys(out).forEach(function (b) { if (!(b in index)) buckets.push(b); });
  buckets.forEach(function (b) {
    var rec = Object.prototype.hasOwnProperty.call(out, b) ? out[b] : index[b];
    if (!rec) return;
    docs.push({
      docId: b,
      lastOpenedAt: rec.lastOpenedAt || 0,
      expiresAt: rec.expiresAt || 0,
      snapshots: snapshotsOf(rec).map(function (s) { return { id: s.id, atMs: s.atMs, sizeBytes: s.sizeBytes }; })
    });
  });
  var plan = planHistoryEviction(docs, capBytes, nowMs, {
    perDoc: HISTORY_PER_DOC, olderKey: HISTORY_OLDER_KEY, protect: protect
  });
  var gone = Object.create(null);
  plan.deletes.forEach(function (d) {
    (gone[d.docId] || (gone[d.docId] = Object.create(null)))[d.id] = true;
  });
  Object.keys(gone).forEach(function (b) {
    var rec = Object.prototype.hasOwnProperty.call(out, b) ? out[b] : cloneRecord(index[b]);
    rec.snapshots = rec.snapshots.filter(function (s) { return !gone[b][s.id]; });
    out[b] = rec;
  });
  /* A bucket left with nothing goes as a whole — an expired Older bucket in
     particular, so a later migration starts a fresh 90 days. */
  Object.keys(out).forEach(function (b) {
    if (out[b] && !snapshotsOf(out[b]).length) out[b] = null;
  });
  var before = namedShas(index, null);
  (putShas || []).forEach(function (sha) { before[sha] = true; });
  var after = namedShas(index, out);
  var dropped = Object.keys(before).filter(function (sha) { return !after[sha]; });
  return {
    changes: out,
    dropped: dropped,
    evicted: plan.deletes.length,
    overCap: plan.overCap,
    totalBefore: plan.totalBefore,
    totalAfter: plan.totalAfter
  };
}

function hasChanges(changes) { return Object.keys(changes).length > 0; }

function createHistoryStore(opts) {
  opts = opts || {};
  var backend = opts.backend;
  if (!backend || typeof backend.exclusive !== "function") throw new TypeError("createHistoryStore: backend.exclusive is required");
  if (typeof opts.now !== "function") throw new TypeError("createHistoryStore: now() is required");
  if (typeof opts.hashText !== "function") throw new TypeError("createHistoryStore: hashText() is required");
  var now = opts.now;
  var hashText = opts.hashText;
  var capOption = opts.capBytes;
  var maxBodyBytes = Number(opts.maxBodyBytes) > 0 ? Number(opts.maxBodyBytes) : Infinity;
  var holdsProvider = typeof opts.holds === "function" ? opts.holds : null;

  /* WHY quotaStuck (the desktop rule, #83). An eviction is committed before
     the retry runs and cannot be undone. When the retry is refused too —
     the disk or the origin's quota is genuinely full, not merely over OUR
     cap — evicting again on the next capture would delete roughly one more
     snapshot per capture while storing nothing. So after one failed
     evict-and-retry, and ALSO when the eviction freed nothing (a retry then
     cannot gain anything: the browser store used to retry anyway), later
     no-room refusals answer at once until some write is stored again. Every
     put still makes its first attempt, so space freed elsewhere is picked
     up. */
  var quotaStuck = false;
  var lastTotal = null;
  var ownHolds = Object.create(null);   /* bucket + "\n" + id → count */

  function readOnly() { return !!backend.readOnly; }

  function run(write, fn) {
    return Promise.resolve().then(function () {
      return backend.exclusive(fn, { write: !!write });
    });
  }

  /* tx.list(), remembering the total for the next capBytes() call. */
  function listIndex(tx) {
    return tx.list().then(function (index) {
      index = index || {};
      lastTotal = totalOf(index);
      return index;
    });
  }

  /* tx.commit(), then remember the total the committed index adds up to. */
  function commitAndNote(tx, index, changes, dropped) {
    return tx.commit(changes, dropped).then(function () {
      var next = {};
      Object.keys(index).forEach(function (b) { next[b] = index[b]; });
      Object.keys(changes).forEach(function (b) { next[b] = changes[b]; });
      lastTotal = totalOf(next);
    });
  }

  function readCap(total) {
    return Promise.resolve().then(function () {
      return typeof capOption === "function" ? capOption(total) : capOption;
    }).then(function (v) {
      return (typeof v === "number" && v >= 0) ? v : Infinity;
    }, function () { return Infinity; });
  }

  function allHolds(protect) {
    var out = [], seen = Object.create(null);
    protectList(protect, out, seen);
    Object.keys(ownHolds).forEach(function (k) {
      var i = k.indexOf("\n");
      protectList([{ docId: k.slice(0, i), id: k.slice(i + 1) }], out, seen);
    });
    if (holdsProvider) {
      var provided;
      try { provided = holdsProvider(); } catch (e) { provided = null; }
      protectList(provided, out, seen);
    }
    return out;
  }

  function hash(text) {
    return Promise.resolve().then(function () { return hashText(text); }).then(function (sha) {
      if (typeof sha !== "string" || !sha) throw new Error("history store: hashText gave no sha");
      return sha;
    });
  }

  /* ---- holds ----
     ({docId?, older?, id}) → release(). A restore holds the snapshot it is
     reading while its "Before restoring" backup is written; no eviction —
     the quota retry, the over-cap pass, the trim, the expired-Older sweep —
     deletes a held snapshot. Holds nest; a release runs at most once. */
  function hold(q) {
    q = q || {};
    var id = typeof q.id === "string" ? q.id : "";
    var bucket = q.older ? HISTORY_OLDER_KEY : (isDocId(q.docId) ? q.docId : "");
    if (!bucket || !HISTORY_SNAP_ID_RE.test(id)) return noop;
    var key = bucket + "\n" + id;
    ownHolds[key] = (ownHolds[key] || 0) + 1;
    var released = false;
    return function () {
      if (released) return;
      released = true;
      if (ownHolds[key] > 1) ownHolds[key]--; else delete ownHolds[key];
    };
  }

  /* ---- eviction ----
     capFor(total) is evaluated INSIDE the transaction, from the index it
     read, so it must be synchronous. */
  function evictWith(capFor, protect) {
    var held = allHolds(protect);
    if (readOnly()) {
      return run(false, function (tx) {
        return listIndex(tx).then(function (index) {
          var plan = planChanges(index, {}, capFor(totalOf(index)), now(), held, []);
          return { evicted: 0, overCap: plan.overCap, totalBefore: plan.totalBefore, totalAfter: plan.totalBefore };
        });
      });
    }
    return run(true, function (tx) {
      return listIndex(tx).then(function (index) {
        var plan = planChanges(index, {}, capFor(totalOf(index)), now(), held, []);
        var result = { evicted: plan.evicted, overCap: plan.overCap, totalBefore: plan.totalBefore, totalAfter: plan.totalAfter };
        if (!hasChanges(plan.changes)) return result;
        return commitAndNote(tx, index, plan.changes, plan.dropped).then(function () { return result; });
      });
    });
  }

  /* evict(cap?, {protect}) — cap omitted or null reads capBytes(). */
  function evict(cap, o) {
    var protect = o && o.protect;
    var capP = cap == null ? readCap(lastTotal) : Promise.resolve(typeof cap === "number" && cap >= 0 ? cap : Infinity);
    return capP.then(function (c) {
      return evictWith(function () { return c; }, protect);
    }).then(null, function (e) {
      return { evicted: 0, overCap: false, totalBefore: 0, totalAfter: 0, code: errorCode(e) };
    });
  }

  /* ---- put ---- */

  function putOnce(bucket, clean, stateJson, sha, size, cap, held) {
    return run(true, function (tx) {
      return listIndex(tx).then(function (index) {
        var rec = index[bucket] || null;
        /* Idempotent: the same snapshot id twice is the retry of a write
           whose answer was lost, never a second snapshot. */
        if (findEntry(rec, clean.id)) return { duplicate: true };
        var m = historyStampAfter(entryOf(clean, sha), newestAtMs(rec));
        m.sizeBytes = size;
        return tx.put(sha, stateJson).then(function () {
          var t = now();
          var next = rec ? cloneRecord(rec) : { title: "", lastOpenedAt: t, snapshots: [] };
          next.snapshots.push(m);
          next.snapshots.sort(byAtAscending);
          if (m.title) next.title = m.title;
          next.lastOpenedAt = t;
          var changes = {};
          changes[bucket] = next;
          /* The trim to 50, the expired-Older sweep and the cap in the SAME
             commit as the new entry: the planner never deletes a
             document's newest snapshot, and the stamp above made this one
             the newest. */
          var plan = planChanges(index, changes, cap, t, held, [sha]);
          return commitAndNote(tx, index, plan.changes, plan.dropped).then(function () {
            return { duplicate: false, evicted: plan.evicted, overCap: plan.overCap };
          });
        });
      });
    });
  }

  /* put(docId, meta, stateJson, {protect, older})
     {older:true} writes into the Older bucket instead (docId must then be
     null or HISTORY_OLDER_KEY) with importOlder's rules: no stamp, the
     bucket's 90 days set only when it is created. Without it, the Older
     bucket cannot be named (invariant #38). */
  function put(docId, meta, stateJson, o) {
    o = o || {};
    var clean = sanitizeHistoryMeta(meta);
    if (o.older) {
      if ((docId != null && docId !== HISTORY_OLDER_KEY) || !clean || typeof stateJson !== "string") {
        return Promise.resolve({ stored: false, code: "invalid" });
      }
      if (readOnly()) return Promise.resolve({ stored: false, code: "read-only" });
      if (historyUtf8Length(stateJson) > maxBodyBytes) return Promise.resolve({ stored: false, code: "too-large" });
      return importOlder([{ meta: clean, stateJson: stateJson }]).then(function (r) {
        if (!r.ok) return { stored: false, code: r.code || "io" };
        var out = { stored: true, evicted: 0, overCap: false };
        if (!r.added) out.duplicate = true;
        return out;
      });
    }
    if (!isDocId(docId) || !clean || typeof stateJson !== "string") {
      return Promise.resolve({ stored: false, code: "invalid" });
    }
    if (readOnly()) return Promise.resolve({ stored: false, code: "read-only" });
    var size = historyUtf8Length(stateJson);
    if (size > maxBodyBytes) return Promise.resolve({ stored: false, code: "too-large" });
    var held = allHolds(o.protect);

    return Promise.all([hash(stateJson), readCap(lastTotal)]).then(function (pre) {
      var sha = pre[0], cap = pre[1];
      function attempt() { return putOnce(docId, clean, stateJson, sha, size, cap, held); }
      function stored(r, evictedBefore) {
        var out = { stored: true, evicted: evictedBefore, overCap: false };
        if (r.duplicate) { out.duplicate = true; return out; }
        quotaStuck = false;
        out.evicted += r.evicted;
        out.overCap = !!r.overCap;
        return out;
      }
      return attempt().then(function (r) { return stored(r, 0); }, function (e) {
        var code = errorCode(e);
        if (!isNoRoom(code)) return { stored: false, code: code === "read-only" ? code : "io" };
        if (quotaStuck) return { stored: false, code: code, evicted: 0, overCap: true };
        /* The retry's budget is the normal cap lowered by this snapshot's
           size: evicting under the normal cap alone frees nothing when the
           real disk or quota, not our cap, is what refused the write. */
        return evictWith(function (total) { return Math.min(cap, Math.max(0, total - size)); }, o.protect)
          .then(null, function () { return { evicted: 0 }; })
          .then(function (ev) {
            var evicted = ev.evicted || 0;
            if (!evicted) {
              /* Nothing could be freed, so a retry cannot gain anything. */
              quotaStuck = true;
              return { stored: false, code: code, evicted: 0, overCap: true };
            }
            return attempt().then(function (r) { return stored(r, evicted); }, function (e2) {
              var code2 = errorCode(e2);
              if (isNoRoom(code2)) quotaStuck = true;
              return { stored: false, code: isNoRoom(code2) ? code2 : "io", evicted: evicted, overCap: true };
            });
          });
      });
    }).then(null, function (e) {
      return { stored: false, code: errorCode(e) };
    });
  }

  /* ---- reads ---- */

  /* A missing body (a desktop file someone deleted) answers null and drops
     every entry that names it — self-healing, no fsck. Re-checked inside
     its own write job, because a put of the same content may have restored
     the body since. */
  function healMissing(sha) {
    if (readOnly()) return Promise.resolve();
    return run(true, function (tx) {
      return listIndex(tx).then(function (index) {
        if (!namedShas(index, null)[sha]) return null;
        return tx.get(sha).then(function (text) {
          if (typeof text === "string") return null;
          var changes = {};
          Object.keys(index).forEach(function (b) {
            var list = snapshotsOf(index[b]);
            if (!list.some(function (s) { return s && s.sha === sha; })) return;
            var next = cloneRecord(index[b]);
            next.snapshots = next.snapshots.filter(function (s) { return !s || s.sha !== sha; });
            changes[b] = next.snapshots.length ? next : null;
          });
          return commitAndNote(tx, index, changes, []);
        });
      });
    }).then(noop, noop);
  }

  /* get(bucket, id) → {meta, stateJson} | null. bucket is a docId or
     HISTORY_OLDER_KEY (the caller resolved {older:true}). An expired Older
     bucket answers null: a restore must not reach a snapshot the panel has
     already stopped showing. */
  function get(bucket, id) {
    if (!isBucket(bucket) || typeof id !== "string" || !HISTORY_SNAP_ID_RE.test(id)) return Promise.resolve(null);
    return run(false, function (tx) {
      return listIndex(tx).then(function (index) {
        var rec = index[bucket];
        var e = findEntry(rec, id);
        if (!e) return null;
        if (bucket === HISTORY_OLDER_KEY && historyOlderExpired(rec, now())) return null;
        return tx.get(e.sha).then(function (text) {
          if (typeof text !== "string") return { missing: e.sha };
          return { meta: publicMeta(e, bucket), stateJson: text };
        });
      });
    }).then(function (r) {
      if (r && r.missing) {
        healMissing(r.missing);
        return null;
      }
      return r;
    });
  }

  /* list(docId|null) → {entries, older, olderExpiresAt}. An expired Older
     bucket is reported empty and its delete queued behind this read (a read
     does not write in its own transaction). */
  function list(docId) {
    var id = isDocId(docId) ? docId : null;
    return run(false, function (tx) { return listIndex(tx); }).then(function (index) {
      var entries = id ? snapshotsOf(index[id]).map(function (s) { return publicMeta(s, id); }).filter(Boolean) : [];
      var olderRec = index[HISTORY_OLDER_KEY] || null;
      var older = [], olderExpiresAt = null;
      if (olderRec && historyOlderExpired(olderRec, now())) {
        if (!readOnly()) evictWith(function () { return Infinity; }, null).then(noop, noop);
      } else if (olderRec) {
        older = snapshotsOf(olderRec).map(function (s) { return publicMeta(s, HISTORY_OLDER_KEY); }).filter(Boolean);
        var exp = Number(olderRec.expiresAt);
        olderExpiresAt = isFinite(exp) && exp > 0 ? exp : null;
      }
      return { entries: entries.sort(byAtDescending), older: older.sort(byAtDescending), olderExpiresAt: olderExpiresAt };
    });
  }

  function usage() {
    return run(false, function (tx) { return listIndex(tx); }).then(function (index) {
      var total = totalOf(index);
      var docCount = Object.keys(index).filter(function (b) { return b !== HISTORY_OLDER_KEY && index[b]; }).length;
      return readCap(total).then(function (cap) {
        return { totalBytes: total, capBytes: cap, overCap: total > cap, docCount: docCount, readOnly: readOnly() };
      });
    });
  }

  function listDocs() {
    return run(false, function (tx) { return listIndex(tx); }).then(function (index) {
      return Object.keys(index).filter(function (b) { return b !== HISTORY_OLDER_KEY && index[b]; }).sort().map(function (b) {
        return { docId: b, title: index[b].title || "", lastOpenedAt: Number(index[b].lastOpenedAt) || 0 };
      });
    });
  }

  /* The whole index as plain data — test hooks and export. */
  function rawIndex() {
    return run(false, function (tx) { return listIndex(tx); }).then(function (index) {
      return JSON.parse(JSON.stringify(index));
    });
  }

  /* ---- copy, touch ---- */

  /* copy(from, to, {protect}): idempotent union of from's entries into to,
     ids kept (a second copy is a no-op), atMs kept (not new work). INDEX-
     ONLY: the new entries name the same bodies. Sets to's lastOpenedAt, then
     the same planner pass a put runs. */
  function copy(from, to, o) {
    if (!isDocId(from) || !isDocId(to)) return Promise.resolve({ ok: false, copied: 0, code: "invalid" });
    if (from === to) return Promise.resolve({ ok: true, copied: 0 });
    if (readOnly()) return Promise.resolve({ ok: false, copied: 0, code: "read-only" });
    var held = allHolds(o && o.protect);
    return readCap(lastTotal).then(function (cap) {
      return run(true, function (tx) {
        return listIndex(tx).then(function (index) {
          var src = index[from] || null, dst = index[to] || null;
          /* Nothing to copy and nothing already there: a copy of an empty
             history must not conjure a record. */
          if (!snapshotsOf(src).length && !dst) return { ok: true, copied: 0 };
          var t = now();
          var next = dst ? cloneRecord(dst) : { title: "", lastOpenedAt: t, snapshots: [] };
          var have = Object.create(null);
          next.snapshots.forEach(function (s) { if (s) have[s.id] = true; });
          var copied = 0;
          snapshotsOf(src).forEach(function (s) {
            if (!s || have[s.id] || typeof s.sha !== "string") return;
            var m = entryOf(s, s.sha);
            if (!m) return;
            next.snapshots.push(m);
            have[m.id] = true;
            copied++;
          });
          next.snapshots.sort(byAtAscending);
          if (!next.title && src && src.title) next.title = src.title;
          next.lastOpenedAt = t;
          var changes = {};
          changes[to] = next;
          var plan = planChanges(index, changes, cap, t, held, []);
          return commitAndNote(tx, index, plan.changes, plan.dropped).then(function () { return { ok: true, copied: copied }; });
        });
      });
    }).then(null, function (e) {
      return { ok: false, copied: 0, code: errorCode(e) };
    });
  }

  /* Never creates a record: opening a document that has no history yet
     must not leave an empty one behind for every file ever opened. */
  function touch(docId, title) {
    if (!isDocId(docId) || readOnly()) return Promise.resolve();
    return run(true, function (tx) {
      return listIndex(tx).then(function (index) {
        var rec = index[docId];
        if (!rec) return null;
        var next = cloneRecord(rec);
        next.lastOpenedAt = now();
        var t = historyClip(title, 300);
        if (t) next.title = t;
        var changes = {};
        changes[docId] = next;
        return tx.commit(changes, []);
      });
    }).then(noop, noop);
  }

  /* ---- the Older bucket ----
     importOlder([{meta, stateJson}]) → {ok, count, added, code?}.
     Put-if-absent by id; atMs kept (these are old already); no eviction of
     its own (the next put's planner pass drains Older first when over the
     cap). migratedAt/expiresAt are set only when the bucket is CREATED, so
     re-running an interrupted migration never extends the 90 days. A bucket
     that has already expired is treated as gone — its unheld entries are
     dropped and a fresh 90 days starts — or the imported entries would be
     hidden the moment they landed and a migration could never confirm
     them. All or nothing: one commit. */
  function importOlder(entries) {
    if (!Array.isArray(entries)) return Promise.resolve({ ok: false, count: 0, added: 0, code: "invalid" });
    if (readOnly()) return Promise.resolve({ ok: false, count: 0, added: 0, code: "read-only" });
    var clean = [], seen = Object.create(null);
    entries.forEach(function (e) {
      var meta = e && typeof e === "object" ? sanitizeHistoryMeta(e.meta) : null;
      if (!meta || typeof e.stateJson !== "string" || seen[meta.id]) return;
      var size = historyUtf8Length(e.stateJson);
      if (size > maxBodyBytes) return;
      seen[meta.id] = true;
      meta.sizeBytes = size;
      clean.push({ meta: meta, stateJson: e.stateJson });
    });
    var held = allHolds(null);
    var heldKey = Object.create(null);
    held.forEach(function (p) { heldKey[p.docId + "\n" + p.id] = true; });
    return Promise.all(clean.map(function (e) { return hash(e.stateJson); })).then(function (shas) {
      return run(true, function (tx) {
        return listIndex(tx).then(function (index) {
          var t = now();
          var rec = index[HISTORY_OLDER_KEY] || null;
          var expired = !!rec && historyOlderExpired(rec, t);
          /* Nothing to add: no write at all (a dead bucket is the sweep's). */
          if (!clean.length) return { ok: true, count: rec && !expired ? snapshotsOf(rec).length : 0, added: 0 };
          var next = (rec && !expired) ? cloneRecord(rec) : {
            title: "", lastOpenedAt: 0, migratedAt: t, expiresAt: t + HISTORY_OLDER_TTL_MS,
            snapshots: snapshotsOf(rec).filter(function (s) { return s && heldKey[HISTORY_OLDER_KEY + "\n" + s.id]; })
          };
          var have = Object.create(null);
          next.snapshots.forEach(function (s) { if (s) have[s.id] = true; });
          var fresh = [];
          clean.forEach(function (e, i) {
            if (have[e.meta.id]) return;
            have[e.meta.id] = true;
            fresh.push({ entry: entryOf(e.meta, shas[i]), stateJson: e.stateJson });
          });
          if (!fresh.length && rec && !expired) return { ok: true, count: next.snapshots.length, added: 0 };
          /* Bodies first, one tx.put after another, then the one commit. */
          var chain = Promise.resolve();
          fresh.forEach(function (f) {
            chain = chain.then(function () { return tx.put(f.entry.sha, f.stateJson); });
          });
          return chain.then(function () {
            fresh.forEach(function (f) { next.snapshots.push(f.entry); });
            next.snapshots.sort(byAtAscending);
            var changes = {};
            changes[HISTORY_OLDER_KEY] = next.snapshots.length ? next : null;
            var before = namedShas(index, null);
            fresh.forEach(function (f) { before[f.entry.sha] = true; });
            var after = namedShas(index, changes);
            var dropped = Object.keys(before).filter(function (sha) { return !after[sha]; });
            return commitAndNote(tx, index, changes, dropped).then(function () {
              return { ok: true, count: next.snapshots.length, added: fresh.length };
            });
          });
        });
      });
    }).then(null, function (e) {
      return { ok: false, count: 0, added: 0, code: errorCode(e) };
    });
  }

  return {
    get backend() { return backend; },
    get name() { return backend.name; },
    get persistent() { return !!backend.persistent; },
    get readOnly() { return readOnly(); },
    put: put,
    get: get,
    list: list,
    copy: copy,
    touch: touch,
    importOlder: importOlder,
    usage: usage,
    listDocs: listDocs,
    evict: evict,
    hold: hold,
    rawIndex: rawIndex
  };
}

/* ---------------------------------------------------------------------
 * The memory backend: the browser's fallback when IndexedDB cannot open,
 * the node test backend, and (step 3b) the body of 20f's fake desktop
 * bridge. Everything lives in this object and dies with it.
 *
 *   createMemoryHistoryBackend({name, persistent, readOnly, strict,
 *                               macrotask})
 *
 * Transactions are all-or-nothing, like IndexedDB's: tx.put and tx.commit
 * are staged and applied together only when fn resolves; a job that throws
 * leaves nothing behind.
 *
 * STRICT MODE (tests): {strict: true, macrotask: (cb) => setTimeout(cb, 0)}
 * makes a transaction behave like an IndexedDB one about going INACTIVE.
 * Each tx op settles on a later macrotask, and once a macrotask passes with
 * no op pending the transaction is finished — so a stray non-tx await
 * inside exclusive() (a timer, an async hash, storage.estimate) makes the
 * next tx op throw a TransactionInactiveError instead of passing a test the
 * real browser would fail. Strict mode also refuses writes in a
 * {write:false} job, freezes what tx.list() hands out (a store that mutated
 * the backend's records would throw), and throws rather than drop a body the
 * committed index still names. The macrotask is injected because this file
 * may name no global.
 *
 * Test helpers on the returned object: failNext(op, code, times),
 * clearFaults(), bodyCount(), hasBody(sha), inspect(), seed(index,
 * bodies), dropBody(sha), counts.
 * --------------------------------------------------------------------- */

function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    Object.keys(v).forEach(function (k) { deepFreeze(v[k]); });
  }
  return v;
}

function plainCopy(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function codedError(code, message, name) {
  var e = new Error(message);
  e.code = code;
  if (name) e.name = name;
  return e;
}

function createMemoryHistoryBackend(o) {
  o = o || {};
  var strict = !!o.strict;
  var macrotask = o.macrotask;
  if (strict && typeof macrotask !== "function") {
    throw new TypeError("createMemoryHistoryBackend: strict mode needs a macrotask(cb) scheduler");
  }
  var index = Object.create(null);    /* bucket → frozen DocRecord */
  var bodies = Object.create(null);   /* sha → text */
  var chain = Promise.resolve();
  var faults = { put: [], commit: [] };
  var counts = { exclusive: 0, put: 0, commit: 0 };

  function takeFault(op) {
    var q = faults[op];
    if (!q.length) return null;
    var f = q[0];
    if (--f.times <= 0) q.shift();
    return f.code;
  }

  function isNamed(sha, idx) {
    return Object.keys(idx).some(function (b) {
      return snapshotsOf(idx[b]).some(function (s) { return s && s.sha === sha; });
    });
  }

  function runTx(fn, write) {
    var active = true, pending = 0, done = false;
    var stagedBodies = Object.create(null);
    var staged = null;

    function scheduleCheck() {
      macrotask(function () { if (!done && pending === 0) active = false; });
    }
    function op(body) {
      if (!active) throw codedError("inactive", "The history transaction has finished (a non-tx await inside exclusive()?)", "TransactionInactiveError");
      if (!strict) return Promise.resolve().then(body);
      pending++;
      return new Promise(function (resolve, reject) {
        macrotask(function () {
          pending--;
          try { resolve(body()); } catch (e) { reject(e); }
          scheduleCheck();
        });
      });
    }
    function mustWrite(what) {
      if (strict && !write) throw codedError("io", "history: " + what + " in a read-only job");
      if (backend.readOnly) throw codedError("read-only", "history: the store is read-only");
    }

    var tx = {
      list: function () {
        return op(function () {
          var out = {};
          Object.keys(index).forEach(function (b) { out[b] = index[b]; });
          return strict ? Object.freeze(out) : plainCopy(out);
        });
      },
      get: function (sha) {
        return op(function () {
          if (typeof sha !== "string") return null;
          if (sha in stagedBodies) return stagedBodies[sha];
          return sha in bodies ? bodies[sha] : null;
        });
      },
      put: function (sha, text) {
        return op(function () {
          mustWrite("put");
          counts.put++;
          var code = takeFault("put");
          if (code) throw codedError(code, "Injected " + code + " fault");
          if (typeof sha !== "string" || typeof text !== "string") throw codedError("io", "history: bad body");
          if (!(sha in bodies)) stagedBodies[sha] = text;
        });
      },
      commit: function (changes, dropped) {
        return op(function () {
          mustWrite("commit");
          if (staged) throw codedError("io", "history: commit called twice in one transaction");
          counts.commit++;
          var code = takeFault("commit");
          if (code) throw codedError(code, "Injected " + code + " fault");
          staged = { changes: plainCopy(changes || {}), dropped: Array.isArray(dropped) ? dropped.slice() : [] };
        });
      }
    };

    if (strict) scheduleCheck();
    return Promise.resolve().then(function () { return fn(tx); }).then(function (result) {
      done = true;
      active = false;
      /* All or nothing: the staged bodies, the new index and the dropped
         bodies land together. */
      var nextIndex = Object.create(null);
      Object.keys(index).forEach(function (b) { nextIndex[b] = index[b]; });
      if (staged) {
        Object.keys(staged.changes).forEach(function (b) {
          if (staged.changes[b]) nextIndex[b] = deepFreeze(staged.changes[b]);
          else delete nextIndex[b];
        });
      }
      var drop = staged ? staged.dropped.filter(function (sha) {
        if (!isNamed(sha, nextIndex)) return true;
        if (strict) throw codedError("io", "history: asked to drop body " + sha + " that the index still names");
        return false;
      }) : [];
      Object.keys(stagedBodies).forEach(function (sha) { bodies[sha] = stagedBodies[sha]; });
      index = nextIndex;
      drop.forEach(function (sha) { delete bodies[sha]; });
      return result;
    }, function (e) {
      done = true;
      active = false;
      throw e;
    });
  }

  var backend = {
    name: typeof o.name === "string" ? o.name : "memory",
    persistent: !!o.persistent,
    readOnly: !!o.readOnly,
    counts: counts,

    exclusive: function (fn, xo) {
      var write = !(xo && xo.write === false);
      counts.exclusive++;
      var job = chain.then(function () { return runTx(fn, write); });
      chain = job.then(noop, noop);
      return job;
    },

    /* op: 'put' | 'commit'; code: 'quota' | 'enospc' | 'io' | …;
       times: how many calls fail (Infinity for always). */
    failNext: function (op, code, times) {
      if (!faults[op]) throw new TypeError("failNext: unknown op " + op);
      faults[op].push({ code: code, times: times == null ? 1 : times });
    },
    clearFaults: function () { faults.put = []; faults.commit = []; },
    bodyCount: function () { return Object.keys(bodies).length; },
    hasBody: function (sha) { return sha in bodies; },
    /* a test's way to lose a body behind the store's back */
    dropBody: function (sha) { delete bodies[sha]; },
    inspect: function () {
      var b = {};
      Object.keys(bodies).forEach(function (sha) { b[sha] = bodies[sha]; });
      return { index: plainCopy(Object.assign({}, index)), bodies: b };
    },
    /* Replace everything (a fixture: a legacy record with expiresAt 0, a
       body gone missing, …). */
    seed: function (idx, bods) {
      index = Object.create(null);
      Object.keys(idx || {}).forEach(function (bucket) { index[bucket] = deepFreeze(plainCopy(idx[bucket])); });
      bodies = Object.create(null);
      Object.keys(bods || {}).forEach(function (sha) { bodies[sha] = bods[sha]; });
    }
  };
  return backend;
}

module.exports = {
  createHistoryStore,
  createMemoryHistoryBackend
};
