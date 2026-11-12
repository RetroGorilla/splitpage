import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree } from "./executor-support.ts";
import { validatedFixture } from "./helpers.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { joinWithPrevious, backspaceAt, beatPos } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { applyFlowOperations } from "../../core/flow/operation-applier.ts";

test("complete app join lists equal the independent applier and shared rows, visuals, gallery, status and sections", t => {
  const runtime = createFlowLoadRuntime(), limits: readonly string[] = []; let calls = 0, moves = 0, executed = 0, joins = 0, seed = 0x5c606;
  const choose = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % limit; };
  for (let sample = 0; sample < 12; sample++) for (const method of ["direct", "backspace"] as const) for (const order of ["D1", "rev", "dup"] as const) {
    const source = validatedFixture({ rows: [
      { id: "R1", audioText: ["<b>ab</b>", "", "ab ", "<em>a</em>b"][choose(4)], visualText: "<b>Left</b>", status: ["todo", "ready", "shot"][choose(3)], lengthSeconds: 7,
        imageRef: { sha256: "1".repeat(64) }, imageName: sample % 2 ? "first" : "", imageLinks: [{ href: "https://v/1" }] },
      { id: "R2", audioText: ["cd", "<b>cd</b>", "c<br>d"][choose(3)], visualText: "<em>Right</em>", status: ["todo", "ready", "shot"][choose(3)], lengthSeconds: 19,
        imageRef: { sha256: (sample % 2 ? "2" : "1").repeat(64) }, imageName: "second", imageLinks: [{ href: "https://v/2", poster: true }] },
      { id: "R3", audioText: "end" }
    ], sections: [{ id: "H1", name: "Before", firstSceneId: "R1" }, { id: "H2", name: "After", firstSceneId: "R3" }] });
    const doc: FlowDoc = { rows: source.rows, sections: source.sections, comments: [] }, ports = { ...runtime.ports, operations: { id: "flow", by: "Writer" } };
    const result = method === "direct" ? joinWithPrevious(doc, "R2", ports) : backspaceAt(doc, beatPos("R2", 0), ports, { tick: "join" });
    if (result && "move" in result) { assert.deepEqual(result, { move: beatPos("R1", 0) }); moves++; continue; }
    assert.ok(result && "rows" in result && result.ops); const expected = applyFlowOperations(doc, result.ops, runtime.cells);
    assert.deepEqual(expected.rows, result.rows); assert.deepEqual(expected.sections, result.sections);
    const set = replicas(3, source);
    try {
      registerSharedJoinHandlers(set.a);
      assert.deepEqual(executeSharedOperations(set.a, result.ops, { base: readSharedRevision(set.a) }), { ok: true });
      const normalized = runtime.load({ ...source, rows: expected.rows, sections: expected.sections });
      set.queue.flush(order); agree(method + sample, order, [set.a, set.b, set.c], handle => {
        const loaded = runtime.load(projectSharedDocument(handle)); assert.deepEqual(loaded.rows, normalized.rows); assert.deepEqual(loaded.sections, normalized.sections);
        return { rows: loaded.rows, sections: loaded.sections };
      });
      calls++; executed += result.ops.length; joins += result.ops.filter(op => op.kind === "join").length;
    } finally { set.close(); }
  }
  t.diagnostic(JSON.stringify({ seed: 0x5c606, calls, moves, executed, joins, skipped: 0, deferred: 0, limits }));
  assert.deepEqual({ calls, moves, executed, joins, skipped: 0, deferred: 0, limits }, { calls: 64, moves: 8, executed: 64, joins: 64, skipped: 0, deferred: 0, limits: [] });
});
