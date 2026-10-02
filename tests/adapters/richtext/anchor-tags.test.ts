import { test } from "node:test";
import assert from "node:assert/strict";
import { adapterWith, fakePorts } from "./fakes.ts";

const rt = adapterWith(fakePorts());

const tagged = (inner: string): string =>
  `<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Lamp" contenteditable="false">${inner}</span>`;
const cmt = (id: string, inner: string): string => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const broll = (id: string): string => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

test("a span that is both a comment anchor and a tag keeps both, the comment outside the tag (#280)", () => {
  for (const classes of ["cmt-anchor tag-anchor", "tag-anchor cmt-anchor", "x-paste tag-anchor cmt-anchor"]) {
    const html = `pick up <span class="${classes}" data-cmt="c1" data-tag-cat="prop" data-tag-name="Lamp">the lamp</span> now`;
    assert.equal(rt.sanitize(html), "pick up " + cmt("c1", tagged("the lamp")) + " now", classes);
  }
});

test("a span that is both a b-roll key and a comment anchor keeps both (#280)", () => {
  for (const classes of ["broll-key cmt-anchor", "cmt-anchor broll-key"]) {
    const html = `<span class="${classes}" data-cmt="c2" data-broll-id="k1">B-roll:</span> drone`;
    assert.equal(rt.sanitize(html), cmt("c2", broll("k1")) + " drone", classes);
  }
});

test("a span that is a comment anchor and a stage direction or an audio cue keeps both (#280)", () => {
  assert.equal(rt.sanitize('<span class="stage-dir cmt-anchor" data-cmt="c3">aside</span>'),
    cmt("c3", '<span class="stage-dir">aside</span>'));
  assert.equal(rt.sanitize('<span class="cmt-anchor audio-cue" data-cmt="c4">SFX: boom</span>'),
    cmt("c4", '<span class="audio-cue">SFX: boom</span>'));
});

test("a mark the sanitiser refuses still leaves the comment (#280)", () => {
  assert.equal(rt.sanitize('a <span class="cmt-anchor tag-anchor" data-cmt="c3" data-tag-cat="nope" data-tag-name="">b</span>'),
    "a " + cmt("c3", "b"));
  assert.equal(rt.sanitize('<span class="broll-key cmt-anchor" data-cmt="c5">Not a marker</span>'), cmt("c5", "Not a marker"));
});

test("the combined span's comment id is cleaned and minted like a lone anchor's (#280)", () => {
  const ports = fakePorts();
  const local = adapterWith(ports);
  const out = local.sanitize('<span class="cmt-anchor tag-anchor" data-tag-cat="prop" data-tag-name="Lamp">x</span>');
  assert.equal(ports.minted.length, 1);
  assert.equal(ports.minted[0]?.prefix, "c");
  assert.equal(out, cmt(ports.minted[0]?.value ?? "", tagged("x")));
  assert.equal(local.sanitize('<span class="cmt-anchor tag-anchor" data-cmt="c 1&lt;&gt;" data-tag-cat="prop" data-tag-name="Lamp">x</span>'),
    cmt("c1", tagged("x")));
});

test("the combined span admits nothing a lone anchor and a lone tag did not (#280)", () => {
  const hostile = '<span class="cmt-anchor tag-anchor" onclick="alert(1)" style="x:y" id="i" data-cmt="c1" data-tag-cat="prop" data-tag-name="Lamp" href="javascript:alert(1)"><img src=x onerror="alert(3)">t</span>';
  const out = rt.sanitize(hostile);
  assert.equal(out, cmt("c1", tagged("t")));
  assert.doesNotMatch(out, /onclick|onerror|<script|<img|javascript|style=|id=/);
});

test("decoding a combined span reads the comment and the tag on the same words (#280)", () => {
  const html = 'pick up <span class="cmt-anchor tag-anchor" data-cmt="c1" data-tag-cat="prop" data-tag-name="Lamp">the lamp</span> now';
  const nested = "pick up " + cmt("c1", tagged("the lamp")) + " now";
  assert.deepEqual(rt.decode(html, { onMedia: () => undefined }), rt.decode(nested, { onMedia: () => undefined }));
  const marked = rt.decode(html, { onMedia: () => undefined }).filter((r) => (r as { marks?: { cmt?: unknown[] } }).marks?.cmt?.length);
  assert.equal(marked.length, 1);
});

test("seeded fuzz: combined spans sanitise to nested spans, and the result is a fixed point (#280)", () => {
  const classesList = ["cmt-anchor tag-anchor", "tag-anchor cmt-anchor", "x-paste tag-anchor cmt-anchor"];
  const words = ["the", "red mug", " ", "a b", "x&lt;y", "&amp;", "lamp "];
  const formats = ["", "", "strong", "em", "u", "s", "mark"];
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)] as T;
    let combined = "", nested = "";
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const id = "c" + String(1 + Math.floor(r() * 3));
      const f = pick(formats);
      const text = pick(words) + pick(words);
      const inner = f ? `<${f}>${text}</${f}>` : text;
      combined += `<span class="${pick(classesList)}" data-cmt="${id}" data-tag-cat="prop" data-tag-name="Lamp">${inner}</span>`;
      nested += cmt(id, tagged(inner));
    }
    const msg = `seed ${String(seed)}: ${combined}`;
    assert.equal(rt.sanitize(combined), nested, msg);
    assert.equal(rt.sanitize(rt.sanitize(combined)), rt.sanitize(combined), msg);
  }
});
