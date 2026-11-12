import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { applySharedUpdate, encodeSharedState, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

function reading(handle: SharedDocumentHandle) {
  const entries = [...collabState(handle).roots.beats].flatMap(([from, beat]) => {
    assert.ok(beat instanceof Y.Map); const joins = beat.get("joins"); assert.ok(joins instanceof Y.Map);
    return [...joins].map(([id, value]) => ({ from, id, value: value as Record<string, unknown> }));
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { projection: projectSharedDocumentWithRecovery(handle), entries };
}

test("seeded issued joins retain every writer's intent across cycles, competing targets and delivery checkpoints", t => {
  const declaredLimits: readonly string[] = [], violations = new Set<string>(), covered = new Set<string>();
  let random = 0x5c601, histories = 0, commands = 0, checkpoints = 0, comparisons = 0;
  const choose = (limit: number) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random >>> 16) % limit; };
  const checkpoint = (handles: readonly SharedDocumentHandle[]) => {
    checkpoints++;
    for (const handle of handles) {
      const fresh = createMonitoredSharedDocument();
      try {
        assert.ok(applySharedUpdate(fresh, encodeSharedState(handle)).ok);
        try {
          assertReplicasAgree("issued join checkpoint", [{ order: "D1", replica: "A", output: reading(handle) }, { order: "late-C", replica: "C", output: reading(fresh) }]);
          const result = reading(handle).projection;
          assert.deepEqual(result.recovery, []);
          assert.equal(result.document.rows.map(row => row.audioText).join("").replace(/ /g, "").split("").sort().join(""), "abcd");
        } catch { violations.add("join changes content or differs from an encoded fresh replica"); }
        comparisons++;
      } finally { destroySharedDocument(fresh); }
    }
  };
  for (let sample = 0; sample < 24; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const run = replicas(copies, { rows: [{ id: "R1", audioText: "a" }, { id: "R2", audioText: "b" }, { id: "R3", audioText: "c" }, { id: "R4", audioText: "d" }] });
    const handles = [run.a, run.b, run.c].slice(0, copies), issued: { writer: number; from: string; into: string; glue: "" | " "; by: string; operation: string }[] = [];
    try {
      for (const handle of handles) registerSharedJoinHandlers(handle);
      for (let step = 0; step < 6; step++) {
        const writer = choose(copies), handle = handles[writer]; assert.ok(handle);
        const from = "R" + (choose(4) + 1), into = "R" + (choose(4) + 1), glue = choose(2) ? " " : "";
        const value: (typeof issued)[number] = { writer: writer + 1, from, into, glue, by: "Writer" + writer, operation: "turn" + step };
        assert.deepEqual(executeSharedOperations(handle, [operation({ kind: "join", id: value.operation, by: value.by, from, into, glue })]), { ok: true });
        issued.push(value); covered.add(from === into ? "self" : "edge"); covered.add(glue ? "space" : "empty");
        commands++; checkpoint(handles);
      }
      run.queue.flush(order); checkpoint(handles);
      agree("issued joins " + sample, order, handles, handle => {
        const output = reading(handle); assert.equal(output.entries.length, 6);
        const decoded = output.entries.map(entry => {
          const parts = /^structure_([0-9]+)_([0-9a-f]+)_join_0$/.exec(entry.id); assert.ok(parts);
          const operation = (parts[2]?.match(/.{4}/g) ?? []).map(unit => String.fromCharCode(Number.parseInt(unit, 16))).join("");
          assert.equal(entry.value.operation, operation);
          return { writer: Number(parts[1]), from: entry.from, into: entry.value.into, glue: entry.value.glue, by: entry.value.by, operation };
        }).sort((a, b) => a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0);
        assert.deepEqual(decoded, issued);
        return output;
      }); histories++;
    } finally { run.close(); }
  }
  assert.deepEqual([...violations], declaredLimits); assert.deepEqual([...covered].sort(), ["edge", "empty", "self", "space"]);
  assert.deepEqual({ histories, commands, checkpoints, comparisons }, { histories: 144, commands: 864, checkpoints: 1008, comparisons: 2520 });
  t.diagnostic(JSON.stringify({ seed: 0x5c601, histories, commands, checkpoints, comparisons, covered: [...covered].sort(), declaredLimits, violations: [...violations] }));
});
