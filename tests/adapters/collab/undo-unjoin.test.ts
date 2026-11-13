import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const runtime = createFlowLoadRuntime(), ORDERS = ["D1", "rev", "dup"] as const, target = { owner: "R1", segment: "R1", field: "audioText" };
const strong = (text: string) => `<strong>${text}</strong>`;
const SOURCE = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }] };
const rows = (handle: SharedDocumentHandle) => projectSharedDocumentWithRecovery(handle).document.rows.map(row => row.audioText);
const remove = (beat: string) => ({ kind: "remove", id: "gone", by: "Other", removalKind: "beat", targets: [beat], boundaries: [beat], observed: [], components: [], gallery: [], at: 0 });

function scenario(order: typeof ORDERS[number], body: (run: ReturnType<typeof start>) => void) {
  const run = start(order);
  try { body(run); } finally { run.close(); }
}
function start(order: typeof ORDERS[number]) {
  const set = replicas(2, SOURCE), handles = [set.a, set.b], incremental = handles.map(handle => captureIncrementalReplica(handle));
  handles.forEach(handle => {
    registerSharedJoinHandlers(handle); registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime);
    registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle);
  });
  const flush = () => { set.queue.flush(order); handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); }); };
  const send = (handle: SharedDocumentHandle, value: unknown) =>
    assert.deepEqual(executeSharedOperations(handle, [operation(value)], { base: readSharedRevision(handle) }), { ok: true });
  const command = (value: unknown, label: string, handle = set.a): SharedUndoRecord | null => {
    const execution = executeSharedCommand(handle, [operation(value)], { label, selection: null, typing: null }, { base: readSharedRevision(handle) });
    assert.deepEqual(execution.result, { ok: true }); flush(); return execution.record;
  };
  const joined = command({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " }, "join"), part = joined?.parts[0];
  assert.ok(part?.kind === "join");
  const unjoin = (id = "apart", handle = set.a) => command({ kind: "join-retire", id, by: "Writer", joins: [part.join] }, "unjoin", handle);
  let count = 0;
  const reverse = (record: SharedUndoRecord, effective: boolean) => {
    const done = reverseSharedUndoRecord(set.a, record, { by: "Writer", nextId: () => "u" + ++count }); flush();
    assert.ok(done.ok); assert.equal(done.effective, effective); return done.inverse;
  };
  const check = (label: string, expected: (string | undefined)[]) => agree(label, order, handles, rows, expected);
  const unchanged = (record: SharedUndoRecord, label: string, expected: (string | undefined)[]) => {
    const before = [encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)];
    reverse(record, false);
    assert.deepEqual([encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)], before); check(label, expected);
  };
  return { set, flush, send, command, join: part.join, unjoin, reverse, check, unchanged,
    close: () => { incremental.forEach(value => value.projector.dispose()); set.close(); } };
}

for (const order of ORDERS) test(`an unjoin is recorded as the join it retired, undone by joining again and redone by unjoining: ${order}`, () => scenario(order, run => {
  run.check("joined", ["ab cd", "ef"]);
  const record = run.unjoin(); assert.ok(record); run.check("unjoined", ["ab", "cd", "ef"]);
  assert.deepEqual(record.parts.map(part => part.kind === "join" ? [part.join === run.join, part.from, part.into, part.glue, part.retired, part.formats ?? null] : part.kind),
    [[true, "R2", "R1", " ", true, null]]);
  const undone = run.reverse(record, true); run.check("joined again", ["ab cd", "ef"]);
  const redone = run.reverse(undone, true); run.check("unjoined again", ["ab", "cd", "ef"]);
  run.reverse(redone, true); run.check("joined once more", ["ab cd", "ef"]);
}));

for (const [name, change, before, separated, after] of [
  ["the separator it had", (run: Run) => run.send(run.set.b, { kind: "join-glue", id: "glue", by: "Other", joins: [run.join], glue: "" }), "abcd", ["ab", "cd", "ef"], "abcd"],
  ["the space's formatting it had", (run: Run) => run.send(run.set.b, { kind: "mark", id: "bold", by: "Other", target, observed: [flowBaseReference("R1", "audioText", 0, 5)],
    mark: { kind: "b", value: true } }), strong("ab cd"), [strong("ab"), strong("cd"), "ef"], strong("ab cd")]
] as const) for (const order of ORDERS) test(`undo of an unjoin joins again with ${name}: ${order}`, () => scenario(order, run => {
  change(run); run.flush(); run.check("before", [before, "ef"]);
  const record = run.unjoin(); assert.ok(record); run.check("unjoined", [...separated]);
  run.reverse(record, true); run.check("joined again", [after, "ef"]);
}));
type Run = ReturnType<typeof start>;

for (const [name, change, after] of [
  ["the first beat was removed", (run: Run) => run.send(run.set.b, remove("R1")), ["cd", "ef"]],
  ["the second beat was removed", (run: Run) => run.send(run.set.b, remove("R2")), ["ab", "ef"]],
  ["someone joined them again", (run: Run) => run.send(run.set.b, { kind: "join", id: "again", by: "Other", from: "R2", into: "R1", glue: " " }), ["ab cd", "ef"]],
  ["someone split the first beat so a new beat stands between them", (run: Run) => run.send(run.set.b, { kind: "split", id: "cut", by: "Other", target,
    at: { left: flowBaseReference("R1", "audioText", 0), right: null, affinity: "after" }, observed: [], boundary: "Rs", beat: "Rs", fields: {} }), ["a", "b", "cd", "ef"]]
] as const) for (const order of ORDERS) test(`used up: undo of an unjoin after ${name}: ${order}`, () => scenario(order, run => {
  const record = run.unjoin(); assert.ok(record); change(run); run.flush();
  run.unchanged(record, "used up", [...after]);
}));

for (const order of ORDERS) test(`a separator change is undone back to the separator before it and redone: ${order}`, () => scenario(order, run => {
  const record = run.command({ kind: "join-glue", id: "glue", by: "Writer", joins: [run.join], glue: "" }, "separator"); assert.ok(record);
  assert.deepEqual(record.parts.map(part => part.kind === "join-glue" ? [part.prior, part.written] : part.kind), [[" ", ""]]);
  run.check("changed", ["abcd", "ef"]);
  const undone = run.reverse(record, true); run.check("undone", ["ab cd", "ef"]);
  run.reverse(undone, true); run.check("redone", ["abcd", "ef"]);
}));

for (const [name, change, after] of [
  ["another writer changed the separator again (rule 28)", (run: Run) => run.send(run.set.b, { kind: "join-glue", id: "back", by: "Other", joins: [run.join], glue: " " }), ["ab cd", "ef"]],
  ["the join was unjoined", (run: Run) => run.send(run.set.b, { kind: "join-retire", id: "apart", by: "Other", joins: [run.join] }), ["ab", "cd", "ef"]]
] as const) for (const order of ORDERS) test(`used up: undo of a separator change after ${name}: ${order}`, () => scenario(order, run => {
  const record = run.command({ kind: "join-glue", id: "glue", by: "Writer", joins: [run.join], glue: "" }, "separator"); assert.ok(record);
  change(run); run.flush();
  run.unchanged(record, "used up", [...after]);
}));

test("an unjoin of a join that is already retired records nothing", () => scenario("D1", run => {
  assert.ok(run.unjoin("first", run.set.b));
  assert.equal(run.unjoin("second"), null); run.check("unjoined", ["ab", "cd", "ef"]);
  assert.deepEqual(["join", "join-glue", "join-retire"].map(supportsSharedUndoPart), [true, true, false]);
}));
