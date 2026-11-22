import assert from "node:assert/strict";
import { test } from "node:test";
import { projectSharedBlocks } from "../../../src/core/collab/projection/blocks.ts";
import type { SharedProjectionStream } from "../../../src/core/collab/projection/blocks.ts";

test("pure split interpretation keeps its frozen inputs and literal prefix offsets", () => {
  const unit = (value: string) => Object.freeze({ value, marks: Object.freeze([]) });
  const streams: readonly SharedProjectionStream[] = Object.freeze([Object.freeze({ segment: "S", inOrder: true,
    head: Object.freeze({ kind: "b" as const, id: "R1", before: null }), parts: Object.freeze([
      Object.freeze({ boundary: null, units: Object.freeze([unit("a")]), from: 0, to: 1 }),
      Object.freeze({ boundary: Object.freeze({ kind: "b" as const, id: "N", before: "R1" }), units: Object.freeze([]), from: 1, to: 2 }),
      Object.freeze({ boundary: null, units: Object.freeze([unit("b")]), from: 2, to: 3 })]) })]);
  const records = Object.freeze([Object.freeze({ id: "R1", valid: true, segment: null }), Object.freeze({ id: "N", valid: true, segment: "S" })]);
  const before = JSON.stringify({ streams, records });
  assert.deepEqual(projectSharedBlocks(streams, records), [
    { kind: "b", id: "N", segment: "S", from: 0, to: 1, units: [{ value: "a", marks: [] }], reason: null },
    { kind: "b", id: "R1", segment: "S", from: 2, to: 3, units: [{ value: "b", marks: [] }], reason: null }
  ]);
  assert.equal(JSON.stringify({ streams, records }), before);
});

const beat = (id: string, before: string | null = null) => ({ kind: "b" as const, id, before });
const text = (value: string, from: number) => ({ boundary: null, units: [{ value, marks: [] }], from, to: from + 1 });
const boundary = (id: string, from: number, before: string | null = null) => ({ boundary: beat(id, before), units: [], from, to: from + 1 });

test("a foreign segment cannot claim a beat owned by its real segment", () => {
  const streams = [
    { segment: "foreign", inOrder: true, head: beat("R1"), parts: [text("f", 0)] },
    { segment: "owned", inOrder: true, head: beat("R1"), parts: [text("a", 0)] }
  ];
  assert.deepEqual(projectSharedBlocks(streams, [{ id: "R1", valid: true, segment: "owned" }]), [
    { kind: "b", id: "R1", segment: "foreign", from: 0, to: 1, units: [{ value: "f", marks: [] }], reason: "foreign-segment" },
    { kind: "b", id: "R1", segment: "owned", from: 0, to: 1, units: [{ value: "a", marks: [] }], reason: null }
  ]);
});

test("adjacent identical boundaries do not create an extra recovery fragment", () => {
  assert.deepEqual(projectSharedBlocks([
    { segment: "S", inOrder: true, head: beat("R1"), parts: [boundary("R1", 0), text("a", 1)] }
  ], [{ id: "R1", valid: true, segment: "S" }]), [
    { kind: "b", id: "R1", segment: "S", from: 0, to: 2, units: [{ value: "a", marks: [] }], reason: null }
  ]);
});

test("a retired boundary leaves following text with the preceding beat", () => {
  assert.deepEqual(projectSharedBlocks([
    { segment: "S", inOrder: true, head: beat("R1"), parts: [text("a", 0), boundary("N", 1), text("b", 2)] }
  ], [{ id: "R1", valid: true, segment: "S" }, { id: "N", valid: true, segment: "S", retired: true }]), [
    { kind: "b", id: "R1", segment: "S", from: 0, to: 3, units: [{ value: "a", marks: [] }, { value: "b", marks: [] }], reason: null }
  ]);
});

test("leading text without a boundary is kept in a recovery fragment", () => {
  assert.deepEqual(projectSharedBlocks([
    { segment: "S", inOrder: true, head: null, parts: [text("a", 0), boundary("R1", 1), text("b", 2)] }
  ], [{ id: "R1", valid: true, segment: "S" }]), [
    { kind: "b", id: null, segment: "S", from: 0, to: 1, units: [{ value: "a", marks: [] }], reason: "missing-boundary" },
    { kind: "b", id: "R1", segment: "S", from: 2, to: 3, units: [{ value: "b", marks: [] }], reason: null }
  ]);
});

test("a prefix split with no source keeps its text in an invalid-prefix fragment", () => {
  assert.deepEqual(projectSharedBlocks([
    { segment: "S", inOrder: true, head: beat("R1"), parts: [text("a", 0), boundary("N", 1, "Missing"), text("b", 2)] }
  ], [{ id: "R1", valid: true, segment: "S" }]), [
    { kind: "b", id: "R1", segment: "S", from: 0, to: 1, units: [{ value: "a", marks: [] }], reason: null },
    { kind: "b", id: "Missing", segment: "S", from: 2, to: 3, units: [{ value: "b", marks: [] }], reason: "invalid-prefix" }
  ]);
});

test("empty and colliding cleaned beat IDs project as recovery fragments", () => {
  const ids = ["R1", "R!1", "!"];
  const streams = ids.map((id, index) => ({ segment: String(index), inOrder: true, head: beat(id), parts: [text(id, 0)] }));
  const records = ids.map((id, index) => ({ id, valid: true, segment: String(index) }));
  assert.deepEqual(projectSharedBlocks(streams, records).map(block => [block.id, block.reason]),
    [["R1", null], ["R!1", "duplicate-boundary"], ["!", "invalid-beat-id"]]);
});
