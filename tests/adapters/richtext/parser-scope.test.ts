import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedMarkup } from "../../../src/adapters/richtext/parse-bound.ts";
import { storedImageMarkup } from "../../../src/core/document/text-policy.ts";
import { adapterWith, fakePorts } from "./fakes.ts";
import { jsdomParser } from "./jsdom.mjs";
import { splitBudget, walkSanitize } from "../../../src/adapters/richtext/sanitize.ts";
import { createRichText } from "../../../src/adapters/richtext/richtext.ts";

const rt = adapterWith(fakePorts());
const Parser: new () => DOMParser = jsdomParser();

function baseSanitize(html: string): string {
  const ports = fakePorts();
  const body = new Parser().parseFromString('<!doctype html><body>' + html, 'text/html').body;
  const doc = body.ownerDocument;
  const out = doc.createElement('div');
  walkSanitize(body, out, { doc, images: ports.images, ids: ports.ids, split: splitBudget(html.length) });
  return out.innerHTML;
}

test("deep blocks do not close an italic span before its text (#461)", () => {
  const html = '<div>'.repeat(32) + '<span style="font-style:italic">' + '<div>'.repeat(400) +
    'KEEP' + '</p>'.repeat(400);
  const body = rt.inertBody(rt.sanitize(html));
  assert.equal(body.querySelector('em')?.textContent?.trim(), 'KEEP');
  assert.equal(rt.sanitize(html), baseSanitize(html));
});

test("deep blocks keep comment text inside its anchor (#461)", () => {
  const html = '<div>'.repeat(32) + '<span class="cmt-anchor" data-cmt="c1">' + '<div>'.repeat(400) +
    'KEEP' + '</p>'.repeat(400);
  const once = rt.sanitize(html);
  assert.equal(rt.inertBody(once).querySelector('[data-cmt="c1"]')?.textContent?.trim(), 'KEEP');
  assert.equal(rt.sanitize(once), once);
  assert.equal(once, baseSanitize(html));
});

test("foreign-content breakouts cannot bypass the block-depth guard (#461)", () => {
  for (const prefix of ['<svg>', '<math>', '<svg><foreignObject>', '<math><annotation-xml encoding="text/html">',
    '<svg><desc>', '<svg><title>', '<math><mi>', '<math><mo>', '<math><mn>', '<math><ms>', '<math><mtext>',
    ...['b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta',
      'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table',
      'tt', 'u', 'ul', 'var', 'font color="red"', 'font face="serif"', 'font size="3"'].map(tag => '<svg><' + tag + '>')]) {
    const html = prefix + '<div>'.repeat(5000) + 'KEEP' + '</p>'.repeat(5000);
    assert.throws(() => boundedMarkup(html), RangeError, prefix);
  }
});

test("rejected block depth never reaches DOMParser (#461)", () => {
  let calls = 0;
  class CountingParser extends Parser {
    override parseFromString(html: string, type: DOMParserSupportedType): Document {
      calls++;
      return super.parseFromString(html, type);
    }
  }
  const guarded = createRichText({ ...fakePorts(), DOMParser: CountingParser });
  assert.throws(() => guarded.sanitize('<svg>' + '<div>'.repeat(20000) + 'KEEP' + '</p>'.repeat(20000)), RangeError);
  assert.equal(calls, 0);
});

test("excessive block depth is rejected before parsing instead of rewriting inline scopes (#461)", () => {
  for (const n of [1000, 2048]) {
    const html = "<div>".repeat(n) + "</p>".repeat(n);
    assert.equal(boundedMarkup(html), html);
  }
  for (const n of [2049, 5000, 10000, 20000]) {
    const html = "<div>".repeat(n) + "</p>".repeat(n);
    assert.throws(() => boundedMarkup(html), { name: "RichTextDepthError" });
    assert.throws(() => rt.inertBody(html), { name: "RichTextDepthError" });
  }
});

test("ordinary blocks, quoted tag text, raw text and rich-text atoms are unchanged by the scope bound (#461)", () => {
  const image = storedImageMarkup({ sha256: "a".repeat(64), width: 17, height: 13, mime: "image/png" });
  const content = '<strong>bold</strong><em>italic</em><u>underlined</u><s>struck</s><mark>marked</mark>' +
    '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug" contenteditable="false">mug</span>' +
    '<span class="cmt-anchor" data-cmt="c1">comment</span>' + image +
    '<a class="video-embed-card" href="https://youtu.be/example">video</a>';
  const shapes = [
    '<div class="article"><p>' + content + '</p><div><p>more</p></div></div>',
    '<div>'.repeat(1000) + '<p>' + content + '</p>' + '</div>'.repeat(1000),
    '<b>'.repeat(1000) + 'word' + '</b>'.repeat(1000),
    '<div title="' + '<div></p>'.repeat(1000) + '">word</div>',
    '<!--' + '<div></p>'.repeat(1000) + '--><p>word</p>',
    '<script>' + '<div></p>'.repeat(1000) + '</script><p>word</p>',
    '<textarea>' + '<div></p>'.repeat(1000) + '</textarea><p>word</p>',
    Array.from({ length: 1000 }, () => '<div><p>' + content + '</p></div>').join('')
  ];
  for (const html of shapes) assert.equal(boundedMarkup(html), html);
});

test("accepted deep blocks keep their words, image, video, tag and comment, and remain a fixed point (#461)", () => {
  const image = storedImageMarkup({ sha256: "b".repeat(64), width: 17, height: 13, mime: "image/png" });
  const content = 'before<strong>bold</strong>' + image +
    '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug" contenteditable="false">mug</span>' +
    '<span class="cmt-anchor" data-cmt="c1">comment</span>' +
    '<a class="video-embed-card" href="https://youtu.be/example">video</a>after';
  const html = '<div>'.repeat(1000) + content + '</p>'.repeat(1000);
  assert.equal(boundedMarkup(html), html);
  const once = rt.sanitize(html);
  assert.ok(once.includes('<strong>bold</strong>'));
  assert.ok(once.includes(image));
  assert.ok(once.includes('data-tag-name="Mug"'));
  assert.ok(once.includes('data-cmt="c1"'));
  assert.ok(once.includes('class="video-embed-card"'));
  const body = rt.inertBody(once);
  assert.ok(body.textContent?.startsWith("beforeboldmugcomment"));
  assert.ok(body.textContent?.endsWith("after"));
  assert.equal(body.querySelectorAll("img").length, 1);
  assert.equal(body.querySelectorAll("a.video-embed-card").length, 1);
  assert.equal(rt.sanitize(once), once);
});

test("separate accepted block stacks retain their contents and fixed point (#461)", () => {
  const stack = '<p>'.repeat(1000) + '<div>'.repeat(1000) + 'word' + '</p>'.repeat(1000);
  const html = stack + '</div>'.repeat(1000) + stack;
  const bounded = boundedMarkup(html);
  assert.equal(bounded, html);
  assert.equal(boundedMarkup(bounded), bounded);
  const once = rt.sanitize(html);
  assert.equal(rt.inertBody(once).textContent?.replace(/\s/g, ''), 'wordword');
  assert.equal(rt.sanitize(once), once);
});

test("seeded normal block trees keep their exact markup and sanitizer result (#461)", () => {
  let seed = 461;
  function pick(n: number): number {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  }
  const atoms = [
    '<strong>bold</strong>', '<em>italic</em>', '<u>underlined</u>', '<s>struck</s>', '<mark>marked</mark>',
    '<span class="stage-dir">direction</span>',
    '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug" contenteditable="false">mug</span>',
    '<span class="cmt-anchor" data-cmt="c1">comment</span>',
    storedImageMarkup({ sha256: 'c'.repeat(64), width: 17, height: 13, mime: 'image/png' }),
    '<a class="video-embed-card" href="https://youtu.be/example">video</a>'
  ];
  for (let sample = 0; sample < 200; sample++) {
    let html = '';
    for (let block = 0, count = 1 + pick(20); block < count; block++) {
      let content = atoms[pick(atoms.length)] + 'word' + String(block);
      for (let mark = 0, count = pick(5); mark < count; mark++) content = '<strong>' + content + '</strong>';
      const depth = pick(100);
      html += '<div class="block">'.repeat(depth) + '<p>' + content + '</p>' + '</div>'.repeat(depth);
    }
    assert.equal(boundedMarkup(html), html, 'sample ' + String(sample));
    const once = rt.sanitize(html);
    assert.equal(once, baseSanitize(html), 'sample ' + String(sample));
    assert.equal(rt.sanitize(once), once, 'sample ' + String(sample));
  }
});
