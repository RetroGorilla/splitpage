import test from "node:test";
import assert from "node:assert/strict";
import { applyFlowOperations } from "./operation-applier.ts";
import { createFlowLoadRuntime } from "./load.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";

function operation(raw: unknown) { const result = readOperation(raw); assert.ok(result); return result; }
const target = Object.freeze({ owner: "R1", segment: "R1", field: "audioText" });
const base = Object.freeze({ rows: [{ id: "R1", audioText: "abcd" }], comments: [] });

for (const [from, to, expected] of [[0, 1, "aYbcd"], [1, 2, "aXbcd"]] as const) test(`interpreter numbers insertion chunks cumulatively for deletion [${from},${to})`, () => {
  const insert = operation({ kind: "text-insert", id: "i", by: "A", target,
    at: { left: null, right: flowBaseReference("R1", "audioText", 1), affinity: "before" }, content: [{ value: "X", marks: [] }, { value: "Y", marks: [] }] });
  const remove = operation({ kind: "text-delete", id: "d", by: "A", target, observed: [flowBaseReference("i", "audioText", from, to)] });
  assert.deepEqual(applyFlowOperations(base, [insert, remove], createFlowLoadRuntime().cells), { rows: [{ id: "R1", audioText: expected }], sections: undefined, removedComments: [] });
});

test("interpreter keeps deleted base units as collapsed gaps", () => {
  const remove = operation({ kind: "text-delete", id: "d", by: "A", target, observed: [flowBaseReference("R1", "audioText", 1, 3)] });
  const insert = operation({ kind: "text-insert", id: "i", by: "A", target,
    at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" }, content: [{ value: "X", marks: [] }] });
  assert.deepEqual(applyFlowOperations(base, [remove, insert], createFlowLoadRuntime().cells), { rows: [{ id: "R1", audioText: "aXd" }], sections: undefined, removedComments: [] });
});

test("interpreter keeps deleted insertion units as collapsed gaps", () => {
  const insert = operation({ kind: "text-insert", id: "i", by: "A", target,
    at: { left: null, right: flowBaseReference("R1", "audioText", 1), affinity: "before" }, content: [{ value: "X", marks: [] }] });
  const remove = operation({ kind: "text-delete", id: "d", by: "A", target, observed: [flowBaseReference("i", "audioText", 0, 1)] });
  const replace = operation({ kind: "text-insert", id: "j", by: "A", target,
    at: { left: flowBaseReference("i", "audioText", 0), right: null, affinity: "after" }, content: [{ value: "Y", marks: [] }] });
  assert.deepEqual(applyFlowOperations(base, [insert, remove, replace], createFlowLoadRuntime().cells), { rows: [{ id: "R1", audioText: "aYbcd" }], sections: undefined, removedComments: [] });
});
