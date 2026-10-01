import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCell } from "../../../src/core/text/runs.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import type { Where } from "../../../src/core/text/html.ts";
import { buildTree } from "../../../src/core/text/tree.ts";
import { B, COMBINED_E, GRIN, NBSP, SHALOM, T, TECHNOLOGIST, randomCells } from "./cells.ts";

const RANDOM = randomCells(41, 200);

const tagSpan = (cat: string, name: string, inner: string) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${inner}</span>`;

test("elements nest in one fixed order: cue, comments, direction, link, tag, then formatting", () => {
  assert.equal(toHtml([T("SFX: x", { cue: true, cmt: ["c1"], dir: true, href: "https://e.x/", tag: "t:prop:X", b: true, i: true, u: true, s: true, hl: true })]),
    '<span class="audio-cue"><span class="cmt-anchor" data-cmt="c1"><span class="stage-dir"><a href="https://e.x/" target="_blank" rel="noopener">' +
    tagSpan("prop", "X", "<mark><strong><em><u><s>SFX: x</s></u></em></strong></mark>") + "</a></span></span></span>");
  assert.equal(toHtml([T("a", { cmt: ["c2", "c1"] })]),
    '<span class="cmt-anchor" data-cmt="c1"><span class="cmt-anchor" data-cmt="c2">a</span></span>');
});

test("an element stays open across runs that share it, so a tag is never split", () => {
  assert.equal(toHtml([T("a", { b: true, cmt: ["c1"] }), T("b", { cmt: ["c1"] })]), '<span class="cmt-anchor" data-cmt="c1"><strong>a</strong>b</span>');
  const html = toHtml([T("ab", { tag: "t:prop:X", cmt: ["c1"] }), T("cd", { tag: "t:prop:X" }), T("ef", { cmt: ["c1"] })]);
  assert.equal((html.match(/tag-anchor/g) || []).length, 1, html);
  assert.equal(toHtml([T("x", { b: true }), T("y", { b: true, i: true }), T("z", { b: true })]), "<strong>x<em>y</em>z</strong>");
});

test("text and attributes are escaped; NBSP is written as an entity", () => {
  assert.equal(toHtml([T("a" + NBSP + "<\"&>'")]), "a&nbsp;&lt;\"&amp;&gt;'");
  assert.equal(toHtml([T("l", { href: "https://e.x/a" + NBSP + "b?a=\"1\"&b" })]),
    '<a href="https://e.x/a&nbsp;b?a=&quot;1&quot;&amp;b" target="_blank" rel="noopener">l</a>');
  assert.equal(toHtml([T("m", { tag: "t:cast:A & \"B\"" })]), tagSpan("cast", "A &amp; &quot;B&quot;", "m"));
  assert.equal(toHtml([T("c", { cmt: ["c<1>"] })]), '<span class="cmt-anchor" data-cmt="c<1>">c</span>');
});

test("Unicode text is written as it is", () => {
  for (const s of [GRIN, COMBINED_E, TECHNOLOGIST, SHALOM]) assert.equal(toHtml([T(s, { i: true })]), "<em>" + s + "</em>");
});

test("line feeds become <br>, and a b-roll key its span, inside its comments and formatting", () => {
  assert.equal(toHtml([T("a\n\nb\n")]), "a<br><br>b<br>");
  assert.equal(toHtml([T("x", { b: true, cmt: ["c1"] }), B("bs_1", "B-roll:", { b: true, cmt: ["c1"] })]),
    '<span class="cmt-anchor" data-cmt="c1"><strong>x<span class="broll-key" data-broll-id="bs_1" contenteditable="false">B-roll:</span></strong></span>');
  assert.equal(toHtml([]), "");
  assert.equal(toHtml(null), "");
});

test("a tag is named by tagOf, by default from its id; one tagOf cannot name loses its element, not its words", () => {
  assert.equal(toHtml([T("mug", { tag: "t:prop:Red mug" })]), tagSpan("prop", "Red mug", "mug"));
  assert.equal(toHtml([T("mug", { tag: "t_1" })]), "mug");
  const tagOf = (id: string) => (id === "t_1" ? { cat: "prop", name: "Red mug" } : null);
  assert.equal(toHtml([T("mug", { tag: "t_1", b: true })], { tagOf }), tagSpan("prop", "Red mug", "<strong>mug</strong>"));
  assert.equal(toHtml([T("mug", { tag: "t:prop:Red mug" })], { tagOf }), "mug");
});

test("textHtml writes each stretch of text and the b-roll key's word, and knows when it is inside a direction", () => {
  const seen: [string, boolean][] = [];
  const html = toHtml([T("a <b>"), T("b\nc", { dir: true }), B("bs1")], {
    textHtml: (text: string, esc: (t: string) => string, where: Where) => { seen.push([text, where.dir]); return "[" + esc(text) + "]"; }
  });
  assert.deepEqual(seen, [["a <b>", false], ["b", true], ["c", true], ["B-roll:", false]]);
  assert.equal(html, '[a &lt;b&gt;]<span class="stage-dir">[b]<br>[c]</span><span class="broll-key" data-broll-id="bs1" contenteditable="false">[B-roll:]</span>');
});

test("toHtml writes the canonical form, whatever runs it is handed", () => {
  for (const cell of RANDOM) assert.equal(toHtml(cell), toHtml(normalizeCell(cell)));
});

test("the tree joins adjacent text and keeps line breaks as their own nodes", () => {
  const t = buildTree([T("a"), T("b", { b: true }), T("\nc")]);
  assert.deepEqual(t.root.kids, [
    { text: "a" },
    { el: { k: "b", v: true }, kids: [{ text: "b" }] },
    { br: true },
    { text: "c" }
  ]);
  assert.deepEqual(t.tagOf("t:prop:X"), { cat: "prop", name: "X" });
});
