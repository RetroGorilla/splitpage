import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedHeadingHandlers } from "../../../src/adapters/collab/heading-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { pictureA } from "./projection-record-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { sharedStructureIdentity } from "../../../src/adapters/collab/structure-identity.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedContentRef } from "../../../src/core/collab/operations.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { beatPos, pasteFlowRange } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";

const runtime = createFlowLoadRuntime(), ORDERS = ["D1", "rev", "dup"] as const;
const SOURCE = { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }] };
const fields = (audioText: string, visualText = "") => ({ status: "todo", visualText, audioText, imageRef: null, updatedAt: "2026-11-14T10:00:00.000Z", updatedBy: "Writer" });
const create = (at: Record<string, unknown>, audioText = "", visualText = "") =>
  operation({ kind: "segment-create", id: "make", by: "Writer", segment: "Rn", beat: "Rn", at, fields: fields(audioText, visualText) });
const between = { left: "R1", right: "R2", affinity: "after" };
const split = operation({ kind: "split", id: "cut", by: "Writer", target: { owner: "R1", segment: "R1", field: "audioText" },
  at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" }, observed: [], boundary: "Rs", beat: "Rs", fields: {} });
const typeAt = (id: string, beat: string, segment: string, offset: number, value: string, by = "Other") => ({ kind: "text-insert", id, by, target: { owner: beat, segment, field: "audioText" },
  at: { left: offset ? flowBaseReference(beat, "audioText", offset - 1) : null, right: offset ? null : flowBaseReference(beat, "audioText", 0), affinity: offset ? "after" : "before" },
  content: [{ value, marks: [] }] });

type Run = ReturnType<typeof start>;
function scenario(order: typeof ORDERS[number], body: (run: Run) => void, source: Record<string, unknown> = SOURCE) {
  const run = start(order, source);
  try { body(run); } finally { run.close(); }
}
function start(order: typeof ORDERS[number], source: Record<string, unknown>) {
  const set = replicas(2, source), handles = [set.a, set.b], incremental = handles.map(handle => captureIncrementalReplica(handle));
  handles.forEach(handle => {
    registerSharedJoinHandlers(handle); registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedHeadingHandlers(handle); registerSharedRecordHandlers(handle);
    registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle);
  });
  const writer = String(collabState(set.a).doc.clientID), names = new Map<string, string>([["make", "Rn"], ["cut", "Rs"], ["part", "Rm"]].map(([id, name]) => [sharedStructureIdentity(writer, id ?? "", "beat"), name ?? ""]));
  const read = (handle: SharedDocumentHandle) => projectSharedDocumentWithRecovery(handle).document.rows.map(row => [names.get(row.id) ?? row.id, row.audioText]);
  const flush = () => { set.queue.flush(order); handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); }); };
  const send = (value: unknown, handle = set.b) => assert.deepEqual(executeSharedOperations(handle, [operation(value)], { base: readSharedRevision(handle) }), { ok: true });
  const command = (values: readonly ReturnType<typeof operation>[], label = "create"): SharedUndoRecord => {
    const execution = executeSharedCommand(set.a, values, { label, selection: null, typing: null }, { base: readSharedRevision(set.a) });
    assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); flush(); return execution.record;
  };
  let count = 0;
  const reverse = (record: SharedUndoRecord, effective: boolean, deliver = true) => {
    const done = reverseSharedUndoRecord(set.a, record, { by: "Writer", nextId: () => "u" + ++count }); if (deliver) flush();
    assert.ok(done.ok, JSON.stringify(done)); assert.equal(done.effective, effective); return done.inverse;
  };
  const check = (label: string, expected: readonly (readonly string[])[]) => agree(label, order, handles, read, expected.map(row => [...row]));
  const unchanged = (record: SharedUndoRecord, label: string, expected: readonly (readonly string[])[]) => {
    const before = [encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)];
    reverse(record, false);
    assert.deepEqual([encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)], before); check(label, expected);
  };
  const beat = (record: SharedUndoRecord) => { const part = record.parts.find(item => item.kind === "beat-create"); assert.ok(part?.kind === "beat-create"); return part.beat as SharedContentRef; };
  return { set, flush, send, command, reverse, check, unchanged, beat, close: () => { incremental.forEach(value => value.projector.dispose()); set.close(); } };
}

const three = [["R1", "abcd"], ["Rn", ""], ["R2", "ef"]], two = [["R1", "abcd"], ["R2", "ef"]];

for (const order of ORDERS) test(`a blank beat added between two scenes' segments is recorded, undone by dropping it and redone by bringing the same beat back: ${order}`, () => scenario(order, run => {
  const record = run.command([create(between)]); run.check("created", three);
  assert.deepEqual(record.parts.map(part => part.kind === "beat-create" ? [part.kind, part.retired] : [part.kind]), [["beat-create", false]]);
  const undone = run.reverse(record, true); run.check("undone", two);
  const redone = run.reverse(undone, true); run.check("redone", three);
  assert.equal(run.beat(redone), run.beat(record));
  run.reverse(redone, true); run.check("undone again", two);
}));

const inline = [["R1", "ab"], ["Rn", "N"], ["Rs", "cd"], ["R2", "ef"]], cut = [["R1", "ab"], ["Rs", "cd"], ["R2", "ef"]];
for (const order of ORDERS) test(`a beat with text added inside a segment, between two of its beats, is undone and redone the same way: ${order}`, () => scenario(order, run => {
  run.command([split], "split");
  const record = run.command([create({ left: "R1", right: null, affinity: "after" }, "N")]); run.check("created", inline);
  const undone = run.reverse(record, true); run.check("undone", cut);
  run.reverse(undone, true); run.check("redone", inline);
}));

const EMPTIED = { rows: [{ id: "R1", audioText: "abcd" }] };
const removeBeat = (beat: string, by = "Other") => ({ kind: "remove", id: "gone", by, removalKind: "beat", targets: [beat], boundaries: [beat], observed: [], components: [], gallery: [], at: 0 });
for (const order of ORDERS) test(`rule 91: the first character typed into an emptied script is one step, undone back to the emptied script and redone: ${order}`, () => scenario(order, run => {
  run.send(removeBeat("R1", "Writer"), run.set.a); run.flush(); run.check("emptied", []);
  const record = run.command([create({ left: null, right: "b:R1", affinity: "before" }, "a")], "empty-script-type"); run.check("typed", [["Rn", "a"]]);
  const undone = run.reverse(record, true); run.check("undone", []);
  run.reverse(undone, true); run.check("redone", [["Rn", "a"]]);
}, EMPTIED));

for (const order of ORDERS) test(`rule 35: typing in the new beat, then undoing it, leaves the creation's undo whole: ${order}`, () => scenario(order, run => {
  const record = run.command([create(between, "N")]), beat = run.beat(record);
  const typing = executeSharedCommand(run.set.a, [operation(typeAt("typed", beat, beat, 1, "X", "Writer"))], { label: "typing", selection: null, typing: "X" }, { base: readSharedRevision(run.set.a) });
  assert.deepEqual(typing.result, { ok: true }); assert.ok(typing.record); run.flush(); run.check("typed", [["R1", "abcd"], ["Rn", "NX"], ["R2", "ef"]]);
  run.reverse(typing.record, true); run.check("typing undone", [["R1", "abcd"], ["Rn", "N"], ["R2", "ef"]]);
  run.reverse(record, true); run.check("creation undone", two);
}));

const statusOf = (beat: string) => ({ scope: "beat", record: beat as SharedContentRef }) as const;
const visualOf = (beat: string) => ({ owner: beat as SharedContentRef, segment: beat as SharedContentRef, field: "visualText" as const });
const gallery = (beat: string) => ({ kind: "record-create", id: "g", by: "Other", target: { collection: "gallery", record: "G1" },
  fields: { beat, rank: "0", picture: { imageRef: pictureA, name: "" }, links: [] } });
const CHANGES: readonly (readonly [string, (run: Run, beat: string) => void, readonly (readonly string[])[]])[] = [
  ["types in the new beat", (run, beat) => run.send(typeAt("x", beat, beat, 1, "X")), [["R1", "abcd"], ["Rn", "NX"], ["R2", "ef"]]],
  ["sets a field on the new beat", (run, beat) => run.send({ kind: "scalar", id: "f", by: "Other", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 9 }),
    [["R1", "abcd"], ["Rn", "N"], ["R2", "ef"]]],
  ["sets the new beat's status", (run, beat) => run.send({ kind: "status", id: "s", by: "Other", target: statusOf(beat), value: "ready", parents: readSharedStatusHeads(run.set.b, statusOf(beat)) }),
    [["R1", "abcd"], ["Rn", "N"], ["R2", "ef"]]],
  ["types in the new beat's visual", (run, beat) => {
    const gap = readSharedPaintedText(run.set.b, visualOf(beat))?.emptyGap; assert.ok(gap);
    run.send({ kind: "text-insert", id: "v", by: "Other", target: visualOf(beat), at: { left: null, right: gap, affinity: "before" }, content: [{ value: "V", marks: [] }] });
  }, [["R1", "abcd"], ["Rn", "N"], ["R2", "ef"]]],
  ["adds a gallery picture to the new beat", (run, beat) => run.send(gallery(beat)), [["R1", "abcd"], ["Rn", "N"], ["R2", "ef"]]],
  ["joins another beat into the new beat", (run, beat) => run.send({ kind: "join", id: "j", by: "Other", from: "R2", into: beat, glue: " " }), [["R1", "abcd"], ["Rn", "N ef"]]]
];
for (const [name, change, after] of CHANGES) for (const order of ORDERS) test(`used up: undo of a creation after another writer ${name}: ${order}`, () => scenario(order, run => {
  const record = run.command([create(between, "N")]); change(run, run.beat(record)); run.flush();
  run.unchanged(record, "used up", after);
}));

for (const order of ORDERS) test(`used up: undo of a creation after another writer removed the new beat: ${order}`, () => scenario(order, run => {
  const record = run.command([create(between, "N")]); run.send(removeBeat(run.beat(record))); run.flush();
  run.unchanged(record, "used up", two);
}));

for (const [name, change, after] of CHANGES) for (const order of ORDERS) test(`a creation undone while another writer ${name} without seeing the undo keeps the beat, and its redo is used up: ${order}`,
  () => scenario(order, run => {
    const record = run.command([create(between, "N")]), beat = run.beat(record);
    const undone = run.reverse(record, true, false); change(run, beat); run.flush(); run.check("kept", after);
    run.unchanged(undone, "redo used up", after);
  }));

for (const order of ORDERS) test(`used up: redo of a creation after someone else brought the beat back: ${order}`, () => scenario(order, run => {
  const record = run.command([create(between, "N")]), beat = run.beat(record);
  const undone = run.reverse(record, true); run.send({ kind: "split-restore", id: "back", by: "Other", beat }); run.flush();
  run.unchanged(undone, "used up", [["R1", "abcd"], ["Rn", "N"], ["R2", "ef"]]);
}));

const takenBack: readonly (readonly [string, (run: Run, beat: string) => void])[] = [
  ["types in the new beat and deletes it", (run, beat) => {
    run.send(typeAt("x", beat, beat, 1, "X"));
    run.send({ kind: "text-delete", id: "y", by: "Other", target: { owner: beat, segment: beat, field: "audioText" }, observed: [createSharedAnchor(run.set.b, { owner: beat as SharedContentRef, segment: beat as SharedContentRef, field: "audioText" }, 1, "after")] });
  }],
  ["sets a field on the new beat and clears it", (run, beat) => {
    run.send({ kind: "scalar", id: "f", by: "Other", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 9 });
    run.send({ kind: "scalar", id: "g", by: "Other", target: { scope: "beat", record: beat }, field: "lengthSeconds", clear: true });
  }],
  ["adds a gallery picture to the new beat and deletes it", (run, beat) => {
    run.send(gallery(beat)); run.send({ kind: "record-delete", id: "gone", by: "Other", target: { collection: "gallery", record: "G1" } });
  }]
];
for (const [name, change] of takenBack) for (const order of ORDERS) test(`rule 103: a creation undone while another writer ${name} is undone on every copy: ${order}`, () => scenario(order, run => {
  const record = run.command([create(between, "N")]), beat = run.beat(record);
  run.reverse(record, true, false); change(run, beat); run.flush(); run.check("taken back", two);
}));

for (const order of ORDERS) test(`a creation then a split of the new beat, undone in turn and redone in turn: ${order}`, () => scenario(order, run => {
  const record = run.command([create(between, "Nxyz")]), beat = run.beat(record);
  const parted = run.command([operation({ kind: "split", id: "part", by: "Writer", target: { owner: beat, segment: beat, field: "audioText" },
    at: { left: flowBaseReference(beat, "audioText", 0), right: null, affinity: "after" }, observed: [], boundary: "Rm", beat: "Rm", fields: {} })], "split");
  run.check("split", [["R1", "abcd"], ["Rn", "N"], ["Rm", "xyz"], ["R2", "ef"]]);
  const unparted = run.reverse(parted, true); run.check("split undone", [["R1", "abcd"], ["Rn", "Nxyz"], ["R2", "ef"]]);
  const uncreated = run.reverse(record, true); run.check("creation undone", two);
  run.reverse(uncreated, true); run.check("creation redone", [["R1", "abcd"], ["Rn", "Nxyz"], ["R2", "ef"]]);
  run.reverse(unparted, true); run.check("split redone", [["R1", "abcd"], ["Rn", "N"], ["Rm", "xyz"], ["R2", "ef"]]);
}));

for (const order of ORDERS) test(`after a split of the new beat is undone, text typed in its far part while the creation's undo is in flight keeps the beat: ${order}`, () => scenario(order, run => {
  const record = run.command([create(between, "Nxyz")]), beat = run.beat(record);
  const parted = run.command([operation({ kind: "split", id: "part", by: "Writer", target: { owner: beat, segment: beat, field: "audioText" },
    at: { left: flowBaseReference(beat, "audioText", 0), right: null, affinity: "after" }, observed: [], boundary: "Rm", beat: "Rm", fields: {} })], "split");
  run.reverse(parted, true); run.reverse(record, true, false);
  run.send(typeAt("x", beat, beat, 4, "X")); run.flush();
  run.check("kept", [["R1", "abcd"], ["Rn", "NxyzX"], ["R2", "ef"]]);
}));

for (const order of ORDERS) test(`a dropped beat leaves no row, visual or recovery item behind, and comes back with its visual: ${order}`, () => scenario(order, run => {
  const record = run.command([create(between, "N", "V")]);
  const before = projectSharedDocumentWithRecovery(run.set.a).recovery;
  const undone = run.reverse(record, true);
  for (const handle of [run.set.a, run.set.b]) {
    const projected = projectSharedDocumentWithRecovery(handle);
    assert.deepEqual([projected.document.rows.map(row => row.visualText), projected.recovery], [["", ""], before]);
  }
  run.reverse(undone, true);
  for (const handle of [run.set.a, run.set.b]) assert.deepEqual(projectSharedDocumentWithRecovery(handle).document.rows.map(row => row.visualText), ["", "V", ""]);
}));

test("the owner accepts the creation part by its own name and still refuses an unrecorded creation by name", () => {
  assert.deepEqual(["beat-create", "segment-create", "create-retire"].map(supportsSharedUndoPart), [true, false, false]);
});

const texts = (handle: SharedDocumentHandle) => projectSharedDocumentWithRecovery(handle).document.rows.map(row => row.audioText);
for (const order of ORDERS) test(`a paste of two whole beats is one step, undone and redone as one: ${order}`, () => scenario(order, run => {
  const document = projectSharedDocumentWithRecovery(run.set.a).document, at = beatPos("R2", 0);
  let next = 0;
  const outcome = pasteFlowRange({ rows: document.rows, comments: [] } as FlowDoc, { anchor: at, head: at },
    { text: "", rows: [{ id: "P0", audioText: "p", visualText: "", status: "todo" }, { id: "P1", audioText: "q", visualText: "", status: "todo" }], headers: [], wholeIds: ["P0", "P1"] },
    { ...runtime.ports, newId: () => "fresh" + ++next, operations: { id: "paste", by: "Writer" } });
  assert.ok(outcome && "rows" in outcome && outcome.ops);
  const record = run.command([...outcome.ops], "paste");
  assert.deepEqual(record.parts.map(part => part.kind === "structure" ? part.command : part.kind), ["beat-create", "beat-create"]);
  agree("pasted", order, [run.set.a, run.set.b], texts, ["abcd", "p", "q", "ef"]);
  const undone = run.reverse(record, true); agree("undone", order, [run.set.a, run.set.b], texts, ["abcd", "ef"]);
  run.reverse(undone, true); agree("redone", order, [run.set.a, run.set.b], texts, ["abcd", "p", "q", "ef"]);
}));

for (const order of ORDERS) test(`a beat created with a picture is undone with its picture and redone with it: ${order}`, () => scenario(order, run => {
  const record = run.command([operation({ kind: "segment-create", id: "make", by: "Writer", segment: "Rn", beat: "Rn", at: between, fields: { ...fields("N"), imageRef: pictureA } })]);
  const pictures = (handle: SharedDocumentHandle) => projectSharedDocumentWithRecovery(handle).document.rows.map(row => [row.audioText, row.imageRef ? "picture" : null]);
  agree("created", order, [run.set.a, run.set.b], pictures, [["abcd", null], ["N", "picture"], ["ef", null]]);
  const undone = run.reverse(record, true); agree("undone", order, [run.set.a, run.set.b], pictures, [["abcd", null], ["ef", null]]);
  run.reverse(undone, true); agree("redone", order, [run.set.a, run.set.b], pictures, [["abcd", null], ["N", "picture"], ["ef", null]]);
}));

for (const order of ORDERS) test(`a beat kept by typing while its creation's undo is in flight takes more typing on the undoing copy: ${order}`, () => scenario(order, run => {
  const record = run.command([create(between, "N")]), beat = run.beat(record);
  run.reverse(record, true, false); run.send(typeAt("x", beat, beat, 1, "X")); run.flush();
  run.send(typeAt("z", beat, beat, 2, "Z", "Writer"), run.set.a); run.flush();
  run.check("typed again", [["R1", "abcd"], ["Rn", "NXZ"], ["R2", "ef"]]);
}));
