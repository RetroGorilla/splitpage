import type { BlobBackend } from "./blob-store.ts";
import type { ImageRef } from "../../core/document/ports.ts";
import {
  createBlobStore,
  createIdbBlobBackend,
  createMemoryBlobBackend
} from "./blob-store.ts";
import {
  forgivingBase64Decode,
  rowImage
} from "../../core/document/media.ts";
import { imageDims, isSha256Hex, normalizeImageRef, refsIn, sniffImageMime } from "../../../shared/blob-policy.ts";

const idbBlobs = createIdbBlobBackend(function () {
  return typeof window !== "undefined" && "indexedDB" in window && window.indexedDB ? window.indexedDB : null;
}, function () { return Date.now(); });

export const blobStore = createBlobStore({
  preferred: idbBlobs,
  fallback: createMemoryBlobBackend,
  objectUrl: function (bytes, mime) { return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })); },
  revokeObjectUrl: function (url) { URL.revokeObjectURL(url); },
  later: function (run) { setTimeout(run, 0); },
  warn: function (...args: unknown[]) {
    if (typeof window !== "undefined" && window.console) console.warn(...args);
  }
});

export function intern(bytes: unknown) { return blobStore.intern(bytes); }
export function internDataUrl(dataUrl: unknown) { return blobStore.internDataUrl(dataUrl); }

export const registryImages = {
  known: recordFor,
  fromDataUrl: function (dataUrl: unknown) {
    const rec = internDataUrl(dataUrl);
    if (rec) queuePersist([rec.sha256]);
    return rec;
  }
};

export function has(sha: unknown) { return blobStore.has(sha); }
export function recordFor(sha: unknown) { return blobStore.recordFor(sha); }
export function bytesForSync(sha: unknown) { return blobStore.bytesFor(sha); }
export function urlForSync(sha: unknown) { return blobStore.urlFor(sha); }
export function revokeObjectUrls() { blobStore.revokeUrls(); }
export function dataUrlForSync(sha: unknown) { return blobStore.dataUrlFor(sha); }
export function isDurableSync(sha: unknown) { return blobStore.isDurable(sha); }
export function queuePersist(shas: unknown) { blobStore.queuePersist(shas); }
export function persist(shas: unknown) { return blobStore.persist(shas); }
export function ensureBytes(shas: unknown) { return blobStore.ensureBytes(shas); }
export function setBackend(backend: BlobBackend | null | undefined) { blobStore.setBackend(backend); }
export function backendInfo() { return blobStore.backendInfo(); }
export const createMemoryBackend = createMemoryBlobBackend;

export function rowImageUrl(row: unknown) {
  const img = rowImage(row);
  if (!img) return null;
  return img.dataUrl || urlForSync((img.ref as NonNullable<typeof img.ref>).sha256);
}

export function rowImageDataUrl(row: unknown) {
  const img = rowImage(row);
  if (!img) return null;
  return img.dataUrl || dataUrlForSync((img.ref as NonNullable<typeof img.ref>).sha256);
}

export function rowImageBytes(row: unknown) {
  const img = rowImage(row);
  if (!img) return null;
  if (img.ref) {
    const held = bytesForSync((img.ref as NonNullable<typeof img.ref>).sha256);
    return held ? { bytes: held, mime: img.ref.mime, width: img.ref.width, height: img.ref.height } : null;
  }
  return dataUrlPicture(img.dataUrl);
}

export function dataUrlPicture(dataUrl: unknown) {
  const url = String(dataUrl || "").replace(/[\t\n\r]/g, "");
  const bytes = forgivingBase64Decode(url.slice(url.indexOf(",") + 1));
  if (!bytes) return null;
  const declared = /^data:(image\/[a-z0-9.+-]+)/i.exec(url);
  const dims = imageDims(bytes);
  return {
    bytes: bytes,
    mime: sniffImageMime(bytes) || (declared ? (declared[1] as string).toLowerCase() : "image/jpeg"),
    width: dims ? dims.width : 0,
    height: dims ? dims.height : 0
  };
}

export function blobImgHtml(ref: ImageRef, cls?: string) {
  const url = urlForSync(ref.sha256);
  return '<img' + (cls ? ' class="' + blobAttr(cls) + '"' : '') +
    ' data-blob="' + blobAttr(ref.sha256) + '" width="' + (ref.width | 0) + '" height="' + (ref.height | 0) + '" alt=""' +
    (url ? ' src="' + blobAttr(url) + '"' : '') + '>';
}

function blobAttr(s: unknown) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function inlineStateImages(s: unknown, only?: readonly string[] | null, urlOf?: ((sha: string) => string | null) | null) {
  const dataUrlOf = urlOf || dataUrlForSync;
  const missing: string[] = [];
  const want: Record<string, boolean> | null = only ? {} : null;
  if (only) only.forEach(function (sha) { (want as Record<string, boolean>)[sha] = true; });
  function pick(rec: unknown) {
    const ref = normalizeImageRef(rec) as ImageRef | null;
    if (!ref || (want && !want[ref.sha256])) return null;
    const url = dataUrlOf(ref.sha256);
    if (!url && missing.indexOf(ref.sha256) === -1) missing.push(ref.sha256);
    return url;
  }
  function inlineOriginal(a: unknown) {
    if (!a || typeof a !== "object" || !(a as Record<string, unknown>).imageRef) return;
    const u = pick((a as Record<string, unknown>).imageRef);
    if (u) { (a as Record<string, unknown>).visualImage = u; delete (a as { imageRef?: unknown }).imageRef; }
  }
  if (!s || typeof s !== "object") return missing;
  ((Array.isArray((s as Record<string, unknown>).rows) ? (s as Record<string, unknown>).rows : []) as unknown[]).forEach(function (r) {
    if (!r || typeof r !== "object") return;
    ((Array.isArray((r as Record<string, unknown>).moreImages) ? (r as Record<string, unknown>).moreImages : []) as unknown[]).forEach(function (it) {
      if (!it || typeof it !== "object" || !(it as Record<string, unknown>).imageRef) return;
      inlineOriginal((it as Record<string, unknown>).annotation);
      const u = pick((it as Record<string, unknown>).imageRef);
      if (u) { (it as Record<string, unknown>).visualImage = u; delete (it as { imageRef?: unknown }).imageRef; }
    });
    inlineOriginal((r as Record<string, unknown>).imageAnnotation);
    if (!(r as Record<string, unknown>).imageRef) {
      if (!only && "imageRef" in r) { delete (r as { imageRef?: unknown }).imageRef; (r as Record<string, unknown>).visualImage = null; }
      return;
    }
    const url = pick((r as Record<string, unknown>).imageRef);
    if (url) { (r as Record<string, unknown>).visualImage = url; delete (r as { imageRef?: unknown }).imageRef; }
  });
  function html(h: unknown) {
    if (typeof h !== "string" || h.indexOf("data-blob") === -1) return h;
    return h.replace(IMG_TAG_RE, function (tag) {
      const m = IMG_BLOB_ATTR_RE.exec(tag);
      const sha = m ? (m[1] || m[2] || m[3]) : null;
      if (!sha || (want && !want[sha])) return tag;
      const url = dataUrlOf(sha);
      if (!url) {
        if (missing.indexOf(sha) === -1) missing.push(sha);
        return tag;
      }
      return inlineImgTag(url);
    });
  }
  ((Array.isArray((s as Record<string, unknown>).rows) ? (s as Record<string, unknown>).rows : []) as unknown[]).forEach(function (r) {
    if (!r || typeof r !== "object") return;
    (r as Record<string, unknown>).visualText = html((r as Record<string, unknown>).visualText);
    (r as Record<string, unknown>).audioText = html((r as Record<string, unknown>).audioText);
  });
  ((Array.isArray((s as Record<string, unknown>).comments) ? (s as Record<string, unknown>).comments : []) as unknown[]).forEach(function (c) {
    if (!c || typeof c !== "object") return;
    const url = (c as Record<string, unknown>).imageValue ? pick((c as Record<string, unknown>).imageValue) : null;
    if (url) (c as Record<string, unknown>).body = inlineImgTag(url);
    else (c as Record<string, unknown>).body = html((c as Record<string, unknown>).body);
    ((Array.isArray((c as Record<string, unknown>).replies) ? (c as Record<string, unknown>).replies : []) as unknown[]).forEach(function (rep) {
      if (rep && typeof rep === "object") (rep as Record<string, unknown>).body = html((rep as Record<string, unknown>).body);
    });
  });
  return missing;
}

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const IMG_BLOB_ATTR_RE = /\sdata-blob\s*=\s*(?:"([0-9a-f]{64})"|'([0-9a-f]{64})'|([0-9a-f]{64})(?=[\s/>]))/i;

function inlineImgTag(url: string) {
  return '<img src="' + url + '" class="comment-img">';
}

export function inlineStateJson(json: string, only: readonly string[] | null | undefined) {
  if (typeof json !== "string" || !only || !only.length) return json;
  let s;
  try { s = JSON.parse(json); } catch (e) { return json; }
  const before = only.filter(has).length;
  if (!before) return json;
  inlineStateImages(s, only);
  return JSON.stringify(s);
}

export function missingInlineImages(s: unknown) {
  return (refsIn(s) as string[]).filter(function (sha) { return !has(sha); });
}

const BLOB_MISSING_TEXT = "Image unavailable";
const hydrateQueued: Record<string, boolean> = {};
let hydrateScheduled = false;
let hydrateObserver: MutationObserver | null = null;

function collectBlobImgs(node: Node | null, into: Element[]) {
  if (!node || node.nodeType !== 1) return;
  if ((node as Element).tagName === "IMG" && (node as Element).hasAttribute("data-blob")) into.push(node as Element);
  if ((node as Element).firstElementChild) {
    const found = (node as Element).querySelectorAll("img[data-blob]");
    for (let i = 0; i < found.length; i++) into.push(found[i] as Element);
  }
}

function needsHydrating(img: Element) {
  return img.isConnected && !img.getAttribute("src") && img.getAttribute("data-blob-state") !== "missing" &&
    isSha256Hex(img.getAttribute("data-blob"));
}

function fillBlobImgs(imgs: Element[]) {
  const waiting: (string | null)[] = [];
  imgs.forEach(function (img) {
    if (!needsHydrating(img)) return;
    const sha = img.getAttribute("data-blob");
    const url = urlForSync(sha);
    if (url) img.setAttribute("src", url);
    else if (waiting.indexOf(sha) === -1) waiting.push(sha);
  });
  return waiting;
}

export function hydrateBlobImages(root?: Element | null) {
  const imgs: Element[] = [];
  collectBlobImgs(root || document.documentElement, imgs);
  const waiting = fillBlobImgs(imgs);
  if (!waiting.length) return Promise.resolve([]);
  waiting.forEach(function (sha) { hydrateQueued[sha as string] = true; });
  return ensureBytes(waiting).then(function (missing) {
    waiting.forEach(function (sha) { Reflect.deleteProperty(hydrateQueued, sha as string); });
    const again: Element[] = [];
    collectBlobImgs(document.documentElement, again);
    fillBlobImgs(again);
    again.forEach(function (img) {
      if (!needsHydrating(img) || missing.indexOf(img.getAttribute("data-blob") as string) === -1) return;
      img.setAttribute("data-blob-state", "missing");
      img.setAttribute("alt", BLOB_MISSING_TEXT);
      img.setAttribute("title", BLOB_MISSING_TEXT);
    });
    return missing;
  });
}

function scheduleHydrate(imgs: Element[]) {
  const waiting = fillBlobImgs(imgs).filter(function (sha) { return !hydrateQueued[sha as string]; });
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
    const imgs: Element[] = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i] as MutationRecord;
      if (r.type === "attributes") collectBlobImgs(r.target, imgs);
      else for (let k = 0; k < r.addedNodes.length; k++) collectBlobImgs(r.addedNodes[k] as Node, imgs);
    }
    if (imgs.length) scheduleHydrate(imgs);
  });
  hydrateObserver.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["data-blob", "src"]
  });
  const initial: Element[] = [];
  collectBlobImgs(document.documentElement, initial);
  if (initial.length) scheduleHydrate(initial);
}

export function startBlobs() {
  startBlobHydrator();
}

export function blobsTestControls() {
  return {
    intern: function (bytes: ArrayLike<number> | ArrayBuffer | null | undefined) { return intern(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])); },
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
    idbRecord: function (sha: string) { return idbBlobs.record(sha); },
    forgetMemory: function () {
      blobStore.forgetMemory();
      return true;
    }
  };
}
