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
  assert.equal(assertFixedPoint(hostile(same, 100)), assertFixedPoint(hostile(same.slice(0, 1), 100)));
  const apart = assertFixedPoint(hostile(distinctAnchors(3), 2));
  assert.equal(apart.match(/data-cmt="c0"/g)?.length, 5);
  assert.equal(apart.match(/data-cmt="c2"/g)?.length, 5);
});

test("a chain with a repeated mark stays as written while its splits are few (#355)", () => {
  const s3 = (inner: string): string => "<strong><strong><strong>" + inner + "</strong></strong></strong>";
  const link = (href: string, inner: string): string => '<a href="' + href + '" target="_blank" rel="noopener">' + inner + "</a>";
  assert.equal(assertFixedPoint(hostile(repeated([STRONG], 3), 1)),
    link("https://one.test/", s3("p")) + link("https://two.test/", s3("x")) + link("https://one.test/", s3("q")));
  const s20 = (inner: string): string => "<strong>".repeat(20) + inner + "</strong>".repeat(20);
  assert.equal(assertFixedPoint(hostile(repeated([STRONG], 20), 1)),
    link("https://one.test/", s20("p")) + link("https://two.test/", s20("x")) + link("https://one.test/", s20("q")));
});

test("more splits than the budget allows unwrap the inner links and keep every word (#355)", () => {
  const deep = hostile(distinctAnchors(300), 120);
  const once = assertFixedPoint(deep);
  assert.equal(linkCount(once), 1);
  assert.equal(textOf(once), expectedText(deep));
  assert.ok(once.length < deep.length, String(once.length) + " from " + String(deep.length));
});

test("a card inside a link over the budget is dropped, as an unsafe card is (#355)", () => {
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

test("a link over the budget unwraps its own inner links only, and still splits the link around it (#355)", () => {
  const middle = '<a href="https://two.test/">' + around(distinctAnchors(300), "<object>" + Array.from({ length: 120 }, () => '<a href="https://three.test/">z</a>').join("") + "</object>") + "</a>";
  const html = OUTER + "p<object>" + middle + "</object>q</a>";
  const once = assertFixedPoint(html);
  assert.equal(linkCount(once), 3);
  assert.equal(nestedLinks(once), 0);
  assert.doesNotMatch(once, /three\.test/);
  assert.equal(textOf(once), expectedText(html));
});

function pageLinks(count: number): string {
  return Array.from({ length: count }, (_, i) => '<a href="https://example.com/page-' + String(i) + '">link ' + String(i) + "</a>").join(" ");
}

function levels(depth: number, marks: readonly Mark[], innermost: string): string {
  let html = innermost;
  for (let l = 0; l < depth; l++) html = '<a href="https://l' + String(l) + '.test/">' + around(marks, "p<object>" + html + "</object>q") + "</a>";
  return html;
}

function tree(depth: number, fanout: number, marks: readonly Mark[]): string {
  if (!depth) return INNER;
  const kids = Array.from({ length: fanout }, () => tree(depth - 1, fanout, marks)).join("t");
  return '<a href="https://d' + String(depth) + '.test/">' + around(marks, "p<object>" + kids + "</object>q") + "</a>";
}

function tagAnchors(depth: number): Mark[] {
  return Array.from({ length: depth }, (_, i) => ['<span class="tag-anchor" data-tag-cat="prop" data-tag-name="' + String(i).padEnd(80, "n") + '">', "</span>"] as const);
}

function plainSiblings(count: number): string {
  return Array.from({ length: count }, () => INNER).join("t");
}

test("links nested inside links keep the output within 14 code units per input code unit plus 4096, at any depth (#355)", () => {
  const shapes: Record<string, string> = {
    "100 link levels, 1 mark each, 300 innermost links": levels(100, [STRONG], pageLinks(300)),
    "12 link levels, 8 marks each, 200 innermost links": levels(12, repeated([STRONG, EM, ["<u>", "</u>"], ["<s>", "</s>"], ["<mark>", "</mark>"]], 8), pageLinks(200)),
    "a tree of links 6 deep with 3 links in each": tree(6, 3, [STRONG]),
    "100 sibling links, each 9 distinct anchors around 30 inner links": Array.from({ length: 100 }, () => hostile(distinctAnchors(9), 30)).join(" "),
    "400 repeating marks around 300 inner links": hostile(repeated([STRONG], 400), 300),
    "9 distinct comment anchors around 2000 inner links": hostile(distinctAnchors(9), 2000),
    "8 tag anchors with 80-character names around 3000 inner links": hostile(tagAnchors(8), 3000),
    "a 2000-character href around 3000 inner links": '<a href="https://one.test/' + "h".repeat(2000) + '">p<object>' + plainSiblings(3000) + "</object>q</a>"
  };
  for (const [name, html] of Object.entries(shapes)) {
    const once = rt.sanitize(html);
    assert.equal(rt.sanitize(once), once, name);
    assert.equal(nestedLinks(once), 0, name);
    assert.equal(textOf(once), expectedText(html), name);
    assert.ok(once.length <= 14 * html.length + 4096, name + ": " + String(once.length) + " from " + String(html.length));
  }
});

test("one deeply formatted inner link leaves its plain sibling links split (#355)", () => {
  const deep = around(distinctAnchors(9), '<a href="https://deep.test/">deep</a>');
  const html = OUTER + "p<object>" + deep + Array.from({ length: 60 }, (_, i) => '<a href="https://x.test/' + String(i) + '">' + String(i) + "</a>").join("") + "</object>q</a>";
  const once = assertFixedPoint(html);
  assert.equal(linkCount(once), 63);
  assert.equal(nestedLinks(once), 0);
  assert.match(once, /deep\.test/);
  assert.match(once, /x\.test\/59"/);
});

const TRACKING = "https://click.news.example.com/ls/click?utm_source=newsletter&utm_medium=email&utm_campaign=autumn&upn=".padEnd(400, "aZ3_9-Qx");

function newsletter(cells: number, href: string): string {
  const cell = (i: number): string => '<td>Shop the <a href="https://x.co/' + String(i) + '">range ' + String(i) + "</a> while it lasts</td>";
  const rows = Array.from({ length: Math.ceil(cells / 5) }, (_, r) =>
    "<tr>" + Array.from({ length: Math.min(5, cells - 5 * r) }, (_, c) => cell(5 * r + c)).join("") + "</tr>");
  return '<a href="' + href.split("&").join("&amp;") + '"><table><tbody>' + rows.join("") + "</tbody></table></a>";
}

test("a newsletter's 400-character tracking link round a 50-cell table of product links keeps every link (#355)", () => {
  const html = newsletter(50, TRACKING);
  const once = assertFixedPoint(html);
  assert.equal(linkCount(once), 101);
  assert.equal(nestedLinks(once), 0);
  assert.equal(once.split('href="https://x.co/').length - 1, 50);
  assert.equal(once.split("&amp;upn=aZ3_9-Qx").length - 1, 51);
  assert.equal(textOf(once), expectedText(html));
});

const NBSP = String.fromCharCode(0xa0);
const ESCAPED: readonly string[] = ["&", '"', "<", ">", NBSP];

function specials(text: string): number {
  return Array.from(text).filter((c) => ESCAPED.includes(c)).length;
}

function shell(tag: string, attributes: readonly (readonly [string, string])[]): number {
  return 2 * tag.length + 5 + attributes.reduce((n, [name, value]) => n + name.length + 4 + value.length + 5 * specials(value), 0);
}

function linkShell(href: string): number {
  return shell("a", [["href", href], ["target", "_blank"], ["rel", "noopener"]]);
}

interface Shape {
  readonly body: string;
  readonly cost: number;
}

interface Edge {
  readonly html: string;
  readonly stretch: string;
}

function edgeOf(over: number, build: (stretch: string) => Shape): Edge {
  for (let k = 0; k < 64; k++) {
    const stretch = "h".repeat(k);
    const shape = build(stretch);
    const gap = shape.cost - over - 4096 - 8 * shape.body.length;
    if (gap >= 0 && gap % 8 === 0) return { html: "w".repeat(gap / 8) + shape.body, stretch };
  }
  throw new Error("no shape lands on the edge");
}

function onTheEdge(over: number, build: (stretch: string) => Shape): string {
  return edgeOf(over, build).html;
}

function sanitisedLink(href: string, inner: string): string {
  return '<a href="' + href.split("&").join("&amp;") + '" target="_blank" rel="noopener">' + inner + "</a>";
}

function plainLink(href: string, links: number): Shape {
  return {
    body: '<a href="' + href + '">p<object>' + plainSiblings(links) + "</object>q</a>",
    cost: (links + 1) * linkShell(href)
  };
}

const LONG_HREF = "https://one.test/?a=1&b=2&" + "x".repeat(600);

test("a split that costs exactly the budget is made, and one character more unwraps instead (#355)", () => {
  const build = (stretch: string): Shape => plainLink(LONG_HREF + stretch, 30);
  assert.equal(linkCount(assertFixedPoint(onTheEdge(0, build))), 61);
  assert.equal(linkCount(assertFixedPoint(onTheEdge(1, build))), 1);
});

test("the budget counts every shell a split opens once per piece, and a mark shared by a piece's steps once, and the split built is the one counted (#355)", () => {
  const build = (stretch: string): Shape => {
    const href = LONG_HREF + stretch;
    const marks = "<strong></strong>".length + "<em></em>".length;
    return {
      body: '<a href="' + href + '">' + around([STRONG, EM], "p<object>" + Array.from({ length: 30 }, () => INNER).join("t<u>v</u>") + "</object>q") + "</a>",
      cost: 31 * (linkShell(href) + marks) + 30 * marks
    };
  };
  const edge = edgeOf(0, build);
  const href = LONG_HREF + edge.stretch;
  const marked = (inner: string): string => "<strong><em>" + inner + "</em></strong>";
  const point = sanitisedLink("https://two.test/", marked("x"));
  assert.equal(assertFixedPoint(edge.html), edge.html.slice(0, edge.html.indexOf("<a")) + sanitisedLink(href, marked("p")) + point +
    (sanitisedLink(href, marked("t<u>v</u>")) + point).repeat(29) + sanitisedLink(href, marked("q")));
  assert.equal(linkCount(assertFixedPoint(onTheEdge(1, build))), 1);
});

test("the budget counts each &, \", <, > and no-break space in a cloned attribute value as 6 code units (#355)", () => {
  const name = '"t>a' + NBSP + "g&n<m";
  const anchor = shell("span", [["class", "tag-anchor"], ["data-tag-cat", "prop"], ["data-tag-name", name], ["contenteditable", "false"]]);
  const quoted = (value: string): string => "'" + value.split("&").join("&amp;").split(NBSP).join("&nbsp;") + "'";
  const build = (stretch: string): Shape => {
    const href = 'https://one.test/?q="a' + NBSP + "b&c<d>e&" + "x".repeat(600) + stretch;
    return {
      body: "<a href=" + quoted(href) + '><span class="tag-anchor" data-tag-cat="prop" data-tag-name=' + quoted(name) + ">p<object>" +
        plainSiblings(30) + "</object>q</span></a>",
      cost: 31 * (linkShell(href) + anchor) + 30 * anchor
    };
  };
  const at = assertFixedPoint(onTheEdge(0, build));
  assert.equal(linkCount(at), 61);
  assert.equal(at.split("data-tag-name=").length - 1, 61);
  assert.equal(linkCount(assertFixedPoint(onTheEdge(1, build))), 1);
});

test("a repeated mark stays as written while the split fits the budget, and collapses one character past it (#355)", () => {
  const build = (stretch: string): Shape => {
    const href = LONG_HREF + stretch;
    const marks = 2 * "<strong></strong>".length;
    return {
      body: '<a href="' + href + '">' + around([STRONG, STRONG], "p<object>" + plainSiblings(30) + "</object>q") + "</a>",
      cost: 31 * (linkShell(href) + marks) + 30 * marks
    };
  };
  const at = assertFixedPoint(onTheEdge(0, build));
  assert.equal(linkCount(at), 61);
  assert.match(at, /<strong><strong>x<\/strong><\/strong>/);
  const past = assertFixedPoint(onTheEdge(1, build));
  assert.equal(linkCount(past), 61);
  assert.doesNotMatch(past, /<strong><strong>/);
});

function doubledStrong(href: string): Shape {
  const strong = "<strong></strong>".length;
  return {
    body: '<a href="' + href + '">' + around([STRONG, STRONG], "p<object>" + plainSiblings(30) + "</object>q") + "</a>",
    cost: 31 * (linkShell(href) + strong) + 30 * strong
  };
}

test("after a collapse the collapsed split is what must fit and what is spent (#355)", () => {
  const alone = (stretch: string): Shape => doubledStrong(LONG_HREF + stretch);
  const fits = assertFixedPoint(onTheEdge(0, alone));
  assert.equal(linkCount(fits), 61);
  assert.doesNotMatch(fits, /<strong><strong>/);
  assert.equal(linkCount(assertFixedPoint(onTheEdge(1, alone))), 1);
  const pair = (stretch: string): Shape => {
    const first = doubledStrong(LONG_HREF + stretch);
    const second = plainLink("https://z.test/", 1);
    return { body: first.body + second.body, cost: first.cost + second.cost };
  };
  assert.equal(linkCount(assertFixedPoint(onTheEdge(0, pair))), 64);
  assert.equal(linkCount(assertFixedPoint(onTheEdge(1, pair))), 62);
});

test("the budget is shared by the whole input: the second of two links gets only what the first left (#355)", () => {
  const build = (stretch: string): Shape => {
    const first = plainLink(LONG_HREF, 30);
    const second = plainLink(LONG_HREF + stretch, 30);
    return { body: first.body + second.body, cost: first.cost + second.cost };
  };
  assert.equal(linkCount(assertFixedPoint(onTheEdge(0, build))), 122);
  const past = assertFixedPoint(onTheEdge(1, build));
  assert.equal(linkCount(past), 62);
  assert.equal(linkCount(past.slice(0, past.indexOf("q</a>") + 5)), 61);
});

test("what an inner link spent before its outer link unwraps stays spent (#355)", () => {
  const big = "https://big.test/" + "y".repeat(1000);
  const strong = "<strong></strong>".length;
  const spent = 2 * (linkShell("https://two.test/") + strong) + strong;
  const unwrapped = '<a href="' + big + '">p<object><a href="https://two.test/"><strong>x<object><a href="https://three.test/">z</a></object>y</strong></a>' +
    plainSiblings(400) + "</object>q</a>";
  const left = rt.sanitize(unwrapped);
  assert.equal(linkCount(left), 1);
  assert.equal(left.split("<strong>").length - 1, 3);
  const build = (stretch: string): Shape => {
    const second = plainLink(LONG_HREF + stretch, 400);
    return { body: unwrapped + second.body, cost: spent + second.cost };
  };
  assert.equal(linkCount(assertFixedPoint(onTheEdge(0, build))), 802);
  assert.equal(linkCount(assertFixedPoint(onTheEdge(1, build))), 2);
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
  const link = OUTER + around(marks, "p<object>" + parts.join("") + "</object>q") + "</a>";
  if (rnd() < 0.6) return link;
  const levelMarks = Array.from({ length: Math.floor(rnd() * 6) }, () => pick(POOL));
  return levels(1 + Math.floor(rnd() * 12), levelMarks, rnd() < 0.5 ? link : link + "t" + link);
}

test("seeded fuzz: deep chains and links nested in links stay a fixed point, nest no link, keep every word and stay within the bound (#355)", () => {
  const failures: string[] = [];
  for (let seed = 355000; seed < 355000 + COUNT; seed++) {
    const html = generated(seed);
    const once = rt.sanitize(html);
    let why: string | null = null;
    if (rt.sanitize(once) !== once) why = "not a fixed point";
    else if (nestedLinks(once)) why = "a link in a link";
    else if (textOf(once).replace(/\s+/g, "") !== expectedText(html).replace(/\s+/g, "")) why = "text changed";
    else if (once.length > 14 * html.length + 4096) why = "output of " + String(once.length) + " from " + String(html.length);
    if (why) failures.push(String(seed) + ": " + why);
  }
  assert.deepEqual(failures, []);
});
