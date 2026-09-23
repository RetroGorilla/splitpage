/* shared/blob-policy.js — the image record, the reference walker and the
 * byte sniffer every blob store agrees on (issue #82).
 *
 * NO _dom.mjs IMPORT, deliberately — see history-policy.test.mjs's header:
 * this module is loaded by the browser bundle, by Electron's main process
 * and by node, and a suite that installed jsdom first could not tell if it
 * had started to need a DOM.
 *
 * The byte fixtures are hand-built headers, not real image files: the
 * sniffer and the measurer only ever read headers, and a fixture spelled out
 * byte by byte says exactly which field is being read. Real encoder output
 * (a canvas's PNG, JPEG and WebP) is measured in browser suite 65-blobs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  IMAGE_DIM_MAX,
  IMAGE_MIMES,
  imageDims,
  isSha256Hex,
  normalizeImageRef,
  refsIn,
  sniffImageMime
} from "../../shared/blob-policy.js";

const SHA_A = "a".repeat(64);
const SHA_B = "0123456789abcdef".repeat(4);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);

const bytes = (...parts) => {
  const out = [];
  for (const p of parts) {
    if (typeof p === "string") for (const ch of p) out.push(ch.charCodeAt(0));
    else if (Array.isArray(p)) out.push(...p);
    else out.push(p);
  }
  return new Uint8Array(out);
};
const be16 = (n) => [(n >> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >> 8) & 255];
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le24 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];

/* ---- fixtures ---- */

const png = (w, h) => bytes(0x89, "PNG\r\n\x1a\n", be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0], be32(0));

const JFIF = [0xff, 0xe0, ...be16(16), ..."JFIF\0".split("").map((c) => c.charCodeAt(0)), 1, 1, 0, 0, 1, 0, 1, 0, 0];
const sof = (marker, w, h) => [0xff, marker, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
const jpeg = (...segments) => bytes([0xff, 0xd8], ...segments, [0xff, 0xd9]);
/* An APP1 Exif segment whose IFD0 holds one entry: Orientation (0x0112). */
const exif = (orientation, littleEndian) => {
  const r16 = littleEndian ? le16 : be16;
  const r32 = littleEndian ? (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255] : be32;
  const tiff = [
    ...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]), ...r16(42), ...r32(8),
    ...r16(1), ...r16(0x0112), ...r16(3), ...r32(1), ...r16(orientation), 0, 0, ...r32(0)
  ];
  const payload = [..."Exif\0\0".split("").map((c) => c.charCodeAt(0)), ...tiff];
  return [0xff, 0xe1, ...be16(payload.length + 2), ...payload];
};

const gif = (w, h) => bytes("GIF89a", le16(w), le16(h), [0, 0, 0], [0x3b]);

const riff = (chunk) => bytes("RIFF", [0, 0, 0, 0], "WEBP", chunk);
const webpLossy = (w, h) => riff([..."VP8 ".split("").map((c) => c.charCodeAt(0)), 0, 0, 0, 0, 0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
const webpLossless = (w, h) => {
  const bits = (w - 1) | ((h - 1) << 14); /* 28 bits: fits in a double's exact ints */
  return riff([..."VP8L".split("").map((c) => c.charCodeAt(0)), 0, 0, 0, 0, 0x2f,
    bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
};
const webpExtended = (w, h) => riff([..."VP8X".split("").map((c) => c.charCodeAt(0)), 10, 0, 0, 0, 0x10, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);

/* ---- sniffImageMime ---- */

test("sniffImageMime reads the four raster formats off their magic numbers", () => {
  assert.equal(sniffImageMime(png(1, 1)), "image/png");
  assert.equal(sniffImageMime(jpeg(sof(0xc0, 1, 1))), "image/jpeg");
  assert.equal(sniffImageMime(bytes("GIF87a", le16(1), le16(1))), "image/gif");
  assert.equal(sniffImageMime(gif(1, 1)), "image/gif");
  assert.equal(sniffImageMime(webpLossy(1, 1)), "image/webp");
  /* A Node Buffer and a plain array are read the same way. */
  assert.equal(sniffImageMime(Buffer.from(png(1, 1))), "image/png");
  assert.equal(sniffImageMime(Array.from(gif(1, 1))), "image/gif");
});

test("sniffImageMime never says SVG, or anything else it cannot prove", () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(sniffImageMime(svg), null, "SVG is a document, never an image here");
  assert.equal(sniffImageMime(new TextEncoder().encode('<?xml version="1.0"?><svg/>')), null);
  assert.equal(sniffImageMime(bytes("RIFF", [0, 0, 0, 0], "WAVE")), null, "RIFF but not WebP");
  assert.equal(sniffImageMime(bytes("GIF88a")), null);
  assert.equal(sniffImageMime(bytes(0x89, "PNG")), null, "truncated signature");
  assert.equal(sniffImageMime(bytes(0xff, 0xd8)), null, "two bytes are not a JPEG");
  assert.equal(sniffImageMime(bytes("BM", [0, 0, 0, 0])), null, "BMP is not one of the four");
  assert.equal(sniffImageMime(new Uint8Array(0)), null);
  assert.equal(sniffImageMime(null), null);
  assert.equal(sniffImageMime("GIF89a"), null, "a string is not bytes");
});

/* ---- imageDims ---- */

test("imageDims: PNG from IHDR", () => {
  assert.deepEqual(imageDims(png(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageDims(png(1, 70000)), { width: 1, height: 70000 });
  assert.equal(imageDims(png(0, 10)), null, "zero width");
  assert.equal(imageDims(png(IMAGE_DIM_MAX + 1, 10)), null, "past the cap");
  assert.equal(imageDims(png(640, 480).slice(0, 22)), null, "truncated IHDR");
  const notIhdr = png(640, 480);
  notIhdr[12] = "X".charCodeAt(0);
  assert.equal(imageDims(notIhdr), null, "first chunk must be IHDR");
});

test("imageDims: JPEG from the first start-of-frame, orientation applied", () => {
  assert.deepEqual(imageDims(jpeg(JFIF, sof(0xc0, 800, 600))), { width: 800, height: 600 }, "baseline SOF0");
  assert.deepEqual(imageDims(jpeg(JFIF, sof(0xc1, 801, 601))), { width: 801, height: 601 }, "extended SOF1");
  assert.deepEqual(imageDims(jpeg(JFIF, sof(0xc2, 802, 602))), { width: 802, height: 602 }, "progressive SOF2");
  /* DHT (C4) sits in the SOF range and is not a frame. */
  const dht = [0xff, 0xc4, ...be16(4), 0, 0];
  assert.deepEqual(imageDims(jpeg(dht, sof(0xc0, 10, 20))), { width: 10, height: 20 });
  /* Fill bytes before a marker are legal. */
  assert.deepEqual(imageDims(jpeg([0xff, 0xff], sof(0xc0, 10, 20))), { width: 10, height: 20 });
  /* EXIF orientation 6 (rotate 90) is shown portrait: width and height swap. */
  assert.deepEqual(imageDims(jpeg(exif(6, true), sof(0xc0, 4032, 3024))), { width: 3024, height: 4032 }, "II");
  assert.deepEqual(imageDims(jpeg(exif(8, false), sof(0xc2, 4032, 3024))), { width: 3024, height: 4032 }, "MM");
  assert.deepEqual(imageDims(jpeg(exif(3, false), sof(0xc0, 4032, 3024))), { width: 4032, height: 3024 }, "180 keeps shape");
  assert.deepEqual(imageDims(jpeg(exif(1, true), sof(0xc0, 4032, 3024))), { width: 4032, height: 3024 });
  /* Scan data or the end before any frame: nothing to measure. */
  assert.equal(imageDims(jpeg(JFIF, [0xff, 0xda, ...be16(2)], sof(0xc0, 1, 1))), null);
  assert.equal(imageDims(jpeg(JFIF)), null);
  assert.equal(imageDims(jpeg(sof(0xc0, 0, 10))), null, "zero width");
  assert.equal(imageDims(jpeg(JFIF, sof(0xc0, 800, 600)).slice(0, 26)), null, "truncated frame header");
  /* A broken Exif segment is ignored, not fatal. */
  const badExif = [0xff, 0xe1, ...be16(10), ..."Exif\0\0".split("").map((c) => c.charCodeAt(0)), 0x4d, 0x4d];
  assert.deepEqual(imageDims(jpeg(badExif, sof(0xc0, 5, 7))), { width: 5, height: 7 });
});

test("imageDims: GIF from the logical screen, or the first frame when that is 0 x 0", () => {
  assert.deepEqual(imageDims(gif(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(imageDims(bytes("GIF87a", le16(3), le16(4), [0, 0, 0])), { width: 3, height: 4 });
  /* A zero screen, a 2-entry global colour table, a graphic control
     extension, then the frame at (1, 2) sized 10 x 20. */
  const zeroScreen = bytes("GIF89a", le16(0), le16(0), [0x80, 0, 0], [0, 0, 0, 255, 255, 255],
    [0x21, 0xf9, 4, 0, 0, 0, 0, 0], [0x2c], le16(1), le16(2), le16(10), le16(20), [0], [0x3b]);
  assert.deepEqual(imageDims(zeroScreen), { width: 11, height: 22 });
  assert.equal(imageDims(bytes("GIF89a", le16(0), le16(0), [0, 0, 0], [0x3b])), null, "no frame at all");
  assert.equal(imageDims(bytes("GIF89a", le16(5))), null, "truncated");
});

test("imageDims: WebP lossy, lossless and extended", () => {
  assert.deepEqual(imageDims(webpLossy(640, 480)), { width: 640, height: 480 });
  /* The top two bits of each lossy dimension are a scale hint, not size. */
  assert.deepEqual(imageDims(webpLossy(640 | 0xc000, 480 | 0x4000)), { width: 640, height: 480 });
  assert.deepEqual(imageDims(webpLossless(1, 1)), { width: 1, height: 1 });
  assert.deepEqual(imageDims(webpLossless(1000, 750)), { width: 1000, height: 750 });
  assert.deepEqual(imageDims(webpLossless(16384, 16384)), { width: 16384, height: 16384 }, "the 14-bit maximum");
  assert.deepEqual(imageDims(webpExtended(4000, 3000)), { width: 4000, height: 3000 });
  const badStart = webpLossy(640, 480);
  badStart[23] = 0;
  assert.equal(imageDims(badStart), null, "lossy start code missing");
  const badSig = webpLossless(10, 10);
  badSig[20] = 0;
  assert.equal(imageDims(badSig), null, "lossless signature missing");
  assert.equal(imageDims(riff([..."ALPH".split("").map((c) => c.charCodeAt(0)), 0, 0, 0, 0])), null, "unknown first chunk");
  assert.equal(imageDims(webpExtended(4000, 3000).slice(0, 28)), null, "truncated");
});

test("imageDims is null for anything that is not one of the four formats", () => {
  assert.equal(imageDims(new TextEncoder().encode("<svg width='10' height='10'/>")), null);
  assert.equal(imageDims(new Uint8Array(0)), null);
  assert.equal(imageDims(undefined), null);
});

/* ---- normalizeImageRef ---- */

test("normalizeImageRef: accept exactly the canonical record, return a fresh copy", () => {
  const ok = { sha256: SHA_B, width: 640, height: 480, mime: "image/png" };
  const out = normalizeImageRef(ok);
  assert.deepEqual(out, ok);
  assert.notEqual(out, ok, "a fresh object");
  for (const mime of IMAGE_MIMES) assert.ok(normalizeImageRef({ ...ok, mime }), mime);
  assert.deepEqual(normalizeImageRef({ ...ok, extra: "<script>", src: "data:x" }), ok, "extra keys are dropped");
  assert.ok(normalizeImageRef({ ...ok, width: 1, height: IMAGE_DIM_MAX }), "the bounds are inclusive");
});

test("normalizeImageRef: reject everything else", () => {
  const ok = { sha256: SHA_B, width: 640, height: 480, mime: "image/png" };
  const rejects = [
    [null, "null"], [undefined, "undefined"], ["x", "string"], [[ok], "array"], [42, "number"],
    [{ ...ok, sha256: SHA_B.toUpperCase() }, "upper-case hex"],
    [{ ...ok, sha256: SHA_B.slice(1) }, "63 hex"],
    [{ ...ok, sha256: SHA_B + "0" }, "65 hex"],
    [{ ...ok, sha256: " " + SHA_B.slice(1) }, "whitespace"],
    [{ ...ok, sha256: "g".repeat(64) }, "non-hex"],
    [{ ...ok, sha256: undefined }, "no sha"],
    [{ ...ok, width: 0 }, "zero width"],
    [{ ...ok, height: -1 }, "negative height"],
    [{ ...ok, width: 1.5 }, "fractional width"],
    [{ ...ok, width: "640" }, "string width"],
    [{ ...ok, height: NaN }, "NaN"],
    [{ ...ok, height: Infinity }, "Infinity"],
    [{ ...ok, width: IMAGE_DIM_MAX + 1 }, "past the cap"],
    [{ ...ok, mime: "image/svg+xml" }, "SVG"],
    [{ ...ok, mime: "image/jpg" }, "image/jpg is not a type"],
    [{ ...ok, mime: "IMAGE/PNG" }, "case"],
    [{ ...ok, mime: "image/bmp" }, "bmp"],
    [{ ...ok, mime: undefined }, "no mime"]
  ];
  for (const [x, why] of rejects) assert.equal(normalizeImageRef(x), null, why);
});

test("isSha256Hex is the same strict shape", () => {
  assert.equal(isSha256Hex(SHA_A), true);
  assert.equal(isSha256Hex(SHA_A.toUpperCase()), false);
  assert.equal(isSha256Hex(SHA_A.slice(1)), false);
  assert.equal(isSha256Hex(null), false);
});

/* ---- refsIn ---- */

test("refsIn collects rows, HTML fields, comments and replies — once each, in order", () => {
  const state = {
    rows: [
      { id: "r1", imageRef: { sha256: SHA_A, width: 1, height: 1, mime: "image/png" },
        visualText: '<p>x<img class="comment-img" data-blob="' + SHA_B + '" data-w="1"></p>', audioText: "" },
      { id: "r2", imageRef: null, visualText: "", audioText: "<img data-blob='" + SHA_C + "'>" },
      { id: "r3", imageRef: { sha256: SHA_A, width: 1, height: 1, mime: "image/png" } },
      null, "junk"
    ],
    comments: [
      { id: "c1", body: '<IMG CLASS="comment-img" DATA-BLOB=' + SHA_D + ">",
        replies: [{ id: "rp1", body: '<img src="" data-blob="' + SHA_E + '"/>' }, null, { body: 7 }] },
      { id: "c2", kind: "conflict", imageValue: { sha256: SHA_C, width: 2, height: 2, mime: "image/gif" },
        body: '<img data-blob="' + SHA_B + '">' },
      "junk"
    ]
  };
  assert.deepEqual(refsIn(state), [SHA_A, SHA_B, SHA_C, SHA_D, SHA_E]);
});

test("refsIn counts only real <img> attributes, and only lower-case shas", () => {
  const typed = { rows: [{ visualText: "<p>data-blob=\"" + SHA_A + "\"</p>", audioText: "&lt;img data-blob=\"" + SHA_B + "\"&gt;" }] };
  assert.deepEqual(refsIn(typed), [], "text a user typed is not a reference");
  const escapedAttr = { rows: [{ visualText: '<a title="<img data-blob=&quot;' + SHA_A + '&quot;>">x</a>' }] };
  assert.deepEqual(refsIn(escapedAttr), [], "an attribute VALUE is not an attribute");
  const upper = { rows: [{ visualText: '<img data-blob="' + SHA_A.toUpperCase() + '">' }] };
  assert.deepEqual(refsIn(upper), []);
  const otherTag = { rows: [{ visualText: '<span data-blob="' + SHA_A + '">' }] };
  assert.deepEqual(refsIn(otherTag), []);
  const lookalike = { rows: [{ visualText: '<img data-blobx="' + SHA_A + '"><img xdata-blob="' + SHA_B + '">' }] };
  assert.deepEqual(refsIn(lookalike), []);
  const tooLong = { rows: [{ visualText: "<img data-blob=" + SHA_A + "0>" }] };
  assert.deepEqual(refsIn(tooLong), [], "an unquoted value must end where the sha ends");
  const two = { rows: [{ visualText: '<img data-blob="' + SHA_A + '"><img alt="x" data-blob="' + SHA_B + '">' }] };
  assert.deepEqual(refsIn(two), [SHA_A, SHA_B]);
  const badRecord = { rows: [{ imageRef: { sha256: "nope" } }, { imageRef: "x" }] };
  assert.deepEqual(refsIn(badRecord), []);
});

test("refsIn is empty for anything that is not a state", () => {
  assert.deepEqual(refsIn(null), []);
  assert.deepEqual(refsIn("x"), []);
  assert.deepEqual(refsIn({}), []);
  assert.deepEqual(refsIn({ rows: "x", comments: {} }), []);
  /* Legacy states hold data: URIs, not refs. */
  assert.deepEqual(refsIn({ rows: [{ visualImage: "data:image/png;base64,AAAA", visualText: '<img src="data:image/png;base64,AAAA">' }] }), []);
});

/* ---- module shape ---- */

test("a require() sees exactly what an import does — this file is CommonJS on purpose", () => {
  const require = createRequire(import.meta.url);
  const cjs = require("../../shared/blob-policy.js");
  assert.equal(cjs.refsIn, refsIn);
  assert.equal(cjs.normalizeImageRef, normalizeImageRef);
  assert.deepEqual(Object.keys(cjs).sort(), [
    "IMAGE_DIM_MAX", "IMAGE_MIMES", "SHA256_RE", "imageDims", "isSha256Hex",
    "normalizeImageRef", "refsIn", "sniffImageMime"
  ]);
});

test("the module needs no DOM, no Electron and no init", () => {
  assert.equal(typeof globalThis.document, "undefined", "nothing in this suite installed a DOM");
  assert.deepEqual(imageDims(png(2, 3)), { width: 2, height: 3 });
});
