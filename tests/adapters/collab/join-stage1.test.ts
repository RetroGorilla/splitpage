import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation, ref } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { createSharedAnchor, resolveSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { readSharedTextHistory } from "../../../src/adapters/collab/text-history.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { IdentityBook, checkModel } from "../../collab/checker.ts";
import type { CollabCharacter, CollabModel } from "../../collab/checker.ts";
import { joinNarrationOracle } from "../../collab/oracles/oracles.ts";
import { beatOracles } from "../../collab/oracles/structure-oracles.ts";

for (const trace of ["T06", "T12"] as const) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) test(`Stage 1 ${trace} join and retirement retain original native ids: ${copies}/${order}`, () => {
  const set = replicas(copies, { rows: [{ id: "R1", audioText: trace === "T06" ? "<b>ab</b>" : "ab" }, { id: "R2", audioText: "cd" }] });
  const handles = [set.a, set.b, set.c].slice(0, copies), book = new IdentityBook(), runtime = createFlowLoadRuntime();
  const text = (handle: typeof set.a, owner: string) => (collabState(handle).roots.segments.get("b:" + owner) as Y.Map<unknown>).get("text") as Y.Text;
  const send = (handle: typeof set.a, value: unknown) => assert.deepEqual(executeSharedOperations(handle, [operation(value)], { base: readSharedRevision(handle) }), { ok: true });
  try {
    for (const handle of handles) { registerSharedJoinHandlers(handle); registerSharedTextOperationHandlers(handle); }
    let number = 0;
    for (const owner of ["R1", "R2"]) for (let offset = 0; offset < 2; offset++) { const unit = Y.createRelativePositionFromTypeIndex(text(set.a, owner), offset).item; assert.ok(unit); book.bind("s" + ++number, unit); }
    const anchorA = createSharedAnchor(set.a, "b:R2", 0, "before"); assert.ok(anchorA);
    const join = { kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " };
    send(set.a, join);
    if (trace === "T06") send(set.b, join);
    else send(set.b, { kind: "text-insert", id: "typed", by: "Bob", target: { owner: "R2", segment: "b:R2", field: "audioText" },
      at: { left: null, right: flowBaseReference("R2", "audioText", 1), affinity: "before" }, content: [{ value: "Z", marks: [] }] });
    if (copies === 3) send(set.c, join);
    if (trace === "T12") { const unit = Y.createRelativePositionFromTypeIndex(text(set.b, "R2"), 1).item; assert.ok(unit); book.bind("b1", unit); }
    const anchorB = createSharedAnchor(set.b, "b:R2", trace === "T12" ? 2 : 0, "after"); assert.ok(anchorB);
    set.queue.flush(order);
    const read = (handle: typeof set.a, retired: boolean): CollabModel => {
      const roots = collabState(handle).roots, joins = (roots.beats.get("R2") as Y.Map<unknown>).get("joins"); assert.ok(joins instanceof Y.Map);
      const selected = [...joins].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).find(([key, raw]) => {
        const value = raw as { into: string; glue: string; generation: number };
        return roots.retiredJoins.get(key) !== true && roots.retiredJoins.get(JSON.stringify(["join-retirement", "R2", value.into, value.glue, value.generation])) !== true;
      });
      const glue = selected ? (selected[1] as { glue: string }).glue : "";
      const chars = (owner: string, beat: string): CollabCharacter[] => {
        const history = readSharedTextHistory(handle, { owner: ref(owner), segment: ref("b:" + owner), field: "audioText" }); assert.ok(history);
        return history.units.map(unit => ({ identity: unit.unit, notation: book.notation(unit.unit), value: String(unit.value), beat,
          marks: unit.marks.some(mark => mark.kind === "b") ? { b: true } : {} }));
      };
      const rows = selected ? [{ id: "R1", characters: [...chars("R1", "R1"), ...glue.split("").map(value => ({ identity: null, notation: "[glue]", value, marks: {}, beat: "R1" })), ...chars("R2", "R1")] }]
        : [{ id: "R1", characters: chars("R1", "R1") }, { id: "R2", characters: chars("R2", "R2") }];
      const caret = (anchor: typeof anchorA) => { const found = resolveSharedAnchor(handle, anchor); assert.ok(found !== "gone");
        return { beat: selected ? "R1" : "R2", offset: found.offset + (selected ? chars("R1", "R1").length + glue.length : 0) }; };
      const projected = projectSharedDocumentWithRecovery(handle);
      assert.deepEqual(projected.document.rows.map(row => [row.id, runtime.cells(row.audioText).map(run => run.text).join("")]), rows.map(row => [row.id, row.characters.map(char => char.value).join("")]));
      const model = { rows, carets: { A: caret(anchorA), B: caret(anchorB) }, recovery: [] };
      if (trace === "T12") { const oracle = beatOracles[retired ? "T12 join undo" : "T12 join"]; assert.ok(oracle); checkModel(model, oracle, book, order); }
      else if (!retired) checkModel(model, joinNarrationOracle, book, order);
      else checkModel(model, { rows: [{ id: "R1", characters: [["s1", "a", { b: true }], ["s2", "b", { b: true }]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] }],
        carets: { A: { beat: "R2", offset: 0 }, B: { beat: "R2", offset: 0 } }, recovery: [] }, book, order);
      assert.deepEqual(projected.recovery, []); return model;
    };
    agree(trace + " joined", order, handles, handle => read(handle, false));
    send(set.a, { kind: "join-retire", id: "undo", by: "Alice", joins: ["structure_1_006a006f0069006e_join_0"] }); set.queue.flush(order);
    agree(trace + " retired", order, handles, handle => read(handle, true));
    assert.equal(collabState(set.a).roots.order.length, 2);
  } finally { set.close(); }
});
