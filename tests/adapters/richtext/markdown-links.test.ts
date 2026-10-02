import { test } from "node:test";
import assert from "node:assert/strict";
import { toMarkdown } from "../../../src/core/text/projections.ts";
import { adapterWith, fakePorts } from "./fakes.ts";

const rt = adapterWith(fakePorts());
const viaCell = (html: string): string => toMarkdown(rt.decode(html, { onMedia: () => undefined }));

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

test("markdown: a link with no href writes its text alone, on both paths (#281)", () => {
  for (const [html, md] of [
    ["see <a>this</a> here", "see this here"],
    ['see <a href="">this</a> here', "see this here"],
    ["<a><strong>bold</strong> (aside)</a>", "**bold** (aside)"],
    ['<a target="_blank">x]y</a>', "x]y"]
  ] as const) {
    assert.equal(rt.htmlToMarkdown(html), md, html);
    assert.equal(viaCell(html), md, html);
  }
});

test("markdown: a link with an href is written as before (#281)", () => {
  assert.equal(rt.htmlToMarkdown('<a href="https://e.x/">li]nk</a>'), "[li\\]nk](https://e.x/)");
  assert.equal(rt.htmlToMarkdown('<a href="/x">rel</a> <a href="#f">frag</a>'), "[rel](/x) [frag](#f)");
});

const HREFLESS = ["<a>", '<a href="">', '<a target="_blank">'] as const;

function hreflessCase(r: () => number): { html: string; bare: string } {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const words = ["see", "a (b)", "x]y", "[z", "**", "tail ", " ", "é", "&amp;", "\"q\""];
  function frag(depth: number, inLink: boolean): { html: string; bare: string } {
    let html = "", bare = "";
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const k = r();
      if (depth > 2 || k < 0.35) { const w = pick(words); html += w; bare += w; continue; }
      if (k < 0.45) { html += "<br>"; bare += "<br>"; continue; }
      const inner = frag(depth + 1, inLink || k >= 0.75);
      if (k < 0.75) {
        const t = pick(["strong", "em", "s", "u", "mark"]);
        html += "<" + t + ">" + inner.html + "</" + t + ">";
        bare += "<" + t + ">" + inner.bare + "</" + t + ">";
      } else if (inLink) {
        html += inner.html; bare += inner.bare;
      } else if (k < 0.85) {
        html += '<a href="https://e.x/' + String(i) + '">' + inner.html + "</a>";
        bare += '<a href="https://e.x/' + String(i) + '">' + inner.bare + "</a>";
      } else {
        html += pick(HREFLESS) + inner.html + "</a>";
        bare += inner.bare;
      }
    }
    return { html, bare };
  }
  return frag(0, false);
}

test("markdown, seeded: a link with no href writes what its contents alone write, on both paths (#281)", () => {
  const r = seeded(281);
  let hrefless = 0;
  for (let i = 0; i < 600; i++) {
    const { html, bare } = hreflessCase(r);
    if (html !== bare) hrefless++;
    const label = JSON.stringify(html);
    assert.equal(rt.htmlToMarkdown(html), rt.htmlToMarkdown(bare), label);
    assert.equal(viaCell(html), viaCell(bare), label);
    assert.ok(!/\]\((?:null)?\)/.test(rt.htmlToMarkdown(html)), label);
  }
  assert.ok(hrefless > 200, "the generator does make links with no href: " + String(hrefless));
});
