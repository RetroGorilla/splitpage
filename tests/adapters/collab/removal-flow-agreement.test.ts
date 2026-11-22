import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree } from "./executor-support.ts";
import { validatedFixture } from "./helpers.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { applyFlowOperations } from "../../core/flow/operation-applier.ts";
import { backspaceAt, deleteForwardAt, replaceRange, beatPos } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import { structureIdentityFixture } from "../../collab/structure-identity.ts";

test("complete removal lists agree with app rows, scene membership and the independent applier", t => {
  const runtime = createFlowLoadRuntime(); let calls = 0, executed = 0, removals = 0, creates = 0;
  for (const sample of ["backspace", "forward", "range", "first", "only", "all"] as const) for (const order of ["D1", "rev", "dup"] as const) {
    const blank = sample === "backspace" || sample === "forward";
    const source = validatedFixture({ rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: blank ? "" : "cd", ...(blank ? {} : { visualText: "<em>Look</em>", imageName: "Picture" }) }, { id: "R3", audioText: "ef" }],
      sections: sample === "first" ? [{ id: "H1", name: "Scene", firstSceneId: "R2" }] : sample === "only" ? [
        { id: "H0", name: "Before", firstSceneId: "R1" }, { id: "H1", name: "Empty", firstSceneId: "R2" }, { id: "H2", name: "After", firstSceneId: "R3" }] : [] });
    const doc: FlowDoc = { rows: source.rows, sections: source.sections, comments: [] }, ports = { ...runtime.ports, newId: () => "blank", operations: { id: "flow", by: "Writer" } };
    const outcome = sample === "backspace" ? backspaceAt(doc, beatPos("R2", 0), ports, { tick: "delete" }) : sample === "forward" ? deleteForwardAt(doc, beatPos("R2", 0), ports)
      : replaceRange(doc, { anchor: beatPos(sample === "all" ? "R1" : "R2", 0), head: beatPos("R3", sample === "all" ? 2 : 0) }, [], ports, true);
    assert.ok(outcome && "rows" in outcome && outcome.ops);
    const expected = applyFlowOperations(doc, outcome.ops, runtime.cells); assert.deepEqual(expected.rows, outcome.rows); assert.deepEqual(expected.sections, outcome.sections);
    const set = replicas(3, source), aliases = new Map<string, string>();
    try {
      registerSharedRemovalHandlers(set.a); registerSharedSplitHandlers(set.a, runtime); registerSharedTextOperationHandlers(set.a);
      for (const op of outcome.ops) if (op.kind === "segment-create") { aliases.set(op.beat, structureIdentityFixture("1", op.id, "beat")); creates++; }
      assert.deepEqual(executeSharedOperations(set.a, outcome.ops, { base: readSharedRevision(set.a) }), { ok: true }, sample + JSON.stringify(outcome.ops));
      const read = (handle: typeof set.a) => { const loaded = runtime.load(projectSharedDocument(handle)); return { rows: loaded.rows, sections: loaded.sections }; };
      const normalized = runtime.load({ ...source, rows: expected.rows.map(row => ({ ...row, id: aliases.get(String(row.id)) ?? row.id })),
        sections: expected.sections?.map(scene => ({ ...scene, firstSceneId: aliases.get(scene.firstSceneId) ?? scene.firstSceneId })) });
      set.queue.flush(order); agree(sample, order, [set.a, set.b, set.c], handle => { const result = read(handle);
        assert.deepEqual(result.rows, normalized.rows, sample + "/rows"); assert.deepEqual(result.sections, normalized.sections, sample + "/sections"); return result;
      });
      calls++; executed += outcome.ops.length; removals += outcome.ops.filter(op => op.kind === "remove").length;
    } finally { set.close(); }
  }
  assert.deepEqual({ calls, executed, removals, creates }, { calls: 18, executed: 42, removals: 24, creates: 3 });
  t.diagnostic(JSON.stringify({ calls, executed, removals, creates, skipped: 0, deferred: 0, limits: [] }));
});
