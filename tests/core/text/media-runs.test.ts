import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteRange, joinCells, setMark, splitCell } from "../../../src/core/text/edits.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { atomId, cellLength, isMediaRun, normalizeCell, projection } from "../../../src/core/text/runs.ts";
import type { ImageRun, Marks, VideoRun } from "../../../src/core/text/runs.ts";
import { MEDIA_KEY, cellKeys, editorKeys } from "../../../src/core/text/selection.ts";
import { B, OBJ, T } from "./cells.ts";

const SHA = "ab".repeat(32);

function I(marks?: Marks, ref?: ImageRun["ref"]): ImageRun {
  return { atom: "image", ref: ref || { sha256: SHA }, text: "", marks: marks || {} };
}

function V(href: string, marks?: Marks): VideoRun {
  return { atom: "video", href: href, host: "youtu.be", text: "", marks: marks || {} };
}

const CARD = '<a class="video-embed-card" href="https://youtu.be/abc" target="_blank" rel="noopener">' +
  '<span class="vec-play">\u{25B6}</span><span>Watch video</span><span class="vec-host">\u{B7} youtu.be</span></a>';

test("normalizeCell keeps pictures and video cards as atoms with an empty text", () => {
  const cell = normalizeCell([T("a"), I(), V("https://youtu.be/abc"), T("b")]);
  assert.deepEqual(cell, [T("a"), I(), V("https://youtu.be/abc"), T("b")]);
  assert.ok(cell.every((r) => !isMediaRun(r) || r.text === ""));
});

test("normalizeCell drops a picture with no valid hash and a card with an unsafe link", () => {
  assert.deepEqual(normalizeCell([I({}, { sha256: "nope" }), V("javascript:alert(1)"), V("data:text/html,x"), T("x")]), [T("x")]);
});

test("a picture keeps its size and type only when all three are valid", () => {
  const full = { sha256: SHA, width: 7, height: 5, mime: "image/png" };
  assert.deepEqual(normalizeCell([I({}, full)]), [I({}, full)]);
  assert.deepEqual(normalizeCell([I({}, { sha256: SHA, width: 7, height: 0, mime: "image/png" })]), [I()]);
  assert.deepEqual(normalizeCell([I({}, { sha256: SHA, width: 7, height: 5, mime: "text/html" })]), [I()]);
});

test("media atoms keep format, link and comment marks; text-only marks and a card's link are dropped", () => {
  const marks = { b: true, href: "https://e.x/", cmt: ["c1"], tag: "t:prop:Mug", dir: true, cue: true } as const;
  const [pic, card] = normalizeCell([I(marks), V("https://youtu.be/abc", marks)]);
  assert.deepEqual(pic?.marks, { b: true, href: "https://e.x/", cmt: ["c1"] });
  assert.deepEqual(card?.marks, { b: true, cmt: ["c1"] });
});

test("a media atom is one place: in the projection, the length, the selection keys and the atom ids", () => {
  const cell = normalizeCell([T("ab"), I(), V("https://youtu.be/abc"), B("bs1")]);
  assert.equal(projection(cell), "ab" + OBJ + OBJ + OBJ);
  assert.equal(cellLength(cell), 5);
  assert.deepEqual(cellKeys(cell), ["a", "b", OBJ + "image:" + SHA, OBJ + "video:https://youtu.be/abc", OBJ + "bs1"]);
  assert.equal(atomId(B("bs1")), "bs1");
});

test("the editor's selection keys name every media atom as the DOM does, and keep b-roll ids", () => {
  const cell = normalizeCell([T("ab"), I(), V("https://youtu.be/abc"), B("bs1")]);
  assert.deepEqual(editorKeys(cell), ["a", "b", MEDIA_KEY, MEDIA_KEY, OBJ + "bs1"]);
  assert.equal(MEDIA_KEY, OBJ + "#media");
});

test("toHtml writes a picture as its stored image markup and a card as the stored card", () => {
  assert.equal(toHtml([T("See "), I(), T(" and "), V("https://youtu.be/abc")]),
    'See <img class="comment-img" data-blob="' + SHA + '"> and ' + CARD);
  assert.equal(toHtml([I({ b: true, cmt: ["c1"] })]), '<span class="cmt-anchor" data-cmt="c1"><strong><img class="comment-img" data-blob="' + SHA + '"></strong></span>');
  assert.equal(toHtml([V("https://e.x/?a=1&b=\"2\"")]), CARD.replace("https://youtu.be/abc", "https://e.x/?a=1&amp;b=&quot;2&quot;"));
});

test("a split, a delete and a join treat a media atom as one indivisible place", () => {
  const cell = normalizeCell([T("Ab "), V("https://youtu.be/abc"), T(" cd")]);
  assert.deepEqual(splitCell(cell, 4), [[T("Ab "), V("https://youtu.be/abc")], [T(" cd")]]);
  assert.deepEqual(splitCell(cell, 3), [[T("Ab ")], [V("https://youtu.be/abc"), T(" cd")]]);
  assert.deepEqual(deleteRange(cell, 3, 4), [T("Ab  cd")]);
  assert.deepEqual(joinCells([T("x")], [I(), T("y")], " "), [T("x "), I(), T("y")]);
});

test("formatting across a media atom marks the atom too", () => {
  const cell = normalizeCell([T("a"), I(), T("b")]);
  assert.deepEqual(setMark(cell, 0, 3, "b", true), [T("a", { b: true }), I({ b: true }), T("b", { b: true })]);
});
