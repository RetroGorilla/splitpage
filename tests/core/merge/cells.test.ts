import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCells, mergeMarks } from "../../../src/core/merge/cells.ts";
import { cellLength, normalizeCell } from "../../../src/core/text/runs.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { addComment, deleteRange, insertText, replaceText, setMark } from "../../../src/core/text/edits.ts";
import { B, COMBINED_E, GRIN, SHALOM, T, TECHNOLOGIST, THUMB, randomCells, rng } from "../text/cells.ts";

const RANDOM = randomCells(3, 300);

function randomEdit(r: () => number, cell: Run[]): Run[] {
  const n = cellLength(cell);
  const p = Math.floor(r() * (n + 1)), q = Math.floor(r() * (n + 1));
  const kind = Math.floor(r() * 5);
  if (kind === 0) return insertText(cell, p, ["new ", GRIN, "x", "\n"][Math.floor(r() * 4)] as string);
  if (kind === 1) return deleteRange(cell, p, q);
  if (kind === 2) return setMark(cell, p, q, "b", r() < 0.5);
  if (kind === 3) return addComment(cell, p, q, "cz");
  return replaceText(cell, p, q, "word");
}

test("when only one side changed, or both the same way, the merge is that side", () => {
  const r = rng(5);
  for (const o of RANDOM) {
    const x = randomEdit(r, o);
    const clean = { cell: normalizeCell(x), conflict: false, markConflicts: 0 };
    assert.deepEqual(mergeCells(o, o, x), clean);
    assert.deepEqual(mergeCells(o, x, o), clean);
    assert.deepEqual(mergeCells(o, x, x), clean);
    assert.deepEqual(mergeCells(o, o, o), { cell: normalizeCell(o), conflict: false, markConflicts: 0 });
  }
});

test("edits to different words both land, whatever script the words are in", () => {
  const words = ["alpha", GRIN, COMBINED_E, TECHNOLOGIST, THUMB, SHALOM, "golf", "hotel"];
  const o = [T(words.join(" "))];
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 2; j < words.length; j++) {
      const mine = words.slice(), theirs = words.slice(), both = words.slice();
      mine[i] = both[i] = "MINE";
      theirs[j] = both[j] = "THEIRS";
      assert.deepEqual(mergeCells(o, [T(mine.join(" "))], [T(theirs.join(" "))]),
        { cell: [T(both.join(" "))], conflict: false, markConflicts: 0 }, i + "," + j);
    }
  }
});

test("the same words changed two ways is a conflict, and theirs stays", () => {
  const o = [T("meet at " + GRIN + " today")];
  const mine = replaceText(o, 8, 10, "noon");
  const theirs = replaceText(o, 8, 10, "dawn");
  assert.deepEqual(mergeCells(o, mine, theirs), { cell: theirs, conflict: true, markConflicts: 0 });
  assert.deepEqual(mergeCells(o, mine, mine), { cell: mine, conflict: false, markConflicts: 0 });
});

test("both sides inserting the same words at one place is no conflict, unless their marks differ", () => {
  const o = [T("a b")];
  const same = insertText(o, 1, " new");
  assert.deepEqual(mergeCells(o, same, same), { cell: same, conflict: false, markConflicts: 0 });
  const formatted = setMark(same, 2, 5, "b", true);
  assert.deepEqual(mergeCells(o, same, formatted), { cell: formatted, conflict: true, markConflicts: 0 });
  assert.deepEqual(mergeCells(o, insertText(o, 1, " x"), insertText(o, 1, " y")), { cell: insertText(o, 1, " y"), conflict: true, markConflicts: 0 });
});

test("formatting, comments, links and tags merge character by character", () => {
  const o = [T("one two three")];
  const r = mergeCells(o, setMark(o, 0, 3, "b", true), addComment(o, 8, 13, "c1"));
  assert.deepEqual(r, { cell: [T("one", { b: true }), T(" two "), T("three", { cmt: ["c1"] })], conflict: false, markConflicts: 0 });
  const bothComment = mergeCells(o, addComment(o, 0, 7, "c1"), addComment(o, 4, 13, "c2"));
  assert.deepEqual(bothComment.cell, [T("one ", { cmt: ["c1"] }), T("two", { cmt: ["c1", "c2"] }), T(" three", { cmt: ["c2"] })]);
  const links = mergeCells(o, setMark(o, 4, 7, "href", "https://a.x/"), setMark(o, 4, 7, "href", "https://b.x/"));
  assert.deepEqual(links, { cell: [T("one "), T("two", { href: "https://b.x/" }), T(" three")], conflict: false, markConflicts: 3 });
  const tags = mergeCells(o, setMark(o, 0, 3, "tag", "t_a"), setMark(o, 0, 3, "tag", "t_b"));
  assert.deepEqual(tags, { cell: [T("one", { tag: "t_b" }), T(" two three")], conflict: false, markConflicts: 3 });
  const off = mergeCells([T("x", { b: true })], [T("x")], [T("x", { b: true, i: true })]);
  assert.deepEqual(off.cell, [T("x", { i: true })], "one side's removal and the other's addition both hold");
});

test("a b-roll key is a token of its own, and its marks merge too", () => {
  const o = [T("a "), B("bs1"), T(" drone")];
  assert.deepEqual(mergeCells(o, insertText(o, 0, "x"), deleteRange(o, 2, 3)), { cell: [T("xa  drone")], conflict: false, markConflicts: 0 });
  const marked = mergeCells(o, setMark(o, 2, 3, "b", true), addComment(o, 2, 3, "c1"));
  assert.deepEqual(marked.cell, [T("a "), B("bs1", "B-roll:", { b: true, cmt: ["c1"] }), T(" drone")]);
  const twoKeys = mergeCells([T("a")], insertText([B("bs1")], 1, "a"), [T("a"), B("bs2")]);
  assert.equal(twoKeys.conflict, false);
  assert.deepEqual(twoKeys.cell, [B("bs1"), T("a"), B("bs2")]);
});

test("a rewrite too big to diff is one conflict unless both sides agree", () => {
  const big = (w: string) => [T(Array.from({ length: 2500 }, (_, k) => w + k).join(" "))];
  const res = mergeCells(big("o"), big("m"), big("t"));
  assert.equal(res.conflict, true);
  assert.deepEqual(res.cell, big("t"));
  assert.deepEqual(mergeCells(big("o"), big("m"), big("m")), { cell: big("m"), conflict: false, markConflicts: 0 });
});

test("mergeMarks: a change on either side holds, and two different links or tags keep theirs", () => {
  assert.deepEqual(mergeMarks({}, { b: true }, {}), { marks: { b: true }, conflict: false });
  assert.deepEqual(mergeMarks({ b: true }, {}, { b: true }), { marks: {}, conflict: false });
  assert.deepEqual(mergeMarks({}, { b: true }, { i: true }), { marks: { b: true, i: true }, conflict: false });
  assert.deepEqual(mergeMarks({ cmt: ["c1"] }, { cmt: ["c1", "c2"] }, {}), { marks: { cmt: ["c2"] }, conflict: false });
  assert.deepEqual(mergeMarks({}, { href: "https://a.x/" }, { href: "https://b.x/" }), { marks: { href: "https://b.x/" }, conflict: true });
  assert.deepEqual(mergeMarks({ tag: "t_o" }, { tag: "t_a" }, { tag: "t_o" }), { marks: { tag: "t_a" }, conflict: false });
  assert.deepEqual(mergeMarks({}, { tag: "t_a", dir: true }, { tag: "t_b", cue: true }), { marks: { tag: "t_b", dir: true, cue: true }, conflict: true });
  assert.deepEqual(mergeMarks({}, { href: "https://e.x/?a=b" }, {}), { marks: { href: "https://e.x/?a=b" }, conflict: false });
});

test("merging never leaves a cell out of canonical form, and without conflicts the sides can swap", () => {
  const r = rng(9);
  for (const o of RANDOM) {
    const a = randomEdit(r, o), b = randomEdit(r, o);
    const res = mergeCells(o, a, b);
    assert.deepEqual(normalizeCell(res.cell), res.cell);
    if (!res.conflict && !res.markConflicts) assert.deepEqual(mergeCells(o, b, a), res);
  }
});
