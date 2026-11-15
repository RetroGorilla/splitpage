import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_WORLD } from "./scenario.ts";
import { sweep } from "./generator-sweep.ts";

test("seeded histories on the shared document, two writers: every copy ends equal and every violation is a declared limit", () => {
  const result = sweep(2, ADAPTER_WORLD);
  assert.equal(result.copies, 900);
  assert.deepEqual(result.counts, {
    command: 5586, "command changed nothing": 2717, deliver: 963, "deliver-dup": 223, "deliver-rev": 250, "effective redo": 506, "effective undo": 1300,
    "empty redo": 476, "empty undo": 274, "identical change cancelled": 23, "nothing to deliver": 124,
    "record command refused: duplicate-record": 48, "record command refused: foreign-author": 23, "record command refused: missing-or-invalid-record": 923,
    "record command refused: missing-status-target": 659,
    "record-create comments": 237, "record-create people": 215, "record-create replies": 227, "record-create shots": 261, "record-create tags": 230,
    "record-delete comments": 64, "record-delete people": 44, "record-delete replies": 54, "record-delete shots": 62, "record-delete tags": 45,
    "record-set comments": 55, "record-set people": 79, "record-set replies": 70, "record-set shots": 72, "record-set tags": 87,
    "record-status shots": 129, "record-status tags": 135, "undo then redo": 443, "used up redo": 5, "used up undo": 19
  });
  assert.deepEqual(result.steps, {
    bold: 557, delete: 588, deliver: 1055, "deliver-dup": 244, "deliver-rev": 261, insert: 639, "record-create": 1218, "record-delete": 628, "record-set": 950,
    "record-status": 923, redo: 544, replace: 306, scalar: 332, status: 624, tag: 323, type: 613, unbold: 281, undo: 1059, "undo-redo": 534, untag: 321
  });
  assert.deepEqual(result.limited, { "typed-beside-restored": [29, 174, 181, 202, 213, 217, 238, 268, 274], "double-restore": [65, 148, 262] });
});
