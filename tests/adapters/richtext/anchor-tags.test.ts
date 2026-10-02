import { test } from "node:test";
import assert from "node:assert/strict";
import { toHtml } from "../../../src/core/text/html.ts";
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
    '<span class="audio-cue">' + cmt("c4", "SFX: boom") + "</span>");
});

test("a combined span sanitises to the nesting toHtml writes, whatever the class order (#280)", () => {
  const shapes = [
    '<span class="cmt-anchor tag-anchor" data-cmt="c1" data-tag-cat="prop" data-tag-name="Lamp">a</span>',
    '<span class="tag-anchor cmt-anchor" data-cmt="c1" data-tag-cat="prop" data-tag-name="Lamp">a</span>',
    '<span class="broll-key cmt-anchor" data-cmt="c2" data-broll-id="k1">B-roll:</span>',
    '<span class="cmt-anchor broll-key" data-cmt="c2" data-broll-id="k1">B-roll:</span>',
    '<span class="stage-dir cmt-anchor" data-cmt="c3">a</span>',
    '<span class="cmt-anchor stage-dir" data-cmt="c3">a</span>',
    '<span class="audio-cue cmt-anchor" data-cmt="c4">SFX: a</span>',
    '<span class="cmt-anchor audio-cue" data-cmt="c4">Music: a</span>',
    '<span class="cmt-anchor stage-dir audio-cue" data-cmt="c5">SFX: a</span>',
    '<span class="audio-cue cmt-anchor tag-anchor" data-cmt="c6" data-tag-cat="prop" data-tag-name="Lamp">SFX: a</span>'
  ];
  for (const html of shapes) {
    const decoded = rt.decode(html, { onMedia: () => undefined });
    assert.equal(rt.sanitize(html), toHtml(decoded), html);
    assert.equal(rt.sanitize(toHtml(decoded)), toHtml(decoded), html);
  }
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

const MARK_CLASSES = ["tag-anchor", "broll-key", "stage-dir", "audio-cue"] as const;
const ALLOWED_ATTRS: Readonly<Record<string, readonly string[]>> = {
  "cmt-anchor": ["class", "data-cmt"],
  "tag-anchor": ["class", "data-tag-cat", "data-tag-name", "contenteditable"],
  "broll-key": ["class", "data-broll-id", "contenteditable"],
  "stage-dir": ["class"],
  "audio-cue": ["class"]
};
const PLAIN_TAGS = ["strong", "em", "u", "s", "mark", "br"];

function shuffled<T>(r: () => number, list: readonly T[]): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function assertWhitelisted(html: string, msg: string): void {
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/g)) {
    if (m[1]) continue;
    const name = m[2] as string;
    const attrs = Array.from((m[3] as string).matchAll(/([a-z-]+)="/g), (a) => a[1] as string);
    if (name !== "span") {
      assert.ok(PLAIN_TAGS.includes(name), `${msg}: element ${name}`);
      assert.deepEqual(attrs, [], `${msg}: attributes on ${name}`);
      continue;
    }
    const cls = /class="([^"]*)"/.exec(m[3] as string)?.[1] ?? "";
    const allowed = ALLOWED_ATTRS[cls];
    assert.ok(allowed, `${msg}: span class "${cls}"`);
    assert.ok(attrs.every((a) => (allowed as readonly string[]).includes(a)), `${msg}: attributes ${attrs.join(",")} on ${cls}`);
  }
}

test("seeded fuzz: every combination of comment, tag, key, direction and cue, in every class order (#280)", () => {
  const words = ["the", "red mug", " ", "a b", "x&lt;y", "&amp;", "lamp "];
  const formats = ["", "", "strong", "em", "u", "s", "mark"];
  const hostile = ' onclick="alert(1)" style="x:y" id="i" href="javascript:alert(1)"';
  for (let seed = 1; seed <= 1500; seed++) {
    const r = rng(seed);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)] as T;
    let html = "";
    const ids: string[] = [];
    let unnamed = 0;
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const marks = MARK_CLASSES.filter(() => r() < 0.4);
      const withCmt = marks.length === 0 || r() < 0.85;
      const classes = shuffled(r, [...marks, ...(withCmt ? ["cmt-anchor"] : []), ...(r() < 0.2 ? ["x-paste"] : [])]);
      const attrs: string[] = [];
      if (withCmt) {
        if (r() < 0.25) unnamed++;
        else {
          const id = "c" + String(1 + Math.floor(r() * 3));
          ids.push(id);
          attrs.push(`data-cmt="${id}"`);
        }
      }
      attrs.push('data-tag-cat="prop" data-tag-name="Lamp" data-broll-id="k1"');
      const f = pick(formats);
      const text = marks.includes("broll-key") ? "B-roll:" : marks.includes("audio-cue") ? "SFX: boom" : pick(words) + pick(words);
      const inner = f && !marks.includes("broll-key") ? `<${f}>${text}</${f}>` : text;
      html += (i ? "<br>" : "") + `<span class="${classes.join(" ")}" ${shuffled(r, attrs).join(" ")}${r() < 0.3 ? hostile : ""}>${inner}</span>`;
    }
    const msg = `seed ${String(seed)}: ${html}`;
    const once = rt.sanitize(html);
    assert.equal(rt.sanitize(once), once, msg);
    assertWhitelisted(once, msg);
    assert.doesNotMatch(once, /onclick|style=|id="i"|href=|javascript/, msg);
    for (const id of new Set(ids)) assert.ok(once.includes(`data-cmt="${id}"`), `${msg}: lost comment ${id}`);
    assert.equal(Array.from(once.matchAll(/data-cmt="/g)).length >= ids.length + unnamed, true, `${msg}: comment count`);
    const unminted = (s: string): string => s.replace(/cMinted\d+/g, "cMinted");
    assert.equal(unminted(once), unminted(toHtml(rt.decode(html, { onMedia: () => undefined }))), msg);
  }
});
