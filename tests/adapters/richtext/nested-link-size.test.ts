import { test } from "node:test";
import assert from "node:assert/strict";
import { adapterWith, fakePorts } from "./fakes.ts";
import { jsdomParser } from "./jsdom.mjs";

const rt = adapterWith(fakePorts());
const Parser: new () => DOMParser = jsdomParser();

function linkCount(html: string): number {
  return Array.from(html.matchAll(/<a[\s>]/g)).length;
}

function nestedLinks(html: string): number {
  let depth = 0, nested = 0;
  for (const m of html.matchAll(/<(\/?)a[\s>]/g)) {
    depth += m[1] ? -1 : 1;
    if (depth > 1) nested++;
  }
  return nested;
}

function textOf(html: string): string {
  return html.replace(/<a class="video-embed-card"[^>]*>.*?<\/a>/g, "").replace(/<[^>]*>/g, "");
}

function expectedText(html: string): string {
  const doc = new Parser().parseFromString("<!doctype html><body>" + html, "text/html");
  doc.body.querySelectorAll("a.video-embed-card").forEach((c) => { c.remove(); });
  return doc.body.textContent ?? "";
}

function assertFixedPoint(html: string): string {
  const once = rt.sanitize(html);
  assert.equal(rt.sanitize(once), once);
  return once;
}

const OUTER = '<a href="https://one.test/">';
const INNER = '<a href="https://two.test/">x</a>';
const CARD = '<a class="video-embed-card" href="https://youtu.be/x">c</a>';

type Mark = readonly [open: string, close: string];

const STRONG: Mark = ["<strong>", "</strong>"];
const EM: Mark = ["<em>", "</em>"];

function around(marks: readonly Mark[], inner: string): string {
  return marks.reduceRight((html, [open, close]) => open + html + close, inner);
}

function hostile(marks: readonly Mark[], links: number, inner: string = INNER): string {
  return OUTER + around(marks, "p<object>" + Array.from({ length: links }, () => inner).join("t") + "</object>q") + "</a>";
}

function repeated(marks: readonly Mark[], depth: number): Mark[] {
  return Array.from({ length: depth }, (_, i) => marks[i % marks.length] as Mark);
}

function distinctAnchors(depth: number): Mark[] {
  return Array.from({ length: depth }, (_, i) => ['<span class="cmt-anchor" data-cmt="c' + String(i) + '">', "</span>"] as const);
}

test("a mark repeated down the chain around many inner links is kept once, not cloned at every split (#355)", () => {
  const deep = hostile(repeated([STRONG], 100), 300);
  const once = assertFixedPoint(deep);
  assert.equal(once, assertFixedPoint(hostile([STRONG], 300)));
  assert.equal(nestedLinks(once), 0);
  assert.equal(linkCount(once), 601);
  assert.equal(textOf(once), expectedText(deep));
});

test("alternating marks down the chain collapse to one of each (#355)", () => {
  const deep = hostile(repeated([STRONG, EM], 100), 300);
  const once = assertFixedPoint(deep);
  assert.equal(once, assertFixedPoint(hostile([STRONG, EM], 300)));
});

test("comment anchors with the same id collapse, with different ids they stay apart (#355)", () => {
  const same = Array.from({ length: 80 }, () => ['<span class="cmt-anchor" data-cmt="c1">', "</span>"] as const);
  assert.equal(assertFixedPoint(hostile(same, 300)), assertFixedPoint(hostile(same.slice(0, 1), 300)));
  const apart = assertFixedPoint(hostile(distinctAnchors(3), 2));
  assert.equal(apart.match(/data-cmt="c0"/g)?.length, 5);
  assert.equal(apart.match(/data-cmt="c2"/g)?.length, 5);
});

test("a chain with a repeated mark stays as written while its splits are few (#355)", () => {
  const s3 = (inner: string): string => "<strong><strong><strong>" + inner + "</strong></strong></strong>";
  const link = (href: string, inner: string): string => '<a href="' + href + '" target="_blank" rel="noopener">' + inner + "</a>";
  assert.equal(assertFixedPoint(hostile(repeated([STRONG], 3), 1)),
    link("https://one.test/", s3("p")) + link("https://two.test/", s3("x")) + link("https://one.test/", s3("q")));
});

test("more splits than the cap allows unwrap the inner links and keep every word (#355)", () => {
  const deep = hostile(distinctAnchors(300), 120);
  const once = assertFixedPoint(deep);
  assert.equal(linkCount(once), 1);
  assert.equal(textOf(once), expectedText(deep));
  assert.ok(once.length < deep.length, String(once.length) + " from " + String(deep.length));
});

test("a card inside a link over the cap is dropped, as an unsafe card is (#355)", () => {
  const deep = hostile(distinctAnchors(300), 120, CARD);
  const once = assertFixedPoint(deep);
  assert.equal(linkCount(once), 1);
  assert.doesNotMatch(once, /video-embed-card/);
  assert.equal(textOf(once), expectedText(deep));
});

test("many inner links around nothing stay split, however many there are (#355)", () => {
  const once = assertFixedPoint(hostile([], 3000));
  assert.equal(linkCount(once), 6001);
  assert.equal(nestedLinks(once), 0);
});

test("a link over the cap unwraps its own inner links only, and still splits the link around it (#355)", () => {
  const middle = '<a href="https://two.test/">' + around(distinctAnchors(300), "<object>" + Array.from({ length: 120 }, () => '<a href="https://three.test/">z</a>').join("") + "</object>") + "</a>";
  const html = OUTER + "p<object>" + middle + "</object>q</a>";
  const once = assertFixedPoint(html);
  assert.equal(linkCount(once), 3);
  assert.equal(nestedLinks(once), 0);
  assert.doesNotMatch(once, /three\.test/);
  assert.equal(textOf(once), expectedText(html));
});

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNT = Number(process.env["NESTED_LINK_SIZE_FUZZ"] || 120);
const POOL: readonly Mark[] = [STRONG, EM, ["<u>", "</u>"], ["<s>", "</s>"], ["<mark>", "</mark>"],
  ['<span class="stage-dir">', "</span>"], ['<span class="cmt-anchor" data-cmt="c1">', "</span>"],
  ['<span class="cmt-anchor" data-cmt="c2">', "</span>"], ['<span style="font-weight:bold">', "</span>"]];

function generated(seed: number): string {
  const rnd = prng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;
  const distinct = rnd() < 0.3;
  const marks = distinct ? distinctAnchors(1 + Math.floor(rnd() * 150)) : Array.from({ length: 1 + Math.floor(rnd() * 120) }, () => pick(POOL));
  const parts = Array.from({ length: Math.floor(rnd() * 200) }, () => pick([INNER, INNER, CARD, "w", "<br>", around([pick(POOL)], INNER)]));
  return OUTER + around(marks, "p<object>" + parts.join("") + "</object>q") + "</a>";
}

test("seeded fuzz: deep chains around many inner links stay a fixed point, nest no link, keep every word and stay bounded (#355)", () => {
  const failures: string[] = [];
  for (let seed = 355000; seed < 355000 + COUNT; seed++) {
    const html = generated(seed);
    const once = rt.sanitize(html);
    let why: string | null = null;
    if (rt.sanitize(once) !== once) why = "not a fixed point";
    else if (nestedLinks(once)) why = "a link in a link";
    else if (textOf(once).replace(/\s+/g, "") !== expectedText(html).replace(/\s+/g, "")) why = "text changed";
    else if (once.length > 20 * html.length) why = "output of " + String(once.length) + " from " + String(html.length);
    if (why) failures.push(String(seed) + ": " + why);
  }
  assert.deepEqual(failures, []);
});
