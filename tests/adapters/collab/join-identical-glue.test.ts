import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { deliveryReplica } from "./helpers.ts";

const source = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }] };
const ids = ["structure_1_006a006f0069006e_join_0", "structure_2_006a006f0069006e_join_0", "structure_3_006a006f0069006e_join_0"];
const join = operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " });
const change = (index: number, glue: string) => operation({ kind: "join-glue", id: "change", by: "Writer", joins: [ids[index]], glue });
const read = (handle: Parameters<typeof collabState>[0]) => projectSharedDocumentWithRecovery(handle).document.rows.map(row => [row.id, row.audioText]);

test("the obsolete per-entry separator key is ignored rather than read as a fallback", () => {
  const set = replicas(2, source);
  try {
    registerSharedJoinHandlers(set.a); assert.deepEqual(executeSharedOperations(set.a, [join]), { ok: true });
    transactSharedDocument(set.a, "hydration", () => collabState(set.a).roots.meta.set("joinGlue:structure_1_006a006f0069006e_join_0", ""));
    set.queue.flush("dup"); agree("obsolete separator key", "dup", [set.a, set.b], read, [["R1", "ab cd"], ["R3", "ef"]]);
    assert.deepEqual(executeSharedOperations(set.a, [change(0, "")]), { ok: true });
    set.queue.flush("rev"); agree("group separator key", "rev", [set.a, set.b], read, [["R1", "abcd"], ["R3", "ef"]]);
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) for (const author of [0, 1]) test(`either identical join's early separator change survives delivery: ${order}/${author}`, () => {
  const set = replicas(2, source), handles = [set.a, set.b], incremental = handles.map(handle => captureIncrementalReplica(handle));
  try {
    handles.forEach(registerSharedJoinHandlers);
    handles.forEach(handle => assert.deepEqual(executeSharedOperations(handle, [join]), { ok: true }));
    const handle = handles[author]; assert.ok(handle);
    assert.deepEqual(executeSharedOperations(handle, [change(author, "")]), { ok: true });
    assert.deepEqual(read(handle), [["R1", "abcd"], ["R3", "ef"]]);
    set.queue.flush(order);
    agree("early identical separator", order, handles, read, [["R1", "abcd"], ["R3", "ef"]]);
    agree("one group register", order, handles, handle => [...collabState(handle).roots.meta].filter(([key]) => key.startsWith("joinGlue:")),
      [['joinGlue:["join-retirement","R2","R1"," ",0]', ""]]);
    handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); });
  } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) for (const values of [["", " "], [" ", ""]]) test(`competing separators through different identical entries use the scalar winner: ${order}/${values[0]}`, () => {
  const set = replicas(2, source), handles = [set.a, set.b], incremental = handles.map(handle => captureIncrementalReplica(handle));
  try {
    handles.forEach(registerSharedJoinHandlers);
    handles.forEach(handle => assert.deepEqual(executeSharedOperations(handle, [join]), { ok: true }));
    handles.forEach((handle, index) => {
      const glue = values[index]; assert.equal(typeof glue, "string"); assert.ok(glue !== undefined);
      assert.deepEqual(executeSharedOperations(handle, [change(index, glue),
        operation({ kind: "scalar", id: "control", by: "Writer", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: index + 1 })]), { ok: true });
    });
    set.queue.flush(order);
    agree("identical register winner", order, handles, read, [["R1", values[1] === "" ? "abcd" : "ab cd"], ["R3", "ef"]]);
    agree("matching scalar winner", order, handles, handle => (collabState(handle).roots.beats.get("R1") as Y.Map<unknown>).get("lengthSeconds"), 2);
    handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); });
  } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
});

test("retired join and exhausted generation refuse the whole list without changing state", () => {
  for (const reason of ["retired-join", "join-generation-limit"]) {
    const set = replicas(2, source);
    try {
      registerSharedJoinHandlers(set.a); assert.deepEqual(executeSharedOperations(set.a, [join]), { ok: true });
      if (reason === "retired-join") assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join-retire", id: "retire", by: "Writer", joins: [ids[0]] })]), { ok: true });
      else transactSharedDocument(set.a, "hydration", () => {
        const beat = collabState(set.a).roots.beats.get("R2"); assert.ok(beat instanceof Y.Map);
        const joins = beat.get("joins"); assert.ok(joins instanceof Y.Map);
        joins.set("exhausted", { into: "R1", glue: " ", generation: Number.MAX_SAFE_INTEGER });
      });
      const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
      let updates = 0; const stop = deliveryReplica(set.a).onLocalUpdate(() => updates++);
      try {
        const result = executeSharedOperations(set.a, [operation({ kind: "scalar", id: "first", by: "Writer", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 9 }),
          reason === "retired-join" ? change(0, "") : operation({ ...join, id: "fresh" })]);
        assert.ok(!result.ok && "index" in result); assert.equal(result.reason, reason); assert.equal(result.index, 1);
        assert.deepEqual(encodeSharedState(set.a), bytes); assert.deepEqual(encodeSharedStateVector(set.a), vector);
        assert.equal(readSharedRevision(set.a), revision); assert.equal(updates, 0);
      } finally { stop(); }
    } finally { set.close(); }
  }
});

test("seeded identical joins and separator changes through different entries match literal values at every checkpoint", t => {
  const declaredLimits: readonly string[] = [], violations = new Set<string>(), kinds = new Set<string>();
  let random = 0x5c628, histories = 0, commands = 0, checkpoints = 0;
  const pick = (limit: number) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random >>> 16) % limit; };
  for (let sample = 0; sample < 12; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const set = replicas(copies, source), handles = [set.a, set.b, set.c].slice(0, copies);
    const incremental = handles.map(handle => captureIncrementalReplica(handle));
    const checkpoint = () => {
      checkpoints++;
      handles.forEach((handle, index) => {
        const value = incremental[index]; assert.ok(value);
        try { assertIncremental(handle, value.projector); agree("encoded separator checkpoint", order, [handle], projectSharedDocumentWithRecovery); }
        catch (error) { violations.add("identical separator differs from incremental or encoded projection"); t.diagnostic(String(error)); }
      });
    };
    try {
      handles.forEach(registerSharedJoinHandlers);
      handles.forEach(handle => {
        assert.deepEqual(executeSharedOperations(handle, [join]), { ok: true }); commands++; kinds.add("identical-join"); checkpoint();
      });
      const writers = pick(2) ? handles.map((_, index) => index) : [pick(copies)];
      let expected = "ab cd";
      writers.forEach(index => {
        const value = pick(2) ? { glue: "", text: "abcd" } : { glue: " ", text: "ab cd" };
        const handle = handles[index]; assert.ok(handle);
        assert.deepEqual(executeSharedOperations(handle, [change(index, value.glue)]), { ok: true });
        commands++; kinds.add("identical-join-glue"); expected = value.text; checkpoint();
      });
      set.queue.flush(order); checkpoint();
      try { agree("merged identical separator", order, handles, read, [["R1", expected], ["R3", "ef"]]); }
      catch { violations.add("identical separator differs from the literal scalar register winner"); }
      for (let step = 0; step < 2; step++) {
        const index = pick(copies), value = expected === "abcd" ? { glue: " ", text: "ab cd" } : { glue: "", text: "abcd" };
        const handle = handles[index]; assert.ok(handle);
        assert.deepEqual(executeSharedOperations(handle, [change(index, value.glue)]), { ok: true });
        commands++; kinds.add("causal-join-glue"); checkpoint(); set.queue.flush(order); checkpoint(); expected = value.text;
        try { agree("causal identical separator", order, handles, read, [["R1", expected], ["R3", "ef"]]); }
        catch { violations.add("causal identical separator differs from its literal value"); }
      }
      histories++;
    } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
  }
  assert.deepEqual([...violations], declaredLimits);
  assert.deepEqual([...kinds].sort(), ["causal-join-glue", "identical-join", "identical-join-glue"]);
  assert.deepEqual({ histories, commands, checkpoints }, { histories: 72, commands: 448, checkpoints: 664 });
  t.diagnostic(JSON.stringify({ seed: 0x5c628, histories, commands, checkpoints, declaredLimits, violations: [...violations] }));
});
