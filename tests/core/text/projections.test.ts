import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCell } from "../../../src/core/text/runs.ts";
import { OMIT_CLOSES, spokenText, toDocxRuns, toMarkdown, toPlainText } from "../../../src/core/text/projections.ts";
import { B, COMBINED_E, GRIN, NBSP, SHALOM, T, TECHNOLOGIST, randomCells } from "./cells.ts";

const RANDOM = randomCells(19, 200);

test("plain text: NBSP reads as a space, the ends are trimmed, b-roll keys keep their word", () => {
  assert.equal(toPlainText([T("  a" + NBSP + "b  ")]), "a b");
  assert.equal(toPlainText([T("x "), B("bs1"), T(" drone")]), "x B-roll: drone");
  assert.equal(toPlainText([]), "");
  for (const s of [GRIN, COMBINED_E, TECHNOLOGIST, SHALOM]) assert.equal(toPlainText([T(" " + s + " ", { b: true })]), s);
});

test("a closing mark after a left-out direction pulls the words together", () => {
  for (const ch of [".", ",", ";", ":", "!", "?", ")", "]", "}", "\"", "'", "\u{2019}", "\u{201D}"]) {
    assert.ok(OMIT_CLOSES.test(ch + "x"), ch);
    assert.equal(toPlainText([T("Hi "), T("aside", { dir: true }), T(ch + " there")], { directions: "omit" }), "Hi" + ch + " there", ch);
  }
  assert.ok(!OMIT_CLOSES.test("(x"));
  assert.ok(!OMIT_CLOSES.test(" ."));
});

test("spoken text leaves out cue lines and directions", () => {
  assert.equal(spokenText(normalizeCell([T("MUSIC: theme", { cue: true }), T("\nGo "), T("loudly", { dir: true }), T(" now.")])), "Go now.");
  assert.equal(spokenText([T("aside", { dir: true })]), "");
});

test("Markdown counts characters by code point, so astral and combined characters stay whole", () => {
  assert.equal(toMarkdown([T(GRIN, { b: true }), T(COMBINED_E, { i: true })]), "<strong>" + GRIN + "</strong>*" + COMBINED_E + "*");
  assert.equal(toMarkdown([T("a "), T(GRIN + " b", { dir: true })]), "a *(" + GRIN + " b)*");
  assert.equal(toMarkdown([T("x " + TECHNOLOGIST + " y", { s: true })]), "~~x " + TECHNOLOGIST + " y~~");
  assert.equal(toMarkdown([T(SHALOM, { b: true }), T(" ok")]), "**" + SHALOM + "** ok");
});

test("Markdown: links escape their brackets, blank lines collapse, and the ends are trimmed", () => {
  assert.equal(toMarkdown([T("li]n(k", { href: "https://e.x/a" })]), "[li\\]n\\(k](https://e.x/a)");
  assert.equal(toMarkdown([T("\n\na\n\n\n\nb\n\n")]), "a\n\nb");
  assert.equal(toMarkdown([T("bold ", { b: true }), T("text")]), "**bold** text");
  assert.equal(toMarkdown([T("SFX: rain", { cue: true })]), "*SFX: rain*");
  assert.equal(toMarkdown([T("<u>", { u: true })]), "<u><u></u>");
  assert.equal(toMarkdown([B("bs1"), T(" drone", { hl: true })]), "B-roll: <mark>drone</mark>");
});

test("Markdown's rule of three: two delimiter runs whose lengths are both multiples of three may still pair", () => {
  assert.equal(toMarkdown([T(".", { b: true, i: true }), T("(")]), "***.***(");
  assert.equal(toMarkdown([T("a", { b: true, i: true }), T("a")]), "***a***a");
  assert.equal(toMarkdown([T("x "), T("a", { b: true, i: true }), T(" y")]), "x ***a*** y");
});

test("Markdown's rule of three: with one run a multiple of three and the other not, their sum is not one, so the rule never applies", () => {
  assert.equal(toMarkdown([T("a", { b: true, i: true }), T("b", { i: true }), T("c")]), "***a**b*c");
  assert.equal(toMarkdown([T("a", { b: true, i: true }), T("b", { b: true }), T("c")]), "***a*b**c");
});

test("Markdown's rule of three: runs of one and two that can both open and close do not pair, so plain delimiters are safe", () => {
  assert.equal(toMarkdown([T("a", { b: true }), T("a", { b: true, i: true })]), "**a*a***");
  assert.equal(toMarkdown([T("a", { i: true }), T("a", { b: true, i: true })]), "*a**a***");
  assert.equal(toMarkdown([T(".", { b: true }), T(".", { b: true, i: true })]), "**.*.***");
  assert.equal(toMarkdown([T("a"), T("b", { i: true }), T("c", { b: true, i: true })]), "a*b**c***");
});

test("Word runs carry formatting; annotated, they carry the tag, comments and b-roll key too", () => {
  const cell = [T("a", { tag: "t:prop:X", cmt: ["c1"], b: true }), B("bs1", "B-roll:", { cmt: ["c1"] }), T("b" + NBSP + "c", { dir: true, href: "https://e.x/" })];
  const base = { b: false, i: false, u: false, s: false, mark: false, href: null };
  assert.deepEqual(toDocxRuns(cell), [
    { ...base, text: "a", b: true },
    { ...base, text: "B-roll:" },
    { ...base, text: "(", dir: true },
    { ...base, text: "b c", href: "https://e.x/", dir: true },
    { ...base, text: ")", dir: true }
  ]);
  assert.deepEqual(toDocxRuns(cell, { annotate: true }), [
    { ...base, text: "a", b: true, tag: { cat: "prop", name: "X" }, cmt: ["c1"] },
    { ...base, text: "B-roll:", cmt: ["c1"], broll: "bs1" },
    { ...base, text: "(", dir: true },
    { ...base, text: "b c", href: "https://e.x/", dir: true },
    { ...base, text: ")", dir: true }
  ]);
  assert.deepEqual(toDocxRuns([T("a\nb", { i: true })]), [{ ...base, text: "a", i: true }, { text: "\n" }, { ...base, text: "b", i: true }]);
  assert.deepEqual(toDocxRuns([T("SFX: x", { cue: true })]), [{ ...base, text: "SFX: x", cue: true }]);
  assert.deepEqual(toDocxRuns([T(NBSP)]), [{ ...base, text: " " }]);
});

test("every reader handles any canonical cell and changes nothing it is given", () => {
  for (const cell of RANDOM) {
    const before = JSON.stringify(cell);
    assert.equal(typeof toPlainText(cell), "string");
    assert.equal(typeof toMarkdown(cell), "string");
    const runs = toDocxRuns(cell, { annotate: true });
    assert.equal(runs.map((r) => r.text).join("").replace(/[()]/g, ""),
      normalizeCell(cell).map((r) => r.text).join("").replace(/\u{A0}/gu, " ").replace(/[()]/g, ""));
    assert.equal(JSON.stringify(cell), before);
  }
});
