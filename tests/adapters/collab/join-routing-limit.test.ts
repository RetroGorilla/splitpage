import test from "node:test";
import assert from "node:assert/strict";
import { replicas, operation, ref } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { readSharedRevision, encodeSharedState, encodeSharedStateVector } from "../../../src/adapters/collab/document.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";

test("declared join routing limit: the painted reader and whole-row offsets still address one physical text", () => {
  const declaredLimits = ["Joined narration paints only its first physical fragment and refuses whole-row offsets beyond it; joined-text routing is the next join cut."];
  const violations: string[] = [], set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  try {
    registerSharedJoinHandlers(set.a); registerSharedTextOperationHandlers(set.a);
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " })]), { ok: true });
    assert.equal(projectSharedDocument(set.a).rows[0]?.audioText, "ab cd");
    const painted = readSharedPaintedText(set.a, { owner: ref("R1"), segment: ref("R1"), field: "audioText" }); assert.ok(painted);
    assert.equal(painted.text, "ab");
    if (painted.text.length !== 5) violations.push("Joined narration paints only its first physical fragment and refuses whole-row offsets beyond it; joined-text routing is the next join cut.");
    const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
    const result = executeSharedOperations(set.a, [operation({ kind: "text-insert", id: "typed", by: "Writer", target: { owner: "R1", segment: "R1", field: "audioText" },
      at: { left: null, right: flowBaseReference("R1", "audioText", 4), affinity: "before" }, content: [{ value: "X", marks: [] }] })], { base: revision });
    assert.ok(!result.ok); assert.equal(result.reason, "invalid-reference");
    assert.deepEqual(encodeSharedState(set.a), bytes); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision);
    assert.deepEqual(violations, declaredLimits);
  } finally { set.close(); }
});
