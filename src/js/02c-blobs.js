import {
  createBlobStore,
  createIdbBlobBackend,
  createMemoryBlobBackend
} from "../adapters/storage/blob-store.ts";
import {
  forgivingBase64Decode,
  rowImage,
  rowImageKey,
  rowImageShas
} from "../core/document/media.ts";
import { imageDims, isSha256Hex, normalizeImageRef, refsIn, sniffImageMime } from "../../shared/blob-policy.js";
export { rowImage, rowImageKey, rowImageShas };

var idbBlobs = createIdbBlobBackend(function () {
  return typeof window !== "undefined" && "indexedDB" in window && window.indexedDB ? window.indexedDB : null;
}, function () { return Date.now(); });

export var blobStore = createBlobStore({
  preferred: idbBlobs,
  fallback: createMemoryBlobBackend,
  objectUrl: function (bytes, mime) { return URL.createObjectURL(new Blob([bytes], { type: mime })); },
  revokeObjectUrl: function (url) { URL.revokeObjectURL(url); },
  later: function (run) { setTimeout(run, 0); },
  now: function () { return Date.now(); },
  warn: function () {
    if (typeof window !== "undefined" && window.console) console.warn.apply(console, arguments);
  }
});

export function intern(bytes) { return blobStore.intern(bytes); }
export function internDataUrl(dataUrl) { return blobStore.internDataUrl(dataUrl); }

export var registryImages = {
  known: recordFor,
  fromDataUrl: function (dataUrl) {
    var rec = internDataUrl(dataUrl);
    if (rec) queuePersist([rec.sha256]);
    return rec;
  }
};

export function has(sha) { return blobStore.has(sha); }
export function recordFor(sha) { return blobStore.recordFor(sha); }
export function bytesForSync(sha) { return blobStore.bytesFor(sha); }
export function urlForSync(sha) { return blobStore.urlFor(sha); }
export function revokeObjectUrls() { blobStore.revokeUrls(); }
export function dataUrlForSync(sha) { return blobStore.dataUrlFor(sha); }
export function isDurableSync(sha) { return blobStore.isDurable(sha); }
export function queuePersist(shas) { blobStore.queuePersist(shas); }
export function persist(shas) { return blobStore.persist(shas); }
export function ensureBytes(shas, opts) { return blobStore.ensureBytes(shas, opts); }
export function setBackend(backend) { blobStore.setBackend(backend); }
export function backendInfo() { return blobStore.backendInfo(); }
export function setRemoteSource(fn) { blobStore.setRemoteSource(fn); }
export function forgetRemoteMisses() { blobStore.forgetRemoteMisses(); }
export var createMemoryBackend = createMemoryBlobBackend;

export function rowImageUrl(row) {
  var img = rowImage(row);
  if (!img) return null;
  return img.dataUrl || urlForSync(img.ref.sha256);
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
  return dataUrlPicture(img.dataUrl);
}

export function dataUrlPicture(dataUrl) {
  var url = String(dataUrl || "").replace(/[\t\n\r]/g, "");
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

export function blobImgHtml(ref, cls) {
  var url = urlForSync(ref.sha256);
  return '<img' + (cls ? ' class="' + blobAttr(cls) + '"' : '') +
    ' data-blob="' + blobAttr(ref.sha256) + '" width="' + (ref.width | 0) + '" height="' + (ref.height | 0) + '" alt=""' +
    (url ? ' src="' + blobAttr(url) + '"' : '') + '>';
}

function blobAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function inlineStateImages(s, only, urlOf) {
  var dataUrlOf = urlOf || dataUrlForSync;
  var missing = [];
  var want = only ? {} : null;
  if (only) only.forEach(function (sha) { want[sha] = true; });
  function pick(rec) {
    var ref = normalizeImageRef(rec);
    if (!ref || (want && !want[ref.sha256])) return null;
    var url = dataUrlOf(ref.sha256);
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
      var url = dataUrlOf(sha);
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
      return blobStore.resolveBackend().then(function () { return backendInfo(); });
    },
    idbRecord: function (sha) { return idbBlobs.record(sha); },
    remoteMisses: function () { return blobStore.remoteMisses(); },
    forgetRemoteMisses: forgetRemoteMisses,
    ageRemoteMisses: function () {
      blobStore.ageRemoteMisses();
      return true;
    },
    forgetMemory: function () {
      blobStore.forgetMemory();
      return true;
    }
  };
}
