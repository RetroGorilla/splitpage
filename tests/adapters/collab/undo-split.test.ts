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
import { readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedContentRef } from "../../../src/core/collab/operations.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const runtime = createFlowLoadRuntime(), ORDERS = ["D1", "rev", "dup"] as const, target = { owner: "R1", segment: "R1", field: "audioText" };
const SOURCE = { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }] };
const split = (kind = "split", at = 2) => operation({ kind, id: "cut", by: "Writer", target, at: { left: flowBaseReference("R1", "audioText", at - 1), right: null, affinity: "after" },
  observed: [], boundary: "Rs", beat: "Rs", fields: {} });
const type = (id: string, owner: string, offset: number, value: string) => ({ kind: "text-insert", id, by: "Other", target: { owner, segment: owner, field: "audioText" },
  at: { left: offset ? flowBaseReference(owner, "audioText", offset - 1) : null, right: offset ? null : flowBaseReference(owner, "audioText", 0), affinity: offset ? "after" : "before" },
  content: [{ value, marks: [] }] });
const read = (handle: SharedDocumentHandle) => projectSharedDocumentWithRecovery(handle).document.rows.map(row => [row.id.startsWith("structure_") ? "Rs" : row.id, row.audioText]);

function scenario(order: typeof ORDERS[number], body: (run: Run) => void) {
  const run = start(order);
  try { body(run); } finally { run.close(); }
}
type Run = ReturnType<typeof start>;
function start(order: typeof ORDERS[number]) {
  const set = replicas(2, SOURCE), handles = [set.a, set.b], incremental = handles.map(handle => captureIncrementalReplica(handle));
  handles.forEach(handle => {
    registerSharedJoinHandlers(handle); registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime);
    registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle);
  });
  const flush = () => { set.queue.flush(order); handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); }); };
  const send = (value: unknown, handle = set.b) => assert.deepEqual(executeSharedOperations(handle, [operation(value)], { base: readSharedRevision(handle) }), { ok: true });
  const command = (value: ReturnType<typeof operation>): SharedUndoRecord => {
    const execution = executeSharedCommand(set.a, [value], { label: "split", selection: null, typing: null }, { base: readSharedRevision(set.a) });
    assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); flush(); return execution.record;
  };
  let count = 0;
  const reverse = (record: SharedUndoRecord, effective: boolean, deliver = true) => {
    const done = reverseSharedUndoRecord(set.a, record, { by: "Writer", nextId: () => "u" + ++count }); if (deliver) flush();
    assert.ok(done.ok); assert.equal(done.effective, effective); return done.inverse;
  };
  const check = (label: string, expected: string[][]) => agree(label, order, handles, read, expected);
  const unchanged = (record: SharedUndoRecord, label: string, expected: string[][]) => {
    const before = [encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)];
    reverse(record, false);
    assert.deepEqual([encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)], before); check(label, expected);
  };
  const beat = (record: SharedUndoRecord) => { const part = record.parts[0]; assert.ok(part?.kind === "beat-split"); return part.beat as SharedContentRef; };
  return { set, flush, send, command, reverse, check, unchanged, beat, close: () => { incremental.forEach(value => value.projector.dispose()); set.close(); } };
}

const split2 = [["R1", "ab"], ["Rs", "cd"], ["R2", "ef"]], whole = [["R1", "abcd"], ["R2", "ef"]];

for (const order of ORDERS) test(`a split is recorded, undone by taking its boundary out and redone by putting the same beat back: ${order}`, () => scenario(order, run => {
  const record = run.command(split()); run.check("split", split2);
  assert.deepEqual(record.parts.map(part => part.kind === "beat-split" ? [part.source, part.before, part.retired] : part.kind), [["R1", null, false]]);
  const undone = run.reverse(record, true); run.check("undone", whole);
  const redone = run.reverse(undone, true); run.check("redone", split2);
  assert.equal(run.beat(redone), run.beat(record));
  run.reverse(redone, true); run.check("undone again", whole);
}));

for (const order of ORDERS) test(`text typed on either side of a split stays through its undo and redo: ${order}`, () => scenario(order, run => {
  const record = run.command(split());
  run.send(type("x", run.beat(record), 2, "X")); run.send(type("y", "R1", 2, "Y")); run.flush(); run.check("typed", [["R1", "abY"], ["Rs", "cdX"], ["R2", "ef"]]);
  const undone = run.reverse(record, true); run.check("undone", [["R1", "abYcdX"], ["R2", "ef"]]);
  run.reverse(undone, true); run.check("redone", [["R1", "abY"], ["Rs", "cdX"], ["R2", "ef"]]);
}));

for (const order of ORDERS) test(`a split before a beat is undone and redone the same way: ${order}`, () => scenario(order, run => {
  const record = run.command(split("split-before")); run.check("split", [["Rs", "ab"], ["R1", "cd"], ["R2", "ef"]]);
  const undone = run.reverse(record, true); run.check("undone", whole);
  run.reverse(undone, true); run.check("redone", [["Rs", "ab"], ["R1", "cd"], ["R2", "ef"]]);
}));

for (const order of ORDERS) test(`rule 36: undo of a split of a joined row puts the row back together with its join: ${order}`, () => scenario(order, run => {
  run.send({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " }, run.set.a); run.flush(); run.check("joined", [["R1", "abcd ef"]]);
  const record = run.command(split()); run.check("split", [["R1", "ab"], ["Rs", "cd ef"]]);
  const undone = run.reverse(record, true); run.check("undone", [["R1", "abcd ef"]]);
  run.reverse(undone, true); run.check("redone", [["R1", "ab"], ["Rs", "cd ef"]]);
}));

const removeBeat = (beat: string) => ({ kind: "remove", id: "gone", by: "Other", removalKind: "beat", targets: [beat], boundaries: [beat], observed: [], components: [], gallery: [], at: 0 });
for (const [name, change, after] of [
  ["a field was set on the new beat", (run: Run, beat: string) => run.send({ kind: "scalar", id: "f", by: "Other", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 9 }), split2],
  ["the new beat's status was set", (run: Run, beat: string) => {
    const status = { scope: "beat", record: beat as SharedContentRef } as const;
    run.send({ kind: "status", id: "s", by: "Other", target: status, value: "ready", parents: readSharedStatusHeads(run.set.b, status) });
  }, split2],
  ["the new beat was removed", (run: Run, beat: string) => run.send(removeBeat(beat)), [["R1", "ab"], ["R2", "ef"]]],
  ["the source beat was removed", (run: Run) => run.send(removeBeat("R1")), [["Rs", "cd"], ["R2", "ef"]]],
  ["another beat was joined into the new beat", (run: Run, beat: string) => run.send({ kind: "join", id: "j", by: "Other", from: "R2", into: beat, glue: " " }), [["R1", "ab"], ["Rs", "cd ef"]]],
  ["someone else took the boundary out", (run: Run, beat: string) => run.send({ kind: "split-retire", id: "out", by: "Other", beat }), whole]
] as const) for (const order of ORDERS) test(`used up: undo of a split after ${name}: ${order}`, () => scenario(order, run => {
  const record = run.command(split()); change(run, run.beat(record)); run.flush();
  run.unchanged(record, "used up", [...after.map(row => [...row])]);
}));

for (const [name, change, after] of [
  ["the source beat was removed", (run: Run) => run.send(removeBeat("R1")), [["R2", "ef"]]],
  ["someone else put the boundary back", (run: Run, beat: string, unit: SharedContentRef) => run.send({ kind: "split-restore", id: "back", by: "Other", target, beat, unit, before: null }), split2]
] as const) for (const order of ORDERS) test(`used up: redo of a split after ${name}: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), part = record.parts[0]; assert.ok(part?.kind === "beat-split");
  const undone = run.reverse(record, true); change(run, part.beat, part.boundary); run.flush();
  run.unchanged(undone, "used up", [...after.map(row => [...row])]);
}));

for (const order of ORDERS) test(`a redo brings the new beat back with a change someone made to it without seeing the undo: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record), undone = run.reverse(record, true, false);
  run.send({ kind: "scalar", id: "f", by: "Other", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 9 }); run.flush(); run.check("undone", whole);
  run.reverse(undone, true); run.check("redone", split2);
  assert.deepEqual(projectSharedDocumentWithRecovery(run.set.b).document.rows.map(row => row.lengthSeconds ?? null), [null, 9, null]);
}));

test("the owner accepts the split part by its own name and still refuses an unrecorded split by name", () => {
  assert.deepEqual(["beat-split", "split", "split-before", "split-retire", "split-restore", "segment-create"].map(supportsSharedUndoPart), [true, false, false, false, false, false]);
});
