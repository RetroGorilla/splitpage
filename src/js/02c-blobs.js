import { sha256Bytes } from "../core/document/ids.ts";
import { safeImageSrc } from "../core/document/text-policy.ts";
import { imageDims, isSha256Hex, normalizeImageRef, refsIn, sniffImageMime } from "../../shared/blob-policy.js";

var BLOB_DB_NAME = "splitpage-blobs";
var BLOB_DB_VERSION = 1;
var BLOB_STORE = "blobs";
var BLOB_TOUCH_MS = 24 * 60 * 60 * 1000;

var blobEntries = {};
var blobDurable = {};
var blobPersisting = {};
var blobLoading = {};

var blobRemote = null;
var blobFetching = {};
var blobRemoteMissAt = {};
var REMOTE_MISS_MS = 5 * 60 * 1000;

var blobBackend = null;
var blobBackendPromise = null;
var blobBackendGen = 0;
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

var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

var B64_LOOKUP = null;

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

export function internDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !safeImageSrc(dataUrl)) return null;
  var url = dataUrl.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "").replace(/[\t\n\r]/g, ""); // eslint-disable-line no-control-regex
  var bytes = forgivingBase64Decode(url.slice(url.indexOf(",") + 1));
  return bytes ? intern(bytes) : null;
}

export function has(sha) {
  return isSha256Hex(sha) && !!blobEntries[sha];
}

export function recordFor(sha) {
  return has(sha) ? freshRecord(blobEntries[sha].record) : null;
}

export function bytesForSync(sha) {
  return has(sha) ? blobEntries[sha].bytes : null;
}

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

export function revokeObjectUrls() {
  Object.keys(blobEntries).forEach(function (sha) {
    var e = blobEntries[sha];
    if (e.url) {
      try { URL.revokeObjectURL(e.url); } catch (x) {}
      e.url = null;
    }
  });
}

export function dataUrlForSync(sha) {
  if (!has(sha)) return null;
  var e = blobEntries[sha];
  return "data:" + e.record.mime + ";base64," + base64Encode(e.bytes);
}

export function isDurableSync(sha) {
  return has(sha) && !!blobDurable[sha] && !!(blobBackend && blobBackend.persistent);
}

function legacyImageSrc(row) {
  var v = row.visualImage;
  return typeof v === "string" && v.slice(0, 11) === "data:image/" ? v : null;
}

export function rowImage(row) {
  if (!row || typeof row !== "object") return null;
  var legacy = legacyImageSrc(row);
  if (legacy) return { ref: null, dataUrl: legacy };
  var ref = normalizeImageRef(row.imageRef);
  return ref ? { ref: ref, dataUrl: null } : null;
}

export function rowImageUrl(row) {
  var img = rowImage(row);
  if (!img) return null;
  return img.dataUrl || urlForSync(img.ref.sha256);
}

export function rowImageKey(row) {
  var img = rowImage(row);
  return img ? (img.ref ? img.ref.sha256 : img.dataUrl) : null;
}

export function rowImageDataUrl(row) {
  var img = rowImage(row);
  if (!img) return null;
  return img.dataUrl || dataUrlForSync(img.ref.sha256);
}

export function rowImageBytes(row) {
  var img = rowImage(row);
  if (!img) return null;
  if (img.ref) {
    var held = bytesForSync(img.ref.sha256);
    return held ? { bytes: held, mime: img.ref.mime, width: img.ref.width, height: img.ref.height } : null;
  }
  var url = img.dataUrl.replace(/[\t\n\r]/g, "");
  var bytes = forgivingBase64Decode(url.slice(url.indexOf(",") + 1));
  if (!bytes) return null;
  var declared = /^data:(image\/[a-z0-9.+-]+)/i.exec(url);
  var dims = imageDims(bytes);
  return {
    bytes: bytes,
    mime: sniffImageMime(bytes) || (declared ? declared[1].toLowerCase() : "image/jpeg"),
    width: dims ? dims.width : 0,
    height: dims ? dims.height : 0
  };
}

export function rowImageShas(rows) {
  var out = [], seen = {};
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    var img = rowImage(row);
    if (!img || !img.ref || seen[img.ref.sha256]) return;
    seen[img.ref.sha256] = true;
    out.push(img.ref.sha256);
  });
  return out;
}

export function blobImgHtml(ref, cls) {
  var url = urlForSync(ref.sha256);
  return '<img' + (cls ? ' class="' + blobAttr(cls) + '"' : '') +
    ' data-blob="' + blobAttr(ref.sha256) + '" width="' + (ref.width | 0) + '" height="' + (ref.height | 0) + '" alt=""' +
    (url ? ' src="' + blobAttr(url) + '"' : '') + '>';
}

function blobAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function inlineStateImages(s, only) {
  var missing = [];
  var want = only ? {} : null;
  if (only) only.forEach(function (sha) { want[sha] = true; });
  function pick(rec) {
    var ref = normalizeImageRef(rec);
    if (!ref || (want && !want[ref.sha256])) return null;
    var url = dataUrlForSync(ref.sha256);
    if (!url && missing.indexOf(ref.sha256) === -1) missing.push(ref.sha256);
    return url;
  }
  function inlineOriginal(a) {
    if (!a || typeof a !== "object" || !a.imageRef) return;
    var u = pick(a.imageRef);
    if (u) { a.visualImage = u; delete a.imageRef; }
  }
  if (!s || typeof s !== "object") return missing;
  (Array.isArray(s.rows) ? s.rows : []).forEach(function (r) {
    if (!r || typeof r !== "object") return;
    (Array.isArray(r.moreImages) ? r.moreImages : []).forEach(function (it) {
      if (!it || typeof it !== "object" || !it.imageRef) return;
      inlineOriginal(it.annotation);
      var u = pick(it.imageRef);
      if (u) { it.visualImage = u; delete it.imageRef; }
    });
    inlineOriginal(r.imageAnnotation);
    if (!r.imageRef) {
      if (!only && "imageRef" in r) { delete r.imageRef; r.visualImage = null; }
      return;
    }
    var url = pick(r.imageRef);
    if (url) { r.visualImage = url; delete r.imageRef; }
  });
  function html(h) {
    if (typeof h !== "string" || h.indexOf("data-blob") === -1) return h;
    return h.replace(IMG_TAG_RE, function (tag) {
      var m = IMG_BLOB_ATTR_RE.exec(tag);
      var sha = m ? (m[1] || m[2] || m[3]) : null;
      if (!sha || (want && !want[sha])) return tag;
      var url = dataUrlForSync(sha);
      if (!url) {
        if (missing.indexOf(sha) === -1) missing.push(sha);
        return tag;
      }
      return inlineImgTag(url);
    });
  }
  (Array.isArray(s.rows) ? s.rows : []).forEach(function (r) {
    if (!r || typeof r !== "object") return;
    r.visualText = html(r.visualText);
    r.audioText = html(r.audioText);
  });
  (Array.isArray(s.comments) ? s.comments : []).forEach(function (c) {
    if (!c || typeof c !== "object") return;
    var url = c.imageValue ? pick(c.imageValue) : null;
    if (url) c.body = inlineImgTag(url);
    else c.body = html(c.body);
    (Array.isArray(c.replies) ? c.replies : []).forEach(function (rep) {
      if (rep && typeof rep === "object") rep.body = html(rep.body);
    });
  });
  return missing;
}

var IMG_TAG_RE = /<img\b[^>]*>/gi;
var IMG_BLOB_ATTR_RE = /\sdata-blob\s*=\s*(?:"([0-9a-f]{64})"|'([0-9a-f]{64})'|([0-9a-f]{64})(?=[\s/>]))/i;

function inlineImgTag(url) {
  return '<img src="' + url + '" class="comment-img">';
}

export function inlineStateJson(json, only) {
  if (typeof json !== "string" || !only || !only.length) return json;
  var s;
  try { s = JSON.parse(json); } catch (e) { return json; }
  var before = only.filter(has).length;
  if (!before) return json;
  inlineStateImages(s, only);
  return JSON.stringify(s);
}

export function missingInlineImages(s) {
  return refsIn(s).filter(function (sha) { return !has(sha); });
}

var persistQueue = {};
var persistQueued = false;

export function queuePersist(shas) {
  (Array.isArray(shas) ? shas : []).forEach(function (sha) {
    if (isSha256Hex(sha) && !blobDurable[sha]) persistQueue[sha] = true;
  });
  if (persistQueued || !Object.keys(persistQueue).length) return;
  if (!blobBackend && !(typeof window !== "undefined" && window.indexedDB)) { persistQueue = {}; return; }
  persistQueued = true;
  setTimeout(function () {
    persistQueued = false;
    var list = Object.keys(persistQueue);
    persistQueue = {};
    if (list.length) persist(list);
  }, 0);
}

var BLOB_MISSING_TEXT = "Image unavailable";
var hydrateQueued = {};
var hydrateScheduled = false;
var hydrateObserver = null;

function collectBlobImgs(node, into) {
  if (!node || node.nodeType !== 1) return;
  if (node.tagName === "IMG" && node.hasAttribute("data-blob")) into.push(node);
  if (node.firstElementChild) {
    var found = node.querySelectorAll("img[data-blob]");
    for (var i = 0; i < found.length; i++) into.push(found[i]);
  }
}

function needsHydrating(img) {
  return img.isConnected && !img.getAttribute("src") && img.getAttribute("data-blob-state") !== "missing" &&
    isSha256Hex(img.getAttribute("data-blob"));
}

function fillBlobImgs(imgs) {
  var waiting = [];
  imgs.forEach(function (img) {
    if (!needsHydrating(img)) return;
    var sha = img.getAttribute("data-blob");
    var url = urlForSync(sha);
    if (url) img.setAttribute("src", url);
    else if (waiting.indexOf(sha) === -1) waiting.push(sha);
  });
  return waiting;
}

export function hydrateBlobImages(root) {
  var imgs = [];
  collectBlobImgs(root || document.documentElement, imgs);
  var waiting = fillBlobImgs(imgs);
  if (!waiting.length) return Promise.resolve([]);
  waiting.forEach(function (sha) { hydrateQueued[sha] = true; });
  return ensureBytes(waiting).then(function (missing) {
    waiting.forEach(function (sha) { delete hydrateQueued[sha]; });
    var again = [];
    collectBlobImgs(document.documentElement, again);
    fillBlobImgs(again);
    again.forEach(function (img) {
      if (!needsHydrating(img) || missing.indexOf(img.getAttribute("data-blob")) === -1) return;
      img.setAttribute("data-blob-state", "missing");
      img.setAttribute("alt", BLOB_MISSING_TEXT);
      img.setAttribute("title", BLOB_MISSING_TEXT);
    });
    return missing;
  });
}

function scheduleHydrate(imgs) {
  var waiting = fillBlobImgs(imgs).filter(function (sha) { return !hydrateQueued[sha]; });
  if (!waiting.length || hydrateScheduled) return;
  hydrateScheduled = true;
  Promise.resolve().then(function () {
    hydrateScheduled = false;
    hydrateBlobImages(document.documentElement);
  });
}

function startBlobHydrator() {
  if (hydrateObserver || typeof MutationObserver !== "function" || !document.documentElement) return;
  hydrateObserver = new MutationObserver(function (records) {
    var imgs = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === "attributes") collectBlobImgs(r.target, imgs);
      else for (var k = 0; k < r.addedNodes.length; k++) collectBlobImgs(r.addedNodes[k], imgs);
    }
    if (imgs.length) scheduleHydrate(imgs);
  });
  hydrateObserver.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["data-blob", "src"]
  });
  var initial = [];
  collectBlobImgs(document.documentElement, initial);
  if (initial.length) scheduleHydrate(initial);
}

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
    if (gen === blobBackendGen && !blobBackend) blobBackend = b;
    blobBackendPromise = null;
    return blobBackend || b;
  });
  blobBackendPromise = p;
  return p;
}

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

export function setRemoteSource(fn) {
  blobRemote = typeof fn === "function" ? fn : null;
  blobFetching = {};
  blobRemoteMissAt = {};
}

export function forgetRemoteMisses() {
  blobRemoteMissAt = {};
}

function remoteMissFresh(sha) {
  var at = blobRemoteMissAt[sha];
  if (!at) return false;
  if (Date.now() - at < REMOTE_MISS_MS) return true;
  delete blobRemoteMissAt[sha];
  return false;
}

function fetchRemoteBlob(sha) {
  if (blobFetching[sha]) return blobFetching[sha];
  if (remoteMissFresh(sha)) return Promise.resolve();
  var source = blobRemote;
  var p = Promise.resolve().then(function () { return source ? source(sha) : null; }).then(function (bytes) {
    if (blobEntries[sha]) return;
    if (!bytes) { if (source && source === blobRemote) blobRemoteMissAt[sha] = Date.now(); return; }
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

function blobTx(mode, body) {
  return openBlobDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = mode === "readwrite"
        ? db.transaction([BLOB_STORE], "readwrite", { durability: "strict" })
        : db.transaction([BLOB_STORE], "readonly");
      var result;
      tx.oncomplete = function () { resolve(result); };
      tx.onabort = function () { reject(tx.error || new Error("transaction aborted")); };
      tx.onerror = function () { };
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

export function __init() {
  startBlobHydrator();
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
    rowImage: rowImage,
    rowImageUrl: rowImageUrl,
    hydrate: hydrateBlobImages,
    backendInfo: function () {
      return resolveBlobBackend().then(function () { return backendInfo(); });
    },
    idbRecord: function (sha) {
      return blobTx("readonly", function (store, done) {
        var req = store.get(sha);
        req.onsuccess = function () { done(req.result || null); };
      }).then(function (rec) {
        return rec ? { mime: rec.mime, size: rec.size, isBlob: rec.bytes instanceof Blob, addedAt: rec.addedAt, usedAt: rec.usedAt } : null;
      });
    },
    remoteMisses: function () { return Object.keys(blobRemoteMissAt); },
    forgetRemoteMisses: forgetRemoteMisses,
    ageRemoteMisses: function () {
      Object.keys(blobRemoteMissAt).forEach(function (sha) { blobRemoteMissAt[sha] -= REMOTE_MISS_MS; });
      return true;
    },
    forgetMemory: function () {
      revokeObjectUrls();
      blobEntries = {};
      blobLoading = {};
      return true;
    }
  };
}
