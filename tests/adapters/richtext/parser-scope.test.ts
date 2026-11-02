import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedMarkup } from "../../../src/adapters/richtext/parse-bound.ts";
import { storedImageMarkup } from "../../../src/core/document/text-policy.ts";
import { adapterWith, fakePorts } from "./fakes.ts";

const rt = adapterWith(fakePorts());

function strayParagraphWork(html: string): number {
  let divs = 0;
  let paragraph = false;
  let work = 0;
  for (const [, closing, name] of html.matchAll(/<(\/?)(div|p)>/g)) {
    if (name === "div") {
      if (!closing) work += divs;
      divs = closing ? Math.max(0, divs - 1) : divs + 1;
      if (!closing) paragraph = false;
    } else if (closing) {
      if (!paragraph) work += divs;
      paragraph = false;
    } else paragraph = true;
  }
  return work;
}

test("deep div opens followed by stray paragraph closes are bounded before DOM parsing (#461)", () => {
  for (const n of [1000, 5000, 10000, 20000]) {
    const html = "<div>".repeat(n) + "</p>".repeat(n);
    const work = strayParagraphWork(boundedMarkup(html));
    const limit = 8 * html.length + 4096;
    assert.ok(work <= limit, String(work) + " ancestor checks exceeds " + String(limit));
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

test("bounding a hostile block stack keeps its words, image, video, tag and comment, and remains a fixed point (#461)", () => {
  const image = storedImageMarkup({ sha256: "b".repeat(64), width: 17, height: 13, mime: "image/png" });
  const content = 'before<strong>bold</strong>' + image +
    '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug" contenteditable="false">mug</span>' +
    '<span class="cmt-anchor" data-cmt="c1">comment</span>' +
    '<a class="video-embed-card" href="https://youtu.be/example">video</a>after';
  const html = '<div>'.repeat(1000) + content + '</p>'.repeat(1000);
  assert.ok(strayParagraphWork(boundedMarkup(html)) <= 8 * html.length + 4096);
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

test("multiple malformed block stacks and implicitly closed paragraphs stay bounded (#461)", () => {
  const stack = '<p>'.repeat(1000) + '<div>'.repeat(1000) + 'word' + '</p>'.repeat(1000);
  const html = stack + '</div>'.repeat(1000) + stack;
  const bounded = boundedMarkup(html);
  assert.ok(strayParagraphWork(bounded) <= 8 * html.length + 4096);
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
    assert.equal(rt.sanitize(once), once, 'sample ' + String(sample));
  }
});
