import { test } from "node:test";
import assert from "node:assert/strict";
import type { ImageRef } from "../../../src/core/document/ports.ts";
import { storedImageAttributes, storedImageMarkup } from "../../../src/core/document/text-policy.ts";
import type { StoredImageRef } from "../../../src/core/document/text-policy.ts";
import type { DecodedMedia } from "../../../src/core/text/ports.ts";
import { image } from "../../../src/test/golden-helpers.mjs";
import { adapterWith, fakePorts } from "./fakes.ts";

const KNOWN = image("png", 7, 5);
const PNG = image("png", 71, 13);
const GIF = image("gif", 3, 2);
const UNKNOWN = "a1".repeat(32);
const SVG = "data:image/svg+xml;base64,PHN2Zy8+";

test("a data-URL picture is ingested through fromDataUrl and a data-blob looked up through known, in document order", () => {
  const ports = fakePorts([KNOWN.record]);
  const rt = adapterWith(ports);
  const out = rt.sanitize(`a<img src="${PNG.dataUrl}">b<img data-blob="${KNOWN.sha256}" data-w="1" data-h="1" data-mime="image/gif" src="${GIF.dataUrl}">` +
    `c<img src="https://e.x/p.png"><img src="${SVG}">d`);
  assert.deepEqual(ports.log, [["fromDataUrl", PNG.dataUrl], ["known", KNOWN.sha256]]);
  assert.equal(out, "a" + storedImageMarkup(PNG.record) + "b" + storedImageMarkup(KNOWN.record) + "cd");
});

test("an unknown data-blob keeps its own size only when all of it is valid, and its src is never read", () => {
  const ports = fakePorts();
  const rt = adapterWith(ports);
  assert.equal(rt.sanitize(`<img data-blob="${UNKNOWN}" data-w="5" data-h="6" data-mime="image/webp" src="${GIF.dataUrl}">`),
    storedImageMarkup({ sha256: UNKNOWN, width: 5, height: 6, mime: "image/webp" }));
  assert.equal(rt.sanitize(`<img data-blob="${UNKNOWN}" data-w="5" data-mime="image/png">`), storedImageMarkup({ sha256: UNKNOWN }));
  assert.equal(rt.sanitize(`<img data-blob="${UNKNOWN}" data-w="5" data-h="6" data-mime="image/svg+xml">`), storedImageMarkup({ sha256: UNKNOWN }));
  assert.deepEqual(ports.log, [["known", UNKNOWN], ["known", UNKNOWN], ["known", UNKNOWN]]);
});

test("a picture the image source cannot take is dropped, and a bad data-blob falls back to the picture's own src", () => {
  const ports = fakePorts();
  const rt = adapterWith(ports);
  const bad = "data:image/png;base64,AAAA";
  assert.equal(rt.sanitize(`a<img src="${bad}">b`), "ab");
  assert.equal(rt.sanitize(`<img data-blob="nope" src="${GIF.dataUrl}">`), storedImageMarkup(GIF.record));
  assert.deepEqual(ports.log, [["fromDataUrl", bad], ["fromDataUrl", GIF.dataUrl]]);
});

test("a record the image source hands back is written attribute by attribute, so it cannot add one", () => {
  const odd: ImageRef = { sha256: UNKNOWN, width: 1, height: 1, mime: 'image/png" onerror="alert(1)' };
  const rt = adapterWith({ ids: fakePorts().ids, images: { known: () => ({ ...odd }), fromDataUrl: () => null } });
  const out = rt.sanitize(`<img data-blob="${UNKNOWN}">`);
  const img = rt.inertBody(out).querySelector("img");
  assert.ok(img);
  assert.equal(img.hasAttribute("onerror"), false);
  assert.equal(img.getAttribute("data-mime"), odd.mime);
  assert.deepEqual(Array.from(img.attributes, (a) => a.name), ["class", "data-blob", "data-w", "data-h", "data-mime"]);
});

test("core's stored image markup parses back to exactly its attributes, whatever the record holds", () => {
  const rt = adapterWith(fakePorts());
  const hostile = `x" onerror="alert('1')" <b>&amp;`;
  for (const field of ["sha256", "width", "height", "mime"] as const) {
    const ref = { sha256: UNKNOWN, width: 4, height: 3, mime: "image/png", [field]: hostile } as unknown as StoredImageRef;
    const body = rt.inertBody(storedImageMarkup(ref) + "after");
    assert.equal(body.childNodes.length, 2, field);
    const img = body.firstElementChild;
    assert.ok(img, field);
    assert.deepEqual(Array.from(img.attributes, (a) => [a.name, a.value]), storedImageAttributes(ref), field);
  }
});

test("ids are minted through the IdSource for anchors and b-roll keys that lack one, interleaved with pictures in document order", () => {
  const ports = fakePorts();
  const rt = adapterWith(ports);
  const out = rt.sanitize(`<span class="cmt-anchor">a</span><img src="${PNG.dataUrl}"><span class="broll-key">B-roll:</span> ` +
    '<span class="cmt-anchor" data-cmt="c 9!">b</span><span class="broll-key" data-broll-id="!!!">B-roll:</span>');
  assert.deepEqual(ports.log, [["id", "c"], ["fromDataUrl", PNG.dataUrl], ["id", "bs"], ["id", "bs"]]);
  assert.deepEqual(ports.minted.map((m) => m.value), ["cMinted1", "bsMinted2", "bsMinted3"]);
  assert.equal(out,
    '<span class="cmt-anchor" data-cmt="cMinted1">a</span>' + storedImageMarkup(PNG.record) +
    '<span class="broll-key" data-broll-id="bsMinted2" contenteditable="false">B-roll:</span> ' +
    '<span class="cmt-anchor" data-cmt="c9">b</span><span class="broll-key" data-broll-id="bsMinted3" contenteditable="false">B-roll:</span>');
});

test("decode sanitises once, reports media, and hands its options to normalizeCell", () => {
  const ports = fakePorts();
  const rt = adapterWith(ports);
  const media: DecodedMedia[] = [];
  const asked: string[] = [];
  const cell = rt.decode(`<b>x</b><img src="${PNG.dataUrl}"><a class="video-embed-card" href="https://youtu.be/x">v</a>` +
    '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug">mug</span><span class="tag-anchor" data-tag-cat="gear" data-tag-name="Rig">rig</span>', {
    onMedia: (m) => { media.push(m); },
    tagId: (cat, name) => cat + "/" + name,
    hasTag: (id) => { asked.push(id); return id === "prop/Mug"; }
  });
  assert.deepEqual(ports.log, [["fromDataUrl", PNG.dataUrl]]);
  assert.deepEqual(media, [
    { kind: "image", ref: { sha256: PNG.sha256, width: 71, height: 13, mime: "image/png" } },
    { kind: "video", href: "https://youtu.be/x" }
  ]);
  assert.deepEqual(asked, ["prop/Mug", "gear/Rig"]);
  assert.deepEqual(cell, [{ text: "x", marks: { b: true } }, { text: "mug", marks: { tag: "prop/Mug" } }, { text: "rig", marks: {} }]);
});

test("a cell reader decodes each HTML once and keeps what it read", () => {
  const ports = fakePorts();
  const rt = adapterWith(ports);
  const read = rt.createCellReader();
  const html = '<span class="cmt-anchor">a</span>';
  const first = read(html);
  assert.equal(read(html), first);
  assert.deepEqual(ports.log, [["id", "c"]]);
  assert.equal(read(null), read(""));
  assert.equal(read(42), read("42"));
  const other = rt.createCellReader();
  assert.notEqual(other(html), first);
  assert.deepEqual(ports.log, [["id", "c"], ["id", "c"]]);
});

test("a cell reader forgets everything once it holds more than two million characters", () => {
  const rt = adapterWith(fakePorts());
  const read = rt.createCellReader();
  const atBudget = "x".repeat(2000000);
  const big = read(atBudget);
  const small = read("y");
  assert.equal(read(atBudget), big);
  assert.equal(read("z").length, 1);
  assert.notEqual(read(atBudget), big);
  assert.notEqual(read("y"), small);
});

test("Markdown, stored form and inert parsing use neither port", () => {
  const ports = fakePorts();
  const rt = adapterWith(ports);
  const html = `<span class="cmt-anchor">a</span><img src="${PNG.dataUrl}"><img data-blob="${UNKNOWN}" alt="x"><span class="broll-key">B-roll:</span>`;
  assert.equal(rt.htmlToMarkdown(html), "aB-roll:");
  assert.equal(rt.storedHtmlFromDom(html),
    `<span class="cmt-anchor">a</span><img src="${PNG.dataUrl}"><img data-blob="${UNKNOWN}"><span class="broll-key">B-roll:</span>`);
  assert.equal(rt.inertBody(html).childNodes.length, 4);
  assert.deepEqual(ports.log, []);
});

test("imageRefOf reads a node through the image source", () => {
  const ports = fakePorts([KNOWN.record]);
  const rt = adapterWith(ports);
  const body = rt.inertBody(`<img data-blob="${KNOWN.sha256}"><img src="${GIF.dataUrl}"><img src="${SVG}">`);
  assert.deepEqual(Array.from(body.children, (el) => rt.imageRefOf(el)), [KNOWN.record, GIF.record, null]);
  assert.deepEqual(ports.log, [["known", KNOWN.sha256], ["fromDataUrl", GIF.dataUrl]]);
});

test("a video card's HTML is its element's, and survives sanitising unchanged", () => {
  const ports = fakePorts();
  const rt = adapterWith(ports);
  const href = "https://www.youtube.com/watch?v=abc";
  const card = rt.videoCardElement(href);
  assert.equal(rt.videoCardHtml(href), card.outerHTML);
  assert.equal(card.outerHTML,
    '<a class="video-embed-card" href="' + href + '" target="_blank" rel="noopener"><span class="vec-play">▶</span>' +
    '<span>Watch video</span><span class="vec-host">· youtube.com</span></a>');
  assert.equal(rt.sanitize(card.outerHTML), card.outerHTML);
  assert.deepEqual(ports.log, []);
});
