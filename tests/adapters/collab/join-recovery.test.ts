import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";

for (const removed of ["R1", "R2"]) for (const order of ["D1", "rev", "dup"] as const) test(`issued join meeting removal and typing preserves the decided recovery group: ${removed}/${order}`, () => {
  const set = replicas(3, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  const handles = [set.a, set.b, set.c];
  const send = (handle: typeof set.a, value: unknown) => assert.deepEqual(executeSharedOperations(handle, [operation(value)], { base: readSharedRevision(handle) }), { ok: true });
  try {
    for (const handle of handles) { registerSharedJoinHandlers(handle); registerSharedRemovalHandlers(handle); registerSharedTextOperationHandlers(handle); }
    send(set.a, { kind: "join", id: "join", by: "Alice", from: "R2", into: "R1", glue: " " });
    send(set.b, { kind: "remove", id: "remove", by: "Bob", removalKind: "beat", targets: [removed], boundaries: [removed], observed: [], components: [], gallery: [], at: 0 });
    send(set.c, { kind: "text-insert", id: "typed", by: "Carol", target: { owner: "R2", segment: "R2", field: "audioText" },
      at: { left: null, right: flowBaseReference("R2", "audioText", 1), affinity: "before" }, content: [{ value: "X", marks: [] }] });
    set.queue.flush(order);
    agree("join/remove/typing", order, handles, handle => {
      const result = projectSharedDocumentWithRecovery(handle);
      return { rows: result.document.rows.map(row => [row.id, row.audioText]), recovery: result.recovery.map(entry => {
        assert.ok(entry.kind === "removed-beat"); return { id: entry.row.id, text: entry.row.audioText, members: entry.members };
      }) };
    }, removed === "R1" ? { rows: [], recovery: [{ id: "R1", text: "ab cXd", members: ["R1", "R2"] }] }
      : { rows: [["R1", "ab"]], recovery: [{ id: "R2", text: "cXd", members: ["R2"] }] });
  } finally { set.close(); }
});
