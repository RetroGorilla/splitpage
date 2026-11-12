import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree } from "./executor-support.ts";
import { validatedFixture } from "./helpers.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedHeadingHandlers } from "../../../src/adapters/collab/heading-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { applyFlowOperations } from "../../core/flow/operation-applier.ts";
import { pasteFlowRange, beatPos } from "../../../src/core/flow/flow.ts";
import type { FlowClipboardSlice, FlowDoc, FlowPos } from "../../../src/core/flow/flow.ts";
import { structureIdentityFixture } from "../../collab/structure-identity.ts";

const pasted = (count: number) => Array.from({ length: count }, (_, index) => ({ id: "P" + index, audioText: "p" + index, visualText: "", status: "todo" }));
const header = (index: number, name = "New") => ({ index, scene: { id: "clip", name, firstSceneId: "" } });
const clips: Record<string, FlowClipboardSlice> = {
  bare: { text: "", rows: [], headers: [header(0)], wholeIds: [] },
  leading: { text: "", rows: pasted(1), headers: [header(0, " Mid ")], wholeIds: [] },
  trailing: { text: "", rows: pasted(1), headers: [header(1)], wholeIds: [] },
  both: { text: "", rows: pasted(2), headers: [header(0, "First"), header(1, "Second")], wholeIds: [] }
};
const places: Record<string, readonly [FlowPos, FlowPos]> = {
  "R1@0": [beatPos("R1", 0), beatPos("R1", 0)], "R1@1": [beatPos("R1", 1), beatPos("R1", 1)], "R1@2": [beatPos("R1", 2), beatPos("R1", 2)],
  "R2@0": [beatPos("R2", 0), beatPos("R2", 0)], "R3@2": [beatPos("R3", 2), beatPos("R3", 2)], "R1@1-R1@2": [beatPos("R1", 1), beatPos("R1", 2)],
  "R1@1-R3@1": [beatPos("R1", 1), beatPos("R3", 1)]
};

test("complete paste lists carrying scene headers agree with app rows, scene membership and the independent applier", t => {
  const runtime = createFlowLoadRuntime(); let calls = 0, executed = 0, headings = 0, creates = 0, splits = 0;
  const source = validatedFixture({ rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }], sections: [{ id: "H1", name: "One", firstSceneId: "R2" }] });
  const doc: FlowDoc = { rows: source.rows, sections: source.sections, comments: [] };
  for (const [place, [anchor, head]] of Object.entries(places)) for (const [name, clip] of Object.entries(clips)) for (const order of ["D1", "rev", "dup"] as const) {
    let next = 0;
    const outcome = pasteFlowRange(doc, { anchor, head }, clip, { ...runtime.ports, newId: () => "fresh" + ++next, operations: { id: "paste", by: "Writer" } });
    assert.ok(outcome && "rows" in outcome && outcome.ops, place + name);
    const expected = applyFlowOperations(doc, outcome.ops, runtime.cells); assert.deepEqual(expected.rows, outcome.rows); assert.deepEqual(expected.sections, outcome.sections);
    const set = replicas(3, source), aliases = new Map<string, string>(), label = place + "/" + name + "/" + order;
    try {
      registerSharedRemovalHandlers(set.a); registerSharedSplitHandlers(set.a, runtime); registerSharedTextOperationHandlers(set.a); registerSharedHeadingHandlers(set.a);
      const { projector } = captureIncrementalReplica(set.b);
      for (const op of outcome.ops) {
        if (op.kind === "segment-create" || op.kind === "split") aliases.set(op.beat, structureIdentityFixture("1", op.id, "beat"));
        if (op.kind === "heading-create") aliases.set(op.heading, structureIdentityFixture("1", op.id, "heading"));
      }
      assert.deepEqual(executeSharedOperations(set.a, outcome.ops, { base: readSharedRevision(set.a) }), { ok: true }, label + JSON.stringify(outcome.ops));
      const read = (handle: typeof set.a) => { const loaded = runtime.load(projectSharedDocument(handle)); return { rows: loaded.rows, sections: loaded.sections }; };
      const normalized = runtime.load({ ...source, rows: expected.rows.map(row => ({ ...row, id: aliases.get(String(row.id)) ?? row.id })),
        sections: expected.sections?.map(scene => ({ ...scene, id: aliases.get(scene.id) ?? scene.id, firstSceneId: aliases.get(scene.firstSceneId) ?? scene.firstSceneId })) });
      set.queue.flush(order); assertIncremental(set.b, projector);
      agree(label, order, [set.a, set.b, set.c], handle => { const result = read(handle);
        assert.deepEqual(result.rows, normalized.rows, label + "/rows"); assert.deepEqual(result.sections, normalized.sections, label + "/sections"); return result;
      });
      calls++; executed += outcome.ops.length; headings += outcome.ops.filter(op => op.kind === "heading-create").length;
      creates += outcome.ops.filter(op => op.kind === "segment-create").length; splits += outcome.ops.filter(op => op.kind === "split").length;
    } finally { set.close(); }
  }
  assert.deepEqual({ calls, executed, headings, creates, splits }, { calls: 84, executed: 588, headings: 105, creates: 132, splits: 12 });
  t.diagnostic(JSON.stringify({ calls, executed, headings, creates, splits, skipped: 0, deferred: 0, limits: [] }));
});
