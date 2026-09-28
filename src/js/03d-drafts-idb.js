/* ---------------------------------------------------------------------
 * 03d-drafts-idb.js: the browser's store for crash-safe drafts of SERVER
 * documents (PR #233, Collaborate's guests).
 *
 * The desktop app has kept a draft of every unsaved tab on disk since step
 * K (desktop/drafts.js, HANDOFF §3.13). A guest who co-edits through an
 * invite link has no desktop app: their unsaved edits lived only in the
 * open tab, and a closed tab, a browser crash or a flat phone battery took
 * them. So the browser build keeps the same draft here, in its own
 * IndexedDB, and 20g-drafts.js — the one writer and the one restore —
 * talks to this store instead of the desktop bridge when there is no
 * desktop (its "backend" choice). localStorage would not do: a script with
 * many scenes and pictures is past its few megabytes.
 *
 * It has no __init(): nothing here reads the DOM or storage at evaluation
 * time — the factory is handed its indexedDB, so node --test runs it over
 * fake-indexeddb (src/test/browser-drafts.test.mjs), as 03c does.
 *
 * ---- THE SCHEMA: database 'splitpage-drafts', version 1 ----
 *
 *   meta    keyPath 'key'   one DraftMeta per server document:
 *                           {key, base, docId, rev, title, writtenAt,
 *                            writerId, editSeq, schema, docIdWrittenOut,
 *                            bytes}
 *   bodies  keyPath 'key'   {key, stateJson, baseJson}
 *
 * ONE DRAFT PER DOCUMENT, keyed by the server's base address and the
 * server's document id (browserDraftKey) — so one guest with two scripts,
 * or the same id on two servers, never share one. The base is an origin
 * and a path only (draftBaseOf): no query, no fragment, no user name —
 * nothing a link key or a token could ride in on. Nothing
 * credential-shaped is in a draft at all (HANDOFF invariants #29, #62):
 * the writer hands this store the document, its ancestor and scalars.
 *
 * Bodies are apart from the metas so a scan (which drafts are there, which
 * are old, how big is it all) never reads a whole script.
 *
 * `writerId` is the page that wrote it (one random id per page load,
 * 20g-drafts.js). A page removes only its own draft (remove's `writerId`),
 * so a tab that saves never deletes the draft of another tab still editing
 * the same script, and a draft whose writer is still open is not offered
 * back as "recovered" (20g's Web Locks check).
 *
 * ---- BOUNDS ----
 *
 * planDraftEviction(): a draft older than 30 days is dropped; past 20
 * drafts, or past 64 MiB of bodies, the oldest go first — never the one
 * being written. Run inside every put's own transaction, so the store can
 * never grow past them by more than the draft being written.
 *
 * ---- FAILING QUIETLY ----
 *
 * No IndexedDB (a private window in some browsers, storage turned off, an
 * open that throws or is blocked) answers every call {ok:false, code:
 * 'UNAVAILABLE'} or null, never a throw: the writer then simply stops,
 * with nothing on screen — there is no draft to protect in a browser that
 * cannot keep one, and a warning about it on every edit would be noise.
 * A full quota answers 'QUOTA', which the writer does say (it can change).
 * --------------------------------------------------------------------- */

export var DRAFTS_IDB_NAME = "splitpage-drafts";
export var DRAFTS_IDB_VERSION = 1;

var META_STORE = "meta";
var BODY_STORE = "bodies";

export var DRAFT_LIMITS = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxCount: 20,
  maxBytes: 64 * 1024 * 1024
};

/* The one key a server document's draft is kept under. JSON of the pair,
   so no base and id can ever be spelled into another pair's key. */
export function browserDraftKey(base, docId) {
  return JSON.stringify([String(base || ""), String(docId || "")]);
}

/* Where a server document lives, as a draft key names it: the base the
   API is reached through (a connection's serverUrl, or "" for the server
   that served this page — then the page's own folder, since that is what
   apiUrl("api/…") resolves against), reduced to origin + path. "" when
   there is no such place (a file:// page on no server). */
export function draftBaseOf(serverUrl, pageHref) {
  try {
    var u = new URL(String(serverUrl || "") || ".", pageHref);
    u = new URL(".", u.href);
    if (!/^https?:$/.test(u.protocol) || !u.origin || u.origin === "null") return "";
    return u.origin + u.pathname;
  } catch (e) { return ""; }
}

/* Which drafts to drop, given every DraftMeta: the expired ones, then the
   oldest while there are too many or they are too big. `keepKey` (the one
   being written) is never dropped. → keys, oldest first. Pure. */
export function planDraftEviction(metas, now, limits, keepKey) {
  limits = limits || DRAFT_LIMITS;
  var list = (Array.isArray(metas) ? metas : []).filter(function (m) {
    return m && typeof m.key === "string";
  }).slice().sort(function (a, b) { return (Number(a.writtenAt) || 0) - (Number(b.writtenAt) || 0); });
  var drop = [];
  var kept = [];
  list.forEach(function (m) {
    var at = Number(m.writtenAt) || 0;
    if (m.key !== keepKey && now - at > limits.maxAgeMs) drop.push(m.key);
    else kept.push(m);
  });
  var bytes = kept.reduce(function (n, m) { return n + (Number(m.bytes) || 0); }, 0);
  var i = 0;
  while (i < kept.length && (kept.length > limits.maxCount || bytes > limits.maxBytes)) {
    /* oldest first; the one being written is stepped over, never dropped */
    if (kept[i].key === keepKey) { i++; continue; }
    drop.push(kept[i].key);
    bytes -= Number(kept[i].bytes) || 0;
    kept.splice(i, 1);
  }
  return drop;
}

function noop() {}

function isQuotaError(e) {
  return !!e && (e.name === "QuotaExceededError" || e.code === 22 || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

function codeOf(e) {
  if (e && typeof e.draftCode === "string") return e.draftCode;
  return isQuotaError(e) ? "QUOTA" : "EIO";
}

function idbReq(req) {
  return new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function metaOf(rec) {
  return {
    key: rec.key,
    base: String(rec.base || ""),
    docId: String(rec.docId || ""),
    rev: Number(rec.rev) || 0,
    title: typeof rec.title === "string" ? rec.title.slice(0, 500) : "",
    writtenAt: Number(rec.writtenAt) || 0,
    writerId: String(rec.writerId || ""),
    editSeq: Number(rec.editSeq) || 0,
    schema: rec.schema == null ? null : rec.schema,
    docIdWrittenOut: !!rec.docIdWrittenOut,
    bytes: Number(rec.bytes) || 0
  };
}

/* createIdbDraftStore({indexedDB, name, now, limits})
     indexedDB  the IDBFactory (default: window.indexedDB; null = none)
     name       database name (default 'splitpage-drafts')
     now        clock (default Date.now), for the tests
     limits     DRAFT_LIMITS by default

   Every method resolves, never rejects:
     put(rec, {keepBase})  → {ok:true, evicted} | {ok:false, code}
         rec: {key, base, docId, rev, title, writerId, editSeq, schema,
         docIdWrittenOut, stateJson, baseJson}. baseJson null means "the
         ancestor this writer already sent is still the one" (the desktop
         store's rule): kept from the stored draft when THIS writer wrote
         it, else 'NEED_BASE' and the writer sends it (20g's handshake).
         keepBase keeps whatever ancestor is stored, whoever wrote it (a
         recovered copy, which has none of its own).
     get(key)              → {…meta, stateJson, baseJson} | null (expired: null)
     list()                → [DraftMeta] (expired left out)
     remove(key, writerId) → true when it was removed; with a writerId,
                             only that writer's draft is
     claim(key, writerId)  → true; the draft is now that writer's
     available()           → true once the database opened */
export function createIdbDraftStore(o) {
  o = o || {};
  var factory = o.indexedDB !== undefined ? o.indexedDB
    : (typeof window !== "undefined" ? (function () { try { return window.indexedDB; } catch (e) { return null; } })() : null);
  var dbName = typeof o.name === "string" && o.name ? o.name : DRAFTS_IDB_NAME;
  var now = typeof o.now === "function" ? o.now : function () { return Date.now(); };
  var limits = o.limits || DRAFT_LIMITS;

  var db = null;
  var opening = null;
  var unavailable = false;
  var chain = Promise.resolve();

  function fail(code) { var e = new Error("drafts: " + code); e.draftCode = code; return e; }

  function openDb() {
    if (db) return Promise.resolve(db);
    if (unavailable) return Promise.reject(fail("UNAVAILABLE"));
    if (opening) return opening;
    opening = new Promise(function (resolve, reject) {
      var done = false;
      function no() {
        if (done) return;
        done = true;
        unavailable = true;
        reject(fail("UNAVAILABLE"));
      }
      if (!factory || typeof factory.open !== "function") { no(); return; }
      var req;
      try { req = factory.open(dbName, DRAFTS_IDB_VERSION); } catch (e) { no(); return; }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(META_STORE)) d.createObjectStore(META_STORE, { keyPath: "key" });
        if (!d.objectStoreNames.contains(BODY_STORE)) d.createObjectStore(BODY_STORE, { keyPath: "key" });
      };
      req.onsuccess = function () {
        var d = req.result;
        if (done) { try { d.close(); } catch (e) {} return; }
        done = true;
        d.onversionchange = function () { try { d.close(); } catch (e) {} if (db === d) db = null; };
        d.onclose = function () { if (db === d) db = null; };
        db = d;
        resolve(d);
      };
      req.onerror = function (ev) {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        no();
      };
      /* another tab holding an older version open: never hang every draft
         behind it (03c's rule) */
      req.onblocked = no;
    });
    var p = opening;
    p.then(function () { opening = null; }, function () { opening = null; });
    return p;
  }

  /* One job at a time, from this page. body(tx) may await only requests
     on tx (IndexedDB's auto-commit rule — see 03c's header). */
  function job(mode, body) {
    var run = chain.then(function () {
      return openDb().then(function (d) {
        var t;
        try {
          t = mode === "readwrite"
            ? d.transaction([META_STORE, BODY_STORE], "readwrite", { durability: "strict" })
            : d.transaction([META_STORE, BODY_STORE], "readonly");
        } catch (e) { if (db === d) db = null; throw e; }
        var done = new Promise(function (resolve, reject) {
          t.oncomplete = function () { resolve(); };
          /* t.error is null after our own abort(): the job's error is the reason then */
          t.onabort = function () { reject(t.error || null); };
          t.onerror = noop;
        });
        done.then(null, noop);
        var started;
        try { started = Promise.resolve(body(t)); } catch (e) { started = Promise.reject(e); }
        return started.then(function (result) {
          return done.then(function () { return result; });
        }, function (e) {
          try { t.abort(); } catch (x) { /* already over */ }
          return done.then(function () { throw e; }, function (txErr) {
            throw (txErr && txErr.name && txErr.name !== "AbortError") ? txErr : e;
          });
        });
      });
    });
    chain = run.then(noop, noop);
    return run;
  }

  function expired(meta) {
    return !meta || now() - (Number(meta.writtenAt) || 0) > limits.maxAgeMs;
  }

  return {
    available: function () {
      return openDb().then(function () { return true; }, function () { return false; });
    },

    put: function (rec, opts) {
      opts = opts || {};
      if (!rec || typeof rec.key !== "string" || typeof rec.stateJson !== "string") {
        return Promise.resolve({ ok: false, code: "EIO" });
      }
      return job("readwrite", function (t) {
        var metas = t.objectStore(META_STORE);
        var bodies = t.objectStore(BODY_STORE);
        return Promise.all([idbReq(metas.get(rec.key)), idbReq(bodies.get(rec.key))]).then(function (had) {
          var oldMeta = had[0];
          var oldBody = had[1];
          var baseJson = rec.baseJson;
          if (baseJson === null || baseJson === undefined) {
            var mayKeep = opts.keepBase || (oldMeta && oldMeta.writerId === rec.writerId);
            if (oldBody && mayKeep) baseJson = oldBody.baseJson === undefined ? null : oldBody.baseJson;
            else if (opts.keepBase) baseJson = null;
            else throw fail("NEED_BASE");
          }
          var meta = metaOf({
            key: rec.key, base: rec.base, docId: rec.docId, rev: rec.rev, title: rec.title,
            writtenAt: now(), writerId: rec.writerId, editSeq: rec.editSeq, schema: rec.schema,
            docIdWrittenOut: rec.docIdWrittenOut,
            bytes: rec.stateJson.length + (typeof baseJson === "string" ? baseJson.length : 0)
          });
          return Promise.all([
            idbReq(metas.put(meta)),
            idbReq(bodies.put({ key: rec.key, stateJson: rec.stateJson, baseJson: baseJson }))
          ]).then(function () {
            return idbReq(metas.getAll());
          }).then(function (all) {
            var drop = planDraftEviction(all, now(), limits, rec.key);
            return Promise.all(drop.map(function (k) {
              return Promise.all([idbReq(metas.delete(k)), idbReq(bodies.delete(k))]);
            })).then(function () { return { ok: true, evicted: drop.length }; });
          });
        });
      }).then(null, function (e) { return { ok: false, code: codeOf(e) }; });
    },

    get: function (key) {
      return job("readonly", function (t) {
        return Promise.all([
          idbReq(t.objectStore(META_STORE).get(String(key))),
          idbReq(t.objectStore(BODY_STORE).get(String(key)))
        ]).then(function (r) {
          var meta = r[0], body = r[1];
          if (!meta || !body || typeof body.stateJson !== "string" || expired(meta)) return null;
          var out = metaOf(meta);
          out.stateJson = body.stateJson;
          out.baseJson = typeof body.baseJson === "string" ? body.baseJson : null;
          return out;
        });
      }).then(null, function () { return null; });
    },

    list: function () {
      return job("readonly", function (t) {
        return idbReq(t.objectStore(META_STORE).getAll()).then(function (all) {
          return (all || []).filter(function (m) { return m && !expired(m); }).map(metaOf);
        });
      }).then(null, function () { return []; });
    },

    remove: function (key, writerId) {
      return job("readwrite", function (t) {
        var metas = t.objectStore(META_STORE);
        return idbReq(metas.get(String(key))).then(function (meta) {
          if (!meta) return false;
          if (writerId && meta.writerId !== writerId) return false;
          return Promise.all([
            idbReq(metas.delete(String(key))),
            idbReq(t.objectStore(BODY_STORE).delete(String(key)))
          ]).then(function () { return true; });
        });
      }).then(null, function () { return false; });
    },

    claim: function (key, writerId) {
      return job("readwrite", function (t) {
        var metas = t.objectStore(META_STORE);
        return idbReq(metas.get(String(key))).then(function (meta) {
          if (!meta) return false;
          meta.writerId = String(writerId || "");
          return idbReq(metas.put(meta)).then(function () { return true; });
        });
      }).then(null, function () { return false; });
    }
  };
}
