import { test } from "node:test";
import assert from "node:assert/strict";
import { toHtml } from "../../../src/core/text/html.ts";
import { isMediaRun, projection } from "../../../src/core/text/runs.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { image, readGoldenText } from "../../../src/test/golden-helpers.mjs";
import { adapterWith, fakePorts } from "./fakes.ts";

type RichtextGolden = {
  cases: Record<string, { input: unknown }>;
  videoCards: { href: string; html: string }[];
};

const GOLDEN = JSON.parse(readGoldenText("richtext", "richtext-golden.json")) as RichtextGolden;
const KNOWN = image("png", 7, 5);
const rt = adapterWith(fakePorts([KNOWN.record]));
const MEDIA = { media: true };
const CARD = '<a class="video-embed-card" href="https://youtu.be/abc" contenteditable="false">Watch</a>';

const cases = Object.entries(GOLDEN.cases).map(([name, c]) => {
  const sanitized = rt.sanitize(c.input);
  return { name, sanitized, cell: rt.decode(c.input, MEDIA), plain: rt.decode(c.input) };
});

function minted(html: string): string {
  return html.replace(/(bs|c)Minted\d+/g, "$1Minted");
}

function withoutMedia(cell: readonly Run[]): string {
  return minted(toHtml(cell.filter((r) => !isMediaRun(r))));
}

test("the corpus has pictures and video cards for the media decoder to carry", () => {
  assert.ok(cases.some((c) => c.cell.some((r) => r.atom === "image")));
  assert.ok(cases.some((c) => c.cell.some((r) => r.atom === "video")));
});

test("INV-10 with media: toHtml of the media runs is the sanitiser's fixed point over the corpus", () => {
  for (const c of cases) {
    const stored = toHtml(c.cell);
    assert.equal(rt.sanitize(stored), stored, c.name);
  }
});

test("the media runs round-trip: decoding their stored form gives the same runs, and storing again is the same string", () => {
  for (const c of cases) {
    const stored = toHtml(c.cell);
    assert.deepEqual(rt.decode(stored, MEDIA), c.cell, c.name);
    assert.equal(toHtml(rt.decode(stored, MEDIA)), stored, c.name);
  }
});

test("the media runs keep every picture and card the sanitiser keeps, in order", () => {
  for (const c of cases) {
    const fromSanitiser = Array.from(c.sanitized.matchAll(/<img[^>]*data-blob="([0-9a-f]{64})"|<a class="video-embed-card" href="([^"]*)"/g))
      .map((m) => (m[1] ? "image:" + m[1] : "video:" + (m[2] as string).replace(/&amp;/g, "&")));
    const fromRuns = c.cell.filter(isMediaRun).map((r) => (r.atom === "image" ? "image:" + r.ref.sha256 : "video:" + r.href));
    assert.deepEqual(fromRuns, fromSanitiser, c.name);
  }
});

test("with the media taken out, the media runs are the runs the plain decoder gives", () => {
  for (const c of cases) assert.equal(withoutMedia(c.cell), minted(toHtml(c.plain)), c.name);
});

test("without the media option, decoding drops media as before", () => {
  for (const c of cases) assert.equal(c.plain.some(isMediaRun), false, c.name);
});

test("a media atom is one place in the projection, like a b-roll key", () => {
  const cell = rt.decode("Ab " + CARD + " <img data-blob=\"" + KNOWN.sha256 + "\"> cd", MEDIA);
  assert.equal(projection(cell), "Ab \u{FFFC} \u{FFFC} cd");
});

test("a picture's stored form carries the registry's size and type when the registry knows it", () => {
  const cell = rt.decode('<img data-blob="' + KNOWN.sha256 + '">', MEDIA);
  assert.deepEqual(cell, [{ atom: "image", ref: KNOWN.record, text: "", marks: {} }]);
  assert.equal(toHtml(cell), '<img class="comment-img" data-blob="' + KNOWN.sha256 + '" data-w="7" data-h="5" data-mime="image/png">');
});

test("the stored card is the sanitiser's card for every golden card, and the adapter's own card HTML for each one it keeps", () => {
  let kept = 0;
  for (const v of GOLDEN.videoCards) {
    const stored = toHtml(rt.decode(v.html, MEDIA));
    assert.equal(stored, rt.sanitize(v.html), v.href);
    if (stored) { kept++; assert.equal(stored, v.html, v.href); }
  }
  assert.ok(kept > 0);
});

test("a media-aware cell reader caches like the plain one, and the two do not share answers", () => {
  const media = rt.createCellReader(deepFreeze, MEDIA);
  const plain = rt.createCellReader(deepFreeze);
  const html = "See " + CARD;
  assert.equal(media(html), media(html));
  assert.equal(media(html).some(isMediaRun), true);
  assert.equal(plain(html).some(isMediaRun), false);
});
