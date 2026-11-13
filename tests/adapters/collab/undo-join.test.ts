import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const runtime = createFlowLoadRuntime(), ORDERS = ["D1", "rev", "dup"] as const, target = { owner: "R1", segment: "R1", field: "audioText" };
const strong = (text: string) => `<strong>${text}</strong>`;
const rows = (handle: SharedDocumentHandle) => projectSharedDocumentWithRecovery(handle).document.rows.map(row => row.audioText);
const join = (id: string, by = "Writer", glue = " ") => operation({ kind: "join", id, by, from: "R2", into: "R1", glue });

function scenario(order: typeof ORDERS[number], body: (run: ReturnType<typeof start>) => void) {
  const run = start(order);
  try { body(run); } finally { run.close(); }
}
function start(order: typeof ORDERS[number]) {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] }), handles = [set.a, set.b];
  const incremental = handles.map(handle => captureIncrementalReplica(handle));
  handles.forEach(handle => {
    registerSharedJoinHandlers(handle); registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle);
    registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime);
  });
  const flush = () => { set.queue.flush(order); handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); }); };
  const send = (handle: SharedDocumentHandle, value: unknown) => assert.deepEqual(executeSharedOperations(handle, [operation(value)], { base: readSharedRevision(handle) }), { ok: true });
  const joined = (id = "join", handle = set.a): SharedUndoRecord => {
    const execution = executeSharedCommand(handle, [join(id)], { label: "join", selection: null, typing: null }, { base: readSharedRevision(handle) });
    assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); flush(); return execution.record;
  };
  let count = 0;
  const reverse = (record: SharedUndoRecord, effective: boolean, handle = set.a) => {
    const done = reverseSharedUndoRecord(handle, record, { by: "Writer", nextId: () => "u" + ++count }); flush();
    assert.ok(done.ok); assert.equal(done.effective, effective); return done.inverse;
  };
  const check = (label: string, expected: (string | undefined)[]) => agree(label, order, handles, rows, expected);
  return { set, handles, flush, send, joined, reverse, check, close: () => { incremental.forEach(value => value.projector.dispose()); set.close(); } };
}

for (const order of ORDERS) test(`a join is recorded with its entry, undone by retiring it and redone as a fresh join: ${order}`, () => scenario(order, run => {
  const record = run.joined(); run.check("joined", ["ab cd"]);
  assert.deepEqual(record.parts.map(part => part.kind === "join" ? [part.from, part.into, part.glue, part.generation, part.retired, typeof part.join] : part.kind),
    [["R2", "R1", " ", 0, false, "string"]]);
  const undone = run.reverse(record, true); run.check("undone", ["ab", "cd"]);
  const redone = run.reverse(undone, true); run.check("redone", ["ab cd"]);
  assert.deepEqual(redone.parts.map(part => part.kind === "join" ? [part.generation, part.retired] : part.kind), [[1, false]]);
  run.reverse(redone, true); run.check("undone again", ["ab", "cd"]);
}));

for (const order of ORDERS) test(`rule 34: the same join made apart by another writer is retired with ours: ${order}`, () => scenario(order, run => {
  const execution = executeSharedCommand(run.set.a, [join("join")], { label: "join", selection: null, typing: null }, { base: readSharedRevision(run.set.a) });
  run.send(run.set.b, { kind: "join", id: "same", by: "Other", from: "R2", into: "R1", glue: " " }); run.flush(); assert.ok(execution.record);
  run.reverse(execution.record, true); run.check("both retired", ["ab", "cd"]);
}));

for (const order of ORDERS) test(`rule 34: undoing a join made after seeing ours leaves ours in place: ${order}`, () => scenario(order, run => {
  run.joined(); const later = run.joined("after", run.set.b);
  assert.deepEqual(later.parts.map(part => part.kind === "join" ? part.generation : part.kind), [1]);
  run.reverse(later, true, run.set.b); run.check("earlier stays", ["ab cd"]);
}));

for (const order of ORDERS) test(`open: undoing ours while a later generation exists separates the beats, since the later join is bound to the joined row: ${order}`, () => scenario(order, run => {
  const record = run.joined(); run.joined("after", run.set.b);
  run.reverse(record, true); run.check("later generation does not hold", ["ab", "cd"]);
}));

for (const order of ORDERS) test(`after another writer changed the separator the undo separates, and the redo uses the separator it had: ${order}`, () => scenario(order, run => {
  const record = run.joined(), part = record.parts[0]; assert.ok(part?.kind === "join");
  run.send(run.set.b, { kind: "join-glue", id: "glue", by: "Other", joins: [part.join], glue: "" }); run.flush(); run.check("glue", ["abcd"]);
  const undone = run.reverse(record, true); run.check("undone", ["ab", "cd"]);
  run.reverse(undone, true); run.check("redone", ["abcd"]);
}));

for (const order of ORDERS) test(`after another writer bolded across the join the pieces keep their bold and the space's format comes back with the redo: ${order}`, () => scenario(order, run => {
  const record = run.joined();
  run.send(run.set.b, { kind: "mark", id: "bold", by: "Other", target, observed: [flowBaseReference("R1", "audioText", 0, 5)], mark: { kind: "b", value: true } });
  run.flush(); run.check("bold", [strong("ab cd")]);
  const undone = run.reverse(record, true); run.check("undone", [strong("ab"), strong("cd")]);
  run.reverse(undone, true); run.check("redone", [strong("ab cd")]);
}));

for (const order of ORDERS) test(`after another writer typed in the later piece the undo separates and the typing stays: ${order}`, () => scenario(order, run => {
  const record = run.joined();
  run.send(run.set.b, { kind: "text-insert", id: "typed", by: "Other", target, at: { left: null, right: flowBaseReference("R1", "audioText", 5), affinity: "before" },
    content: [{ value: "X", marks: [] }] });
  run.flush(); run.check("typed", ["ab cdX"]);
  run.reverse(record, true); run.check("undone", ["ab", "cdX"]);
}));

for (const [removed, left] of [["R1", []], ["R2", ["ab"]]] as const) for (const order of ORDERS)
  test(`used up: ${removed} removed after the join; the undo writes nothing: ${order}`, () => scenario(order, run => {
    const record = run.joined();
    run.send(run.set.b, { kind: "remove", id: "gone", by: "Other", removalKind: "beat", targets: [removed], boundaries: [removed], observed: [], components: [], gallery: [], at: 0 });
    run.flush(); run.check("removed", [...left]);
    const before = encodeSharedState(run.set.a);
    run.reverse(record, false); assert.deepEqual(encodeSharedState(run.set.a), before); run.check("used up", [...left]);
  }));

for (const order of ORDERS) test(`used up: the first beat split so that the joined part follows the new beat; the undo writes nothing: ${order}`, () => scenario(order, run => {
  const record = run.joined();
  run.send(run.set.b, { kind: "split", id: "cut", by: "Other", target, at: { left: flowBaseReference("R1", "audioText", 0), right: null, affinity: "after" },
    observed: [], boundary: "Rs", beat: "Rs", fields: {} });
  run.flush(); run.check("split", ["a", "b cd"]);
  const before = encodeSharedState(run.set.a);
  run.reverse(record, false); assert.deepEqual(encodeSharedState(run.set.a), before); run.check("used up", ["a", "b cd"]);
}));

for (const order of ORDERS) test(`used up: a redo after another writer joined the same two beats again: ${order}`, () => scenario(order, run => {
  const undone = run.reverse(run.joined(), true);
  run.send(run.set.b, { kind: "join", id: "again", by: "Other", from: "R2", into: "R1", glue: " " }); run.flush(); run.check("joined again", ["ab cd"]);
  const before = encodeSharedState(run.set.a);
  run.reverse(undone, false); assert.deepEqual(encodeSharedState(run.set.a), before); run.check("used up", ["ab cd"]);
}));

function owner(run: ReturnType<typeof start>) {
  let count = 0;
  const undo = createSharedUndo({ now: () => 0, supports: supportsSharedUndoPart,
    reverse: record => reverseSharedUndoRecord(run.set.a, record, { by: "Writer", nextId: () => "o" + ++count }) });
  const perform = (label: string, list: ReturnType<typeof operation>[]) =>
    undo.perform(() => executeSharedCommand(run.set.a, list, { label, selection: null, typing: null }, { base: readSharedRevision(run.set.a) }).record);
  return { undo, perform, state: () => [encodeSharedState(run.set.a), encodeSharedStateVector(run.set.a), readSharedRevision(run.set.a)] };
}

test("through the owner: a used-up undo changes no byte, state vector or revision, adds no redo and reaches nothing older", () => scenario("D1", run => {
  const { undo, perform, state } = owner(run);
  perform("join", [join("join")]); run.flush();
  run.send(run.set.b, { kind: "remove", id: "gone", by: "Other", removalKind: "beat", targets: ["R2"], boundaries: ["R2"], observed: [], components: [], gallery: [], at: 0 }); run.flush();
  const before = state();
  assert.deepEqual(undo.undo(), { ok: true, effective: false, label: "join", selection: null });
  assert.deepEqual(state(), before); assert.deepEqual(undo.sizes(), { undo: 0, redo: 0, dropped: 0 });
}));

test("through the owner: a join recorded with another structure change is refused by that change, writes nothing and stays on top", () => scenario("D1", run => {
  const { undo, perform, state } = owner(run);
  perform("join and separator", [join("join"), operation({ kind: "join-glue", id: "glue", by: "Writer", joins: ["join"], glue: "" })]); run.flush();
  const before = state();
  assert.deepEqual(undo.undo(), { ok: false, reason: "undo-unsupported:join-glue" });
  assert.deepEqual(state(), before); assert.deepEqual(undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
  assert.deepEqual(["join", "split", "join-retire", "structure"].map(supportsSharedUndoPart), [true, false, false, false]);
}));
