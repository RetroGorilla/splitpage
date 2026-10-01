import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mediaCommentId } from "../../../src/core/document/ids.ts";
import {
  base64Encode,
  createImageIngestion,
  decodeImageDataUrl,
  forgivingBase64Decode,
  imageDataUrlBytes,
  imageRecordOf,
  mediaComments,
  rowImage,
  rowImageKey,
  rowImageShas
} from "../../../src/core/document/media.ts";
import type { CellMedia } from "../../../src/core/document/media.ts";
import type { ImageRef, ImageSource } from "../../../src/core/document/ports.ts";

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const dataUrl = (bytes: Uint8Array, type = "png") => "data:image/" + type + ";base64," + Buffer.from(bytes).toString("base64");
const text = (bytes: Uint8Array | null) => bytes === null ? null : Buffer.from(bytes).toString("latin1");

const PNG_A = png(4, 3);
const PNG_B = png(8, 6);
const REF_A: ImageRef = { sha256: sha(PNG_A), width: 4, height: 3, mime: "image/png" };
const REF_B: ImageRef = { sha256: sha(PNG_B), width: 8, height: 6, mime: "image/png" };

test("base64 decodes forgivingly: spaces and padding are optional, stray characters are not", () => {
  assert.equal(text(forgivingBase64Decode("aGVsbG8=")), "hello");
  assert.equal(text(forgivingBase64Decode("aGVs\n bG8")), "hello");
  assert.equal(text(forgivingBase64Decode("aGVsbA==")), "hell");
  assert.equal(text(forgivingBase64Decode("aGVsbA")), "hell");
  assert.equal(text(forgivingBase64Decode("")), "");
  assert.equal(forgivingBase64Decode("aGVsb"), null);
  assert.equal(forgivingBase64Decode("aGV*bG8="), null);
  assert.equal(forgivingBase64Decode("aGVsbG8=="), null);
});

test("base64 encodes as Node does, whatever the length", () => {
  for (let n = 0; n < 8; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 0xff);
    assert.equal(base64Encode(bytes), Buffer.from(bytes).toString("base64"), String(n));
    assert.deepEqual(forgivingBase64Decode(base64Encode(bytes)), bytes, String(n));
  }
  const big = Uint8Array.from({ length: 20000 }, (_, i) => i & 0xff);
  assert.equal(base64Encode(big), Buffer.from(big).toString("base64"));
});

test("an image's record comes from its bytes: sniffed type, its size and its hash", () => {
  assert.deepEqual(imageRecordOf(PNG_A), REF_A);
  assert.deepEqual(Object.keys(imageRecordOf(PNG_A) as ImageRef), ["sha256", "width", "height", "mime"]);
  assert.equal(imageRecordOf(new Uint8Array([1, 2, 3])), null);
  assert.equal(imageRecordOf(png(0, 3)), null);
  assert.equal(imageRecordOf(PNG_A.subarray(0, 20)), null);
});

test("a data URL gives its bytes only when it is a raster image in base64", () => {
  const url = dataUrl(PNG_A);
  assert.deepEqual(imageDataUrlBytes(url), PNG_A);
  assert.equal(imageDataUrlBytes("\u0000" + url), null, "the URL must start the string");
  assert.equal(imageDataUrlBytes(" " + url), null, "the URL must start the string");
  assert.deepEqual(imageDataUrlBytes(url + " \u000b\n"), PNG_A, "trailing white space is trimmed");
  assert.deepEqual(imageDataUrlBytes(url.slice(0, 40) + "\n\t\r " + url.slice(40)), PNG_A, "line breaks and spaces inside are dropped");
  assert.equal(imageDataUrlBytes(url.slice(0, 40) + "\u000b" + url.slice(40)), null, "a vertical tab inside is not");
  assert.equal(imageDataUrlBytes("data:image/svg+xml;base64,PHN2Zz4="), null);
  assert.equal(imageDataUrlBytes("data:image/png;base64,abc!"), null);
  assert.equal(imageDataUrlBytes("data:image/png;base64,aGVsb"), null);
  assert.equal(imageDataUrlBytes(null), null);
  assert.equal(imageDataUrlBytes(42), null);
});

test("decoding a data URL yields its record and bytes, or nothing for bytes that are not a picture", () => {
  assert.deepEqual(decodeImageDataUrl(dataUrl(PNG_A, "jpeg")), { ref: REF_A, bytes: PNG_A });
  assert.equal(decodeImageDataUrl("data:image/png;base64,aGVsbG8="), null);
  assert.equal(decodeImageDataUrl("https://example.com/a.png"), null);
});

function lookup(held: ImageRef[]) {
  const asked: string[] = [];
  return {
    asked,
    known(s: string): ImageRef | null {
      asked.push(s);
      const hit = held.find((r) => r.sha256 === s);
      return hit ? { ...hit } : null;
    }
  };
}

test("ingestion records each decoded picture once, in the order it was first met", () => {
  const registry = lookup([REF_B]);
  const ingest = createImageIngestion(registry.known);
  assert.deepEqual(ingest.fromDataUrl(dataUrl(PNG_A)), REF_A);
  assert.deepEqual(ingest.fromDataUrl(dataUrl(PNG_B)), REF_B);
  assert.deepEqual(ingest.fromDataUrl(dataUrl(PNG_A, "gif")), REF_A);
  assert.equal(ingest.fromDataUrl("data:image/png;base64,aGVsbG8="), null);
  assert.equal(ingest.fromDataUrl("not a url"), null);
  assert.deepEqual(ingest.pending(), [{ ref: REF_A, bytes: PNG_A }, { ref: REF_B, bytes: PNG_B }]);
  assert.deepEqual(registry.asked, [], "decoding never asks the registry");
});

test("ingestion's known() sees a pending picture before the registry, then asks the registry", () => {
  const registry = lookup([REF_B]);
  const ingest = createImageIngestion(registry.known);
  assert.equal(ingest.known(REF_A.sha256), null);
  ingest.fromDataUrl(dataUrl(PNG_A));
  assert.deepEqual(ingest.known(REF_A.sha256), REF_A);
  assert.deepEqual(ingest.known(REF_B.sha256), REF_B);
  assert.equal(ingest.known("__proto__"), null);
  assert.deepEqual(registry.asked, [REF_A.sha256, REF_B.sha256, "__proto__"]);
});

test("ingestion hands out copies, so a caller cannot change what is pending", () => {
  const ingest = createImageIngestion(() => null);
  const got = ingest.fromDataUrl(dataUrl(PNG_A)) as ImageRef;
  got.width = 999;
  const seen = ingest.known(REF_A.sha256) as ImageRef;
  seen.mime = "image/gif";
  assert.deepEqual(ingest.pending()[0]?.ref, REF_A);
  assert.deepEqual(ingest.known(REF_A.sha256), REF_A);
});

test("a row's picture is its legacy data URL first, else its normalised reference", () => {
  const legacy = dataUrl(PNG_A);
  assert.deepEqual(rowImage({ visualImage: legacy, imageRef: REF_B }), { ref: null, dataUrl: legacy });
  assert.deepEqual(rowImage({ visualImage: "data:text/plain,x", imageRef: { ...REF_B, extra: 1 } }), { ref: REF_B, dataUrl: null });
  assert.equal(rowImage({ imageRef: { sha256: REF_B.sha256 } }), null);
  assert.equal(rowImage({}), null);
  assert.equal(rowImage(null), null);
  assert.equal(rowImage("row"), null);
  assert.equal(rowImageKey({ visualImage: legacy }), legacy);
  assert.equal(rowImageKey({ imageRef: REF_B }), REF_B.sha256);
  assert.equal(rowImageKey({}), null);
});

test("a document's row pictures are listed once each, legacy data URLs aside", () => {
  assert.deepEqual(rowImageShas([
    { imageRef: REF_B }, { imageRef: REF_A }, { imageRef: REF_B }, { visualImage: dataUrl(PNG_A) }, null, {}
  ]), [REF_B.sha256, REF_A.sha256]);
  assert.deepEqual(rowImageShas(null), []);
  assert.deepEqual(rowImageShas({ length: 1, 0: { imageRef: REF_A } }), []);
});

function images(held: ImageRef[]): ImageSource {
  return {
    known: (s) => held.find((r) => r.sha256 === s) || null,
    fromDataUrl: () => { throw new Error("moving media out of a cell decodes nothing"); }
  };
}

const card = (href: string) => '<a class="video-embed-card" href="' + href + '">card</a>';

test("media found in a cell becomes one comment each, with the picture the registry knows", () => {
  const found: CellMedia[] = [
    { kind: "image", ref: { sha256: REF_A.sha256, width: null, height: null, mime: null } },
    { kind: "video", href: "https://youtu.be/x" },
    { kind: "image", ref: { sha256: REF_A.sha256 } }
  ];
  const out = mediaComments({ id: "r1", updatedAt: "2026-04-01T09:00:00.000Z" }, "visualText", found, images([REF_A]), card);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    id: mediaCommentId("r1", "visualText", "img:" + REF_A.sha256),
    rowId: "r1",
    field: "visualText",
    anchorId: null,
    quotedText: "",
    author: "Splitpage",
    body: "This was in the scene's visual column. Pictures and videos go in comments now:<br>" +
      '<img class="comment-img" data-blob="' + REF_A.sha256 + '" data-w="4" data-h="3" data-mime="image/png">',
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    assignee: "",
    createdAt: "2026-04-01T09:00:00.000Z",
    updatedAt: "2026-04-01T09:00:00.000Z",
    kind: "anchor",
    replies: []
  });
  assert.equal(out[1]?.id, mediaCommentId("r1", "visualText", "video:https://youtu.be/x"));
  assert.equal(out[1]?.body, "This was in the scene's visual column. Pictures and videos go in comments now:<br>" + card("https://youtu.be/x"));
});

test("an unknown picture keeps the reference the cell carried, or only its hash", () => {
  const found: CellMedia[] = [
    { kind: "image", ref: { ...REF_B } },
    { kind: "image", ref: { sha256: REF_A.sha256 } }
  ];
  const out = mediaComments({ id: "r2" }, "audioText", found, images([]), card);
  assert.deepEqual(out.map((c) => c.body.split("<br>")[1]), [
    '<img class="comment-img" data-blob="' + REF_B.sha256 + '" data-w="8" data-h="6" data-mime="image/png">',
    '<img class="comment-img" data-blob="' + REF_A.sha256 + '">'
  ]);
  assert.ok(out.every((c) => c.body.startsWith("This was in the scene's audio column.")));
  assert.ok(out.every((c) => c.createdAt === "" && c.updatedAt === ""));
});

test("media without a valid hash or a safe link is dropped", () => {
  const found: CellMedia[] = [
    { kind: "image", ref: { sha256: "ABC" } },
    { kind: "image", ref: null },
    { kind: "image" },
    { kind: "video", href: "javascript:alert(1)" },
    { kind: "video", href: null },
    { kind: "video" }
  ];
  const calls: string[] = [];
  assert.deepEqual(mediaComments({ id: "r3" }, "visualText", found, images([]), (h) => { calls.push(h); return h; }), []);
  assert.deepEqual(calls, []);
});
