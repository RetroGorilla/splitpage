import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { inertBody, sanitizeHtml } from "../js/04-richtext.js";
import { __init as initTags } from "../js/07-production-tags.js";

initTags();

function assertFixedPoint(html, why) {
  const once = sanitizeHtml(html);
  assert.equal(sanitizeHtml(once), once, (why || "") + "\ninput: " + html + "\nonce:  " + once);
  return once;
}

function nestedLinks(html) {
  let depth = 0, nested = 0;
  for (const m of html.matchAll(/<(\/?)a[\s>]/g)) {
    depth += m[1] ? -1 : 1;
    if (depth > 1) nested++;
  }
  return nested;
}

test("a link inside a link through <object> becomes one link, a fixed point (#290)", () => {
  const once = assertFixedPoint('<a href="https://one.test/"><object><a href="https://two.test/">x</a></object></a>');
  assert.equal(once, '<a href="https://one.test/" target="_blank" rel="noopener">x</a>');
});

test("a link inside a link through a table keeps the outer link on all its text (#290)", () => {
  const once = assertFixedPoint('<a href="https://one.test/">p<table><td><a href="https://two.test/">x</a></td></table>q</a>');
  assert.equal(once, '<a href="https://one.test/" target="_blank" rel="noopener">pxq</a>');
});

test("the inner link keeps its formatting when it is unwrapped", () => {
  const once = assertFixedPoint('<a href="https://one.test/">a<object><a href="https://two.test/"><b>b</b></a></object></a>');
  assert.equal(once, '<a href="https://one.test/" target="_blank" rel="noopener">a<strong>b</strong></a>');
});

test("a link nested inside a span or mark inside a link is unwrapped too", () => {
  for (const wrap of ['<span style="font-weight:bold">', "<mark>", '<span class="stage-dir">']) {
    const close = wrap.startsWith("<mark") ? "</mark>" : "</span>";
    const once = assertFixedPoint('<a href="https://one.test/">' + wrap + '<object><a href="https://two.test/">x</a></object>' + close + "</a>");
    assert.equal(nestedLinks(once), 0, once);
    assert.equal(inertBody(once).querySelectorAll("a").length, 1, once);
  }
});

test("a video card inside a link is unwrapped to text, never a link in a link", () => {
  const once = assertFixedPoint('<a href="https://one.test/">see <object><a class="video-embed-card" href="https://youtu.be/x">' +
    '<span class="vec-play">x</span><span>Watch video</span></a></object></a>');
  assert.equal(nestedLinks(once), 0, once);
  assert.equal(inertBody(once).querySelectorAll("a").length, 1, once);
});

test("an unsafe outer link does not unwrap a safe inner one", () => {
  const once = assertFixedPoint('<a href="javascript:alert(1)">a<object><a href="https://two.test/">x</a></object></a>');
  assert.equal(once, 'a<a href="https://two.test/" target="_blank" rel="noopener">x</a>');
});

test("sibling links stay separate links", () => {
  const once = assertFixedPoint('<a href="https://one.test/">a</a> <a href="https://two.test/">b</a>');
  assert.equal(inertBody(once).querySelectorAll("a").length, 2);
});

function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPENERS = [
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
const LEAVES = ["x", "y z", " ", "<br>", ""];

function genHtml(rnd, depth) {
  let out = "";
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    if (depth <= 0 || rnd() < 0.3) {
      out += LEAVES[Math.floor(rnd() * LEAVES.length)];
    } else {
      const [open, close] = OPENERS[Math.floor(rnd() * OPENERS.length)];
      out += open + genHtml(rnd, depth - 1) + close;
    }
  }
  return out;
}

const REGRESSION_SEEDS = [290094];

test("seeded fuzz: sanitising nested inline elements, links, spans and marks is a fixed point", () => {
  const COUNT = 2000;
  const failures = [];
  const seeds = REGRESSION_SEEDS.concat(Array.from({ length: COUNT }, (_, i) => 290000 + i));
  for (const seed of seeds) {
    const html = genHtml(prng(seed), 5);
    const once = sanitizeHtml(html);
    if (sanitizeHtml(once) !== once || nestedLinks(once)) failures.push(seed);
  }
  if (failures.length) {
    const seed = failures[0];
    const html = genHtml(prng(seed), 5);
    assert.fail(failures.length + " of " + seeds.length + " seeds fail, first " + seed +
      "\ninput: " + html + "\nonce:  " + sanitizeHtml(html) + "\ntwice: " + sanitizeHtml(sanitizeHtml(html)));
  }
});
