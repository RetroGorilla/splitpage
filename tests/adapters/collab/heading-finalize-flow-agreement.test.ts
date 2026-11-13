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
import { readSharedRevision, encodeSharedState, encodeSharedStateVector } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { applyFlowOperations } from "../../core/flow/operation-applier.ts";
import { finalizeHeading, startParagraph, beatPos } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import { structureIdentityFixture } from "../../collab/structure-identity.ts";

const scene = [{ id: "H1", name: "One", firstSceneId: "R0" }];
const places: Record<string, { readonly source: Record<string, unknown>; readonly row: string; readonly enter: number | null; readonly split?: number }> = {
  "first beat, follower": { source: { rows: [{ id: "R1", audioText: "# Ab" }, { id: "R2", audioText: "cd", paragraphStart: true }] }, row: "R1", enter: null },
  "first beat, tail": { source: { rows: [{ id: "R1", audioText: "# Ab<br>cd" }, { id: "R2", audioText: "ef" }] }, row: "R1", enter: null },
  "only beat, empty first beat": { source: { rows: [{ id: "R1", audioText: "# Ab" }] }, row: "R1", enter: null },
  "first beat, Enter": { source: { rows: [{ id: "R1", audioText: "# Abcd" }] }, row: "R1", enter: 4 },
  "mid scene, follower": { source: { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# Ab", paragraphStart: true }, { id: "R2", audioText: "cd", paragraphStart: true }], sections: scene }, row: "R1", enter: null },
  "mid scene, tail": { source: { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "#  Ab <br>cd", paragraphStart: true }, { id: "R2", audioText: "ef" }], sections: scene }, row: "R1", enter: null },
  "existing scene, follower": { source: { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# Ab" }, { id: "R2", audioText: "cd", paragraphStart: true }], sections: [{ id: "H1", name: "One", firstSceneId: "R1" }] }, row: "R1", enter: null },
  "existing scene, tail": { source: { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# Ab<br>cd" }, { id: "R2", audioText: "ef" }], sections: [{ id: "H1", name: "One", firstSceneId: "R1" }] }, row: "R1", enter: null },
  "split inline, tail": { source: { rows: [{ id: "R0", audioText: "x# Ab<br>cd" }, { id: "R2", audioText: "ef" }], sections: scene }, row: "split", enter: null, split: 1 },
  "split inline, follower": { source: { rows: [{ id: "R0", audioText: "x# Ab" }, { id: "R2", audioText: "ef", paragraphStart: true }] }, row: "split", enter: null, split: 1 },
  "bold name, comment in tail": { source: { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# A<b>b</b>c<br>r<span class=\"cmt-anchor\" data-cmt=\"C1\">es</span>t", paragraphStart: true }],
    comments: [{ id: "C1", rowId: "R1", text: "note" }] }, row: "R1", enter: null },
  "comment in name": { source: { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# A<span class=\"cmt-anchor\" data-cmt=\"C1\">b</span><br>rest", paragraphStart: true }],
    comments: [{ id: "C1", rowId: "R1", text: "note" }] }, row: "R1", enter: null }
};

test("complete finalization lists agree with app rows, scene ids, names and first beats under three delivery orders and a late joiner", t => {
  const runtime = createFlowLoadRuntime(); let calls = 0, executed = 0, finalized = 0, removed = 0, creates = 0;
  for (const [place, { source: raw, row, enter, split }] of Object.entries(places)) for (const order of ["D1", "rev", "dup"] as const) {
    const source = validatedFixture(raw), label = place + "/" + order, aliases = new Map<string, string>();
    let doc: FlowDoc = { rows: source.rows, sections: source.sections, comments: source.comments ?? [] }, target = row, next = 0;
    const lists: (readonly SharedOperation[])[] = [];
    if (split !== undefined) {
      const cut = startParagraph(doc, beatPos("R0", split), { ...runtime.ports, newId: () => "split" + ++next, operations: { id: "split", by: "Writer" } });
      assert.ok(cut && "rows" in cut && cut.ops, label); lists.push(cut.ops); target = structureIdentityFixture("1", "split_o_0", "beat");
      doc = { rows: cut.rows.map(item => item.id === "split1" ? { ...item, id: target } : item), sections: cut.sections ?? doc.sections, comments: doc.comments };
    }
    const outcome = finalizeHeading(doc, target, enter, null, { ...runtime.ports, newId: () => "fresh" + ++next, operations: { id: "fin", by: "Writer" } });
    assert.ok(outcome && "rows" in outcome && outcome.ops, label); lists.push(outcome.ops);
    const expected = applyFlowOperations(doc, outcome.ops, runtime.cells); assert.deepEqual(expected.rows, outcome.rows, label); assert.deepEqual(expected.sections, outcome.sections, label);
    const set = replicas(3, source);
    try {
      registerSharedRemovalHandlers(set.a); registerSharedSplitHandlers(set.a, runtime); registerSharedTextOperationHandlers(set.a); registerSharedHeadingHandlers(set.a);
      const { projector } = captureIncrementalReplica(set.b);
      for (const ops of lists) {
        for (const op of ops) {
          if (op.kind === "segment-create" || op.kind === "split") aliases.set(op.beat, structureIdentityFixture("1", op.id, "beat"));
          if (op.kind === "heading-finalize") aliases.set(op.heading, structureIdentityFixture("1", op.id, "heading"));
        }
        assert.deepEqual(executeSharedOperations(set.a, ops, { base: readSharedRevision(set.a) }), { ok: true }, label + JSON.stringify(ops));
        set.queue.flush(order); assertIncremental(set.b, projector);
        calls++; executed += ops.length; finalized += ops.filter(op => op.kind === "heading-finalize").length;
        removed += ops.filter(op => op.kind === "remove").length; creates += ops.filter(op => op.kind === "segment-create").length;
      }
      const name = (id: string) => aliases.get(id) ?? id;
      const normalized = runtime.load({ ...source, rows: outcome.rows.map(item => ({ ...item, id: name(String(item.id)) })),
        sections: outcome.sections?.map(item => ({ ...item, id: name(item.id), firstSceneId: name(item.firstSceneId) })) });
      agree(label, order, [set.a, set.b, set.c], handle => {
        const loaded = runtime.load(projectSharedDocument(handle)), result = { rows: loaded.rows, sections: loaded.sections };
        assert.deepEqual(result.rows, normalized.rows, label + "/rows"); assert.deepEqual(result.sections, normalized.sections, label + "/sections"); return result;
      });
    } finally { set.close(); }
  }
  assert.deepEqual({ calls, executed, finalized, removed, creates }, { calls: 42, executed: 93, finalized: 33, removed: 15, creates: 9 });
  t.diagnostic(JSON.stringify({ calls, executed, finalized, removed, creates, skipped: 0, deferred: 0, limits: [] }));
});

const declaredLimits = Object.freeze([
  { place: "last beat after an earlier beat", rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# Ab", paragraphStart: true }] },
  { place: "last beat of a scene before the next heading", rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# Ab", paragraphStart: true }, { id: "R2", audioText: "ef" }],
    sections: [{ id: "H1", name: "One", firstSceneId: "R0" }, { id: "H2", name: "Two", firstSceneId: "R2" }] }
]);
test("declared limit: an empty first beat the app creates after an earlier beat lands before the finalized line, so the complete list is refused and nothing is written", t => {
  const runtime = createFlowLoadRuntime();
  for (const { place, ...raw } of declaredLimits) {
    const source = validatedFixture(raw);
    let next = 0;
    const outcome = finalizeHeading({ rows: source.rows, sections: source.sections, comments: [] }, "R1", null, null, { ...runtime.ports, newId: () => "fresh" + ++next, operations: { id: "fin", by: "Writer" } });
    assert.ok(outcome && "rows" in outcome && outcome.ops, place);
    assert.deepEqual(outcome.ops.map(op => op.kind), ["segment-create", "heading-finalize", "remove"], place);
    const created = outcome.ops[0]; assert.ok(created?.kind === "segment-create");
    assert.deepEqual(created.at, { left: "R0", right: "sections" in raw ? "R2" : null, affinity: "after" }, place);
    const set = replicas(2, source);
    try {
      registerSharedRemovalHandlers(set.a); registerSharedSplitHandlers(set.a, runtime); registerSharedTextOperationHandlers(set.a); registerSharedHeadingHandlers(set.a);
      const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
      const result = executeSharedOperations(set.a, outcome.ops, { base: revision });
      assert.ok(!result.ok && "index" in result, place); assert.deepEqual([result.reason, result.index], ["misplaced-heading-beat", 1], place);
      assert.deepEqual([encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)], [bytes, vector, revision], place);
    } finally { set.close(); }
  }
  t.diagnostic(JSON.stringify({ limits: declaredLimits.map(item => "empty first beat placed before the line, " + item.place + ": refused with misplaced-heading-beat") }));
});
