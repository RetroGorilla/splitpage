import test from "node:test";
import assert from "node:assert/strict";
import { agree, operation, replicas } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const CASES = [
  { insert: "R1", remove: "R1", first: "insert", undone: "ab cd" },
  { insert: "R1", remove: "R1", first: "delete", undone: "ab cd" },
  { insert: "R1", remove: "b:R1", first: "insert", refused: true },
  { insert: "R1", remove: "b:R1", first: "delete", refused: true },
  { insert: "b:R1", remove: "R1", first: "insert", undone: "ab cd" },
  { insert: "b:R1", remove: "R1", first: "delete", undone: "ab cd" },
  { insert: "b:R1", remove: "b:R1", first: "insert", undone: "ab cd" },
  { insert: "b:R1", remove: "b:R1", first: "delete", undone: "ab cd" }
] as const satisfies readonly ({ insert: string; remove: string; first: string; undone: string } | { insert: string; remove: string; first: string; refused: true })[];

const text = (handle: SharedDocumentHandle) => {
  const result = projectSharedDocumentWithRecovery(handle);
  assert.deepEqual(result.recovery, []);
  return result.document.rows.map(row => row.audioText);
};

for (const item of CASES) for (const order of ["D1", "rev", "dup"] as const) {
  const outcome = "refused" in item ? "is refused by name" : "is undone once";
  test(`a replacement in a joined row, the insert addressed ${item.insert} and the delete ${item.remove}, ${item.first} first, ${outcome}: ${order}`, () => {
    const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] }), handles = [set.a, set.b];
    try {
      for (const handle of handles) { registerSharedJoinHandlers(handle); registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle); }
      assert.deepEqual(executeSharedOperations(set.b, [operation({ kind: "join", id: "join", by: "Bob", from: "R2", into: "R1", glue: " " })]), { ok: true });
      set.queue.flush(order);
      const insert = operation({ kind: "text-insert", id: "put", by: "Alice", target: { owner: "R1", segment: item.insert, field: "audioText" },
        at: { left: null, right: flowBaseReference("R1", "audioText", 1), affinity: "before" }, content: [{ value: "X", marks: [] }] });
      const remove = operation({ kind: "text-delete", id: "cut", by: "Alice", target: { owner: "R1", segment: item.remove, field: "audioText" },
        observed: [flowBaseReference("R1", "audioText", 1, 2)] });
      const made = executeSharedCommand(set.a, item.first === "insert" ? [insert, remove] : [remove, insert], { label: "Replace", selection: null, typing: null },
        { base: readSharedRevision(set.a) });
      if ("refused" in item) {
        assert.deepEqual(made.result, { ok: false, index: item.first === "insert" ? 1 : 0, operation: remove, reason: "mixed-text-address" });
        assert.equal(made.record, null);
        set.queue.flush(order);
        agree("refused", order, handles, text, ["ab cd"]);
        return;
      }
      assert.deepEqual(made.result, { ok: true }); assert.ok(made.record);
      set.queue.flush(order);
      agree("replaced", order, handles, text, ["aX cd"]);
      let serial = 0;
      const undone = reverseSharedUndoRecord(set.a, made.record, { by: "Alice", nextId: () => "undo" + ++serial });
      assert.equal(undone.ok, true);
      set.queue.flush(order);
      agree("undone", order, handles, text, [item.undone]);
    } finally { set.close(); }
  });
}
