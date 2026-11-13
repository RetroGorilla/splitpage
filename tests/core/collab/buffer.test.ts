import { test } from "node:test";
import assert from "node:assert/strict";
import { alignSpaceForm, bufferedNativeReplacement, createSharedTextBuffer, exceedsBufferQueue, foldedNativeReplacement, foldedNativeSplice,
  sameUpToSpaceForm, sharedBufferQueueBytes } from "../../../src/core/collab/buffer.ts";
import type { Run } from "../../../src/core/text/runs.ts";

for (const [before, after, expected] of [
  ["ab", "abQ", { from: 2, to: 2, insert: "Q" }],
  ["ab", "a", { from: 1, to: 2, insert: "" }],
  ["ab", "aQ", { from: 1, to: 2, insert: "Q" }],
  ["a😀b", "a😃b", { from: 1, to: 3, insert: "😃" }],
  ["a😀b", "a😀Qb", { from: 3, to: 3, insert: "Q" }],
  ["ab", "ab", null]
] as const) test(`unreported native replacement: ${before} to ${after}`, () => {
  assert.deepEqual(bufferedNativeReplacement(before, after), expected);
});

test("dirty: native evidence retains the original revision across several edits", () => {
  const buffer = createSharedTextBuffer(7, "abcd");
  assert.equal(buffer.dirty(), false);
  buffer.begin();
  buffer.replace(1, 2, "XY");
  buffer.replace(4, 5, "Z");
  assert.deepEqual([buffer.dirty(), buffer.text(), buffer.plan()], [true, "aXYcZ", {
    base: 7, text: "aXYcZ", splices: [{ from: 1, to: 2, insert: "XY" }, { from: 3, to: 4, insert: "Z" }]
  }]);
});

test("commit: replacing identical letters keeps native target evidence", () => {
  const buffer = createSharedTextBuffer(2, "aaa");
  buffer.replace(1, 2, "a");
  assert.deepEqual(buffer.commit(), { base: 2, text: "aaa", splices: [{ from: 1, to: 2, insert: "a" }] });
  assert.equal(buffer.dirty(), false);
});

test("cancel: composition restores the painted text and clears its evidence", () => {
  const buffer = createSharedTextBuffer(3, "ab");
  buffer.replace(0, 2, "composing");
  buffer.cancel();
  assert.deepEqual([buffer.dirty(), buffer.text(), buffer.plan()], [false, "ab", { base: 3, text: "ab", splices: [] }]);
});

test("bound: 64 KiB is accepted, its next byte exceeds the one queue's bound", () => {
  assert.equal(sharedBufferQueueBytes(), 65536);
  assert.deepEqual([exceedsBufferQueue(65535, 1), exceedsBufferQueue(65535, 2)], [false, true]);
});

test("empty text and invalid native targets", () => {
  const buffer = createSharedTextBuffer(1, "");
  assert.throws(() => buffer.replace(-1, 0, "x"), RangeError);
  assert.equal(buffer.dirty(), false);
  buffer.replace(0, 0, "xy");
  assert.deepEqual(buffer.plan(), { base: 1, text: "xy", splices: [{ from: 0, to: 0, insert: "xy" }] });
});

test("large native insertion keeps every inserted unit's evidence without an argument spread", () => {
  const buffer = createSharedTextBuffer(1, ""), insert = "x".repeat(200000);
  buffer.replace(0, 0, insert);
  assert.equal(buffer.dirty(), true);
  assert.deepEqual(buffer.commit(), { base: 1, text: insert, splices: [{ from: 0, to: 0, insert }] });
});

test("a forced preparation failure leaves both clean and dirty buffer state unchanged", () => {
  for (const dirty of [false, true]) {
    const buffer = createSharedTextBuffer(1, "ab");
    if (dirty) buffer.replace(1, 1, "Z");
    const before = { dirty: buffer.dirty(), text: buffer.text(), plan: buffer.plan() }, concat = Array.prototype.concat;
    const failure = new Error("cannot prepare evidence");
    let thrown: unknown;
    try {
      Array.prototype.concat = () => { throw failure; };
      try { buffer.replace(0, 0, "X"); } catch (error) { thrown = error; }
    } finally { Array.prototype.concat = concat; }
    assert.equal(thrown, failure);
    assert.deepEqual({ dirty: buffer.dirty(), text: buffer.text(), plan: buffer.plan() }, before);
  }
});

const NBSP = "\u00a0";

for (const [a, b, expected] of [
  ["the ", "the" + NBSP, true],
  [NBSP + "a" + NBSP, " a ", true],
  ["the ", "the", false],
  ["the t", "the" + NBSP, false],
  ["a b", "a\tb", false],
  ["", "", true]
] as const) test(`rule 55 space form: ${JSON.stringify(a)} and ${JSON.stringify(b)} are ${expected ? "" : "not "}the same`, () => {
  assert.equal(sameUpToSpaceForm(a, b), expected);
});

for (const [name, before, after, from, to, data, expected] of [
  ["T03: the space before the Backspace target turns into U+00A0 and keeps its stored form", "the t", "the" + NBSP, 4, 5, null, { from: 4, to: 5, insert: "" }],
  ["T03: the next Backspace deletes that space", "the ", "the", 3, 4, null, { from: 3, to: 4, insert: "" }],
  ["a typed space shown as U+00A0 is stored as typed", "the", "the" + NBSP, 3, 3, " ", { from: 3, to: 3, insert: " " }],
  ["a typed U+00A0 is stored as U+00A0", "the", "the" + NBSP, 3, 3, NBSP, { from: 3, to: 3, insert: NBSP }],
  ["with no native data the shown form is stored", "the", "the" + NBSP, 3, 3, null, { from: 3, to: 3, insert: NBSP }],
  ["data that does not match the shown text is ignored", "the", "thex", 3, 3, "q", { from: 3, to: 3, insert: "x" }],
  ["a U+00A0 the browser turns back into a space before the target keeps its stored form", "the" + NBSP, "the x", 4, 4, "x", { from: 4, to: 4, insert: "x" }],
  ["a letter changed outside the target is refused", "the t", "thX" + NBSP, 4, 5, null, null],
  ["only U+00A0 stands for a space: a tab outside the target is refused", "a b", "a\tbX", 3, 3, "X", null],
  ["a target that would insert a negative length is refused", "abc", "a", 1, 2, null, null]
] as const) test(`rule 55 native splice: ${name}`, () => {
  assert.deepEqual(foldedNativeSplice(before, after, from, to, data), expected);
});

for (const [before, after, expected] of [
  ["the ", "the" + NBSP, null],
  ["the t", "the" + NBSP, { from: 4, to: 5, insert: "" }],
  ["ab", "a" + NBSP + "b", { from: 1, to: 1, insert: NBSP }],
  ["a b", "a" + NBSP + "Xb", { from: 2, to: 2, insert: "X" }]
] as const) test(`rule 55 native replacement without a target: ${JSON.stringify(before)} to ${JSON.stringify(after)}`, () => {
  assert.deepEqual(foldedNativeReplacement(before, after), expected);
});

test("rule 55 runs: the shown space form is replaced by the buffered one and marks are kept", () => {
  const runs: Run[] = [{ text: "the" + NBSP, marks: { b: true } }, { atom: "who", name: "Ann", text: "Ann", marks: {} }, { text: NBSP + "x ", marks: {} }];
  assert.deepEqual(alignSpaceForm(runs, "the \ufffc" + NBSP + "x" + NBSP), [
    { text: "the ", marks: { b: true } }, { atom: "who", name: "Ann", text: "Ann", marks: {} }, { text: NBSP + "x" + NBSP, marks: {} }
  ]);
});

test("rule 55 runs: runs already in the buffered form are returned as they are", () => {
  const runs: Run[] = [{ text: "the ", marks: {} }];
  assert.equal(alignSpaceForm(runs, "the "), runs);
});

test("rule 55 runs: a difference other than the space form is not aligned", () => {
  assert.equal(alignSpaceForm([{ text: "the" + NBSP, marks: {} }], "thx "), null);
  assert.equal(alignSpaceForm([{ text: "the", marks: {} }], "the "), null);
});
