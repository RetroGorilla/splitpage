import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedHeadingHandlers } from "../../../src/adapters/collab/heading-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedRemovalCommand } from "../../../src/adapters/collab/removal-record.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { pasteFlowRange, beatPos } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const runtime = createFlowLoadRuntime(), ORDERS = ["D1", "rev", "dup"] as const;
const SOURCE = { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "ab" }], sections: [{ id: "H1", name: "In", firstSceneId: "R1" }] };
const unheading = (id: string, by = "Writer", newBeat: string | null = null) => operation({ kind: "heading-remove", id, by, heading: "H1",
  observed: [flowBaseReference("H1", "heading", 0, 2)], newBeat, nextBeat: newBeat ? "R1" : null });
const typeName = (id: string, value: string, at = 2) => ({ kind: "text-insert", id, by: "Other", target: { owner: "H1", segment: "h:H1", field: "heading" },
  at: { left: flowBaseReference("H1", "heading", at - 1), right: null, affinity: "after" }, content: [{ value, marks: [] }] });

function read(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { rows: document.rows.map(row => [row.id.startsWith("structure_") ? "Rn" : row.id, row.audioText]),
    sections: ((document.sections ?? []) as { id: string; name: string; firstSceneId: string }[]).map(scene => [scene.id, scene.name, scene.firstSceneId]),
    recovery: recovery.map(entry => entry.kind === "removed-heading" ? [entry.heading.id, entry.heading.name] : [entry.kind]) };
}
type Reading = ReturnType<typeof read>;
const state = (sections: unknown[][], recovery: unknown[][] = [], rows: unknown[][] = [["R0", "x"], ["R1", "ab"]]) => ({ rows, sections, recovery }) as Reading;
const live = state([["H1", "In", "R1"]]), gone = state([], [["H1", "In"]]);

function scenario(order: typeof ORDERS[number], body: (run: ReturnType<typeof start>) => void) {
  const run = start(order);
  try { body(run); } finally { run.close(); }
}
function start(order: typeof ORDERS[number]) {
  const set = replicas(2, SOURCE), handles = [set.a, set.b], incremental = handles.map(handle => captureIncrementalReplica(handle));
  handles.forEach(handle => {
    registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle);
    registerSharedHeadingHandlers(handle); registerSharedUndoOperationHandlers(handle);
  });
  const flush = () => { set.queue.flush(order); handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); }); };
  const send = (handle: SharedDocumentHandle, ...values: unknown[]) =>
    assert.deepEqual(executeSharedOperations(handle, values.map(operation), { base: readSharedRevision(handle) }), { ok: true });
  const command = (handle: SharedDocumentHandle, list: ReturnType<typeof operation>[], label: string): SharedUndoRecord => {
    const execution = executeSharedCommand(handle, list, { label, selection: null, typing: null }, { base: readSharedRevision(handle) });
    assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); return execution.record;
  };
  let count = 0;
  const reverse = (record: SharedUndoRecord, effective: boolean, handle = set.a, deliver = true) => {
    const done = reverseSharedUndoRecord(handle, record, { by: "Writer", nextId: () => "u" + ++count }); if (deliver) flush();
    assert.ok(done.ok); assert.equal(done.effective, effective); return done.inverse;
  };
  const check = (label: string, expected: Reading) => agree(label, order, handles, read, expected);
  const fixed = () => [encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)];
  const unchanged = (record: SharedUndoRecord, label: string, expected: Reading, handle = set.a) => {
    const before = [encodeSharedState(handle), encodeSharedStateVector(handle), readSharedRevision(handle)];
    reverse(record, false, handle);
    assert.deepEqual([encodeSharedState(handle), encodeSharedStateVector(handle), readSharedRevision(handle)], before); check(label, expected);
  };
  const removal = (record: SharedUndoRecord) => { const part = record.parts[0]; assert.ok(part?.kind === "remove"); return part.removal; };
  const restored = () => {
    const theirs = command(set.b, [unheading("gone", "Other")], "remove heading"); flush();
    const record = command(set.a, [operation({ kind: "restore", id: "back", by: "Writer", removals: [removal(theirs)] })], "restore"); flush();
    return record;
  };
  return { set, flush, send, command, reverse, check, fixed, unchanged, removal, restored,
    close: () => { incremental.forEach(value => value.projector.dispose()); set.close(); } };
}

for (const order of ORDERS) test(`a heading removal is recorded, undone by restoring it and redone as a new removal: ${order}`, () => scenario(order, run => {
  const record = run.command(run.set.a, [unheading("gone")], "remove heading"); run.flush(); run.check("removed", gone);
  assert.deepEqual(record.parts.map(part => part.kind === "remove" ? [part.beats, part.headings] : part.kind), [[[], ["H1"]]]);
  const undone = run.reverse(record, true); run.check("undone", live);
  assert.deepEqual(undone.parts.map(part => part.kind === "restore" ? [part.beats, part.headings] : part.kind), [[[], ["H1"]]]);
  const redone = run.reverse(undone, true); run.check("redone", gone);
  run.reverse(redone, true); run.check("undone again", live);
}));

for (const order of ORDERS) test(`undo of a heading removal keeps a name typed by someone who had not seen it: ${order}`, () => scenario(order, run => {
  const record = run.command(run.set.a, [unheading("gone")], "remove heading");
  run.send(run.set.b, typeName("typed", "Z")); run.flush(); run.check("removed with typing", state([], [["H1", "InZ"]]));
  run.reverse(record, true); run.check("undone", state([["H1", "InZ", "R1"]]));
}));

for (const order of ORDERS) test(`used up: someone else restored the heading; and after their new removal (rule 33) ours stays used up: ${order}`, () => scenario(order, run => {
  const record = run.command(run.set.a, [unheading("gone")], "remove heading"); run.flush();
  run.send(run.set.b, { kind: "restore", id: "back", by: "Other", removals: [run.removal(record)] }); run.flush(); run.check("restored by another", live);
  run.unchanged(record, "used up after their restore", live);
  run.send(run.set.b, unheading("again", "Other")); run.flush(); run.check("removed again by another", gone);
  run.unchanged(record, "used up after their removal", gone);
}));

for (const order of ORDERS) test(`a restore of a heading removal is undone by a new removal that observes the whole name, and redone: ${order}`, () => scenario(order, run => {
  const record = run.restored(); run.check("restored", live);
  const undone = run.reverse(record, true); run.check("removed again", gone);
  const part = undone.parts[0]; assert.ok(part?.kind === "remove");
  const stored = readSharedRemovalCommand(part.removal, collabState(run.set.a).roots.removalRecords.get(part.removal));
  assert.ok(stored?.kind === "remove" && stored.removalKind === "header");
  assert.deepEqual(stored.observed.map(item => item.identities.length), [2]);
  run.reverse(undone, true); run.check("redone", live);
}));

for (const [name, change, after] of [
  ["someone typed in the name", (run: Run) => run.send(run.set.b, typeName("typed", "Z")), state([["H1", "InZ", "R1"]])],
  ["someone bolded the name", (run: Run) => run.send(run.set.b, { kind: "mark", id: "bold", by: "Other", target: { owner: "H1", segment: "h:H1", field: "heading" },
    observed: [flowBaseReference("H1", "heading", 0, 2)], mark: { kind: "b", value: true } }), live],
  ["someone typed in the scene's first beat", (run: Run) => run.send(run.set.b, { kind: "text-insert", id: "beat", by: "Other", target: { owner: "R1", segment: "b:R1", field: "audioText" },
    at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" }, content: [{ value: "Y", marks: [] }] }), state([["H1", "In", "R1"]], [], [["R0", "x"], ["R1", "abY"]])],
  ["someone set a field on the scene's first beat", (run: Run) => run.send(run.set.b, { kind: "scalar", id: "f", by: "Other", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 9 }), live],
  ["someone removed the heading again", (run: Run) => run.send(run.set.b, unheading("again", "Other")), gone],
  ["someone removed and restored the heading", (run: Run) => {
    const again = run.command(run.set.b, [unheading("again", "Other")], "remove heading"); run.flush();
    run.send(run.set.b, { kind: "restore", id: "back2", by: "Other", removals: [run.removal(again)] });
  }, live]
] as const) for (const order of ORDERS) test(`used up: undo of a heading restore after ${name}: ${order}`, () => scenario(order, run => {
  const record = run.restored(); change(run); run.flush();
  run.unchanged(record, "used up", after);
}));
type Run = ReturnType<typeof start>;

function refused(run: Run, record: SharedUndoRecord, reason: string) {
  const before = run.fixed();
  assert.deepEqual(reverseSharedUndoRecord(run.set.a, record, { by: "Writer", nextId: () => "r1" }), { ok: false, reason });
  assert.deepEqual(run.fixed(), before);
}

test("declared: a demotion keeps the generic part and stays refused by name, since undoing it needs the undo of its split", () => scenario("D1", run => {
  const record = run.command(run.set.a, [unheading("demote", "Writer", "Rn")], "demote"); run.flush();
  assert.deepEqual(record.parts.map(part => part.kind === "structure" ? part.command : part.kind), ["heading-remove"]);
  refused(run, record, "undo-unsupported:heading-remove");
  assert.equal(supportsSharedUndoPart("heading-remove"), false);
}));

test("declared: a heading created by paste stays refused by name, since the paste also creates a beat", () => scenario("D1", run => {
  const document = projectSharedDocumentWithRecovery(run.set.a).document, at = beatPos("R1", 0);
  let next = 0;
  const outcome = pasteFlowRange({ rows: document.rows, sections: document.sections, comments: [] } as FlowDoc, { anchor: at, head: at },
    { text: "", rows: [{ id: "P0", audioText: "p", visualText: "", status: "todo" }], headers: [{ index: 0, scene: { id: "clip", name: "New", firstSceneId: "" } }], wholeIds: [] },
    { ...runtime.ports, newId: () => "fresh" + ++next, operations: { id: "paste", by: "Writer" } });
  assert.ok(outcome && "rows" in outcome && outcome.ops);
  const record = run.command(run.set.a, [...outcome.ops], "paste"); run.flush();
  assert.deepEqual(record.parts.filter(part => part.kind === "structure").map(part => part.kind === "structure" ? part.command : ""), ["segment-create", "segment-create", "heading-create"]);
  refused(run, record, "undo-unsupported:heading-create");
  assert.deepEqual(["heading-create", "segment-create"].map(supportsSharedUndoPart), [false, false]);
}));

test("declared: a command that removes a heading and a beat keeps the generic parts and its undo is refused", () => scenario("D1", run => {
  const record = run.command(run.set.a, [unheading("gone"), operation({ kind: "remove", id: "beat", by: "Writer", removalKind: "beat", targets: ["R0"],
    observed: [flowBaseReference("R0", "audioText", 0, 1)], boundaries: ["R0"], components: [], gallery: [], at: 0 })], "remove"); run.flush();
  assert.deepEqual(record.parts.map(part => part.kind === "structure" ? part.command : part.kind), ["heading-remove", "remove"]);
  refused(run, record, "undo-unsupported:remove");
}));

test("declared: a restore of a heading removal and a beat removal at once keeps the generic part and its undo is refused", () => scenario("D1", run => {
  const heading = run.command(run.set.b, [unheading("gone", "Other")], "remove heading");
  const beat = run.command(run.set.b, [operation({ kind: "remove", id: "beat", by: "Other", removalKind: "beat", targets: ["R0"],
    observed: [flowBaseReference("R0", "audioText", 0, 1)], boundaries: ["R0"], components: [], gallery: [], at: 0 })], "remove"); run.flush();
  const record = run.command(run.set.a, [operation({ kind: "restore", id: "back", by: "Writer", removals: [run.removal(heading), run.removal(beat)] })], "restore"); run.flush();
  assert.deepEqual(record.parts.map(part => part.kind === "structure" ? part.command : part.kind), ["restore"]);
  refused(run, record, "undo-unsupported:restore");
}));
