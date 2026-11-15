import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedCellTextOperations } from "../../../src/core/collab/cell-text-operations.ts";
import type { SharedCellText } from "../../../src/core/collab/cell-text-operations.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { Run } from "../../../src/core/text/runs.ts";

const plain = (text: string): Run[] => [{ text, marks: {} }];
const bold = (text: string): Run => ({ text, marks: { b: true } });
const target = { owner: "R1", segment: "R1", field: "audioText" };
const ref = (from: number, to?: number) => flowBaseReference("R1", "audioText", from, to);
const cell = (before: readonly Run[], after: readonly Run[]): SharedCellText => ({ owner: "R1", field: "audioText", before, after });

test("each splice becomes an insertion placed before its first replaced character, then the deletion, as the Writer writes a replacement", () => {
  assert.deepEqual(sharedCellTextOperations(cell(plain("a cup of"), plain("a mug of")), [{ from: 2, to: 5, insert: plain("mug") }]), [
    { kind: "text-insert", target, at: { left: null, right: ref(2), affinity: "before" }, content: [{ value: "mug", marks: [] }] },
    { kind: "text-delete", target, observed: [ref(2, 5)] }
  ]);
  assert.deepEqual(sharedCellTextOperations(cell(plain("cup"), plain("mug")), [{ from: 0, to: 3, insert: plain("mug") }]), [
    { kind: "text-insert", target, at: { left: null, right: ref(0), affinity: "before" }, content: [{ value: "mug", marks: [] }] },
    { kind: "text-delete", target, observed: [ref(0, 3)] }
  ]);
  assert.deepEqual(sharedCellTextOperations(cell(plain("a cup"), plain("a cup!")), [{ from: 5, to: 5, insert: plain("!") }]), [
    { kind: "text-insert", target, at: { left: ref(4), right: null, affinity: "after" }, content: [{ value: "!", marks: [] }] }
  ]);
  assert.equal(sharedCellTextOperations(cell([], plain("a")), [{ from: 0, to: 0, insert: plain("a") }]), null);
});

test("an empty replacement only deletes, adjacent splices merge, and a splice that writes nothing is dropped", () => {
  assert.deepEqual(sharedCellTextOperations(cell(plain("a cup"), plain("a ")), [{ from: 2, to: 5, insert: [] }]), [
    { kind: "text-delete", target, observed: [ref(2, 5)] }
  ]);
  assert.deepEqual(sharedCellTextOperations(cell(plain("cupcup!"), plain("mugmug!")), [{ from: 0, to: 3, insert: plain("mug") }, { from: 3, to: 6, insert: plain("mug") }]), [
    { kind: "text-insert", target, at: { left: null, right: ref(0), affinity: "before" }, content: [{ value: "mugmug", marks: [] }] },
    { kind: "text-delete", target, observed: [ref(0, 6)] }
  ]);
  assert.deepEqual(sharedCellTextOperations(cell(plain("ab"), plain("ab")), [{ from: 1, to: 1, insert: [] }]), []);
});

test("splices that do not turn the old cell into the new one, overlap, or fall outside it write nothing", () => {
  assert.equal(sharedCellTextOperations(cell(plain("a cup"), plain("a mug")), [{ from: 2, to: 5, insert: plain("mux") }]), null);
  assert.equal(sharedCellTextOperations(cell(plain("a cup"), [{ text: "a ", marks: {} }, bold("mug")]), [{ from: 2, to: 5, insert: plain("mug") }]), null);
  assert.equal(sharedCellTextOperations(cell(plain("cup"), plain("mg")), [{ from: 0, to: 2, insert: plain("m") }, { from: 1, to: 3, insert: plain("g") }]), null);
  assert.equal(sharedCellTextOperations(cell(plain("cup"), plain("cup!")), [{ from: 3, to: 4, insert: plain("!") }]), null);
  assert.equal(sharedCellTextOperations(cell(plain("cup"), plain("cup")), [{ from: 2, to: 1, insert: [] }]), null);
});
