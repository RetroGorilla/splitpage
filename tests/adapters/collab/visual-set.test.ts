import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { setVisualForRange } from "../../../src/core/flow/visual.ts";
import { beatPos, caretAt } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const runtime = createFlowLoadRuntime(), ORDERS = ["D1", "rev", "dup"] as const, OLD = "O<strong>ld</strong>";
const SOURCE = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd", visualText: OLD }] };
const typed = (owner: string, left: number | null, value: string, id: string) => ({ kind: "text-insert", id, by: "Bob", target: { owner, segment: owner, field: "visualText" },
  at: left === null ? { left: null, right: flowBaseReference(owner, "visualText", 0), affinity: "before" } : { left: flowBaseReference(owner, "visualText", left), right: null, affinity: "after" },
  content: [{ value, marks: [] }] });
const removeBeat = (beat: string, id: string) => ({ kind: "remove", id, by: "Bob", removalKind: "beat", targets: [beat],
  observed: [flowBaseReference(beat, "audioText", 0, 2)], boundaries: [beat], components: [], gallery: [], at: 0 });

function read(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { rows: document.rows.map(row => [row.id, row.audioText, row.visualText]),
    recovery: recovery.flatMap(entry => entry.kind === "removed-beat" ? [[entry.row.id, entry.row.visualText]] : []) };
}
type Reading = ReturnType<typeof read>;
const state = (r1: string, r2: string | null, recovery: unknown[][] = []) =>
  ({ rows: [["R1", "ab", r1], ...r2 === null ? [] : [["R2", "cd", r2]]], recovery }) as Reading;

function described(handle: SharedDocumentHandle, rowId: string, html: string, id: string): readonly SharedOperation[] {
  const { document } = projectSharedDocumentWithRecovery(handle);
  const doc = { rows: document.rows, sections: document.sections, comments: [] } as unknown as FlowDoc;
  const outcome = setVisualForRange(doc, caretAt(beatPos(rowId, 0)), html, { ...runtime.ports, newId: () => "unused", operations: { id, by: "Alice" } });
  assert.ok(outcome && "rows" in outcome && outcome.ops);
  return outcome.ops;
}

function start(order: typeof ORDERS[number]) {
  const set = replicas(3, SOURCE), handles = [set.a, set.b, set.c], incremental = handles.map(handle => captureIncrementalReplica(handle));
  handles.forEach(handle => { registerSharedRemovalHandlers(handle); registerSharedTextOperationHandlers(handle); registerSharedRecordHandlers(handle); registerSharedUndoOperationHandlers(handle); });
  const compare = () => handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); });
  const flush = () => {
    for (let round = 0; round < 100 && set.queue.pending.length; round++) {
      const messages = [...set.queue.pending];
      if (order === "rev") messages.reverse();
      for (const message of messages) { set.queue.deliver(message.id, order === "dup" ? 2 : 1); compare(); }
    }
    assert.equal(set.queue.pending.length, 0);
  };
  const send = (handle: SharedDocumentHandle, ...values: unknown[]) =>
    assert.deepEqual(executeSharedOperations(handle, values.map(operation), { base: readSharedRevision(handle) }), { ok: true });
  const set_ = (rowId: string, html: string, id: string): SharedUndoRecord => {
    const base = readSharedRevision(set.a), ops = described(set.a, rowId, html, id);
    const execution = executeSharedCommand(set.a, ops, { label: "visual", selection: null, typing: null }, { base });
    assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); compare(); return execution.record;
  };
  let count = 0;
  const reverse = (record: SharedUndoRecord, effective: boolean) => {
    const done = reverseSharedUndoRecord(set.a, record, { by: "Alice", nextId: () => "undo-" + ++count });
    assert.ok(done.ok, JSON.stringify(done)); assert.equal(done.effective, effective); compare(); return done.inverse;
  };
  const check = (label: string, expected: Reading) => agree(label, order, handles, read, expected);
  return { set, flush, send, setVisual: set_, reverse, check, close: () => { incremental.forEach(value => value.projector.dispose()); set.close(); } };
}

function scenario(order: typeof ORDERS[number], body: (run: ReturnType<typeof start>) => void) {
  const run = start(order);
  try { body(run); } finally { run.close(); }
}

test("the shared form: a set on an empty visual is one insertion, a replacement an insertion and a deletion, and an unchanged set nothing", () => scenario("D1", run => {
  assert.deepEqual(described(run.set.a, "R1", "Wide", "first").map(op => [op.kind, "target" in op ? op.target : null]),
    [["text-insert", { owner: "R1", segment: "R1", field: "visualText" }]]);
  assert.deepEqual(described(run.set.a, "R2", "<strong>New</strong>", "second").map(op => op.kind), ["text-insert", "text-delete"]);
  const outcome = setVisualForRange({ rows: projectSharedDocumentWithRecovery(run.set.a).document.rows, comments: [] } as unknown as FlowDoc,
    caretAt(beatPos("R2", 0)), OLD, { ...runtime.ports, newId: () => "unused", operations: { id: "same", by: "Alice" } });
  assert.ok(outcome && "rows" in outcome); assert.deepEqual(outcome.ops, []);
}));

for (const order of ORDERS) test(`a set on an empty visual: undone and redone on every copy: ${order}`, () => scenario(order, run => {
  const made = run.setVisual("R1", "Wide", "first"); run.flush(); run.check("set", state("Wide", OLD));
  assert.deepEqual(made.parts.map(part => part.kind), ["text"]);
  const undone = run.reverse(made, true); run.flush(); run.check("undone", state("", OLD));
  run.reverse(undone, true); run.flush(); run.check("redone", state("Wide", OLD));
}));

for (const order of ORDERS) test(`a replacement is one undo step that brings the old visual back with its marks: ${order}`, () => scenario(order, run => {
  const made = run.setVisual("R2", "<strong>New</strong>", "second"); run.flush(); run.check("replaced", state("", "<strong>New</strong>"));
  const undone = run.reverse(made, true); run.flush(); run.check("undone", state("", OLD));
  const redone = run.reverse(undone, true); run.flush(); run.check("redone", state("", "<strong>New</strong>"));
  run.reverse(redone, true); run.flush(); run.check("undone again", state("", OLD));
}));

for (const order of ORDERS) test(`a replacement racing another writer's typing in the same visual keeps the typing, and its undo too: ${order}`, () => scenario(order, run => {
  run.send(run.set.b, typed("R2", 2, "X", "bob-typed"));
  const made = run.setVisual("R2", "New", "second"); run.flush(); run.check("replaced, typing kept", state("", "NewX"));
  const undone = run.reverse(made, true); run.flush(); run.check("undone, typing kept", state("", OLD + "X"));
  run.reverse(undone, true); run.flush(); run.check("redone", state("", "NewX"));
}));

for (const order of ORDERS) test(`a set on an empty visual racing another writer's first letter keeps both: ${order}`, () => scenario(order, run => {
  run.send(run.set.b, typed("R1", null, "X", "bob-typed"));
  const made = run.setVisual("R1", "Wide", "first"); run.flush(); run.check("both", state("WideX", OLD));
  run.reverse(made, true); run.flush(); run.check("undone, letter kept", state("X", OLD));
}));

for (const order of ORDERS) test(`a replacement racing a removal of the beat lands in recovery; its undo waits for the restore, as narration typing does: ${order}`, () => scenario(order, run => {
  run.send(run.set.b, removeBeat("R2", "gone"));
  const narration = executeSharedCommand(run.set.a, [operation({ kind: "text-insert", id: "alice-typed", by: "Alice", target: { owner: "R2", segment: "R2", field: "audioText" },
    at: { left: flowBaseReference("R2", "audioText", 1), right: null, affinity: "after" }, content: [{ value: "Z", marks: [] }] })],
    { label: "typing", selection: null, typing: null }, { base: readSharedRevision(run.set.a) }).record;
  assert.ok(narration);
  const made = run.setVisual("R2", "New", "second"); run.flush(); run.check("in recovery", state("", null, [["R2", "New"]]));
  const bytes = encodeSharedState(run.set.a);
  assert.deepEqual([made, narration].map(record => reverseSharedUndoRecord(run.set.a, record, { by: "Alice", nextId: () => "refused" })),
    [{ ok: false, reason: "missing-target" }, { ok: false, reason: "missing-target" }]);
  assert.deepEqual(encodeSharedState(run.set.a), bytes);
  const removal = [...collabState(run.set.b).roots.removalRecords.keys()][0]; assert.ok(removal);
  run.send(run.set.b, { kind: "restore", id: "back", by: "Bob", removals: [removal] }); run.flush();
  const restored = state("", "New"); (restored.rows[1] as unknown[])[1] = "cdZ"; run.check("restored", restored);
  const undone = run.reverse(made, true); run.flush();
  const back = state("", OLD); (back.rows[1] as unknown[])[1] = "cdZ"; run.check("undone", back);
  run.reverse(undone, true); run.flush(); run.check("redone", restored);
}));

test("the replacement as one list, and its operations as separate lists at the base they were described for: the second is refused by name", () => {
  const one = start("D1"), apart = start("D1");
  try {
    const base = readSharedRevision(one.set.a), ops = described(one.set.a, "R2", "New", "second");
    assert.deepEqual(executeSharedOperations(one.set.a, ops, { base }), { ok: true });
    assert.deepEqual(read(one.set.a), state("", "New"));
    const [insert, remove] = ops; assert.ok(insert && remove);
    assert.deepEqual(executeSharedOperations(apart.set.a, [insert], { base }), { ok: true });
    const bytes = encodeSharedState(apart.set.a), second = executeSharedOperations(apart.set.a, [remove], { base });
    assert.deepEqual(second, { ok: false, reason: "stale-base" }); assert.deepEqual(encodeSharedState(apart.set.a), bytes);
    assert.deepEqual(read(apart.set.a), state("", "New" + OLD));
  } finally { one.close(); apart.close(); }
});
