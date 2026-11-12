import { test } from "node:test";
import assert from "node:assert/strict";
import { exceedsBufferQueue, SHARED_BUFFER_QUEUE_BYTES, SharedTextBuffer } from "../../../src/core/collab/buffer.ts";

test("dirty: native evidence retains the original revision across several edits", () => {
  const buffer = new SharedTextBuffer(7, "abcd");
  assert.equal(buffer.dirty(), false);
  buffer.begin();
  buffer.replace(1, 2, "XY");
  buffer.replace(4, 5, "Z");
  assert.deepEqual([buffer.dirty(), buffer.text(), buffer.plan()], [true, "aXYcZ", {
    base: 7, text: "aXYcZ", splices: [{ from: 1, to: 2, insert: "XY" }, { from: 3, to: 4, insert: "Z" }]
  }]);
});

test("commit: replacing identical letters keeps native target evidence", () => {
  const buffer = new SharedTextBuffer(2, "aaa");
  buffer.replace(1, 2, "a");
  assert.deepEqual(buffer.commit(), { base: 2, text: "aaa", splices: [{ from: 1, to: 2, insert: "a" }] });
  assert.equal(buffer.dirty(), false);
});

test("cancel: composition restores the painted text and clears its evidence", () => {
  const buffer = new SharedTextBuffer(3, "ab");
  buffer.replace(0, 2, "composing");
  buffer.cancel();
  assert.deepEqual([buffer.dirty(), buffer.text(), buffer.plan()], [false, "ab", { base: 3, text: "ab", splices: [] }]);
});

test("bound: 64 KiB is accepted, its next byte exceeds the one queue's bound", () => {
  assert.equal(SHARED_BUFFER_QUEUE_BYTES, 65536);
  assert.deepEqual([exceedsBufferQueue(65535, 1), exceedsBufferQueue(65535, 2)], [false, true]);
});

test("empty text and invalid native targets", () => {
  const buffer = new SharedTextBuffer(1, "");
  assert.throws(() => buffer.replace(-1, 0, "x"), RangeError);
  assert.equal(buffer.dirty(), false);
  buffer.replace(0, 0, "xy");
  assert.deepEqual(buffer.plan(), { base: 1, text: "xy", splices: [{ from: 0, to: 0, insert: "xy" }] });
});
