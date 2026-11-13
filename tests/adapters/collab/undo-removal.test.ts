import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { createRecord } from "./record-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const runtime = createFlowLoadRuntime(), ORDERS = ["D1", "rev", "dup"] as const, target = { owner: "R1", segment: "R1", field: "audioText" };
const anchor = (words: string) => `<span class="cmt-anchor" data-cmt="C1">${words}</span>`;
const PLAIN = { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }] };
const COMMENTED = { rows: [{ id: "R1", audioText: "a" + anchor("bc") + "d" }, { id: "R2", audioText: "ef" }] };
const shown = (id: unknown) => typeof id === "string" && id.startsWith("structure_") ? "Rs" : id;
const removeOp = (id: string, by = "Writer") => operation({ kind: "remove", id, by, removalKind: "beat", targets: ["R1"],
  observed: [flowBaseReference("R1", "audioText", 0, 4)], boundaries: ["R1"], components: [], gallery: [], at: 0 });

function read(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { rows: document.rows.map(row => [shown(row.id), row.audioText]),
    recovery: recovery.flatMap(entry => entry.kind === "removed-beat" ? [[shown(entry.row.id), entry.row.audioText, ...entry.comments?.length ? [entry.comments] : []]] : []),
    comments: (document.comments as unknown as { id: string; rowId: string }[]).map(comment => [comment.id, shown(comment.rowId)]) };
}
type Reading = ReturnType<typeof read>;
const state = (rows: unknown[][], recovery: unknown[][] = [], comments: unknown[][] = []) => ({ rows, recovery, comments }) as Reading;

function scenario(order: typeof ORDERS[number], body: (run: ReturnType<typeof start>) => void, source: Record<string, unknown> = PLAIN) {
  const run = start(order, source);
  try { body(run); } finally { run.close(); }
}
function start(order: typeof ORDERS[number], source: Record<string, unknown>) {
  const set = replicas(2, source), handles = [set.a, set.b], incremental = handles.map(handle => captureIncrementalReplica(handle));
  handles.forEach(handle => {
    registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle);
    registerSharedRecordHandlers(handle); registerSharedUndoOperationHandlers(handle); registerSharedJoinHandlers(handle);
  });
  const flush = () => { set.queue.flush(order); handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); }); };
  const send = (handle: SharedDocumentHandle, ...values: unknown[]) =>
    assert.deepEqual(executeSharedOperations(handle, values.map(operation), { base: readSharedRevision(handle) }), { ok: true });
  const command = (handle: SharedDocumentHandle, value: ReturnType<typeof operation>, label: string): SharedUndoRecord => {
    const execution = executeSharedCommand(handle, [value], { label, selection: null, typing: null }, { base: readSharedRevision(handle) });
    assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); return execution.record;
  };
  let count = 0;
  const reverse = (record: SharedUndoRecord, effective: boolean, handle = set.a, deliver = true) => {
    const done = reverseSharedUndoRecord(handle, record, { by: "Writer", nextId: () => "u" + ++count }); if (deliver) flush();
    assert.ok(done.ok); assert.equal(done.effective, effective); return done.inverse;
  };
  const check = (label: string, expected: Reading) => agree(label, order, handles, read, expected);
  const unchanged = (record: SharedUndoRecord, label: string, expected: Reading, handle = set.a) => {
    const before = [encodeSharedState(handle), encodeSharedStateVector(handle), readSharedRevision(handle)];
    const inverse = reverse(record, false, handle);
    assert.deepEqual([encodeSharedState(handle), encodeSharedStateVector(handle), readSharedRevision(handle)], before); check(label, expected); return inverse;
  };
  const removal = (record: SharedUndoRecord) => { const part = record.parts[0]; assert.ok(part?.kind === "remove"); return part.removal; };
  return { set, flush, send, command, reverse, check, unchanged, removal, close: () => { incremental.forEach(value => value.projector.dispose()); set.close(); } };
}

const live = state([["R1", "abcd"], ["R2", "ef"]]), gone = state([["R2", "ef"]], [["R1", "abcd"]]);

for (const order of ORDERS) test(`a beat removal is recorded, undone by restoring it and redone as a new removal: ${order}`, () => scenario(order, run => {
  const record = run.command(run.set.a, removeOp("gone"), "remove"); run.flush(); run.check("removed", gone);
  assert.deepEqual(record.parts.map(part => part.kind === "remove" ? [part.beats, part.removal.startsWith("structure_")] : part.kind), [[["R1"], true]]);
  const undone = run.reverse(record, true); run.check("undone", live);
  assert.deepEqual(undone.parts.map(part => part.kind === "restore" ? part.beats : part.kind), [["R1"]]);
  const redone = run.reverse(undone, true); run.check("redone", gone);
  run.reverse(redone, true); run.check("undone again", live);
}));

for (const order of ORDERS) test(`undo of a removal keeps text typed by someone who had not seen it: ${order}`, () => scenario(order, run => {
  const record = run.command(run.set.a, removeOp("gone"), "remove");
  run.send(run.set.b, { kind: "text-insert", id: "typed", by: "Other", target, at: { left: null, right: flowBaseReference("R1", "audioText", 4), affinity: "before" },
    content: [{ value: "X", marks: [] }] });
  run.flush(); run.check("removed with typing", state([["R2", "ef"]], [["R1", "abcdX"]]));
  run.reverse(record, true); run.check("undone", state([["R1", "abcdX"], ["R2", "ef"]]));
}));

for (const order of ORDERS) test(`rule 44: undo of a removal brings back the beat split off it unseen, and the redo removes both again: ${order}`, () => scenario(order, run => {
  const record = run.command(run.set.a, removeOp("gone"), "remove");
  run.send(run.set.b, { kind: "split", id: "cut", by: "Other", target, at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" },
    observed: [], boundary: "Rs", beat: "Rs", fields: {} });
  run.flush(); run.check("both removed", state([["R2", "ef"]], [["R1", "ab"], ["Rs", "cd"]]));
  const undone = run.reverse(record, true); run.check("both back", state([["R1", "ab"], ["Rs", "cd"], ["R2", "ef"]]));
  run.reverse(undone, true); run.check("both removed again", state([["R2", "ef"]], [["R1", "ab"], ["Rs", "cd"]]));
}));

for (const order of ORDERS) test(`rule 47: undo of a removal brings back the beat with its comment: ${order}`, () => scenario(order, run => {
  run.send(run.set.a, createRecord("comments", "C1", { anchorId: "C1", rowId: "R1", field: "audioText", createdAt: 0, text: "" })); run.flush();
  const record = run.command(run.set.a, removeOp("gone"), "remove"); run.flush();
  run.check("removed", state([["R2", "ef"]], [["R1", "a" + anchor("bc") + "d", ["C1"]]], [["C1", "R1"]]));
  run.reverse(record, true); run.check("undone", state([["R1", "a" + anchor("bc") + "d"], ["R2", "ef"]], [], [["C1", "R1"]]));
}, COMMENTED));

for (const order of ORDERS) test(`used up: someone else restored the beat; and after their new removal (rule 33) ours stays used up: ${order}`, () => scenario(order, run => {
  const record = run.command(run.set.a, removeOp("gone"), "remove"); run.flush();
  run.send(run.set.b, { kind: "restore", id: "back", by: "Other", removals: [run.removal(record)] }); run.flush(); run.check("restored by another", live);
  run.unchanged(record, "used up after their restore", live);
  run.send(run.set.b, removeOp("again", "Other")); run.flush(); run.check("removed again by another", gone);
  run.unchanged(record, "used up after their removal", gone);
}));

for (const order of ORDERS) test(`a restore is recorded, undone by a new removal and redone by restoring that: ${order}`, () => scenario(order, run => {
  const theirs = run.command(run.set.b, removeOp("gone", "Other"), "remove"); run.flush();
  const record = run.command(run.set.a, operation({ kind: "restore", id: "back", by: "Writer", removals: [run.removal(theirs)] }), "restore"); run.flush();
  run.check("restored", live);
  const undone = run.reverse(record, true); run.check("removed again", gone);
  run.reverse(undone, true); run.check("redone", live);
}));

for (const [change, value, after] of [
  ["typed in", { kind: "text-insert", id: "typed", by: "Other", target, at: { left: null, right: flowBaseReference("R1", "audioText", 4), affinity: "before" }, content: [{ value: "X", marks: [] }] }, "abcdX"],
  ["bolded", { kind: "mark", id: "bold", by: "Other", target, observed: [flowBaseReference("R1", "audioText", 0, 2)], mark: { kind: "b", value: true } }, "<strong>ab</strong>cd"]
] as const) for (const order of ORDERS) test(`used up: undo of a restore after someone ${change} the beat: ${order}`, () => scenario(order, run => {
  const theirs = run.command(run.set.b, removeOp("gone", "Other"), "remove"); run.flush();
  const record = run.command(run.set.a, operation({ kind: "restore", id: "back", by: "Writer", removals: [run.removal(theirs)] }), "restore"); run.flush();
  run.send(run.set.b, value); run.flush();
  run.unchanged(record, "used up", state([["R1", after], ["R2", "ef"]]));
}));

for (const order of ORDERS) test(`used up: a redo of a removal after someone typed in the restored beat: ${order}`, () => scenario(order, run => {
  const undone = run.reverse(run.command(run.set.a, removeOp("gone"), "remove"), true);
  run.send(run.set.b, { kind: "text-insert", id: "typed", by: "Other", target, at: { left: null, right: flowBaseReference("R1", "audioText", 0), affinity: "before" },
    content: [{ value: "X", marks: [] }] }); run.flush();
  run.unchanged(undone, "used up", state([["R1", "Xabcd"], ["R2", "ef"]]));
}));

test("through the owner: a used-up undo of a removal adds no redo and reaches nothing older", () => scenario("D1", run => {
  let count = 0;
  const undo = createSharedUndo({ now: () => 0, supports: supportsSharedUndoPart,
    reverse: record => reverseSharedUndoRecord(run.set.a, record, { by: "Writer", nextId: () => "o" + ++count }) });
  let removal = "";
  undo.perform(() => { const record = run.command(run.set.a, removeOp("gone"), "remove"); removal = run.removal(record); return record; }); run.flush();
  run.send(run.set.b, { kind: "restore", id: "back", by: "Other", removals: [removal] }); run.flush();
  const before = [encodeSharedState(run.set.a), encodeSharedStateVector(run.set.a), readSharedRevision(run.set.a)];
  assert.deepEqual(undo.undo(), { ok: true, effective: false, label: "remove", selection: null });
  assert.deepEqual([encodeSharedState(run.set.a), encodeSharedStateVector(run.set.a), readSharedRevision(run.set.a)], before);
  assert.deepEqual(undo.sizes(), { undo: 0, redo: 0, dropped: 0 });
  assert.deepEqual(["remove", "restore", "split", "heading-remove", "structure"].map(supportsSharedUndoPart), [true, true, false, false, false]);
}));

test("a removal of another kind than a beat stays a structure part; its undo is refused by name and writes nothing", () => scenario("D1", run => {
  const record = run.command(run.set.a, operation({ ...removeOp("range"), removalKind: "range" }), "remove"); run.flush();
  assert.deepEqual(record.parts.map(part => part.kind === "structure" ? part.command : part.kind), ["remove"]);
  const before = [encodeSharedState(run.set.a), encodeSharedStateVector(run.set.a), readSharedRevision(run.set.a)];
  assert.deepEqual(reverseSharedUndoRecord(run.set.a, record, { by: "Writer", nextId: () => "r1" }), { ok: false, reason: "undo-unsupported:remove" });
  assert.deepEqual([encodeSharedState(run.set.a), encodeSharedStateVector(run.set.a), readSharedRevision(run.set.a)], before);
}));

const VISUAL = { rows: [{ id: "R1", audioText: "abcd", visualText: "v" }, { id: "R2", audioText: "ef" }] };
const beat = { scope: "beat", record: "R1" } as const, joinR2 = { kind: "join", id: "j", by: "Other", from: "R2", into: "R1", glue: " " };
type Run = ReturnType<typeof start>;
function restoredByWriter(run: Run): SharedUndoRecord {
  const theirs = run.command(run.set.b, removeOp("gone", "Other"), "remove"); run.flush();
  const record = run.command(run.set.a, operation({ kind: "restore", id: "back", by: "Writer", removals: [run.removal(theirs)] }), "restore"); run.flush();
  return record;
}
for (const [name, change, after, source, before] of [
  ["a field set", (run: Run) => run.send(run.set.b, { kind: "scalar", id: "f", by: "Other", target: beat, field: "lengthSeconds", value: 9 }), live, PLAIN, null],
  ["a status set", (run: Run) => run.send(run.set.b, { kind: "status", id: "s", by: "Other", target: beat, value: "ready", parents: readSharedStatusHeads(run.set.b, beat) }), live, PLAIN, null],
  ["typing in the visual column", (run: Run) => run.send(run.set.b, { kind: "text-insert", id: "v", by: "Other", target: { owner: "R1", segment: "R1", field: "visualText" },
    at: { left: null, right: flowBaseReference("R1", "visualText", 0), affinity: "before" }, content: [{ value: "X", marks: [] }] }), live, VISUAL, null],
  ["another beat joined into it", (run: Run) => run.send(run.set.b, joinR2), state([["R1", "abcd ef"]]), PLAIN, null],
  ["typing in a piece joined to it", (run: Run) => run.send(run.set.b, { kind: "text-insert", id: "t", by: "Other", target, at: { left: null, right: flowBaseReference("R1", "audioText", 7), affinity: "before" },
    content: [{ value: "X", marks: [] }] }), state([["R1", "abcd efX"]]), PLAIN, (run: Run) => { run.send(run.set.a, joinR2); run.flush(); }],
  ["a removal and restore by someone else", (run: Run) => {
    const again = run.command(run.set.b, removeOp("again", "Other"), "remove"); run.flush();
    run.send(run.set.b, { kind: "restore", id: "back2", by: "Other", removals: [run.removal(again)] });
  }, live, PLAIN, null]
] as const) for (const order of ORDERS) test(`used up: undo of a restore after ${name}: ${order}`, () => scenario(order, run => {
  before?.(run);
  const record = restoredByWriter(run); change(run); run.flush();
  run.unchanged(record, "used up", after);
}, source));

for (const order of ORDERS) test(`rule 44: undo of a restore made while someone split the beat unseen removes both halves, and the redo brings both back: ${order}`, () => scenario(order, run => {
  const record = restoredByWriter(run);
  const undone = run.reverse(record, true, run.set.a, false);
  run.send(run.set.b, { kind: "split", id: "cut", by: "Other", target, at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" },
    observed: [], boundary: "Rs", beat: "Rs", fields: {} });
  run.flush(); run.check("both removed", state([["R2", "ef"]], [["R1", "ab"], ["Rs", "cd"]]));
  run.reverse(undone, true); run.check("both back", state([["R1", "ab"], ["Rs", "cd"], ["R2", "ef"]]));
}));

for (const order of ORDERS) test(`used up: undo of a restore after someone removed the beat again: ${order}`, () => scenario(order, run => {
  const record = restoredByWriter(run);
  run.send(run.set.b, removeOp("again", "Other")); run.flush(); run.check("removed again", gone);
  run.unchanged(record, "used up", gone);
}));

function refused(run: Run, record: SharedUndoRecord, reason: string) {
  const before = [encodeSharedState(run.set.a), encodeSharedStateVector(run.set.a), readSharedRevision(run.set.a)];
  assert.deepEqual(reverseSharedUndoRecord(run.set.a, record, { by: "Writer", nextId: () => "r1" }), { ok: false, reason });
  assert.deepEqual([encodeSharedState(run.set.a), encodeSharedStateVector(run.set.a), readSharedRevision(run.set.a)], before);
}

test("a command with two removals keeps the generic parts and its undo is refused", () => scenario("D1", run => {
  const execution = executeSharedCommand(run.set.a, [removeOp("one"), operation({ kind: "remove", id: "two", by: "Writer", removalKind: "beat", targets: ["R2"],
    observed: [flowBaseReference("R2", "audioText", 0, 2)], boundaries: ["R2"], components: [], gallery: [], at: 1 })],
  { label: "remove", selection: null, typing: null }, { base: readSharedRevision(run.set.a) });
  assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); run.flush();
  assert.deepEqual(execution.record.parts.map(part => part.kind === "structure" ? part.command : part.kind), ["remove", "remove"]);
  refused(run, execution.record, "undo-unsupported:remove");
}));

test("a restore of a range removal keeps the generic part and its undo is refused", () => scenario("D1", run => {
  const theirs = run.command(run.set.b, operation({ ...removeOp("range", "Other"), removalKind: "range" }), "remove"); run.flush();
  const removal = theirs.parts[0]; assert.ok(removal?.kind === "structure");
  const key = collabState(run.set.b).roots.removalRecords.keys().next().value; assert.ok(typeof key === "string");
  const record = run.command(run.set.a, operation({ kind: "restore", id: "back", by: "Writer", removals: [key] }), "restore"); run.flush();
  assert.deepEqual(record.parts.map(part => part.kind === "structure" ? part.command : part.kind), ["restore"]);
  refused(run, record, "undo-unsupported:restore");
}));

for (const together of [false, true]) for (const order of ORDERS)
  test(`rule 33: two writers undo the removals they made apart ${together ? "at the same moment: both write and the beat is live" : "in turn: the second is used up"}: ${order}`, () => scenario(order, run => {
    const ours = run.command(run.set.a, removeOp("gone"), "remove"), theirs = run.command(run.set.b, removeOp("gone", "Other"), "remove"); run.flush();
    run.check("removed", gone);
    run.reverse(ours, true, run.set.a, !together);
    if (together) run.reverse(theirs, true, run.set.b);
    else run.unchanged(theirs, "second used up", live, run.set.b);
    run.check("live", live);
  }));
