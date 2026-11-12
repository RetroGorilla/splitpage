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
import { observeSharedStructureIndex } from "../../../src/adapters/collab/structure-index.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";

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

test("seeded join, glue and retirement checkpoints compare indexes and incremental projection with encoded copies", t => {
  const declaredLimits: readonly string[] = [], violations = new Set<string>(), kinds = new Set<string>();
  let seed = 0x5c612, histories = 0, commands = 0, checkpoints = 0, indexComparisons = 0;
  const choose = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % limit; };
  for (let sample = 0; sample < 8; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const set = replicas(copies, { rows: [{ id: "R1", audioText: "a" }, { id: "R2", audioText: "b" }, { id: "R3", audioText: "c" }, { id: "R4", audioText: "d" }] });
    const handles = [set.a, set.b, set.c].slice(0, copies), known = new Set<string>(["damaged"]), incremental = handles.map(handle => captureIncrementalReplica(handle));
    const checkpoint = () => {
      checkpoints++;
      for (let writer = 0; writer < handles.length; writer++) {
        const handle = handles[writer], patched = incremental[writer]; assert.ok(handle && patched);
        const fresh = createMonitoredSharedDocument();
        try {
          assert.ok(applySharedUpdate(fresh, encodeSharedState(handle)).ok);
          const expected = reading(fresh), live = reading(handle);
          for (const entry of live.entries) known.add(entry.id);
          assertReplicasAgree("join checkpoint", [{ order: "D1", replica: "A", output: live }, { order: "late-C", replica: "C", output: expected }]);
          assertIncremental(handle, patched.projector);
          const index = observeSharedStructureIndex(handle).joins(), rebuilt = observeSharedStructureIndex(fresh).joins();
          for (const id of known) {
            const owners = expected.entries.filter(entry => entry.id === id).map(entry => entry.from).sort();
            assert.deepEqual(index.locations(id), owners); assert.deepEqual(rebuilt.locations(id), owners); indexComparisons++;
          }
          assert.deepEqual(live.projection.recovery, []);
          assert.equal(live.projection.document.rows.map(row => row.audioText).join("").replace(/ /g, "").split("").sort().join(""), "abcd");
        } catch (error) { violations.add("join checkpoint changes content or differs from a fresh projection or index"); t.diagnostic(String(error)); }
        finally { destroySharedDocument(fresh); }
      }
    };
    try {
      handles.forEach(registerSharedJoinHandlers);
      for (let step = 0; step < 12; step++) {
        const handle = handles[choose(copies)]; assert.ok(handle);
        const local = reading(handle).entries.filter(entry => entry.id !== "damaged");
        const active = local.filter(entry => {
          const value = entry.value, roots = collabState(handle).roots;
          return roots.retiredJoins.get(entry.id) !== true && roots.retiredJoins.get(JSON.stringify(["join-retirement", entry.from, value.into, value.glue, value.generation])) !== true;
        });
        const kind = step % 3 === 1 && active.length ? "join-glue" : step % 3 === 2 && local.length ? "join-retire" : "join";
        const pool = kind === "join-glue" ? active : local, entry = pool[choose(Math.max(1, pool.length))];
        const payload = kind === "join" ? { from: "R" + (choose(4) + 1), into: "R" + (choose(4) + 1), glue: choose(2) ? " " : "" }
          : { joins: [entry?.id], ...(kind === "join-glue" ? { glue: choose(2) ? " " : "" } : {}) };
        assert.deepEqual(executeSharedOperations(handle, [operation({ kind, id: "turn" + step, by: "Writer", ...payload })]), { ok: true }); kinds.add(kind); commands++;
        if (step % 4 === 3) {
          const raw = collabState(handle).roots.beats.get("R4"); assert.ok(raw instanceof Y.Map);
          const joins = raw.get("joins"); assert.ok(joins instanceof Y.Map);
          const values = [null, [], { into: "R1", glue: "x" }, { into: "R2", glue: " ", generation: -1 }, { into: "missing", glue: "" }];
          transactSharedDocument(handle, "hydration", () => {
            joins.set("damaged", values[choose(values.length)]);
            if (step === 7) raw.set("joins", new Y.Map([...joins]));
            if (step === 11) joins.delete("damaged");
          });
          set.queue.flush(order);
        }
        checkpoint();
      }
      set.queue.flush(order); checkpoint();
      agree("join commands " + sample, order, handles, reading); histories++;
    } finally { for (const replica of incremental) replica.projector.dispose(); set.close(); }
  }
  assert.deepEqual([...violations], declaredLimits); assert.deepEqual([...kinds].sort(), ["join", "join-glue", "join-retire"]);
  assert.deepEqual({ histories, commands, checkpoints, indexComparisons }, { histories: 48, commands: 576, checkpoints: 624, indexComparisons: 6955 });
  t.diagnostic(JSON.stringify({ seed: 0x5c612, histories, commands, checkpoints, indexComparisons, declaredLimits, violations: [...violations] }));
});
