"use strict";

type BlobPolicyFields = Record<string, unknown>;
type BlobPolicyBytes = ArrayLike<number>;
type BlobPolicyMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const SHA256_RE = /^[0-9a-f]{64}$/;

const IMAGE_DIM_MAX = 1 << 20;

function isSha256Hex(x: unknown): boolean {
  return typeof x === "string" && SHA256_RE.test(x);
}

function dimOk(n: unknown): boolean {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= IMAGE_DIM_MAX;
}

function normalizeImageRef(x: unknown) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  if (!isSha256Hex((x as BlobPolicyFields).sha256)) return null;
  if (!dimOk((x as BlobPolicyFields).width) || !dimOk((x as BlobPolicyFields).height)) return null;
  if (typeof (x as BlobPolicyFields).mime !== "string" || IMAGE_MIMES.indexOf((x as BlobPolicyFields).mime as string) === -1) return null;
  return { sha256: (x as BlobPolicyFields).sha256 as string, width: (x as BlobPolicyFields).width as number, height: (x as BlobPolicyFields).height as number, mime: (x as BlobPolicyFields).mime as string };
}

const DATA_BLOB_RE = /<img\b[^>]*?\sdata-blob\s*=\s*(?:"([0-9a-fA-F]{64})"|'([0-9a-fA-F]{64})'|([0-9a-fA-F]{64})(?=[\s/>]))/gi;

function refsInHtml(html: unknown, add: (sha: unknown) => void) {
  if (typeof html !== "string" || !/data-blob/i.test(html)) return;
  DATA_BLOB_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATA_BLOB_RE.exec(html)) !== null) add(m[1] || m[2] || m[3]);
}

function refsIn(state: unknown) {
  const out: string[] = [];
  const seen: Record<string, true | undefined> = Object.create(null);
  function add(sha: unknown) {
    if (!isSha256Hex(sha) || seen[sha as string]) return;
    seen[sha as string] = true;
    out.push(sha as string);
  }
  function addRecord(rec: unknown) {
    if (rec && typeof rec === "object") add((rec as BlobPolicyFields).sha256);
  }
  if (!state || typeof state !== "object") return out;
  const rows: unknown[] = Array.isArray((state as BlobPolicyFields).rows) ? (state as BlobPolicyFields).rows as unknown[] : [];
  rows.forEach(function (r) {
    if (!r || typeof r !== "object") return;
    addRecord((r as BlobPolicyFields).imageRef);
    if ((r as BlobPolicyFields).imageAnnotation && typeof (r as BlobPolicyFields).imageAnnotation === "object") addRecord(((r as BlobPolicyFields).imageAnnotation as BlobPolicyFields).imageRef);
    (Array.isArray((r as BlobPolicyFields).moreImages) ? (r as BlobPolicyFields).moreImages as unknown[] : []).forEach(function (it) {
      if (!it || typeof it !== "object") return;
      addRecord((it as BlobPolicyFields).imageRef);
      if ((it as BlobPolicyFields).annotation && typeof (it as BlobPolicyFields).annotation === "object") addRecord(((it as BlobPolicyFields).annotation as BlobPolicyFields).imageRef);
    });
    refsInHtml((r as BlobPolicyFields).visualText, add);
    refsInHtml((r as BlobPolicyFields).audioText, add);
  });
  const comments: unknown[] = Array.isArray((state as BlobPolicyFields).comments) ? (state as BlobPolicyFields).comments as unknown[] : [];
  comments.forEach(function (c) {
    if (!c || typeof c !== "object") return;
    addRecord((c as BlobPolicyFields).imageValue);
    refsInHtml((c as BlobPolicyFields).body, add);
    (Array.isArray((c as BlobPolicyFields).replies) ? (c as BlobPolicyFields).replies as unknown[] : []).forEach(function (rep) {
      if (rep && typeof rep === "object") refsInHtml((rep as BlobPolicyFields).body, add);
    });
  });
  return out;
}

function u8(b: BlobPolicyBytes, i: number) { return i >= 0 && i < b.length ? (b[i] as number) & 0xff : -1; }
function be16(b: BlobPolicyBytes, i: number) { return (u8(b, i) << 8) | u8(b, i + 1); }
function le16(b: BlobPolicyBytes, i: number) { return u8(b, i) | (u8(b, i + 1) << 8); }
function be32(b: BlobPolicyBytes, i: number) { return ((u8(b, i) << 24) | (u8(b, i + 1) << 16) | (u8(b, i + 2) << 8) | u8(b, i + 3)) >>> 0; }
function ascii(b: BlobPolicyBytes, i: number, s: string) {
  if (i + s.length > b.length) return false;
  for (let k = 0; k < s.length; k++) if (u8(b, i + k) !== s.charCodeAt(k)) return false;
  return true;
}

function sniffImageMime(bytes: BlobPolicyBytes | null | undefined): BlobPolicyMime | null {
  if (!bytes || typeof bytes.length !== "number") return null;
  const b = bytes;
  if (b.length >= 8 && u8(b, 0) === 0x89 && ascii(b, 1, "PNG\r\n\x1a\n")) return "image/png";
  if (b.length >= 3 && u8(b, 0) === 0xff && u8(b, 1) === 0xd8 && u8(b, 2) === 0xff) return "image/jpeg";
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return "image/gif";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp";
  return null;
}

function dims(w: number, h: number) {
  return dimOk(w) && dimOk(h) ? { width: w, height: h } : null;
}

function pngDims(b: BlobPolicyBytes) {
  if (!ascii(b, 12, "IHDR") || b.length < 24) return null;
  return dims(be32(b, 16), be32(b, 20));
}

function gifDims(b: BlobPolicyBytes) {
  if (b.length < 10) return null;
  const w = le16(b, 6), h = le16(b, 8);
  if (w && h) return dims(w, h);
  const flags = u8(b, 10);
  let pos = 13;
  if (flags & 0x80) pos += 3 * (1 << ((flags & 7) + 1));
  while (pos < b.length) {
    const tag = u8(b, pos);
    if (tag === 0x2c) {
      if (pos + 9 > b.length) return null;
      return dims(Math.max(w, le16(b, pos + 1) + le16(b, pos + 5)), Math.max(h, le16(b, pos + 3) + le16(b, pos + 7)));
    }
    if (tag !== 0x21) return null;
    pos += 2;
    for (;;) {
      const n = u8(b, pos);
      if (n < 0) return null;
      pos += 1 + n;
      if (n === 0) break;
    }
  }
  return null;
}

function exifOrientation(b: BlobPolicyBytes, at: number, end: number) {
  if (!ascii(b, at, "Exif\0\0")) return 0;
  const t = at + 6;
  if (t + 8 > end) return 0;
  const le = ascii(b, t, "II");
  if (!le && !ascii(b, t, "MM")) return 0;
  const r16 = function (i: number) { return le ? le16(b, i) : be16(b, i); };
  const r32 = function (i: number) {
    return le ? (le16(b, i) + le16(b, i + 2) * 0x10000) : be32(b, i);
  };
  if (r16(t + 2) !== 42) return 0;
  const ifd = t + r32(t + 4);
  if (ifd < t + 8 || ifd + 2 > end) return 0;
  const count = r16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return 0;
    if (r16(e) === 0x0112) return r16(e + 8);
  }
  return 0;
}

function jpegDims(b: BlobPolicyBytes) {
  let pos = 2, orientation = 0;
  while (pos + 4 <= b.length) {
    if (u8(b, pos) !== 0xff) return null;
    const marker = u8(b, pos + 1);
    if (marker === 0xff) { pos += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { pos += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = be16(b, pos + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (pos + 9 > b.length) return null;
      const h = be16(b, pos + 5), w = be16(b, pos + 7);
      return orientation >= 5 && orientation <= 8 ? dims(h, w) : dims(w, h);
    }
    if (marker === 0xe1 && !orientation) {
      orientation = exifOrientation(b, pos + 4, Math.min(b.length, pos + 2 + len));
    }
    pos += 2 + len;
  }
  return null;
}

function webpDims(b: BlobPolicyBytes) {
  if (ascii(b, 12, "VP8 ")) {
    if (u8(b, 23) !== 0x9d || u8(b, 24) !== 0x01 || u8(b, 25) !== 0x2a || b.length < 30) return null;
    return dims(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, "VP8L")) {
    if (u8(b, 20) !== 0x2f || b.length < 25) return null;
    const b1 = u8(b, 21), b2 = u8(b, 22), b3 = u8(b, 23), b4 = u8(b, 24);
    return dims(1 + (((b2 & 0x3f) << 8) | b1), 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)));
  }
  if (ascii(b, 12, "VP8X")) {
    if (b.length < 30) return null;
    return dims(1 + (u8(b, 24) | (u8(b, 25) << 8) | (u8(b, 26) << 16)),
      1 + (u8(b, 27) | (u8(b, 28) << 8) | (u8(b, 29) << 16)));
  }
  return null;
}

function imageDims(bytes: BlobPolicyBytes | null | undefined) {
  switch (sniffImageMime(bytes)) {
    case "image/png": return pngDims(bytes as BlobPolicyBytes);
    case "image/gif": return gifDims(bytes as BlobPolicyBytes);
    case "image/jpeg": return jpegDims(bytes as BlobPolicyBytes);
    case "image/webp": return webpDims(bytes as BlobPolicyBytes);
    default: return null;
  }
}

export {
  IMAGE_DIM_MAX,
  IMAGE_MIMES,
  SHA256_RE,
  imageDims,
  isSha256Hex,
  normalizeImageRef,
  refsIn,
  sniffImageMime
};
