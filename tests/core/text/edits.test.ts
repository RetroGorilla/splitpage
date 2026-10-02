import { test } from "node:test";
import assert from "node:assert/strict";
import { cellLength, normalizeCell, projection } from "../../../src/core/text/runs.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import {
  addComment,
  breakLine,
  clamp,
  commentRange,
  deleteRange,
  insertBrollKey,
  insertText,
  insideDirection,
  joinCells,
  markThroughout,
  marksAt,
  removeComment,
  replaceText,
  replaceWithBrollKey,
  replaceWithTag,
  retag,
  setMark,
  sliceCell,
  splitCell,
  toggleMark,
  typingMarks
} from "../../../src/core/text/edits.ts";
import { B, COMBINED_E, GRIN, NBSP, OBJ, SHALOM, T, TECHNOLOGIST, THUMB, ZWJ, ZWSP, randomCells, rng } from "./cells.ts";

const RANDOM = randomCells(7, 300);

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function wholeCodePoints(cell: readonly Run[], what: string): void {
  for (const r of cell) assert.ok(!LONE.test(r.text), what + ": a lone surrogate in " + JSON.stringify(r.text));
}

function pairCuts(cell: readonly Run[]): number[] {
  const p = projection(cell);
  const cuts: number[] = [];
  for (let i = 1; i < p.length; i++) {
    const hi = p.charCodeAt(i - 1), lo = p.charCodeAt(i);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) cuts.push(i);
  }
  return cuts;
}

function caretAt(cuts: readonly number[], p: number): number {
  return cuts.includes(p) ? p + 1 : p;
}

function rangeAt(cuts: readonly number[], p: number, q: number): [number, number] {
  const lo = Math.min(p, q), hi = Math.max(p, q);
  if (lo === hi) return [caretAt(cuts, lo), caretAt(cuts, lo)];
  return [cuts.includes(lo) ? lo - 1 : lo, caretAt(cuts, hi)];
}

const PAIRED = [
  normalizeCell([T("a" + GRIN + "b", { b: true }), B("bs1"), T(THUMB + TECHNOLOGIST, { cmt: ["c1"] }), T(GRIN, { tag: "t:prop:X" }), T(" " + GRIN + "\n" + GRIN, { i: true })]),
  normalizeCell([T(GRIN + GRIN, { dir: true }), T(GRIN, { href: "https://e.x/", cmt: ["c1"] })]),
  ...RANDOM.map((c) => normalizeCell(c)).filter((c) => pairCuts(c).length).slice(0, 30)
];

function positionsAround(cell: readonly Run[], p: number): number[] {
  const cuts = pairCuts(cell);
  const all = [0, cellLength(cell), p, ...cuts, ...cuts.map((c) => c - 1), ...cuts.map((c) => c + 1)];
  return all.filter((x, i) => all.indexOf(x) === i);
}

test("a b-roll key is one position: slicing, deleting and inserting treat it whole", () => {
  const cell = [T("ab"), B("bs1"), T("cd")];
  assert.equal(cellLength(cell), 5);
  assert.deepEqual(sliceCell(cell, 2, 3), [B("bs1")]);
  assert.deepEqual(deleteRange(cell, 2, 3), [T("abcd")]);
  assert.deepEqual(insertText(cell, 3, "x"), [T("ab"), B("bs1"), T("xcd")]);
  assert.deepEqual(insertText(cell, 2, "x"), [T("abx"), B("bs1"), T("cd")]);
  assert.deepEqual(insertBrollKey([T("ab")], 1, "bs2", "B-roll:"), [T("a"), B("bs2"), T("b")]);
  assert.deepEqual(insertBrollKey([T("ab", { b: true })], 1, "bs2", "B-roll:"), [T("a", { b: true }), B("bs2", "B-roll:", { b: true }), T("b", { b: true })]);
  assert.deepEqual(insertBrollKey([T("ab")], 1, "bs2", "not a key"), [T("anot a keyb")], "a key with no marker falls back to its words");
});

test("a tag, a direction or a cue never lands on a b-roll key; formatting, links and comments do", () => {
  const cell = [T("ab"), B("bs1")];
  assert.deepEqual(setMark(cell, 0, 3, "tag", "t:prop:X"), [T("ab", { tag: "t:prop:X" }), B("bs1")]);
  assert.deepEqual(setMark(cell, 0, 3, "dir", true), [T("ab", { dir: true }), B("bs1")]);
  assert.deepEqual(setMark(cell, 0, 3, "b", true), [T("ab", { b: true }), B("bs1", "B-roll:", { b: true })]);
  assert.deepEqual(setMark(cell, 0, 3, "href", "https://e.x/"), [T("ab", { href: "https://e.x/" }), B("bs1", "B-roll:", { href: "https://e.x/" })]);
  assert.deepEqual(setMark(setMark(cell, 0, 3, "b", true), 3, 0, "b", null), normalizeCell(cell), "a backwards range, and null clears");
  assert.deepEqual(setMark([T("ab", { i: true })], 0, 1, "i", undefined), [T("a"), T("b", { i: true })]);
});

test("comments cover b-roll keys and are found and removed across them", () => {
  const cell = addComment([T("ab"), B("bs1"), T("cd")], 1, 4, "c1");
  assert.deepEqual(cell, [T("a"), T("b", { cmt: ["c1"] }), B("bs1", "B-roll:", { cmt: ["c1"] }), T("c", { cmt: ["c1"] }), T("d")]);
  assert.deepEqual(commentRange(cell, "c1"), { from: 1, to: 4 });
  assert.deepEqual(commentRange(addComment([T("ab"), B("bs1")], 2, 3, "c2"), "c2"), { from: 2, to: 3 });
  assert.deepEqual(commentRange(addComment([T("abc")], 1, 3, "c3"), "c3"), { from: 1, to: 3 }, "to the end of the cell");
  assert.deepEqual(removeComment(cell, "c1", 2, 3), [T("a"), T("b", { cmt: ["c1"] }), B("bs1"), T("c", { cmt: ["c1"] }), T("d")]);
  assert.deepEqual(removeComment(cell, "c1"), [T("ab"), B("bs1"), T("cd")]);
  assert.deepEqual(addComment(addComment([T("ab")], 0, 2, "c2"), 0, 2, "c2"), [T("ab", { cmt: ["c2"] })], "adding twice adds once");
  assert.equal(commentRange(cell, "c9"), null);
});

test("typing next to or inside a tag never carries the tag, its comment or its link", () => {
  const cell = [T("a "), T("mug", { tag: "t:prop:Mug", cmt: ["c1"], href: "https://e.x/", b: true }), T(" b")];
  assert.deepEqual(typingMarks(cell, 2), {});
  assert.deepEqual(typingMarks(cell, 5), { b: true });
  assert.deepEqual(insertText(cell, 5, "s"), [T("a "), T("mug", { b: true, href: "https://e.x/", tag: "t:prop:Mug", cmt: ["c1"] }), T("s", { b: true }), T(" b")]);
  assert.deepEqual(insertText(cell, 3, "x"), [
    T("a "),
    T("m", { b: true, href: "https://e.x/", tag: "t:prop:Mug", cmt: ["c1"] }),
    T("x", { b: true }),
    T("ug", { b: true, href: "https://e.x/", tag: "t:prop:Mug", cmt: ["c1"] }),
    T(" b")
  ], "the model splits it; keeping the caret out of a tag is the editor's job");
  assert.deepEqual(marksAt(cell, 2), {}, "the character before the position decides");
  assert.deepEqual(marksAt(cell, 0), {});
  assert.deepEqual(marksAt([], 0), {});
});

test("replacing typed words with a tag, and retagging, keep a tag one stretch", () => {
  const r = replaceWithTag([T("get [red mug] now")], 4, 13, "red mug", "t:prop:Red mug");
  assert.deepEqual(r, { cell: [T("get "), T("red mug", { tag: "t:prop:Red mug" }), T(" now")], end: 11 });
  const two = [T("a", { tag: "t_a" }), T("b", { tag: "t_b" })];
  assert.deepEqual(retag(two, "t_a", "t_b"), [T("ab", { tag: "t_b" })]);
  assert.deepEqual(retag(two, "t_a", null), [T("a"), T("b", { tag: "t_b" })]);
  assert.deepEqual(retag([B("bs1")], "t_a", "t_b"), [B("bs1")]);
  const key = replaceWithBrollKey([T("x B-roll: y")], 2, 10, "bs3", "B-roll:");
  assert.deepEqual(key, { cell: [T("x "), B("bs3"), T("y")], end: 3 });
});

test("replacing keeps the first replaced character's marks, comment, link and tag included; a b-roll key there means typing marks", () => {
  assert.deepEqual(replaceText([T("a"), T("bc", { b: true })], 1, 3, "x"), [T("a"), T("x", { b: true })]);
  assert.deepEqual(replaceText([T("a", { i: true }), T("bc")], 2, 1, "x"), [T("a", { i: true }), T("xc")]);
  assert.deepEqual(replaceText([T("say "), T("two words", { cmt: ["c1"], href: "https://e.x/" })], 4, 7, "three"),
    [T("say "), T("three words", { href: "https://e.x/", cmt: ["c1"] })]);
  assert.deepEqual(replaceText([T("red mug", { tag: "t:prop:Mug" })], 0, 3, "big"), [T("big mug", { tag: "t:prop:Mug" })]);
  assert.deepEqual(replaceText([T("a", { i: true }), B("bs1"), T("b", { b: true })], 1, 2, "x"), [T("ax", { i: true }), T("b", { b: true })]);
  assert.deepEqual(replaceText([T("ab", { u: true })], 0, 0, "x"), [T("xab", { u: true })], "an empty range types");
});

test("positions are clamped to the cell and floored", () => {
  const cell = [T("abc")];
  assert.equal(clamp(cell, -5), 0);
  assert.equal(clamp(cell, 99), 3);
  assert.equal(clamp(cell, 1.7), 1);
  assert.equal(clamp(cell, Number.NaN), 0);
  assert.deepEqual(insertText(cell, 99, "!"), [T("abc!")]);
  assert.deepEqual(deleteRange(cell, -1, 99), []);
  assert.deepEqual(sliceCell(cell, 2, 1), []);
  assert.deepEqual(sliceCell(cell, 1), [T("bc")]);
  assert.equal(clamp([T("a" + GRIN + "b")], 2), 3, "a position inside a surrogate pair moves to just after it");
  assert.equal(clamp([T("a" + GRIN + "b")], 2.5), 3);
});

test("Unicode: edits on whole code points keep astral characters, combining marks and ZWJ sequences", () => {
  const words = [GRIN, COMBINED_E, TECHNOLOGIST, THUMB, SHALOM];
  const text = words.join(" ");
  const cell = [T(text)];
  let at = 0;
  for (const w of words) {
    assert.equal(projection(sliceCell(cell, at, at + w.length)), w);
    assert.equal(projection(deleteRange(cell, at, at + w.length)), text.slice(0, at) + text.slice(at + w.length));
    assert.equal(projection(insertText(cell, at, w)), text.slice(0, at) + w + text.slice(at));
    assert.equal(projection(setMark(cell, at, at + w.length, "b", true)), text);
    at += w.length + 1;
  }
  assert.deepEqual(replaceText([T("a" + GRIN + "b")], 1, 3, THUMB), [T("a" + THUMB + "b")]);
  assert.deepEqual(insertText([T("ab")], 1, "x" + OBJ + "y" + ZWSP + "z" + ZWJ + "w" + NBSP), [T("axyz" + ZWJ + "w" + NBSP + "b")]);
  assert.deepEqual(toggleMark([T(TECHNOLOGIST)], 0, 5, "i"), [T(TECHNOLOGIST, { i: true })]);
});

test("split and join are inverses at every position, inside a surrogate pair too, on lines that are not cues; a split never cuts a pair", () => {
  const noCues = RANDOM.filter((c) => !normalizeCell(c).some((r) => r.marks.cue)).slice(0, 60);
  for (const cell of [[T("a" + GRIN, { b: true }), B("bs1"), T(COMBINED_E + " x", { cmt: ["c1"] })], ...noCues]) {
    const cuts = pairCuts(normalizeCell(cell));
    for (let p = 0; p <= cellLength(cell); p++) {
      const [a, b] = splitCell(cell, p);
      assert.equal(cellLength(a), caretAt(cuts, p), "at " + p);
      wholeCodePoints(a, "first half at " + p);
      wholeCodePoints(b, "second half at " + p);
      assert.deepEqual(joinCells(a, b), normalizeCell(cell), "at " + p);
    }
  }
  assert.deepEqual(splitCell([T("a" + GRIN + "b")], 2), [[T("a" + GRIN)], [T("b")]]);
});

test("#322: the reported repro keeps the emoji whole", () => {
  const cell = [T("a" + GRIN + "b")];
  assert.equal(projection(insertText(cell, 2, "x")), "a" + GRIN + "xb", "typing inside the pair types after the emoji");
  assert.equal(projection(deleteRange(cell, 1, 2)), "ab", "deleting half the pair deletes the emoji");
  assert.equal(projection(deleteRange(cell, 2, 3)), "ab");
  assert.equal(projection(deleteRange(cell, 2, 2)), "a" + GRIN + "b", "an empty range inside the pair deletes nothing");
  assert.deepEqual(setMark(cell, 0, 2, "b", true), [T("a" + GRIN, { b: true }), T("b")], "a mark over half the pair covers the emoji");
});

test("a caret inside a surrogate pair acts just after the character, for every caret edit", () => {
  for (const cell of PAIRED) {
    const text = projection(cell);
    const cuts = pairCuts(cell);
    for (const p of cuts) {
      const at = caretAt(cuts, p);
      const where = JSON.stringify(text) + " at " + p;
      assert.equal(clamp(cell, p), at, where);
      for (const ins of ["x", GRIN, "\n"]) {
        const out = insertText(cell, p, ins);
        wholeCodePoints(out, "insertText " + where);
        assert.deepEqual(out, insertText(cell, at, ins), "insertText " + where);
        assert.equal(projection(out), text.slice(0, at) + ins + text.slice(at), "insertText " + where);
      }
      const key = insertBrollKey(cell, p, "bs9", "B-roll:");
      wholeCodePoints(key, "insertBrollKey " + where);
      assert.deepEqual(key, insertBrollKey(cell, at, "bs9", "B-roll:"), "insertBrollKey " + where);
      assert.deepEqual(marksAt(cell, p), marksAt(cell, at), "marksAt " + where);
      assert.deepEqual(typingMarks(cell, p), typingMarks(cell, at), "typingMarks " + where);
      assert.equal(insideDirection(cell, p), insideDirection(cell, at), "insideDirection " + where);
      const [a, b] = splitCell(cell, p);
      wholeCodePoints(a, "splitCell " + where);
      wholeCodePoints(b, "splitCell " + where);
      assert.deepEqual([a, b], splitCell(cell, at), "splitCell " + where);
      const tail = sliceCell(cell, p);
      wholeCodePoints(tail, "sliceCell to the end " + where);
      assert.equal(projection(tail), text.slice(p - 1), "sliceCell to the end takes the whole character " + where);
    }
  }
});

test("a range with an end inside a surrogate pair grows to take the whole character, for every range edit", () => {
  for (const cell of PAIRED) {
    const text = projection(cell);
    const cuts = pairCuts(cell);
    for (const p of cuts) {
      for (const q of positionsAround(cell, p)) {
        const [lo, hi] = rangeAt(cuts, p, q);
        const where = JSON.stringify(text) + " at " + p + ".." + q;
        const pairs: [string, Run[], Run[]][] = [
          ["deleteRange", deleteRange(cell, p, q), deleteRange(cell, lo, hi)],
          ["deleteRange backwards", deleteRange(cell, q, p), deleteRange(cell, lo, hi)],
          ["replaceText", replaceText(cell, p, q, "w"), replaceText(cell, lo, hi, "w")],
          ["replaceText with an emoji", replaceText(cell, q, p, THUMB), replaceText(cell, lo, hi, THUMB)],
          ["setMark", setMark(cell, p, q, "b", true), setMark(cell, lo, hi, "b", true)],
          ["setMark clearing", setMark(cell, q, p, "i", null), setMark(cell, lo, hi, "i", null)],
          ["toggleMark", toggleMark(cell, p, q, "hl"), toggleMark(cell, lo, hi, "hl")],
          ["addComment", addComment(cell, p, q, "cx"), addComment(cell, lo, hi, "cx")],
          ["removeComment", removeComment(cell, "c1", p, q), removeComment(cell, "c1", lo, hi)],
          ["sliceCell", sliceCell(cell, Math.min(p, q), Math.max(p, q)), sliceCell(cell, lo, hi)]
        ];
        for (const [name, got, want] of pairs) {
          wholeCodePoints(got, name + " " + where);
          assert.deepEqual(got, want, name + " " + where);
        }
        assert.equal(projection(deleteRange(cell, p, q)), text.slice(0, lo) + text.slice(hi), "deleteRange " + where);
        assert.equal(markThroughout(cell, p, q, "b"), markThroughout(cell, lo, hi, "b"), "markThroughout " + where);
        const tag = replaceWithTag(cell, p, q, "w" + GRIN, "t:prop:W");
        wholeCodePoints(tag.cell, "replaceWithTag " + where);
        assert.deepEqual(tag, replaceWithTag(cell, lo, hi, "w" + GRIN, "t:prop:W"), "replaceWithTag " + where);
        assert.equal(tag.end, lo + 3, "replaceWithTag " + where);
        const key = replaceWithBrollKey(cell, q, p, "bs9", "B-roll:");
        wholeCodePoints(key.cell, "replaceWithBrollKey " + where);
        assert.deepEqual(key, replaceWithBrollKey(cell, lo, hi, "bs9", "B-roll:"), "replaceWithBrollKey " + where);
        assert.equal(key.end, lo + 1, "replaceWithBrollKey " + where);
        const br = breakLine(cell, p, q);
        wholeCodePoints(br.cell, "breakLine " + where);
        assert.deepEqual(br, breakLine(cell, lo, hi), "breakLine " + where);
        assert.ok(!pairCuts(br.cell).includes(br.pos), "breakLine's caret " + where);
      }
    }
  }
});

test("a glue between joined cells carries only the link, comments and direction both sides share", () => {
  assert.deepEqual(joinCells([T("a", { href: "https://e.x/", cmt: ["c1", "c2"], b: true })], [T("b", { href: "https://e.x/", cmt: ["c2"], b: true })], "\n"),
    [T("a", { b: true, href: "https://e.x/", cmt: ["c1", "c2"] }), T("\n", { href: "https://e.x/", cmt: ["c2"] }), T("b", { b: true, href: "https://e.x/", cmt: ["c2"] })]);
  assert.deepEqual(joinCells([T("a", { dir: true })], [T("b", { dir: true })], " "), [T("a b", { dir: true })]);
  assert.deepEqual(joinCells([], [T("b")], " "), [T(" b")]);
  assert.deepEqual(joinCells([T("a")], [], ""), [T("a")]);
});

test("breakLine: one break inside a line, a pair at the end, shared links and comments go on", () => {
  assert.deepEqual(breakLine([T("ab")], 1, 1), { cell: [T("a\nb")], pos: 2 });
  assert.deepEqual(breakLine([T("ab")], 2, 2), { cell: [T("ab\n\n")], pos: 3 });
  assert.deepEqual(breakLine([T("a"), B("bs1")], 2, 2), { cell: [T("a"), B("bs1"), T("\n\n")], pos: 3 });
  const linked = [T("ab", { href: "https://e.x/", cmt: ["c1"] })];
  assert.deepEqual(breakLine(linked, 1, 1).cell, [T("a\nb", { href: "https://e.x/", cmt: ["c1"] })]);
  assert.deepEqual(breakLine([T("a" + GRIN + "b")], 3, 1), { cell: [T("a\nb")], pos: 2 });
});

test("random edits keep lengths and canonical form", () => {
  const r = rng(11);
  for (const cell of RANDOM) {
    const n = cellLength(cell);
    const p = Math.floor(r() * (n + 1)), q = Math.floor(r() * (n + 1));
    const [lo, hi] = rangeAt(pairCuts(normalizeCell(cell)), p, q);
    const ins = insertText(cell, p, "zz");
    assert.equal(cellLength(ins), n + 2);
    const del = deleteRange(cell, p, q);
    assert.equal(projection(del), projection(cell).slice(0, lo) + projection(cell).slice(hi));
    const outs: Run[][] = [ins, del, setMark(cell, p, q, "i", true), addComment(cell, p, q, "cx"), toggleMark(cell, p, q, "hl"), replaceText(cell, p, q, "w")];
    for (const out of outs) {
      assert.deepEqual(normalizeCell(out), out);
      wholeCodePoints(out, "a random edit at " + p + ".." + q);
    }
  }
});
