import * as Y from "yjs";
import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedHeadingHandlers } from "../../../src/adapters/collab/heading-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { pictureA } from "./projection-record-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { sharedStructureIdentity } from "../../../src/adapters/collab/structure-identity.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import type { SharedPreparedWrite } from "../../../src/adapters/collab/prepare.ts";
import { readSharedSplitRetired } from "../../../src/adapters/collab/structure-plan.ts";
import { SHARED_SPLIT_OBSERVATION_PARTS, SHARED_SPLIT_WATCHED_PARTS, sharedSplitRetireHolds } from "../../../src/adapters/collab/split-retirement.ts";
import type { CollabRoots } from "../../../src/adapters/collab/roots.ts";
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
import { beatPos, enterAt, enterInHeading, headingPos, selectionToOwnBeat } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const runtime = createFlowLoadRuntime(), ORDERS = ["D1", "rev", "dup"] as const, target = { owner: "R1", segment: "R1", field: "audioText" };
const SOURCE = { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }] };
const split = (kind = "split", at = 2) => operation({ kind, id: "cut", by: "Writer", target, at: { left: flowBaseReference("R1", "audioText", at - 1), right: null, affinity: "after" },
  observed: [], boundary: "Rs", beat: "Rs", fields: {} });
const type = (id: string, owner: string, offset: number, value: string) => ({ kind: "text-insert", id, by: "Other", target: { owner, segment: owner, field: "audioText" },
  at: { left: offset ? flowBaseReference(owner, "audioText", offset - 1) : null, right: offset ? null : flowBaseReference(owner, "audioText", 0), affinity: offset ? "after" : "before" },
  content: [{ value, marks: [] }] });
const read = (handle: SharedDocumentHandle) => projectSharedDocumentWithRecovery(handle).document.rows.map(row => [row.id.startsWith("structure_") ? "Rs" : row.id, row.audioText]);

function scenario(order: typeof ORDERS[number], body: (run: Run) => void, source: Record<string, unknown> = SOURCE) {
  const run = start(order, source);
  try { body(run); } finally { run.close(); }
}
type Run = ReturnType<typeof start>;
function start(order: typeof ORDERS[number], source: Record<string, unknown> = SOURCE) {
  const set = replicas(2, source), handles = [set.a, set.b], incremental = handles.map(handle => captureIncrementalReplica(handle));
  handles.forEach(handle => {
    registerSharedJoinHandlers(handle); registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedHeadingHandlers(handle); registerSharedRecordHandlers(handle);
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
    assert.ok(done.ok, JSON.stringify(done)); assert.equal(done.effective, effective); return done.inverse;
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
  assert.deepEqual(record.parts.map(part => part.kind === "beat-split" ? [part.source, part.retired] : part.kind), [["R1", false]]);
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
  ["someone else put the boundary back", (run: Run, beat: string) => run.send({ kind: "split-restore", id: "back", by: "Other", beat }), split2]
] as const) for (const order of ORDERS) test(`used up: redo of a split after ${name}: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), part = record.parts[0]; assert.ok(part?.kind === "beat-split");
  const undone = run.reverse(record, true); change(run, part.beat); run.flush();
  run.unchanged(undone, "used up", [...after.map(row => [...row])]);
}));

test("the owner accepts the split part by its own name and still refuses an unrecorded split by name", () => {
  assert.deepEqual(["beat-split", "split", "split-before", "split-retire", "split-restore", "segment-create"].map(supportsSharedUndoPart), [true, false, false, false, false, false]);
});

const stamp = (id: string, beat: string, by: string) => ({ kind: "scalar", id, by, target: { scope: "beat", record: beat }, field: "stamp", value: { at: "2026-11-13T10:00:00.000Z", by } });
const typeIn = (id: string, beat: string, by: string) => operation({ kind: "text-insert", id, by, target: { owner: beat, segment: beat, field: "audioText" },
  at: { left: flowBaseReference(beat, "audioText", 1), right: null, affinity: "after" }, content: [{ value: "X", marks: [] }] });
const stamped = [["R1", "ab"], ["Rs", "cdX"], ["R2", "ef"]];

for (const order of ORDERS) test(`rule 35: typing in the new beat with its stamp, then undoing it, leaves the split's undo whole: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record);
  const typing = executeSharedCommand(run.set.a, [typeIn("typed", beat, "Writer"), operation(stamp("typed:stamp", beat, "Writer"))], { label: "typing", selection: null, typing: "X" },
    { base: readSharedRevision(run.set.a) });
  assert.deepEqual(typing.result, { ok: true }); assert.ok(typing.record); run.flush(); run.check("typed", stamped);
  run.reverse(typing.record, true); run.check("typing undone", split2);
  run.reverse(record, true); run.check("split undone", whole);
}));

for (const order of ORDERS) test(`rule 35: another writer typing in the new beat with its stamp leaves the split's undo whole: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record);
  run.send(typeIn("typed", beat, "Other")); run.send(stamp("typed:stamp", beat, "Other")); run.flush(); run.check("typed", stamped);
  run.reverse(record, true); run.check("split undone", [["R1", "abcdX"], ["R2", "ef"]]);
}));

const lengths = (handle: SharedDocumentHandle) => projectSharedDocumentWithRecovery(handle).document.rows.map(row => row.lengthSeconds ?? null);
const recovered = (handle: SharedDocumentHandle) => projectSharedDocumentWithRecovery(handle).recovery.map(item => JSON.stringify(item).includes("cd"));
const document = (handle: SharedDocumentHandle) => projectSharedDocumentWithRecovery(handle).document;
for (const [name, change, after, kept] of [
  ["sets a field on the new beat", (run: Run, beat: string) => run.send({ kind: "scalar", id: "f", by: "Other", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 9 }),
    split2, (handle: SharedDocumentHandle) => assert.deepEqual([lengths(handle), recovered(handle)], [[null, 9, null], []])],
  ["sets the new beat's status", (run: Run, beat: string) => {
    const status = { scope: "beat", record: beat as SharedContentRef } as const;
    run.send({ kind: "status", id: "s", by: "Other", target: status, value: "ready", parents: readSharedStatusHeads(run.set.b, status) });
  }, split2, (handle: SharedDocumentHandle) => assert.deepEqual(document(handle).rows.map(row => row.status ?? null), ["todo", "ready", "todo"])],
  ["types in the new beat's visual", (run: Run, beat: string) => {
    const visual = { owner: beat as SharedContentRef, segment: beat as SharedContentRef, field: "visualText" as const }, gap = readSharedPaintedText(run.set.b, visual)?.emptyGap;
    assert.ok(gap); run.send({ kind: "text-insert", id: "v", by: "Other", target: visual, at: { left: null, right: gap, affinity: "before" }, content: [{ value: "V", marks: [] }] });
  }, split2, (handle: SharedDocumentHandle) => assert.deepEqual(document(handle).rows.map(row => row.visualText), ["", "V", ""])],
  ["adds a gallery picture to the new beat", (run: Run, beat: string) => run.send({ kind: "record-create", id: "g", by: "Other", target: { collection: "gallery", record: "G1" },
    fields: { beat, rank: "0", picture: { imageRef: pictureA, name: "" }, links: [] } }), split2, (handle: SharedDocumentHandle) => assert.deepEqual(recovered(handle), [])],
  ["removes the new beat", (run: Run, beat: string) => run.send(removeBeat(beat)), [["R1", "ab"], ["R2", "ef"]],
    (handle: SharedDocumentHandle) => assert.deepEqual(recovered(handle), [true])],
  ["joins another beat into the new beat", (run: Run, beat: string) => run.send({ kind: "join", id: "j", by: "Other", from: "R2", into: beat, glue: " " }),
    [["R1", "ab"], ["Rs", "cd ef"]], (handle: SharedDocumentHandle) => assert.deepEqual(recovered(handle), [])]
] as const) for (const order of ORDERS) test(`a split undone while another writer ${name} without seeing the undo stays split, and its redo is used up: ${order}`,
  () => scenario(order, run => {
    const record = run.command(split()), beat = run.beat(record);
    const undone = run.reverse(record, true, false); change(run, beat); run.flush(); run.check("kept", [...after.map(row => [...row])]);
    for (const handle of [run.set.a, run.set.b]) kept(handle);
    run.unchanged(undone, "redo used up", [...after.map(row => [...row])]);
  }));

for (const order of ORDERS) test(`rule 35: another writer typing with its stamp in the new beat while the undo is in flight joins the source beat: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record);
  run.reverse(record, true, false); run.send(typeIn("typed", beat, "Other")); run.send(stamp("typed:stamp", beat, "Other")); run.flush();
  run.check("taken back", [["R1", "abcdX"], ["R2", "ef"]]);
}));

for (const order of ORDERS) test(`a used-up split part is redone as a no-op beside the parts that were undone, never taken back: ${order}`, () => scenario(order, run => {
  const execution = executeSharedCommand(run.set.a, [split(), operation({ kind: "scalar", id: "para", by: "Writer", target: { scope: "beat", record: "R1" }, field: "paragraphStart", value: true })],
    { label: "split", selection: null, typing: null }, { base: readSharedRevision(run.set.a) });
  assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); run.flush();
  assert.deepEqual(execution.record.parts.map(part => part.kind), ["beat-split", "scalar"]);
  run.send({ kind: "scalar", id: "f", by: "Other", target: { scope: "beat", record: run.beat(execution.record) }, field: "lengthSeconds", value: 9 }); run.flush();
  const undone = run.reverse(execution.record, true); run.check("split used up, scalar undone", split2);
  assert.deepEqual(undone.parts.map(part => part.kind === "beat-split" ? part.retired : part.kind), [true, "scalar"]);
  run.reverse(undone, true); run.check("redone without taking the split back", split2);
}));

for (const order of ORDERS) test(`a split-restore while the split stands is refused; two retires made apart agree, and the redo puts the split back: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record);
  const restore = operation({ kind: "split-restore", id: "early", by: "Other", beat });
  assert.deepEqual(executeSharedOperations(run.set.b, [restore]), { ok: false, index: 0, operation: restore, reason: "existing-boundary" });
  const undone = run.reverse(record, true, false);
  assert.deepEqual(executeSharedOperations(run.set.b, [operation({ kind: "split-retire", id: "apart", by: "Other", beat })]), { ok: true }); run.flush();
  run.check("undone twice", whole);
  run.reverse(undone, true); run.check("redone", split2);
}));

test("declared: a command with two splits (a middle selection to its own beat) stays refused by name", () => scenario("D1", run => {
  const document = projectSharedDocumentWithRecovery(run.set.a).document; let next = 0;
  const outcome = selectionToOwnBeat({ rows: document.rows, comments: [] } as FlowDoc, { anchor: beatPos("R1", 1), head: beatPos("R1", 3) },
    { ...runtime.ports, newId: () => "fresh" + ++next, operations: { id: "own", by: "Writer" } });
  assert.ok(outcome && "rows" in outcome && outcome.ops);
  const execution = executeSharedCommand(run.set.a, [...outcome.ops], { label: "own beat", selection: null, typing: null }, { base: readSharedRevision(run.set.a) });
  assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record);
  assert.deepEqual(reverseSharedUndoRecord(run.set.a, execution.record, { by: "Writer", nextId: () => "u" }), { ok: false, reason: "undo-unsupported:split" });
}));

test("declared: Enter inside a scene heading name stays refused by name", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }], sections: [{ id: "H1", name: "In", firstSceneId: "R1" }] });
  try {
    registerSharedSplitHandlers(set.a, runtime); registerSharedTextOperationHandlers(set.a); registerSharedUndoOperationHandlers(set.a); registerSharedRemovalHandlers(set.a);
    const document = projectSharedDocumentWithRecovery(set.a).document;
    const outcome = enterInHeading({ rows: document.rows, sections: document.sections, comments: [] } as FlowDoc, headingPos("H1", 1),
      { ...runtime.ports, newId: () => "fresh", operations: { id: "enter", by: "Writer" } });
    assert.ok(outcome && "rows" in outcome && outcome.ops);
    const execution = executeSharedCommand(set.a, [...outcome.ops], { label: "enter", selection: null, typing: null }, { base: readSharedRevision(set.a) });
    assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record);
    assert.deepEqual(reverseSharedUndoRecord(set.a, execution.record, { by: "Writer", nextId: () => "u" }), { ok: false, reason: "undo-unsupported:split" });
  } finally { set.close(); }
});

const HEADED = { rows: [{ id: "R1", audioText: "abX# Q<br>cd" }, { id: "R2", audioText: "ef" }] };
const headRs = (run: Run, beat: string) => {
  const base = (from: number, to = from) => flowBaseReference(beat, "audioText", from, to);
  run.send({ kind: "heading-finalize", id: "fin", by: "Other", target: { owner: beat, segment: beat, field: "audioText" }, heading: "Hq",
    prefix: [base(0, 2)], name: [base(2, 3)], separator: [base(3, 4)], retainedBeat: beat, emptyBeat: null, tail: { left: null, right: base(4), affinity: "before" } });
};
const headed = (handle: SharedDocumentHandle) => { const document = projectSharedDocumentWithRecovery(handle).document;
  return [read(handle), ((document.sections ?? []) as { readonly name: unknown }[]).map(section => section.name)]; };

const headedSplit2 = [[["R1", "ab"], ["Rs", "cd"], ["R2", "ef"]], ["Q"]];
for (const order of ORDERS) test(`Enter over a selection, the new beat headed by another writer: the split's undo and redo are used up, never refused: ${order}`, () => scenario(order, run => {
  const document = projectSharedDocumentWithRecovery(run.set.a).document, same = (label: string, expected: unknown) => agree(label, order, [run.set.a, run.set.b], headed, expected);
  const outcome = enterAt({ rows: document.rows, comments: [] } as FlowDoc, { anchor: beatPos("R1", 2), head: beatPos("R1", 3) },
    { ...runtime.ports, newId: () => "fresh", operations: { id: "enter", by: "Writer" } });
  assert.ok(outcome && "rows" in outcome && outcome.ops);
  const execution = executeSharedCommand(run.set.a, [...outcome.ops], { label: "enter", selection: null, typing: null }, { base: readSharedRevision(run.set.a) });
  assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); run.flush(); same("entered", [[["R1", "ab"], ["Rs", "# Q<br>cd"], ["R2", "ef"]], []]);
  const beat = execution.record.parts.flatMap(part => part.kind === "beat-split" ? [part.beat] : [])[0]; assert.ok(beat);
  headRs(run, beat); run.flush(); same("headed", headedSplit2);
  const parts = (record: SharedUndoRecord) => record.parts.map(part => part.kind === "beat-split" ? part.retired : part.kind);
  const undone = run.reverse(execution.record, true); assert.deepEqual(parts(undone), ["text", true]);
  same("undone", [[["R1", "abX"], ["Rs", "cd"], ["R2", "ef"]], ["# Q\n"]]);
  const redone = run.reverse(undone, true); assert.deepEqual(parts(redone), ["text", false]);
  same("redone", [[["R1", "ab"], ["Rs", "cd"], ["R2", "ef"]], ["# Q\n"]]);
  run.reverse(redone, true); same("undone again", [[["R1", "abX"], ["Rs", "cd"], ["R2", "ef"]], ["# Q\n"]]);
}, HEADED));

for (const order of ORDERS) test(`a split undone while another writer heads the new beat stays headed, and its redo is used up, never refused: ${order}`, () => scenario(order, run => {
  const record = run.command(split("split", 3)), beat = run.beat(record), same = (label: string, expected: unknown) => agree(label, order, [run.set.a, run.set.b], headed, expected);
  same("split", [[["R1", "abX"], ["Rs", "# Q<br>cd"], ["R2", "ef"]], []]);
  const undone = run.reverse(record, true, false); headRs(run, beat); run.flush(); same("headed", [[["R1", "abX"], ["Rs", "cd"], ["R2", "ef"]], ["Q"]]);
  run.unchanged(undone, "redo used up", [["R1", "abX"], ["Rs", "cd"], ["R2", "ef"]]); same("still headed", [[["R1", "abX"], ["Rs", "cd"], ["R2", "ef"]], ["Q"]]);
}, HEADED));

const gallery = (beat: string, by = "Writer") => ({ kind: "record-create", id: "g", by, target: { collection: "gallery", record: "G1" },
  fields: { beat, rank: "0", picture: { imageRef: pictureA, name: "" }, links: [] } });
for (const order of ORDERS) test(`one list that brings an undone split's new beat back prepares what follows against the split it brought back: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record);
  run.reverse(record, true); run.check("undone", whole);
  const list = [operation(gallery(beat)), operation({ kind: "text-delete", id: "cut", by: "Writer", target, observed: [flowBaseReference("R1", "audioText", 2, 3)] })];
  const revision = readSharedRevision(run.set.a), result = executeSharedOperations(run.set.a, list, { base: revision });
  assert.deepEqual(result, { ok: false, index: 1, operation: list[1], reason: "invalid-reference" });
  assert.equal(readSharedRevision(run.set.a), revision); run.flush(); run.check("nothing written", whole);
}));

for (const order of ORDERS) test(`one list that brings an undone split's new beat back can set a field on that beat, as two lists can: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record);
  run.reverse(record, true); run.check("undone", whole);
  run.send(gallery(beat), run.set.a); run.send({ kind: "scalar", id: "f", by: "Writer", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 9 }, run.set.a);
  run.flush(); run.check("two lists", split2);
  assert.deepEqual(projectSharedDocumentWithRecovery(run.set.b).document.rows.map(row => row.lengthSeconds ?? null), [null, 9, null]);
}));

for (const order of ORDERS) test(`one list of a gallery picture and a field on an undone split's new beat brings the split back with both: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record);
  run.reverse(record, true); run.check("undone", whole);
  const list = [operation(gallery(beat)), operation({ kind: "scalar", id: "f", by: "Writer", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 9 })];
  assert.deepEqual(executeSharedOperations(run.set.a, list, { base: readSharedRevision(run.set.a) }), { ok: true });
  run.flush(); run.check("one list", split2);
  for (const handle of [run.set.a, run.set.b]) assert.deepEqual(projectSharedDocumentWithRecovery(handle).document.rows.map(row => row.lengthSeconds ?? null), [null, 9, null]);
}));

const statusOf = (beat: string) => ({ scope: "beat", record: beat as SharedContentRef }) as const;
const takenBack: readonly (readonly [string, (run: Run, beat: string) => readonly Record<string, unknown>[], boolean])[] = [
  ["sets a field on the new beat and clears it", (_run, beat) => [
    { kind: "scalar", id: "f", by: "Other", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 9 },
    { kind: "scalar", id: "g", by: "Other", target: { scope: "beat", record: beat }, field: "lengthSeconds", clear: true }], true],
  ["adds a gallery picture to the new beat and deletes it", (_run, beat) => [gallery(beat, "Other"),
    { kind: "record-delete", id: "gone", by: "Other", target: { collection: "gallery", record: "G1" } }], true],
  ["sets the new beat's status and retracts it", (run, beat) => [
    { kind: "status", id: "s", by: "Other", target: statusOf(beat), value: "ready", parents: readSharedStatusHeads(run.set.b, statusOf(beat)) },
    { kind: "status-retire", id: "r", by: "Other", target: statusOf(beat), value: "ready", event: JSON.stringify([String(collabState(run.set.b).doc.clientID), "s"]) }], true],
  ["joins another beat into the new beat and unjoins it", (run, beat) => [
    { kind: "join", id: "j", by: "Other", from: "R2", into: beat, glue: " " },
    { kind: "join-retire", id: "u", by: "Other", joins: [sharedStructureIdentity(String(collabState(run.set.b).doc.clientID), "j", "join")] }], true],
  ["types in the new beat's visual and deletes it", (run, beat) => {
    const visual = { owner: beat as SharedContentRef, segment: beat as SharedContentRef, field: "visualText" as const }, gap = readSharedPaintedText(run.set.b, visual)?.emptyGap;
    assert.ok(gap);
    return [{ kind: "text-insert", id: "v", by: "Other", target: visual, at: { left: null, right: gap, affinity: "before" }, content: [{ value: "V", marks: [] }] }];
  }, false]
];
for (const [name, ops, oneList] of takenBack) for (const shape of oneList ? ["one list", "separate lists"] as const : ["separate lists"] as const)
  for (const order of ORDERS) test(`a split undone while another writer ${name}, in ${shape}, without seeing the undo stays split: ${order}`, () => scenario(order, run => {
    const record = run.command(split()), beat = run.beat(record);
    const undone = run.reverse(record, true, false), list = ops(run, beat);
    if (shape === "one list") assert.deepEqual(executeSharedOperations(run.set.b, list.map(operation), { base: readSharedRevision(run.set.b) }), { ok: true });
    else for (const op of list) run.send(op);
    if (name.startsWith("types in the new beat's visual")) {
      const visual = { owner: beat as SharedContentRef, segment: beat as SharedContentRef, field: "visualText" as const };
      run.send({ kind: "text-delete", id: "w", by: "Other", target: visual, observed: [createSharedAnchor(run.set.b, visual, 0, "after")] });
    }
    run.flush(); run.check("kept", split2);
    for (const handle of [run.set.a, run.set.b]) assert.deepEqual(projectSharedDocumentWithRecovery(handle).document.rows.map(row => [row.lengthSeconds ?? null, row.visualText]),
      [[null, ""], [null, ""], [null, ""]]);
    run.unchanged(undone, "redo used up", split2);
  }));

for (const order of ORDERS) test(`a gallery picture added to an undone split's new beat and deleted brings the split back, in one list as in separate lists: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record);
  run.reverse(record, true); run.check("undone", whole);
  const insert = { kind: "text-insert", id: "x", by: "Writer", target: { owner: beat, segment: beat, field: "audioText" },
    at: { left: flowBaseReference(beat, "audioText", 0), right: null, affinity: "after" }, content: [{ value: "X", marks: [] }] };
  const list = [gallery(beat), { kind: "record-delete", id: "gone", by: "Writer", target: { collection: "gallery", record: "G1" } }, insert];
  assert.deepEqual(executeSharedOperations(run.set.a, list.map(operation), { base: readSharedRevision(run.set.a) }), { ok: true });
  run.flush(); run.check("one list", [["R1", "ab"], ["Rs", "cXd"], ["R2", "ef"]]);
}));

for (const order of ORDERS) test(`the same three as separate lists give the same document: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record);
  run.reverse(record, true); run.check("undone", whole);
  run.send(gallery(beat), run.set.a); run.send({ kind: "record-delete", id: "gone", by: "Writer", target: { collection: "gallery", record: "G1" } }, run.set.a);
  run.send({ kind: "text-insert", id: "x", by: "Writer", target: { owner: beat, segment: beat, field: "audioText" },
    at: { left: flowBaseReference(beat, "audioText", 0), right: null, affinity: "after" }, content: [{ value: "X", marks: [] }] }, run.set.a);
  run.flush(); run.check("separate lists", [["R1", "ab"], ["Rs", "cXd"], ["R2", "ef"]]);
}));

for (const order of ORDERS) test(`a gallery picture added and deleted, then a deletion past the source beat: refused in one list as in separate lists: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record);
  run.reverse(record, true); run.check("undone", whole);
  const cut = { kind: "text-delete", id: "cut", by: "Writer", target, observed: [flowBaseReference("R1", "audioText", 2, 3)] };
  const list = [gallery(beat), { kind: "record-delete", id: "gone", by: "Writer", target: { collection: "gallery", record: "G1" } }, cut].map(operation);
  const revision = readSharedRevision(run.set.a);
  assert.deepEqual(executeSharedOperations(run.set.a, list, { base: revision }), { ok: false, index: 2, operation: list[2], reason: "invalid-reference" });
  assert.equal(readSharedRevision(run.set.a), revision);
  run.send(list[0], run.set.a); run.send(list[1], run.set.a);
  const alone = operation(cut);
  assert.deepEqual(executeSharedOperations(run.set.a, [alone], { base: readSharedRevision(run.set.a) }), { ok: false, index: 0, operation: alone, reason: "invalid-reference" });
  run.flush(); run.check("separate lists", split2);
}));

for (const shape of ["one list", "separate lists"] as const) for (const order of ORDERS) test(`retiring a status the new beat had before the undo brings the split back, in ${shape}: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record);
  run.send({ kind: "status", id: "s", by: "Writer", target: statusOf(beat), value: "ready", parents: readSharedStatusHeads(run.set.a, statusOf(beat)) }, run.set.a); run.flush();
  run.send({ kind: "split-retire", id: "hand", by: "Writer", beat }, run.set.a); run.flush(); run.check("retired by hand", whole);
  const retire = { kind: "status-retire", id: "r", by: "Writer", target: statusOf(beat), value: "ready", event: JSON.stringify([String(collabState(run.set.a).doc.clientID), "s"]) };
  const cut = { kind: "text-delete", id: "cut", by: "Writer", target, observed: [flowBaseReference("R1", "audioText", 2, 3)] };
  if (shape === "one list") {
    const list = [retire, cut].map(operation);
    assert.deepEqual(executeSharedOperations(run.set.a, list, { base: readSharedRevision(run.set.a) }), { ok: false, index: 1, operation: list[1], reason: "invalid-reference" });
    run.send(retire, run.set.a);
  } else {
    run.send(retire, run.set.a);
    const alone = operation(cut);
    assert.deepEqual(executeSharedOperations(run.set.a, [alone], { base: readSharedRevision(run.set.a) }), { ok: false, index: 0, operation: alone, reason: "invalid-reference" });
  }
  run.flush(); run.check("split back", split2);
  void record;
}));

type Watched = { readonly change: (roots: CollabRoots, beat: string) => void; readonly writes: (beat: string) => readonly SharedPreparedWrite[];
  readonly unrelated: { readonly change: (roots: CollabRoots, beat: string) => void; readonly writes: (beat: string) => readonly SharedPreparedWrite[] } };
const event = (beat: string) => ({ kind: "status", id: "seed", by: "Writer", target: { scope: "beat", record: beat }, value: "ready", parents: [] });
const WATCHED: Readonly<Record<string, Watched | null>> = {
  record: { change: (roots, beat) => (roots.beats.get(beat) as Y.Map<unknown>).set("lengthSeconds", 9), writes: beat => [{ kind: "set", path: ["beats", beat, "lengthSeconds"], value: 9 }],
    unrelated: { change: (roots, beat) => (roots.beats.get(beat) as Y.Map<unknown>).set("stamp:Other", { at: "2026-11-13T10:00:00.000Z", by: "Other" }),
      writes: beat => [{ kind: "set", path: ["beats", beat, "stamp:Other"], value: { at: "2026-11-13T10:00:00.000Z", by: "Other" } }] } },
  boundaries: null,
  joins: { change: (roots, beat) => ((roots.beats.get("R2") as Y.Map<unknown>).get("joins") as Y.Map<unknown>).set("jX", { into: beat, glue: " ", generation: 0 }),
    writes: beat => [{ kind: "set", path: ["beats", "R2", "joins", "jX"], value: { into: beat, glue: " ", generation: 0 } }],
    unrelated: { change: roots => ((roots.beats.get("R2") as Y.Map<unknown>).get("joins") as Y.Map<unknown>).set("jY", { into: "R1", glue: " ", generation: 0 }),
      writes: () => [{ kind: "set", path: ["beats", "R2", "joins", "jY"], value: { into: "R1", glue: " ", generation: 0 } }] } },
  attachments: { change: (roots, beat) => roots.gallery.set("G9", new Y.Map<unknown>([["beat", beat]])),
    writes: beat => [{ kind: "map", path: ["gallery", "G9"] }, { kind: "set", path: ["gallery", "G9", "beat"], value: beat }],
    unrelated: { change: roots => roots.gallery.set("G8", new Y.Map<unknown>([["beat", "R1"]])), writes: () => [{ kind: "map", path: ["gallery", "G8"] }, { kind: "set", path: ["gallery", "G8", "beat"], value: "R1" }] } },
  status: { change: roots => roots.retiredStatus.set("seed", true), writes: () => [{ kind: "set", path: ["retiredStatus", "seed"], value: true }],
    unrelated: { change: roots => roots.retiredStatus.set("other", true), writes: () => [{ kind: "set", path: ["retiredStatus", "other"], value: true }] } }
};

test("every part an undone split watches is read the same way by the readers and by the planned state of a list", () => {
  assert.deepEqual(Object.keys(WATCHED).sort(), [...SHARED_SPLIT_OBSERVATION_PARTS].sort());
  for (const part of SHARED_SPLIT_OBSERVATION_PARTS) for (const related of [true, false]) scenario("D1", run => {
    const record = run.command(split()), beat = run.beat(record), roots = collabState(run.set.a).roots;
    collabState(run.set.a).doc.transact(() => { roots.statusEvents.set("seed", event(beat)); roots.statusEvents.set("other", event("R1")); });
    run.send({ kind: "split-retire", id: "hand", by: "Writer", beat }, run.set.a); run.flush(); run.check("retired by hand", whole);
    const watched = WATCHED[part];
    if (!watched) {
      assert.deepEqual(SHARED_SPLIT_WATCHED_PARTS.find(entry => entry.name === part)?.staged({ get: () => undefined, keys: () => [] }, ["segments", "b:R1", "text"]), []);
      return;
    }
    const used = related ? watched : watched.unrelated, prep = createSharedPreparation(run.set.a);
    try {
      assert.equal(prep.view.resolveOwner("R1", "audioText")?.owner, "R1"); assert.equal(readSharedSplitRetired(prep.view, beat), true);
      prep.include(used.writes(beat));
      assert.equal(readSharedSplitRetired(prep.view, beat), !related, part + (related ? " planned" : " unrelated planned"));
    } finally { prep.close(); }
    collabState(run.set.a).doc.transact(() => used.change(roots, beat));
    assert.equal(sharedSplitRetireHolds(roots, beat), !related, part + (related ? " read" : " unrelated read"));
  });
});

for (const order of ORDERS) test(`an embed that names the new beat but is no boundary is read the same way by the index and the watch: ${order}`, () => scenario(order, run => {
  const record = run.command(split()), beat = run.beat(record);
  run.reverse(record, true); run.check("undone", whole);
  const text = (collabState(run.set.a).roots.segments.get("b:R1") as Y.Map<unknown>).get("text") as Y.Text;
  collabState(run.set.a).doc.transact(() => text.insertEmbed(1, { b: beat, extra: true }));
  run.flush(); run.check("still undone", whole);
}));
