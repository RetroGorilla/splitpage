import { sha256Bytes } from "./02b-doc-id.js";
import { safeImageSrc } from "./04-richtext.js";
import { imageDims, isSha256Hex, sniffImageMime } from "../../shared/blob-policy.js";

/* ================= image blobs (issue #82) =================

   The page's registry of image bytes, addressed by their SHA-256. Rows are
   moving from `visualImage: "data:image/...;base64,..."` to
   `imageRef: {sha256, width, height, mime}` (shared/blob-policy.js has the
   record and its gate); this file is where the bytes behind a record live
   while the page is open, and the door to where they are kept durably.

   NOT WIRED IN YET (#82 P1). Nothing else in src/js calls this module, and
   importing it does nothing: no database is opened until the first
   ensureBytes() or persist(). The later steps connect it — migrateRows
   interning legacy data: URIs, the renderer asking for object URLs, the
   file writer re-inlining bytes, the history job persisting before it
   writes. The one connection so far is the hosted client (13-hosted.js,
   #82 P5), which installs its server fetch as the remote source
   (setRemoteSource) and reads bytes out to upload them.

   Two halves, and the split is the point:

     SYNCHRONOUS, in-memory: intern(), internDataUrl(), has(), recordFor(),
     bytesForSync(), urlForSync(), dataUrlForSync(). Render and migration
     are synchronous (invariant 39: capture never awaits), so everything
     they need from an image they already hold is answered here without a
     promise. Hashing is the hand-written SHA-256 in 02b-doc-id.js, not
     crypto.subtle — async, and absent on a plain-HTTP LAN page.

     ASYNCHRONOUS, the backend: ensureBytes() pulls bytes this page does not
     hold yet into memory; persist() writes bytes this page holds out to the
     backend and resolves only once the backend has them durably. Neither
     promise ever rejects — a failure is reported in what it resolves to.

   The rule persist() exists for (#82): no durable record — a history
   snapshot, a draft, a server document — may name a blob its store does
   not already hold durably. A writer awaits persist(refsIn(state)) BEFORE
   it writes the record, and treats a non-empty result as "not durable".

   ---- the backend interface ----

   A backend is a plain object. Every method returns a promise; a rejection
   is treated as "no" (get: not found, put: not stored, missing: all
   missing), never passed on.

     name        "idb" | "memory" | "desktop" | ... (diagnostics only)
     persistent  true when what it holds survives this page closing
     get(sha)            → {bytes: Uint8Array, mime} | null
     put(sha, bytes, mime) → resolves once the bytes are stored durably.
                           The registry only ever puts bytes it has hashed
                           itself, but a backend that crosses a trust
                           boundary (the desktop bridge, P3) re-verifies.
     missing(shas)       → the subset of shas it does NOT hold

   Chosen lazily, on the first async call: IndexedDB database
   'splitpage-blobs' if it opens, else memory for the rest of this page
   (flipping between the two mid-session would scatter blobs across two
   stores). IndexedDB is used wherever it opens, file:// included, for the
   same reason as version history (03a-history-store.js), which does the
   same: a history snapshot stored in IndexedDB must be able to find its
   images after a reload. setBackend() overrides the choice — the desktop
   bridge (P3) and the tests use it. */

var BLOB_DB_NAME = "splitpage-blobs";
var BLOB_DB_VERSION = 1;
var BLOB_STORE = "blobs";
/* A stored blob's usedAt is refreshed at most this often by a put() of
   bytes it already holds. Nothing reads usedAt yet (D4: no GC in #82); it
   is kept so a later collector has something better than addedAt. */
var BLOB_TOUCH_MS = 24 * 60 * 60 * 1000;

/* sha → {record: {sha256, width, height, mime}, bytes: Uint8Array,
   url: string | null}. A plain object is safe here: every key is checked
   against isSha256Hex first, so no key can reach Object.prototype. */
var blobEntries = {};
/* sha → true once the CURRENT backend is known to hold it (persist() put
   it there, or ensureBytes() read it from there). Reset by setBackend(). */
var blobDurable = {};
/* In-flight work, so concurrent callers share one read or one write. */
var blobPersisting = {};
var blobLoading = {};

/* The remote source, set once by the hosted client (13-hosted.js,
   setRemoteSource below) — the server a hosted document's blobs live on.
   A hook rather than an import: 02c sits below everything in the module
   order and must not reach up into the hosted client (#66). */
var blobRemote = null;
var blobFetching = {};

var blobBackend = null;         /* the backend in use, once chosen */
var blobBackendPromise = null;  /* the choice, while it is being made */
var blobBackendGen = 0;         /* bumped by setBackend(): late results of an
                                   old backend must not mark anything durable */
var blobIdbFailed = false;
var blobDb = null;
var blobDbPromise = null;

function blobNoop() {}

function freshRecord(rec) {
  return { sha256: rec.sha256, width: rec.width, height: rec.height, mime: rec.mime };
}

function uniqueStrings(list) {
  var out = [], seen = {};
  (Array.isArray(list) ? list : []).forEach(function (s) {
    if (typeof s !== "string" || Object.prototype.hasOwnProperty.call(seen, s)) return;
    seen[s] = true;
    out.push(s);
  });
  return out;
}

/* ---- base64, the way a browser reads it ----

   A data: URI is decoded by the WHATWG "forgiving-base64 decode", after the
   URL parser has already dropped every tab, LF and CR in it and trimmed
   leading and trailing C0 controls and spaces. safeImageSrc (04-richtext.js)
   admits any \s in the payload, which is broader than that; whatever the
   browser would refuse to decode must be refused here too, and whatever it
   decodes must decode to the same bytes — or the same picture, pasted twice
   with different line wrapping, would get two addresses. */
var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

var B64_LOOKUP = null; /* char code → 6-bit value, built on first use */

function forgivingBase64Decode(text) {
  var s = text.replace(/[\t\n\f\r ]/g, "");
  if (s.length % 4 === 0) s = s.replace(/={1,2}$/, "");
  if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) return null;
  if (!B64_LOOKUP) {
    B64_LOOKUP = new Uint8Array(128);
    for (var k = 0; k < 64; k++) B64_LOOKUP[B64_ALPHABET.charCodeAt(k)] = k;
  }
  var out = new Uint8Array(Math.floor(s.length * 3 / 4));
  var buf = 0, bits = 0, o = 0;
  for (var i = 0; i < s.length; i++) {
    buf = ((buf << 6) | B64_LOOKUP[s.charCodeAt(i)]) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}

function base64Encode(bytes) {
  var parts = [], chunk = "", i, n, a, b, c;
  for (i = 0; i + 2 < bytes.length; i += 3) {
    n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += B64_ALPHABET.charAt(n >> 18) + B64_ALPHABET.charAt((n >> 12) & 63) +
      B64_ALPHABET.charAt((n >> 6) & 63) + B64_ALPHABET.charAt(n & 63);
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ""; }
  }
  if (i < bytes.length) {
    a = bytes[i]; b = i + 1 < bytes.length ? bytes[i + 1] : 0; c = 0;
    n = (a << 16) | (b << 8) | c;
    chunk += B64_ALPHABET.charAt(n >> 18) + B64_ALPHABET.charAt((n >> 12) & 63) +
      (i + 1 < bytes.length ? B64_ALPHABET.charAt((n >> 6) & 63) : "=") + "=";
  }
  parts.push(chunk);
  return parts.join("");
}

/* ---- the synchronous half ---- */

/* Registers image bytes and returns their record, or null when the bytes
   are not a PNG, JPEG, GIF or WebP whose size can be read (never SVG).

   The type is SNIFFED, and there is deliberately no way to pass one in:
   what a data: URI or a file claims never overrides the bytes — a
   data:image/png holding a JPEG is recorded as image/jpeg, which is what
   the browser shows. The bytes are copied, so a caller reusing its buffer
   cannot change what a sha names. Interning the same bytes twice returns
   an equal record and stores nothing new. */
export function intern(bytes) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  if (!bytes || typeof bytes.length !== "number" || typeof bytes.byteLength !== "number") return null;
  var mime = sniffImageMime(bytes);
  var size = mime ? imageDims(bytes) : null;
  if (!mime || !size) return null;
  var sha = sha256Bytes(bytes);
  var have = blobEntries[sha];
  if (have) return freshRecord(have.record);
  var record = { sha256: sha, width: size.width, height: size.height, mime: mime };
  blobEntries[sha] = { record: record, bytes: new Uint8Array(bytes), url: null };
  return freshRecord(record);
}

/* intern() for a data: URI, admitting exactly what safeImageSrc admits and
   decoding it the way the browser does (above). null for anything else —
   including a URI safeImageSrc passes but the browser could not decode,
   which never showed a picture to begin with. */
export function internDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !safeImageSrc(dataUrl)) return null;
  /* The URL parser's two passes: trim C0 controls and spaces at both ends,
     then drop every tab and newline anywhere. */
  var url = dataUrl.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "").replace(/[\t\n\r]/g, ""); // eslint-disable-line no-control-regex
  var bytes = forgivingBase64Decode(url.slice(url.indexOf(",") + 1));
  return bytes ? intern(bytes) : null;
}

export function has(sha) {
  return isSha256Hex(sha) && !!blobEntries[sha];
}

/* The record for bytes this page holds, or null. A fresh object each call. */
export function recordFor(sha) {
  return has(sha) ? freshRecord(blobEntries[sha].record) : null;
}

/* The bytes themselves, not a copy — READ ONLY. A copy of a multi-megabyte
   image per call would be the wrong default for the writers that need them;
   the registry never hands the same array to anything that writes. */
export function bytesForSync(sha) {
  return has(sha) ? blobEntries[sha].bytes : null;
}

/* A blob: URL for an <img src>, created on first ask and reused after. The
   page's CSP already allows blob: images. null when the bytes are not here
   (ensureBytes first) or the page cannot make object URLs. */
export function urlForSync(sha) {
  if (!has(sha)) return null;
  var e = blobEntries[sha];
  if (!e.url) {
    try {
      e.url = URL.createObjectURL(new Blob([e.bytes], { type: e.record.mime }));
    } catch (x) {
      e.url = null;
    }
  }
  return e.url;
}

/* Revokes every object URL urlForSync handed out; the next urlForSync makes
   a new one. For a page that has replaced its whole document and a test
   that wants a clean slate — an <img> still showing a revoked URL keeps
   its decoded picture but cannot reload it. */
export function revokeObjectUrls() {
  Object.keys(blobEntries).forEach(function (sha) {
    var e = blobEntries[sha];
    if (e.url) {
      try { URL.revokeObjectURL(e.url); } catch (x) {}
      e.url = null;
    }
  });
}

/* The inline form, for the writers that must not depend on a blob store
   (#82 D1/D2: .splitpage and .md keep carrying their images). Canonical:
   the sniffed type and unwrapped base64, so internDataUrl() of the result
   is the same sha. */
export function dataUrlForSync(sha) {
  if (!has(sha)) return null;
  var e = blobEntries[sha];
  return "data:" + e.record.mime + ";base64," + base64Encode(e.bytes);
}

/* true when the current backend is PERSISTENT and is known to hold the
   blob — what a writer that cannot await (the crash stash) asks before it
   decides to carry the bytes inline instead. */
export function isDurableSync(sha) {
  return has(sha) && !!blobDurable[sha] && !!(blobBackend && blobBackend.persistent);
}

/* ---- the backend ---- */

export function setBackend(backend) {
  blobBackendGen++;
  blobBackend = backend || null;
  blobBackendPromise = null;
  blobDurable = {};
  blobPersisting = {};
  blobLoading = {};
}

export function backendInfo() {
  return blobBackend ? { name: String(blobBackend.name || ""), persistent: !!blobBackend.persistent } : null;
}

function resolveBlobBackend() {
  if (blobBackend) return Promise.resolve(blobBackend);
  if (blobBackendPromise) return blobBackendPromise;
  var gen = blobBackendGen;
  var p = (blobIdbFailed ? Promise.reject(new Error("idb-failed")) : openBlobDb()).then(function () {
    return idbBlobBackend;
  }, function (e) {
    if (!blobIdbFailed && window.console) console.warn("Image store: IndexedDB unavailable, keeping images in memory", e);
    blobIdbFailed = true;
    return createMemoryBackend();
  }).then(function (b) {
    /* setBackend() may have run while this was deciding; it wins. */
    if (gen === blobBackendGen && !blobBackend) blobBackend = b;
    blobBackendPromise = null;
    return blobBackend || b;
  });
  blobBackendPromise = p;
  return p;
}

/* Makes sure the bytes of every listed sha are in memory, reading them
   from the backend when they are not, and then — for what the backend did
   not have either — from the remote source, when one is set. Resolves with
   the shas still not held — the ones nobody had, whose bytes came back
   corrupt (they are re-hashed before they are believed, whichever store
   they came from), and anything that is not a sha at all. Never rejects.

   opts.remote === false stops at the backend: the hosted client asks that
   way for the bytes it is about to UPLOAD, because the server has just
   said it lacks them and asking it again would be a wasted round trip. */
export function ensureBytes(shas, opts) {
  var list = uniqueStrings(shas);
  var need = list.filter(function (sha) { return isSha256Hex(sha) && !blobEntries[sha]; });
  var report = function () { return list.filter(function (sha) { return !has(sha); }); };
  if (!need.length) return Promise.resolve(report());
  var remote = !(opts && opts.remote === false);
  return resolveBlobBackend().then(function (backend) {
    return Promise.all(need.map(function (sha) { return loadBlob(backend, sha); }));
  }).then(function () {
    if (!remote || !blobRemote) return null;
    return Promise.all(need.filter(function (sha) { return !blobEntries[sha]; }).map(fetchRemoteBlob));
  }).then(report, report);
}

/* ---- the remote source ----

   The one door from here to a server, installed by the hosted client:

     setRemoteSource(fn)   fn(sha) → Promise<Uint8Array | ArrayBuffer | null>
                           (or null for "not from here"); null uninstalls.

   It is asked only after the backend, and whatever it answers is re-hashed
   here before it is believed — a source may also intern the bytes itself
   (the hosted client does, to refuse a mismatch where it fetched them), in
   which case they are simply already held. Bytes from a remote are NOT
   marked durable: the backend does not hold them, and persist() is still
   what puts them there. */
export function setRemoteSource(fn) {
  blobRemote = typeof fn === "function" ? fn : null;
  blobFetching = {};
}

function fetchRemoteBlob(sha) {
  if (blobFetching[sha]) return blobFetching[sha];
  var source = blobRemote;
  var p = Promise.resolve().then(function () { return source ? source(sha) : null; }).then(function (bytes) {
    if (blobEntries[sha] || !bytes) return;
    var rec = intern(bytes);
    if (rec && rec.sha256 !== sha && window.console) {
      console.warn("Image store: the server's blob " + sha + " failed its hash check");
    }
  }).then(null, blobNoop).then(function () {
    if (blobFetching[sha] === p) delete blobFetching[sha];
  });
  blobFetching[sha] = p;
  return p;
}

function loadBlob(backend, sha) {
  if (blobLoading[sha]) return blobLoading[sha];
  var gen = blobBackendGen;
  var p = Promise.resolve().then(function () { return backend.get(sha); }).then(function (r) {
    if (!r || !r.bytes || blobEntries[sha]) return;
    var rec = intern(r.bytes);
    if (!rec) return;
    if (rec.sha256 !== sha) {
      /* Stored under the wrong name. intern() registered it under its real
         sha, which is harmless; this one stays missing. */
      if (window.console) console.warn("Image store: blob " + sha + " failed its hash check");
      return;
    }
    if (gen === blobBackendGen) blobDurable[sha] = true;
  }).then(null, blobNoop).then(function () {
    if (blobLoading[sha] === p) delete blobLoading[sha];
  });
  blobLoading[sha] = p;
  return p;
}

/* Writes every listed blob this page holds through to the backend, and
   resolves — only once the backend has them — with the shas that could NOT
   be made durable: the backend refused the write, or this page does not
   hold the bytes and the backend does not either. [] means every one is
   stored. A blob already stored, or being stored, is not written twice: a
   second persist() of the same sha waits on the first one's write. Never
   rejects.

   With the memory backend "stored" only means "stored in this page";
   backendInfo().persistent / isDurableSync() tell the two apart. */
export function persist(shas) {
  var list = uniqueStrings(shas);
  if (!list.length) return Promise.resolve([]);
  return resolveBlobBackend().then(function (backend) {
    return Promise.all(list.map(function (sha) { return persistBlob(backend, sha); }));
  }).then(function (ok) {
    return list.filter(function (sha, i) { return !ok[i]; });
  }, function () { return list.slice(); });
}

function persistBlob(backend, sha) {
  if (!isSha256Hex(sha)) return Promise.resolve(false);
  if (blobDurable[sha]) return Promise.resolve(true);
  if (blobPersisting[sha]) return blobPersisting[sha];
  var gen = blobBackendGen;
  var e = blobEntries[sha];
  var p = Promise.resolve().then(function () {
    if (e) return backend.put(sha, e.bytes, e.record.mime).then(function () { return true; });
    return backend.missing([sha]).then(function (m) { return Array.isArray(m) && m.indexOf(sha) === -1; });
  }).then(function (ok) {
    if (ok && gen === blobBackendGen) blobDurable[sha] = true;
    return !!ok;
  }, function (err) {
    if (window.console) console.warn("Image store: could not store blob " + sha, err);
    return false;
  }).then(function (ok) {
    if (blobPersisting[sha] === p) delete blobPersisting[sha];
    return ok;
  });
  blobPersisting[sha] = p;
  return p;
}

/* ---- memory backend ----

   The fallback when IndexedDB will not open, and the tests' backend. Holds
   the registry's own arrays (never written, so sharing them is safe) and
   does not survive the page: persistent is false. */
export function createMemoryBackend() {
  var held = {};
  return {
    name: "memory",
    persistent: false,
    get: function (sha) {
      var r = isSha256Hex(sha) ? held[sha] : null;
      return Promise.resolve(r ? { bytes: r.bytes, mime: r.mime } : null);
    },
    put: function (sha, bytes, mime) {
      if (!isSha256Hex(sha)) return Promise.reject(new Error("bad sha"));
      if (!held[sha]) held[sha] = { bytes: bytes, mime: mime };
      return Promise.resolve();
    },
    missing: function (shas) {
      return Promise.resolve(uniqueStrings(shas).filter(function (sha) {
        return !isSha256Hex(sha) || !held[sha];
      }));
    }
  };
}

/* ---- IndexedDB backend ----

   Database 'splitpage-blobs' v1, one object store 'blobs', out-of-line key
   = the sha, value {mime, size, bytes: Blob, addedAt, usedAt}. A database
   of its own rather than a store in 'splitpage-history': adding a store
   there means a version upgrade of a database every open tab holds a
   connection to, and blobs are shared by history, drafts and the open
   document alike. Opened the way openHistoryDb opens its database, for the
   same reasons (upgrade by oldVersion, close on versionchange, fail rather
   than hang when blocked). */
function openBlobDb() {
  if (blobDb) return Promise.resolve(blobDb);
  if (blobDbPromise) return blobDbPromise;
  var p = new Promise(function (resolve, reject) {
    var failed = false;
    function fail(e) { failed = true; reject(e); }
    if (!("indexedDB" in window) || !window.indexedDB) { fail(new Error("no-indexeddb")); return; }
    var req;
    try { req = indexedDB.open(BLOB_DB_NAME, BLOB_DB_VERSION); } catch (e) { fail(e); return; }
    req.onupgradeneeded = function (e) {
      var db = req.result;
      if ((e.oldVersion || 0) < 1) db.createObjectStore(BLOB_STORE);
    };
    req.onsuccess = function () {
      var db = req.result;
      if (failed) { try { db.close(); } catch (e) {} return; }
      function forget() {
        if (blobDb === db) { blobDb = null; blobDbPromise = null; }
      }
      db.onversionchange = function () { try { db.close(); } catch (e) {} forget(); };
      db.onclose = forget;
      blobDb = db;
      resolve(db);
    };
    req.onerror = function () { fail(req.error || new Error("idb-open")); };
    req.onblocked = function () { fail(new Error("idb-blocked")); };
  });
  blobDbPromise = p;
  p.then(null, function () { if (blobDbPromise === p) blobDbPromise = null; });
  return p;
}

/* One transaction; resolves with body's result once it COMMITS (a put is
   stored when the browser says so, not when its request came back). The
   body only chains IndexedDB requests, so the transaction stays active. */
function blobTx(mode, body) {
  return openBlobDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = mode === "readwrite"
        ? db.transaction([BLOB_STORE], "readwrite", { durability: "strict" })
        : db.transaction([BLOB_STORE], "readonly");
      var result;
      tx.oncomplete = function () { resolve(result); };
      tx.onabort = function () { reject(tx.error || new Error("transaction aborted")); };
      tx.onerror = function () { /* onabort follows and carries the reason */ };
      try {
        body(tx.objectStore(BLOB_STORE), function (r) { result = r; });
      } catch (e) {
        try { tx.abort(); } catch (x) {}
        reject(e);
      }
    });
  });
}

function blobToBytes(blob) {
  if (blob && typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () { resolve(new Uint8Array(fr.result)); };
    fr.onerror = function () { reject(fr.error); };
    fr.readAsArrayBuffer(blob);
  });
}

var idbBlobBackend = {
  name: "idb",
  persistent: true,
  get: function (sha) {
    if (!isSha256Hex(sha)) return Promise.resolve(null);
    return blobTx("readonly", function (store, done) {
      var req = store.get(sha);
      req.onsuccess = function () { done(req.result || null); };
    }).then(function (rec) {
      if (!rec || !(rec.bytes instanceof Blob)) return null;
      return blobToBytes(rec.bytes).then(function (bytes) { return { bytes: bytes, mime: rec.mime }; });
    });
  },
  put: function (sha, bytes, mime) {
    if (!isSha256Hex(sha)) return Promise.reject(new Error("bad sha"));
    return blobTx("readwrite", function (store) {
      var req = store.get(sha);
      req.onsuccess = function () {
        var now = Date.now();
        var rec = req.result;
        if (rec && rec.bytes instanceof Blob) {
          if (!(now - (rec.usedAt || 0) < BLOB_TOUCH_MS)) {
            rec.usedAt = now;
            store.put(rec, sha);
          }
          return;
        }
        store.put({ mime: mime, size: bytes.length, bytes: new Blob([bytes], { type: mime }), addedAt: now, usedAt: now }, sha);
      };
    });
  },
  missing: function (shas) {
    var list = uniqueStrings(shas);
    var valid = list.filter(isSha256Hex);
    if (!valid.length) return Promise.resolve(list);
    return blobTx("readonly", function (store, done) {
      var held = {}, left = valid.length;
      valid.forEach(function (sha) {
        var req = store.count(sha);
        req.onsuccess = function () {
          if (req.result > 0) held[sha] = true;
          if (--left === 0) done(held);
        };
      });
    }).then(function (held) {
      return list.filter(function (sha) { return !held[sha]; });
    });
  }
};

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* Test backdoor, the way window.__historyTest is 03a's. Opens nothing by
     itself: the backend is chosen on the first async call. */
  window.__blobsTest = {
    intern: function (bytes) { return intern(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])); },
    internDataUrl: internDataUrl,
    has: has,
    recordFor: recordFor,
    dataUrlForSync: dataUrlForSync,
    urlForSync: urlForSync,
    isDurableSync: isDurableSync,
    ensureBytes: ensureBytes,
    persist: persist,
    backendInfo: function () {
      return resolveBlobBackend().then(function () { return backendInfo(); });
    },
    /* the IndexedDB record of a sha, minus the bytes, or null */
    idbRecord: function (sha) {
      return blobTx("readonly", function (store, done) {
        var req = store.get(sha);
        req.onsuccess = function () { done(req.result || null); };
      }).then(function (rec) {
        return rec ? { mime: rec.mime, size: rec.size, isBlob: rec.bytes instanceof Blob, addedAt: rec.addedAt, usedAt: rec.usedAt } : null;
      });
    },
    /* forgets every blob held in memory (NOT the backend's), so a test can
       prove ensureBytes() really reads the backend */
    forgetMemory: function () {
      revokeObjectUrls();
      blobEntries = {};
      blobLoading = {};
      return true;
    }
  };
}
