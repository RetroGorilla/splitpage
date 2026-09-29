"use strict";

// Raster only; never SVG (script-capable). No image/jpg.
var IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

var SHA256_RE = /^[0-9a-f]{64}$/;

// Sanity cap only; rejecting real images loses them on migration.
var IMAGE_DIM_MAX = 1 << 20;

function isSha256Hex(x) {
  return typeof x === "string" && SHA256_RE.test(x);
}

function dimOk(n) {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= IMAGE_DIM_MAX;
}

// Strict, never repairs; returns fresh object with four fields.
function normalizeImageRef(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  if (!isSha256Hex(x.sha256)) return null;
  if (!dimOk(x.width) || !dimOk(x.height)) return null;
  if (typeof x.mime !== "string" || IMAGE_MIMES.indexOf(x.mime) === -1) return null;
  return { sha256: x.sha256, width: x.width, height: x.height, mime: x.mime };
}

// Only inside <img>; escaped typed text cannot forge refs.
var DATA_BLOB_RE = /<img\b[^>]*?\sdata-blob\s*=\s*(?:"([0-9a-fA-F]{64})"|'([0-9a-fA-F]{64})'|([0-9a-fA-F]{64})(?=[\s/>]))/gi;

function refsInHtml(html, add) {
  if (typeof html !== "string" || !/data-blob/i.test(html)) return;
  DATA_BLOB_RE.lastIndex = 0;
  var m;
  while ((m = DATA_BLOB_RE.exec(html)) !== null) add(m[1] || m[2] || m[3]);
}

function refsIn(state) {
  var out = [];
  var seen = Object.create(null);
  function add(sha) {
    if (!isSha256Hex(sha) || seen[sha]) return;
    seen[sha] = true;
    out.push(sha);
  }
  function addRecord(rec) {
    if (rec && typeof rec === "object") add(rec.sha256);
  }
  if (!state || typeof state !== "object") return out;
  var rows = Array.isArray(state.rows) ? state.rows : [];
  rows.forEach(function (r) {
    if (!r || typeof r !== "object") return;
    addRecord(r.imageRef);
    if (r.imageAnnotation && typeof r.imageAnnotation === "object") addRecord(r.imageAnnotation.imageRef);
    (Array.isArray(r.moreImages) ? r.moreImages : []).forEach(function (it) {
      if (!it || typeof it !== "object") return;
      addRecord(it.imageRef);
      if (it.annotation && typeof it.annotation === "object") addRecord(it.annotation.imageRef);
    });
    refsInHtml(r.visualText, add);
    refsInHtml(r.audioText, add);
  });
  var comments = Array.isArray(state.comments) ? state.comments : [];
  comments.forEach(function (c) {
    if (!c || typeof c !== "object") return;
    addRecord(c.imageValue);
    refsInHtml(c.body, add);
    (Array.isArray(c.replies) ? c.replies : []).forEach(function (rep) {
      if (rep && typeof rep === "object") refsInHtml(rep.body, add);
    });
  });
  return out;
}

function u8(b, i) { return i >= 0 && i < b.length ? b[i] & 0xff : -1; }
function be16(b, i) { return (u8(b, i) << 8) | u8(b, i + 1); }
function le16(b, i) { return u8(b, i) | (u8(b, i + 1) << 8); }
function be32(b, i) { return ((u8(b, i) << 24) | (u8(b, i + 1) << 16) | (u8(b, i + 2) << 8) | u8(b, i + 3)) >>> 0; }
function ascii(b, i, s) {
  if (i + s.length > b.length) return false;
  for (var k = 0; k < s.length; k++) if (u8(b, i + k) !== s.charCodeAt(k)) return false;
  return true;
}

// Bytes decide type, never caller's claim.
function sniffImageMime(bytes) {
  if (!bytes || typeof bytes.length !== "number") return null;
  var b = bytes;
  if (b.length >= 8 && u8(b, 0) === 0x89 && ascii(b, 1, "PNG\r\n\x1a\n")) return "image/png";
  if (b.length >= 3 && u8(b, 0) === 0xff && u8(b, 1) === 0xd8 && u8(b, 2) === 0xff) return "image/jpeg";
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return "image/gif";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp";
  return null;
}

function dims(w, h) {
  return dimOk(w) && dimOk(h) ? { width: w, height: h } : null;
}

function pngDims(b) {
  if (!ascii(b, 12, "IHDR") || b.length < 24) return null;
  return dims(be32(b, 16), be32(b, 20));
}

function gifDims(b) {
  if (b.length < 10) return null;
  var w = le16(b, 6), h = le16(b, 8);
  if (w && h) return dims(w, h);
  var flags = u8(b, 10);
  var pos = 13;
  if (flags & 0x80) pos += 3 * (1 << ((flags & 7) + 1));
  while (pos < b.length) {
    var tag = u8(b, pos);
    if (tag === 0x2c) {
      if (pos + 9 > b.length) return null;
      return dims(Math.max(w, le16(b, pos + 1) + le16(b, pos + 5)), Math.max(h, le16(b, pos + 3) + le16(b, pos + 7)));
    }
    if (tag !== 0x21) return null;
    pos += 2;
    for (;;) {
      var n = u8(b, pos);
      if (n < 0) return null;
      pos += 1 + n;
      if (n === 0) break;
    }
  }
  return null;
}

// Orientations 5-8 swap width and height.
function exifOrientation(b, at, end) {
  if (!ascii(b, at, "Exif\0\0")) return 0;
  var t = at + 6;
  if (t + 8 > end) return 0;
  var le = ascii(b, t, "II");
  if (!le && !ascii(b, t, "MM")) return 0;
  var r16 = function (i) { return le ? le16(b, i) : be16(b, i); };
  var r32 = function (i) {
    return le ? (le16(b, i) + le16(b, i + 2) * 0x10000) : be32(b, i);
  };
  if (r16(t + 2) !== 42) return 0;
  var ifd = t + r32(t + 4);
  if (ifd < t + 8 || ifd + 2 > end) return 0;
  var count = r16(ifd);
  for (var k = 0; k < count; k++) {
    var e = ifd + 2 + k * 12;
    if (e + 12 > end) return 0;
    if (r16(e) === 0x0112) return r16(e + 8);
  }
  return 0;
}

function jpegDims(b) {
  var pos = 2, orientation = 0;
  while (pos + 4 <= b.length) {
    if (u8(b, pos) !== 0xff) return null;
    var marker = u8(b, pos + 1);
    if (marker === 0xff) { pos += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { pos += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    var len = be16(b, pos + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (pos + 9 > b.length) return null;
      var h = be16(b, pos + 5), w = be16(b, pos + 7);
      return orientation >= 5 && orientation <= 8 ? dims(h, w) : dims(w, h);
    }
    if (marker === 0xe1 && !orientation) {
      orientation = exifOrientation(b, pos + 4, Math.min(b.length, pos + 2 + len));
    }
    pos += 2 + len;
  }
  return null;
}

function webpDims(b) {
  if (ascii(b, 12, "VP8 ")) {
    if (u8(b, 23) !== 0x9d || u8(b, 24) !== 0x01 || u8(b, 25) !== 0x2a || b.length < 30) return null;
    return dims(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, "VP8L")) {
    if (u8(b, 20) !== 0x2f || b.length < 25) return null;
    var b1 = u8(b, 21), b2 = u8(b, 22), b3 = u8(b, 23), b4 = u8(b, 24);
    return dims(1 + (((b2 & 0x3f) << 8) | b1), 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)));
  }
  if (ascii(b, 12, "VP8X")) {
    if (b.length < 30) return null;
    return dims(1 + (u8(b, 24) | (u8(b, 25) << 8) | (u8(b, 26) << 16)),
      1 + (u8(b, 27) | (u8(b, 28) << 8) | (u8(b, 29) << 16)));
  }
  return null;
}

function imageDims(bytes) {
  switch (sniffImageMime(bytes)) {
    case "image/png": return pngDims(bytes);
    case "image/gif": return gifDims(bytes);
    case "image/jpeg": return jpegDims(bytes);
    case "image/webp": return webpDims(bytes);
    default: return null;
  }
}

module.exports = {
  IMAGE_DIM_MAX,
  IMAGE_MIMES,
  SHA256_RE,
  imageDims,
  isSha256Hex,
  normalizeImageRef,
  refsIn,
  sniffImageMime
};
