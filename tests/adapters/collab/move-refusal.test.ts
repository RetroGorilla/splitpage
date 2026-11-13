import test from "node:test";
import assert from "node:assert/strict";
import { replicas } from "./executor-support.ts";
import { validatedFixture } from "./helpers.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedHeadingHandlers } from "../../../src/adapters/collab/heading-executor.ts";
import { registerSharedMoveRefusal } from "../../../src/adapters/collab/move-refusal.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { beatPos, headingPos, moveBeats, typeWithMarks } from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowOutcome } from "../../../src/core/flow/flow.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";

const runtime = createFlowLoadRuntime();
const source = validatedFixture({ rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }, { id: "R4", audioText: "gh" }],
  sections: [{ id: "H1", name: "One", firstSceneId: "R1" }, { id: "H2", name: "Two", firstSceneId: "R3" }] });
const doc: FlowDoc = { rows: source.rows, sections: source.sections, comments: [] };
const ports = { ...runtime.ports, newId: () => "fresh", operations: { id: "move", by: "Writer" } };

function opsOf(outcome: FlowOutcome): readonly SharedOperation[] {
  assert.ok(outcome && "rows" in outcome && outcome.ops);
  return outcome.ops;
}

function refusedUnchanged(ops: readonly SharedOperation[], index: number): void {
  const set = replicas(2, source);
  try {
    registerSharedRemovalHandlers(set.a); registerSharedSplitHandlers(set.a, runtime); registerSharedTextOperationHandlers(set.a);
    registerSharedHeadingHandlers(set.a); registerSharedMoveRefusal(set.a);
    const before = [encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)];
    assert.deepEqual(executeSharedOperations(set.a, ops, { base: readSharedRevision(set.a) }),
      { ok: false, index, operation: ops[index], reason: "move-in-shared-session" });
    assert.deepEqual([encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)], before);
    assert.deepEqual(runtime.load(projectSharedDocument(set.a)).rows.map(row => [row.id, row.audioText]), [["R1", "ab"], ["R2", "cd"], ["R3", "ef"], ["R4", "gh"]]);
  } finally { set.close(); }
}

test("a whole-beat move from the flow is refused by name and writes nothing", () => {
  const ops = opsOf(moveBeats(doc, ["R2"], beatPos("R4", 2), ports));
  assert.deepEqual(ops.map(op => op.kind), ["segment-move", "scalar"]);
  refusedUnchanged(ops, 0);
});

test("moving a scene's beats before another scene is refused by name after its heading removal prepared, and writes nothing", () => {
  const ops = opsOf(moveBeats(doc, ["R3", "R4"], headingPos("H1", 0), ports));
  assert.deepEqual(ops.map(op => op.kind), ["heading-remove", "segment-move", "scalar"]);
  refusedUnchanged(ops, 1);
});

test("a list that types a character and then moves a beat is refused whole and the character is not written", () => {
  const typed = opsOf(typeWithMarks(doc, beatPos("R1", 1), "x", {}, { ...runtime.ports, operations: { id: "typed", by: "Writer" } }));
  assert.deepEqual(typed.map(op => op.kind), ["text-insert"]);
  refusedUnchanged([...typed, ...opsOf(moveBeats(doc, ["R2"], beatPos("R4", 2), ports))], 1);
});
