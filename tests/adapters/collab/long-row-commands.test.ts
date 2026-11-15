import test from "node:test";
import assert from "node:assert/strict";
import { replicas, operation, ref } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const LONG = 300000;
const target = { owner: ref("R1"), segment: ref("R1"), field: "audioText" as const };
const read = (handle: SharedDocumentHandle) => {
  const result = projectSharedDocumentWithRecovery(handle); assert.deepEqual(result.recovery, []);
  return result.document.rows.map(row => row.audioText);
};
const send = (handle: SharedDocumentHandle, value: unknown) => assert.deepEqual(executeSharedOperations(handle, [operation(value)], { base: readSharedRevision(handle) }), { ok: true });

function joined(size: number, change: (handle: SharedDocumentHandle) => void) {
  const set = replicas(1, { rows: [{ id: "R1", audioText: "x".repeat(size) }, { id: "R2", audioText: "cd" }] });
  try {
    registerSharedJoinHandlers(set.a); registerSharedTextOperationHandlers(set.a);
    send(set.a, { kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " });
    change(set.a);
    return read(set.a);
  } finally { set.close(); }
}
const scaled = (rows: readonly unknown[]) => rows.map(row => String(row).replace(/x+/, "x".repeat(LONG)));

test("typing at the end of a joined row of 300,000 characters routes as it does on a joined row of 3, scaled", () => {
  const type = (size: number) => joined(size, handle => send(handle, { kind: "text-insert", id: "typed", by: "Writer", target,
    at: { left: null, right: flowBaseReference("R1", "audioText", size + 3), affinity: "before" }, content: [{ value: "X", marks: [] }] }));
  const small = type(3);
  assert.deepEqual(small, ["xxx cdX"]);
  assert.deepEqual(type(LONG), scaled(small));
});

test("bolding the whole of a joined row of 300,000 characters marks it as it marks a joined row of 3, scaled", () => {
  const bold = (size: number) => joined(size, handle => send(handle, { kind: "mark", id: "bold", by: "Writer", target,
    observed: [flowBaseReference("R1", "audioText", 0, size + 3)], mark: { kind: "b", value: true } }));
  const small = bold(3);
  assert.deepEqual(small, ["<strong>xxx cd</strong>"]);
  assert.deepEqual(bold(LONG), scaled(small));
});

test("a created beat whose narration holds 1,000 alternating bold and plain runs lands as one of 4 runs does, scaled; 300,000 exhaust memory", () => {
  const created = (runs: number) => {
    const set = replicas(1, { rows: [{ id: "R1", audioText: "ab" }] });
    try {
      registerSharedOperationFamilies(set.a, { cells: createFlowLoadRuntime().cells });
      const html = Array.from({ length: runs / 2 }, () => "<b>z</b>y").join("");
      send(set.a, { kind: "segment-create", id: "create", by: "Writer", beat: "N1", segment: "N1", at: { left: "R1", right: null, affinity: "after" },
        fields: { audioText: html } });
      return read(set.a);
    } finally { set.close(); }
  };
  const small = created(4), narration = String(small[1]), pair = narration.slice(0, narration.length / 2);
  assert.deepEqual([small.length, pair.repeat(2)], [2, narration]);
  assert.deepEqual(created(1000), [small[0], pair.repeat(500)]);
});
