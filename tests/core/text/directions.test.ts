import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCell } from "../../../src/core/text/runs.ts";
import { insideDirection, joinCells, setMark, typingMarks } from "../../../src/core/text/edits.ts";
import {
  DIRECTION_MAX,
  directionRangeAt,
  directionShortcut,
  directionToggleRange,
  flattenDirections,
  importDirections,
  toggleDirection
} from "../../../src/core/text/directions.ts";
import { toDocxRuns, toPlainText } from "../../../src/core/text/projections.ts";
import { B, GRIN, T } from "./cells.ts";

const CELL = normalizeCell([T("one "), T("two", { dir: true }), T(" three")]);

test("a direction's range is found from inside it or either edge; outside there is none", () => {
  assert.deepEqual([0, 3, 4, 5, 7, 8].map((p) => directionRangeAt(CELL, p)),
    [null, null, { from: 4, to: 7 }, { from: 4, to: 7 }, { from: 4, to: 7 }, null]);
  const two = normalizeCell([T("a", { dir: true }), B("bs1"), T("b", { dir: true })]);
  assert.deepEqual(directionRangeAt(two, 1), { from: 0, to: 1 }, "a b-roll key ends a direction");
  assert.deepEqual(directionRangeAt(two, 2), { from: 2, to: 3 });
});

test("only strictly inside a direction is typing a direction", () => {
  assert.deepEqual([3, 4, 5, 6, 7, 8].map((p) => insideDirection(CELL, p)), [false, false, true, true, false, false]);
  assert.deepEqual([4, 5, 7].map((p) => typingMarks(CELL, p)), [{}, { dir: true }, {}]);
});

test("toggling a direction trims white space, turns off only when all of it is one, and skips b-roll keys", () => {
  assert.deepEqual(directionToggleRange([T("  ab  ")], 0, 6), { from: 2, to: 4, off: false });
  assert.deepEqual(directionToggleRange([T("  ab  ")], 6, 0), { from: 2, to: 4, off: false });
  assert.deepEqual(directionToggleRange([T("   ")], 0, 3), { from: 3, to: 3, off: false });
  assert.deepEqual(directionToggleRange(CELL, 4, 7), { from: 4, to: 7, off: true });
  assert.deepEqual(directionToggleRange(CELL, 3, 7), { from: 4, to: 7, off: false });
  assert.deepEqual(toggleDirection(CELL, 4, 7), [T("one two three")]);
  assert.deepEqual(toggleDirection([T("a"), B("bs1"), T("b")], 0, 3), [T("a", { dir: true }), B("bs1"), T("b", { dir: true })]);
});

test("#322: a direction toggled over half a surrogate pair takes the whole character", () => {
  const cell = [T("a" + GRIN + " b" + GRIN)];
  assert.deepEqual(directionToggleRange(cell, 2, 6), { from: 1, to: 7, off: false });
  assert.deepEqual(toggleDirection(cell, 2, 6), [T("a"), T(GRIN + " b" + GRIN, { dir: true })]);
  assert.deepEqual(directionToggleRange(cell, 2, 2), { from: 3, to: 3, off: false });
  assert.deepEqual(directionRangeAt([T("a"), T(GRIN, { dir: true })], 2), { from: 1, to: 3 });
});

test("typing ((words)) makes a direction of the words, leaving the spaces inside them out", () => {
  assert.deepEqual(directionShortcut([T("say ((softly))")], 14), { cell: [T("say "), T("softly", { dir: true })], end: 10 });
  assert.deepEqual(directionShortcut([T("say (( softly ))")], 16), { cell: [T("say  "), T("softly", { dir: true }), T(" ")], end: 12 });
  assert.deepEqual(directionShortcut([T("((x))")], 5), { cell: [T("x", { dir: true })], end: 1 });
  assert.deepEqual(directionShortcut([T("((" + GRIN + "))")], 6), { cell: [T(GRIN, { dir: true })], end: 2 });
  assert.deepEqual(directionShortcut([T("(("), T("mug", { tag: "t:prop:Mug" }), T("))")], 7),
    { cell: [T("mug", { dir: true, tag: "t:prop:Mug" })], end: 3 }, "a tag inside may become a direction");
});

test("the ((words)) shortcut refuses what it cannot make one direction of", () => {
  const no = (cell: Parameters<typeof directionShortcut>[0], pos: number, why: string) => assert.equal(directionShortcut(cell, pos), null, why);
  no([T("(())")], 4, "nothing inside");
  no([T("((   ))")], 7, "only spaces inside");
  no([T("((x)) ")], 6, "not just after the ))");
  no([T("((x)")], 4, "too short");
  no([T("abc x))")], 7, "no ((");
  no([T("((a\nb))")], 7, "a line break");
  no([T("((a(b))")], 7, "a bracket");
  no([T("((a"), B("bs1"), T("b))")], 7, "a b-roll key");
  no([T("(("), T("a", { dir: true }), T("))")], 5, "already a direction");
  no([T("((", { tag: "t:prop:Mug" }), T("mug))")], 7, "a tag on the brackets");
  no([T("((mug"), T("))", { tag: "t:prop:Mug" })], 7, "a tag on the closing brackets");
});

test("a direction is at most DIRECTION_MAX characters", () => {
  assert.equal(DIRECTION_MAX, 200);
  assert.equal(directionShortcut([T("((" + "x".repeat(DIRECTION_MAX) + "))")], DIRECTION_MAX + 4)?.end, DIRECTION_MAX);
  assert.equal(directionShortcut([T("((" + "x".repeat(DIRECTION_MAX + 1) + "))")], DIRECTION_MAX + 5), null);
  assert.deepEqual(importDirections([T("((" + "x".repeat(DIRECTION_MAX + 1) + "))")]), [T("((" + "x".repeat(DIRECTION_MAX + 1) + "))")]);
});

test("importing: a direction's own brackets go, and ((words)) become directions", () => {
  assert.deepEqual(importDirections([T("say "), T("(softly)", { dir: true }), T(" then ((loud)) and (x)")]),
    [T("say "), T("softly", { dir: true }), T(" then "), T("loud", { dir: true }), T(" and (x)")]);
  assert.deepEqual(importDirections([T("()", { dir: true })]), [T("()", { dir: true })], "two characters are not bracketed words");
  assert.deepEqual(importDirections([T("(", { dir: true, tag: "t:prop:X" }), T("a)", { dir: true })]),
    [T("(", { dir: true, tag: "t:prop:X" }), T("a)", { dir: true })], "a tagged bracket stays");
  assert.deepEqual(importDirections([T("((a)) ((b))")]), [T("a", { dir: true }), T(" "), T("b", { dir: true })]);
});

test("flattening writes the brackets in, without the tag but with the other marks", () => {
  assert.deepEqual(flattenDirections([T("say "), T("softly", { dir: true, b: true, tag: "t:prop:X", cmt: ["c1"] }), T(" ok")]), [
    T("say "),
    T("(", { b: true, cmt: ["c1"] }),
    T("softly", { b: true, tag: "t:prop:X", cmt: ["c1"] }),
    T(")", { b: true, cmt: ["c1"] }),
    T(" ok")
  ]);
  assert.deepEqual(flattenDirections([T("a", { dir: true }), T("b", { dir: true, i: true })]), [T("(a"), T("b)", { i: true })],
    "each bracket takes the marks of the run it closes");
  assert.deepEqual(flattenDirections(CELL), [T("one (two) three")]);
  const plain = [T("no directions")];
  assert.deepEqual(flattenDirections(plain), plain);
});

test("readers bracket a direction, and leaving directions out closes the gap", () => {
  const cases: [string, string, string, string][] = [
    ["Hello ", "aside", ", world", "Hello, world"],
    ["Hello ", "aside", " world", "Hello world"],
    ["", "aside", " Hello", "Hello"],
    ["Hello ", "aside", "", "Hello"],
    ["Hello", "aside", "world", "Hello world"],
    ["Hello ", "aside", "\u{2019}s", "Hello\u{2019}s"]
  ];
  for (const [a, d, b, omitted] of cases) {
    const cell = [T(a), T(d, { dir: true }), T(b)];
    assert.equal(toPlainText(cell), (a + "(" + d + ")" + b).trim(), a + d + b);
    assert.equal(toPlainText(cell, { directions: "omit" }), omitted, a + d + b);
  }
  assert.deepEqual(toDocxRuns(CELL).map((r) => r.text), ["one ", "(", "two", ")", " three"]);
  assert.deepEqual(toDocxRuns([T("a\nb", { dir: true })]).map((r) => [r.text, r.dir]), [["(", true], ["a", true], ["\n", true], ["b", true], [")", true]]);
});

test("joining two directions with a glue keeps one direction; setting dir false ends it", () => {
  assert.deepEqual(joinCells([T("a", { dir: true })], [T("b", { dir: true })], " "), [T("a b", { dir: true })]);
  assert.deepEqual(setMark(CELL, 5, 6, "dir", false), [T("one "), T("t", { dir: true }), T("w"), T("o", { dir: true }), T(" three")]);
});
