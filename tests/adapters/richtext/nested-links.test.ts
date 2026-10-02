import { test } from "node:test";
import assert from "node:assert/strict";
import { adapterWith, fakePorts } from "./fakes.ts";
import { jsdomParser } from "./jsdom.mjs";

const rt = adapterWith(fakePorts());
const Parser: new () => DOMParser = jsdomParser();

function assertFixedPoint(html: string, why?: string): string {
  const once = rt.sanitize(html);
  assert.equal(rt.sanitize(once), once, (why ?? "") + "\ninput: " + html + "\nonce:  " + once);
  return once;
}

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

const link = (href: string, inner: string): string => `<a href="${href}" target="_blank" rel="noopener">${inner}</a>`;
const ONE = (inner: string): string => link("https://one.test/", inner);
const TWO = (inner: string): string => link("https://two.test/", inner);
const card = (href: string): string => rt.videoCardHtml(href);

test("a link inside a link through <object> becomes the inner link alone, a fixed point (#290)", () => {
  const once = assertFixedPoint('<a href="https://one.test/"><object><a href="https://two.test/">x</a></object></a>');
  assert.equal(once, TWO("x"));
});

test("a safe link inside a link splits the outer link around it, as setting a link in the editor does (#290)", () => {
  const once = assertFixedPoint('<a href="https://one.test/">p<table><td><a href="https://two.test/">x</a></td></table>q</a>');
  assert.equal(once, ONE("p") + TWO("x") + ONE("q"));
});

test("the inner link keeps its formatting, and the outer pieces keep theirs (#290)", () => {
  assert.equal(assertFixedPoint('<a href="https://one.test/">a<object><a href="https://two.test/"><b>b</b></a></object></a>'),
    ONE("a") + TWO("<strong>b</strong>"));
  assert.equal(assertFixedPoint('<a href="https://one.test/"><em>p<object><a href="https://two.test/">x</a></object>q</em></a>'),
    ONE("<em>p</em>") + TWO("<em>x</em>") + ONE("<em>q</em>"));
});

test("a link inside a span or mark inside a link splits it too, and no text is lost (#290)", () => {
  for (const [open, close] of [['<span style="font-weight:bold">', "</span>"], ["<mark>", "</mark>"], ['<span class="stage-dir">', "</span>"]] as const) {
    const once = assertFixedPoint('<a href="https://one.test/">' + open + 'p<object><a href="https://two.test/">x</a></object>q' + close + "</a>");
    assert.equal(nestedLinks(once), 0, once);
    assert.equal(linkCount(once), 3, once);
    assert.equal(once.replace(/<[^>]*>/g, ""), "pxq", once);
  }
});

test("several inner links split the outer link at each one, and an inner link splits around its own inner link (#290)", () => {
  assert.equal(assertFixedPoint('<a href="https://one.test/">a<object><a href="https://two.test/">b</a>c<a href="https://two.test/">d</a></object>e</a>'),
    ONE("a") + TWO("b") + ONE("c") + TWO("d") + ONE("e"));
  assert.equal(assertFixedPoint('<a href="https://one.test/">a<object><a href="https://two.test/">b<object><a href="https://three.test/">c</a></object>d</a></object>e</a>'),
    ONE("a") + TWO("b") + link("https://three.test/", "c") + TWO("d") + ONE("e"));
});

test("an unsafe link inside a link is unwrapped, so its text stays in the outer link (#290)", () => {
  assert.equal(assertFixedPoint('<a href="https://one.test/">p<object><a href="javascript:alert(1)" onclick="alert(2)">x</a></object>q</a>'),
    ONE("pxq"));
});

test("an unsafe outer link does not split around a safe inner one (#290)", () => {
  assert.equal(assertFixedPoint('<a href="javascript:alert(1)">a<object><a href="https://two.test/">x</a></object></a>'),
    'a' + TWO("x"));
});

test("a video card inside a link splits the outer link around the card, which stays a card (#290)", () => {
  const once = assertFixedPoint('<a href="https://one.test/">see <object><a class="video-embed-card" href="https://youtu.be/x">' +
    '<span class="vec-play">x</span><span>Watch video</span></a></object> after</a>');
  assert.equal(once, ONE("see ") + card("https://youtu.be/x") + ONE(" after"));
  assert.equal(nestedLinks(once), 0, once);
});

test("a card with an unsafe address inside a link is dropped with its contents (#290)", () => {
  assert.equal(assertFixedPoint('<a href="https://one.test/">a<object><a class="video-embed-card" href="javascript:alert(1)">gone</a></object>b</a>'),
    ONE("ab"));
});

test("a card inside formatting inside a link keeps the formatting around it (#290)", () => {
  const once = assertFixedPoint('<a href="https://one.test/"><em>p<object><a class="video-embed-card" href="https://youtu.be/x">c</a></object>q</em></a>');
  assert.equal(once, ONE("<em>p</em>") + "<em>" + card("https://youtu.be/x") + "</em>" + ONE("<em>q</em>"));
});

test("a link inside a link through a span that is also a comment anchor or a mark still splits (#290, #280)", () => {
  const repro = '<a href="https://one.test/">p<object><span class="cmt-anchor stage-dir" data-cmt="c1"><a href="https://two.test/">x</a></span></object>q</a>';
  const once = assertFixedPoint(repro);
  assert.equal(nestedLinks(once), 0, once);
  assert.equal(once.replace(/<[^>]*>/g, ""), "pxq", once);
  for (const classes of ["cmt-anchor stage-dir", "stage-dir cmt-anchor", "cmt-anchor tag-anchor", "cmt-anchor audio-cue", "cmt-anchor broll-key"]) {
    const html = `<a href="https://one.test/">p<object><span class="${classes}" data-cmt="c1" data-tag-cat="prop" data-tag-name="Lamp" data-broll-id="k1"><a href="https://two.test/">x</a></span></object>q</a>`;
    const out = assertFixedPoint(html, classes);
    assert.equal(nestedLinks(out), 0, out);
    assert.equal(out.replace(/<[^>]*>/g, ""), "pxq", out);
    assert.equal(linkCount(out), 3, out);
  }
});

test("sibling links stay separate links (#290)", () => {
  const once = assertFixedPoint('<a href="https://one.test/">a</a> <a href="https://two.test/">b</a>');
  assert.equal(linkCount(once), 2);
});

test("splitting a link admits no attribute, script or address of its own (#290)", () => {
  const once = assertFixedPoint('<a href="https://one.test/" onclick="alert(0)" class="x" style="y:z">a<object>' +
    '<a href="https://two.test/" onclick="alert(2)" id="i" target="_top" style="x:y">y</a></object>b</a>');
  assert.equal(once, ONE("a") + TWO("y") + ONE("b"));
  assert.doesNotMatch(once, /onclick|style=|id="i"|target="_top"|javascript/);
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

const OPENERS: readonly (readonly [string, string])[] = [
  ['<a href="https://one.test/">', "</a>"],
  ['<a href="https://two.test/">', "</a>"],
  ['<a href="javascript:void(0)">', "</a>"],
  ['<a class="video-embed-card" href="https://youtu.be/x">', "</a>"],
  ["<span>", "</span>"],
  ['<span style="font-weight:bold">', "</span>"],
  ['<span style="font-style:italic;text-decoration:underline">', "</span>"],
  ['<span style="background-color:yellow">', "</span>"],
  ['<span class="stage-dir">', "</span>"],
  ['<span class="audio-cue">', "</span>"],
  ['<span class="cmt-anchor" data-cmt="c1">', "</span>"],
  ["<mark>", "</mark>"],
  ["<b>", "</b>"],
  ["<strong>", "</strong>"],
  ["<em>", "</em>"],
  ["<i>", "</i>"],
  ["<u>", "</u>"],
  ["<s>", "</s>"],
  ["<del>", "</del>"],
  ["<object>", "</object>"],
  ["<table><td>", "</td></table>"],
  ["<font>", "</font>"]
];
const COMBINED: readonly (readonly [string, string])[] = [
  ['<span class="cmt-anchor stage-dir" data-cmt="c1">', "</span>"],
  ['<span class="stage-dir cmt-anchor" data-cmt="c2">', "</span>"],
  ['<span class="cmt-anchor tag-anchor" data-cmt="c1" data-tag-cat="prop" data-tag-name="Lamp">', "</span>"],
  ['<span class="tag-anchor cmt-anchor" data-cmt="c3" data-tag-cat="prop" data-tag-name="Lamp">', "</span>"],
  ['<span class="audio-cue cmt-anchor" data-cmt="c2">', "</span>"],
  ['<span class="cmt-anchor audio-cue" data-cmt="c3">', "</span>"],
  ['<span class="cmt-anchor tag-anchor" data-cmt="c1" data-tag-cat="nope" data-tag-name="">', "</span>"],
  ['<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Lamp">', "</span>"]
];
const LEAVES = ["x", "y z", " ", "<br>", ""];

function genHtml(rnd: () => number, depth: number, openers: readonly (readonly [string, string])[], leaves: readonly string[]): string {
  let out = "";
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    if (depth <= 0 || rnd() < 0.3) {
      out += leaves[Math.floor(rnd() * leaves.length)] ?? "";
    } else {
      const [open, close] = openers[Math.floor(rnd() * openers.length)] ?? ["", ""];
      out += open + genHtml(rnd, depth - 1, openers, leaves) + close;
    }
  }
  return out;
}

const COUNT = Number(process.env["NESTED_LINKS_FUZZ"] || 2000);
const REGRESSION_SEEDS: readonly number[] = [290094, 1000019, 1000034, 1000085, 1000241, 1000257];

test("seeded fuzz: sanitising nested inline elements, links, spans and marks is a fixed point with no link in a link (#290)", () => {
  const seeds = REGRESSION_SEEDS.concat(Array.from({ length: COUNT }, (_, i) => 290000 + i));
  const failures: number[] = [];
  for (const seed of seeds) {
    const html = genHtml(prng(seed), 5, OPENERS, LEAVES);
    const once = rt.sanitize(html);
    if (rt.sanitize(once) !== once || nestedLinks(once)) failures.push(seed);
  }
  if (failures.length) {
    const seed = failures[0] as number;
    const html = genHtml(prng(seed), 5, OPENERS, LEAVES);
    assert.fail(String(failures.length) + " of " + String(seeds.length) + " seeds fail, first " + String(seed) +
      "\ninput: " + html + "\nonce:  " + rt.sanitize(html) + "\ntwice: " + rt.sanitize(rt.sanitize(html)));
  }
});

const SPAN_CLASSES: Readonly<Record<string, readonly string[]>> = {
  "": [],
  "cmt-anchor": ["class", "data-cmt"],
  "tag-anchor": ["class", "data-tag-cat", "data-tag-name", "contenteditable"],
  "broll-key": ["class", "data-broll-id", "contenteditable"],
  "stage-dir": ["class"],
  "audio-cue": ["class"],
  "vec-play": ["class"],
  "vec-host": ["class"]
};
const PLAIN_TAGS = ["strong", "em", "u", "s", "mark", "br"];
const ADDRESS = /^https:\/\/(?:one|two)\.test\/$|^https:\/\/youtu\.be\/x$/;

function allowListViolation(html: string): string | null {
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/g)) {
    if (m[1]) continue;
    const name = m[2] as string;
    const rest = m[3] as string;
    const attrs = Array.from(rest.matchAll(/ ([a-z-]+)="/g), (a) => a[1] as string);
    const cls = /class="([^"]*)"/.exec(rest)?.[1] ?? "";
    if (name === "a") {
      const href = /href="([^"]*)"/.exec(rest)?.[1] ?? "";
      if (!ADDRESS.test(href)) return "address " + href;
      const expected = cls ? ["class", "href"] : ["href", "target", "rel"];
      if (cls && cls !== "video-embed-card") return "link class " + cls;
      if (cls ? attrs.slice().sort().join() !== "class,href,rel,target" : attrs.join() !== expected.join()) return "link attributes " + attrs.join();
    } else if (name === "span") {
      const allowed = SPAN_CLASSES[cls];
      if (!allowed) return "span class " + cls;
      if (!attrs.every((a) => allowed.includes(a))) return "span attributes " + attrs.join() + " on " + cls;
    } else if (!PLAIN_TAGS.includes(name) || attrs.length) {
      return "element " + name + " " + attrs.join();
    }
  }
  return null;
}

function expectedText(html: string): string {
  const doc = new Parser().parseFromString("<!doctype html><body>" + html, "text/html");
  doc.body.querySelectorAll("a.video-embed-card").forEach((c) => { c.remove(); });
  return doc.body.textContent ?? "";
}

function textOf(html: string): string {
  return html.replace(/<a class="video-embed-card"[^>]*>.*?<\/a>/g, "").replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

test("seeded fuzz: links split around links and cards, with comment, tag and cue spans, keep every word, nest no link and admit nothing new (#290)", () => {
  const openers = OPENERS.concat(COMBINED);
  const leaves = LEAVES.concat(["B-roll:", "p", "q"]);
  const failures: string[] = [];
  for (let seed = 700000; seed < 700000 + COUNT; seed++) {
    const html = genHtml(prng(seed), 5, openers, leaves);
    const once = rt.sanitize(html);
    let why: string | null;
    if (rt.sanitize(once) !== once) why = "not a fixed point";
    else if (nestedLinks(once)) why = "a link in a link";
    else if (textOf(once).replace(/\s+/g, "") !== expectedText(html).replace(/\s+/g, "")) why = "text changed";
    else why = allowListViolation(once);
    if (why) failures.push(String(seed) + ": " + why);
  }
  if (failures.length) {
    const seed = Number((failures[0] as string).split(":")[0]);
    const html = genHtml(prng(seed), 5, openers, leaves);
    assert.fail(String(failures.length) + " of " + String(COUNT) + " seeds fail, first " + (failures[0] as string) +
      "\ninput: " + html + "\nonce:  " + rt.sanitize(html) + "\ntwice: " + rt.sanitize(rt.sanitize(html)));
  }
});
