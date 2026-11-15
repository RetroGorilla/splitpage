import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_WORLD } from "./scenario.ts";
import { sweep } from "./generator-sweep.ts";

test("seeded histories on the shared document, three writers with a late joiner: every copy ends equal and every violation is a declared limit", () => {
  const result = sweep(3, ADAPTER_WORLD);
  assert.equal(result.copies, 1200);
  assert.deepEqual(result.counts, {
    command: 5098, "command changed nothing": 2557, deliver: 936, "deliver-dup": 266, "deliver-rev": 245, "effective redo": 422, "effective undo": 1118,
    "empty redo": 446, "empty undo": 306, "identical change cancelled": 29, join: 136, "nothing to deliver": 145,
    "record command refused: duplicate-record": 46, "record command refused: foreign-author": 38, "record command refused: missing-or-invalid-record": 830,
    "record command refused: missing-status-target": 687,
    "record-create comments": 248, "record-create people": 249, "record-create replies": 219, "record-create shots": 227, "record-create tags": 224,
    "record-delete comments": 48, "record-delete people": 34, "record-delete replies": 41, "record-delete shots": 41, "record-delete tags": 38,
    "record-set comments": 62, "record-set people": 66, "record-set replies": 47, "record-set shots": 56, "record-set tags": 68,
    "record-status shots": 97, "record-status tags": 95, "skipped before joining": 810, "undo then redo": 368, "used up redo": 4, "used up undo": 15
  });
  assert.deepEqual(result.steps, {
    bold: 607, delete: 587, deliver: 1034, "deliver-dup": 290, "deliver-rev": 268, insert: 628, join: 136, "record-create": 1303, "record-delete": 596, "record-set": 887,
    "record-status": 955, redo: 545, replace: 296, scalar: 307, status: 616, tag: 302, type: 613, unbold: 313, undo: 1024, "undo-redo": 526, untag: 303
  });
  assert.deepEqual(result.limited, { "double-restore": [30, 32, 43, 73, 107, 167, 169], "typed-beside-restored": [59, 63, 68, 73, 135, 146, 147, 169, 212, 251, 261, 283] });
});
