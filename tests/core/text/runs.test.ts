import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUE_LINE_RE,
  OBJ,
  cellLength,
  cleanMarks,
  cleanText,
  commentIds,
  defaultTagId,
  defaultTagOf,
  namedTagId,
  normalizeCell,
  orderedMarks,
  projection,
  sameCell,
  sameMarks,
  tagIds,
  tagNameOf
} from "../../../src/core/text/runs.ts";
import { B, COMBINED_E, GRIN, NBSP, SHALOM, T, TECHNOLOGIST, THUMB, ZWJ, ZWSP, randomCells } from "./cells.ts";

const RANDOM = randomCells(85, 300);

test("one canonical form: equal runs join, empty runs go, marks keep one order", () => {
  assert.deepEqual(normalizeCell([T("a", { b: true }), T("b", { b: true }), T(""), T("c")]), [T("ab", { b: true }), T("c")]);
  const [run] = normalizeCell([T("x", { cmt: ["c2", "c1", "c2"], tag: "t:prop:X", href: "https://e.x/", hl: true, dir: true, b: true })]);
  assert.deepEqual(Object.keys(run?.marks || {}), ["b", "hl", "dir", "href", "tag", "cmt"]);
  assert.deepEqual(run?.marks.cmt, ["c1", "c2"]);
  for (const cell of RANDOM) assert.deepEqual(normalizeCell(normalizeCell(cell)), normalizeCell(cell));
});

test("marks that are not exactly true, unsafe links, empty ids and junk runs are dropped", () => {
  assert.deepEqual(normalizeCell([
    { text: "x", marks: { b: false, i: 1, u: "yes", s: null, hl: true, href: "javascript:alert(1)", tag: "", cmt: ["", 7, null, "c1"] } },
    null,
    undefined,
    { text: "" },
    { marks: { b: true } }
  ]), [T("x", { hl: true, cmt: ["c1"] })]);
  assert.deepEqual(normalizeCell([{ text: "y", marks: { href: "  https://e.x/a  ", cmt: [] } }]), [T("y", { href: "https://e.x/a" })]);
  assert.deepEqual(normalizeCell([{ text: 42, marks: "b" }]), [T("42")]);
  assert.deepEqual(normalizeCell(null), []);
  assert.deepEqual(normalizeCell(undefined), []);
});

test("a tag or comment the document does not know is removed", () => {
  const known = (id: string) => id === "t_ok" || id === "c_ok";
  assert.deepEqual(
    normalizeCell([T("a", { tag: "t_gone", cmt: ["c_gone", "c_ok"] }), T("b", { tag: "t_ok", cmt: ["c_gone"] }), B("bs1", "B-roll:", { cmt: ["c_gone"] })],
      { hasTag: known, hasComment: known }),
    [T("a", { cmt: ["c_ok"] }), T("b", { tag: "t_ok" }), B("bs1")]
  );
});

test("a tag is one unit: across its stretch comments unite, the first link wins and a direction covers it all", () => {
  const cell = normalizeCell([
    T("ab", { tag: "t:prop:X", cmt: ["c2"] }),
    T("cd", { tag: "t:prop:X", href: "https://a.x/", dir: true, cmt: ["c1"] }),
    T("ef", { tag: "t:prop:X", href: "https://b.x/" }),
    B("bs1"),
    T("gh", { tag: "t:prop:X" })
  ]);
  assert.deepEqual(cell, [
    T("abcdef", { dir: true, href: "https://a.x/", tag: "t:prop:X", cmt: ["c1", "c2"] }),
    B("bs1"),
    T("gh", { tag: "t:prop:X" })
  ]);
  assert.deepEqual(normalizeCell([T("a", { tag: "t:prop:X", b: true }), T("b", { tag: "t:prop:X" })]),
    [T("a", { b: true, tag: "t:prop:X" }), T("b", { tag: "t:prop:X" })], "formatting may differ inside a tag");
});

test("a b-roll key needs an id and a marker, and carries no tag, direction or cue", () => {
  assert.deepEqual(normalizeCell([B("bs 1!", " b-roll: \n", { tag: "t:prop:x", dir: true, cue: true, b: true, cmt: ["c2", "c1", "c2"] })]),
    [B("bs1", "b-roll:", { b: true, cmt: ["c1", "c2"] })]);
  assert.deepEqual(normalizeCell([B("bs1", "hello", { b: true, tag: "t:prop:x", dir: true })]), [T("hello", { b: true })]);
  assert.deepEqual(normalizeCell([B("!!", "B-roll:")]), [T("B-roll:")]);
  assert.deepEqual(normalizeCell([B("bs1", "  ")]), []);
  assert.deepEqual(normalizeCell([B("bs1", "B roll -"), B("bs1", "B-roll:")]), [B("bs1", "B roll -"), B("bs1", "B-roll:")], "keys never join");
  assert.deepEqual(normalizeCell([{ atom: "broll", id: 7, text: "BROLL:" }]), [B("7", "BROLL:")]);
});

test("cell text: line ends become line feeds; controls, ZWSP and U+FFFC never enter, tab and NBSP stay", () => {
  assert.equal(cleanText("a\r\nb\rc\n"), "a\nb\nc\n");
  assert.equal(cleanText("\u{0}\u{1}\u{8}x\ty\u{B}\u{C}\u{E}\u{1F}z"), "x\tyz");
  assert.equal(cleanText("a" + ZWSP + "b" + OBJ + "c" + NBSP + "d" + ZWJ + "e\u{7F}"), "abc" + NBSP + "d" + ZWJ + "e\u{7F}");
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
  assert.equal(cleanText(0), "0");
  assert.deepEqual(normalizeCell([T("a\r\nb\u{7}" + ZWSP + OBJ)]), [T("a\nb")]);
});

test("Unicode text is kept exactly; offsets count UTF-16 code units", () => {
  for (const s of [GRIN, COMBINED_E, TECHNOLOGIST, THUMB, SHALOM, "\u{E9}", "a" + ZWJ + "b"]) {
    assert.deepEqual(normalizeCell([T(s, { b: true })]), [T(s, { b: true })], s);
    assert.equal(cellLength([T(s)]), s.length, s);
  }
  assert.equal(cellLength([T(GRIN)]), 2);
  assert.equal(cellLength([T(TECHNOLOGIST)]), 5);
  assert.equal(cellLength([T(COMBINED_E)]), 2);
  assert.deepEqual(normalizeCell([T(GRIN), T(GRIN)]), [T(GRIN + GRIN)]);
});

test("projection writes U+FFFC for a b-roll key and only for one", () => {
  const cell = [T("ab" + OBJ), B("bs1"), T(" " + GRIN)];
  assert.equal(projection(cell), "ab" + OBJ + " " + GRIN);
  assert.equal(cellLength(cell), 6);
  assert.equal(projection([]), "");
  for (const c of RANDOM) {
    const atoms = normalizeCell(c).filter((r) => r.atom).length;
    assert.equal(projection(c).split(OBJ).length - 1, atoms);
  }
});

test("comment ids come sorted and once, b-roll keys included; tag ids in order of first use", () => {
  assert.deepEqual(commentIds([T("a", { cmt: ["c9"] }), B("bs1", "B-roll:", { cmt: ["c1", "c9"] }), T("b", { cmt: ["c5"] })]), ["c1", "c5", "c9"]);
  assert.deepEqual(commentIds([]), []);
  assert.deepEqual(tagIds([T("x", { tag: "t_b" }), T(" "), T("y", { tag: "t_a" }), T("z", { tag: "t_b" })]), ["t_b", "t_a"]);
});

test("sameCell compares canonical forms", () => {
  assert.equal(sameCell([T("a"), T("b")], [T("ab")]), true);
  assert.equal(sameCell([T("a", { cmt: ["c2", "c1"] })], [T("a", { cmt: ["c1", "c2"] })]), true);
  assert.equal(sameCell([T("a", { b: true })], [T("a")]), false);
  assert.equal(sameCell(null, []), true);
});

test("the default tag id names the category and the tag; anything else names no tag", () => {
  assert.equal(namedTagId("prop", "Red mug"), "t:prop:Red mug");
  assert.equal(defaultTagId("vfx", "Smoke: thick"), "t:vfx:Smoke: thick");
  assert.deepEqual(tagNameOf("t:vfx:Smoke: thick"), { cat: "vfx", name: "Smoke: thick" });
  assert.deepEqual(defaultTagOf("t:cast:A\nB"), { cat: "cast", name: "A\nB" });
  for (const id of ["t_abc", "t:Prop:x", "t:prop:", "", null, undefined, 7]) assert.equal(tagNameOf(id), null, String(id));
});

test("marks helpers: cleaning for a b-roll key, comparison and order", () => {
  assert.deepEqual(cleanMarks({ b: true, dir: true, cue: true, tag: "t:x:y", cmt: ["c1"] }, true), { b: true, cmt: ["c1"] });
  assert.deepEqual(cleanMarks({ b: true, dir: true, cue: true, tag: "t:x:y" }), { b: true, dir: true, cue: true, tag: "t:x:y" });
  assert.deepEqual(cleanMarks(null), {});
  assert.deepEqual(cleanMarks("b"), {});
  assert.equal(sameMarks({ b: true, cmt: ["c1"] }, { b: true, cmt: ["c1"] }), true);
  assert.equal(sameMarks({ b: true, cmt: ["c1"] }, { b: true, cmt: ["c2"] }), false);
  assert.equal(sameMarks({ cmt: ["c1"] }, { b: true }), false);
  assert.equal(sameMarks({ b: true }, { i: true }), false);
  assert.deepEqual(Object.keys(orderedMarks({ cmt: ["c"], tag: "t", href: "h", cue: true, dir: true, hl: true, s: true, u: true, i: true, b: true })),
    ["b", "i", "u", "s", "hl", "dir", "cue", "href", "tag", "cmt"]);
});

test("a cue line opens with SFX or MUSIC and a colon, any case, spaces and NBSP around", () => {
  for (const s of ["SFX:", "sfx: rain", "  Music :theme", "\tmusic\t:", NBSP + "SFX" + NBSP + ": x"]) assert.ok(CUE_LINE_RE.test(s), s);
  for (const s of ["sfx", "the sfx: x", "sfx-: x", "musical: x", "\nsfx: x"]) assert.ok(!CUE_LINE_RE.test(s), s);
});
