import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { createRecord, deleteRecord, setRecord } from "./record-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { deliveryReplica, createMonitoredSharedDocument } from "./helpers.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, encodeSharedStateVector, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { readSharedRemovalCommand } from "../../../src/adapters/collab/removal-record.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const runtime = createFlowLoadRuntime(), ORDERS = ["D1", "rev", "dup"] as const;
const SOURCE = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] };
const sha = (letter: string) => letter.repeat(64);
const picture = (name: string, letter: string) => ({ imageRef: { sha256: sha(letter) }, name });
const add = (key: string, name: string, letter: string, rank = "0000000001") => createRecord("gallery", key, { beat: "R1", rank, picture: picture(name, letter) }, "Alice", "add-" + key);
const removeBeat = (id: string, by: string) => ({ kind: "remove", id, by, removalKind: "beat", targets: ["R1"],
  observed: [flowBaseReference("R1", "audioText", 0, 2)], boundaries: ["R1"], components: [], gallery: [], at: 0 });
const typed = { kind: "text-insert", id: "typed", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" },
  at: { left: null, right: flowBaseReference("R1", "audioText", 2), affinity: "before" }, content: [{ value: "X", marks: [] }] };

type Slot = { readonly name?: unknown; readonly links?: readonly { readonly href?: unknown }[] | undefined };
function label(slot: Slot): string {
  return String(slot.name ?? "") + (slot.links?.length ? "+" + slot.links.map(link => String(link.href)).join(",") : "");
}
function pictures(row: Record<string, unknown>): string[] {
  const first = row.imageRef ? [label({ name: row.imageName, links: row.imageLinks as Slot["links"] })] : [];
  return [...first, ...(Array.isArray(row.moreImages) ? row.moreImages as Slot[] : []).map(label)];
}
function read(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { rows: document.rows.map(row => [row.id, row.audioText, pictures(row)]),
    recovery: recovery.flatMap(entry => entry.kind === "removed-beat" ? [[entry.row.id, pictures(entry.row)]] : []),
    records: readSharedRecords(handle, "gallery").filter(record => !record.key.includes(":slot:")).map(record => {
      const shown = record.fields.picture as { readonly name?: string; readonly imageRef?: { readonly sha256?: string } };
      return [record.key, shown.name ?? null, shown.imageRef?.sha256?.slice(0, 1) ?? null];
    }) };
}
type Reading = ReturnType<typeof read>;
const state = (rows: unknown[][], records: unknown[][], recovery: unknown[][] = []) => ({ rows, recovery, records }) as Reading;
const plain = state([["R1", "ab", []], ["R2", "cd", []]], []);
const withP1 = state([["R1", "ab", ["P1"]], ["R2", "cd", []]], [["G1", "P1", "a"]]);

function scenario(order: typeof ORDERS[number], body: (run: ReturnType<typeof start>) => void) {
  const run = start(order);
  try { body(run); } finally { run.close(); }
}

function start(order: typeof ORDERS[number]) {
  const set = replicas(3, SOURCE), handles = [set.a, set.b, set.c], incremental = handles.map(handle => captureIncrementalReplica(handle));
  handles.forEach(handle => {
    registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle);
    registerSharedRecordHandlers(handle); registerSharedUndoOperationHandlers(handle); registerSharedJoinHandlers(handle);
  });
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
  const command = (handle: SharedDocumentHandle, value: unknown, label = "command"): SharedUndoRecord => {
    const execution = executeSharedCommand(handle, [operation(value)], { label, selection: null, typing: null }, { base: readSharedRevision(handle) });
    assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); return execution.record;
  };
  let count = 0;
  const reverse = (record: SharedUndoRecord, effective: boolean, handle = set.a) => {
    const done = reverseSharedUndoRecord(handle, record, { by: "Alice", nextId: () => "undo-" + ++count });
    assert.ok(done.ok, JSON.stringify(done)); assert.equal(done.effective, effective); compare(); return done.inverse;
  };
  const check = (label: string, expected: Reading) => agree(label, order, handles, read, expected);
  const usedUp = (record: SharedUndoRecord, label: string, expected: Reading) => {
    const before = [encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)];
    const inverse = reverse(record, false);
    assert.deepEqual([encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)], before); flush(); check(label, expected); return inverse;
  };
  return { set, compare, flush, send, command, reverse, check, usedUp, close: () => { incremental.forEach(value => value.projector.dispose()); set.close(); } };
}

test("the parts: adding a picture records its creation, its undo is a retirement and that inverse is supported", () => {
  assert.deepEqual(["record-create", "record-delete", "record-retired", "record-field"].map(supportsSharedUndoPart), [true, true, true, true]);
  scenario("D1", run => {
    const added = run.command(run.set.a, add("G1", "P1", "a"));
    assert.deepEqual(added.parts, [{ kind: "record-create", target: { collection: "gallery", record: "G1" },
      fields: { beat: "R1", rank: "0000000001", picture: picture("P1", "a"), links: [] } }]);
    const undone = run.reverse(added, true), stored = collabState(run.set.a).roots.gallery.get("G1") as Y.Map<unknown>;
    assert.deepEqual(undone.parts, [{ kind: "record-retired", target: { collection: "gallery", record: "G1" },
      fields: { beat: "R1", rank: "0000000001", picture: picture("P1", "a"), links: [] }, retirement: (stored.get("retired") as { readonly observed: string }).observed }]);
  });
});

for (const order of ORDERS) test(`a picture added is undone on every copy and redone as the same record with the same picture: ${order}`, () => scenario(order, run => {
  const added = run.command(run.set.a, add("G1", "P1", "a")); run.flush(); run.check("added", withP1);
  const undone = run.reverse(added, true); run.flush(); run.check("undone", plain);
  const redone = run.reverse(undone, true); run.flush(); run.check("redone", withP1);
  assert.equal(collabState(run.set.c).roots.gallery.has("G1"), true);
  run.reverse(redone, true); run.flush(); run.check("undone again", plain);
}));

for (const order of ORDERS) test(`two pictures added are undone newest first and redone in order: ${order}`, () => scenario(order, run => {
  let serial = 0;
  const undo = createSharedUndo({ now: () => 0, supports: supportsSharedUndoPart,
    reverse: record => reverseSharedUndoRecord(run.set.a, record, { by: "Alice", nextId: () => "undo-" + ++serial }) });
  undo.perform(() => run.command(run.set.a, add("G1", "P1", "a"), "first"));
  undo.perform(() => run.command(run.set.a, add("G2", "P2", "b", "0000000002"), "second"));
  run.flush();
  const both = state([["R1", "ab", ["P1", "P2"]], ["R2", "cd", []]], [["G1", "P1", "a"], ["G2", "P2", "b"]]);
  run.check("both added", both);
  assert.deepEqual(undo.undo(), { ok: true, effective: true, label: "second", selection: null }); run.flush(); run.check("second undone", withP1);
  assert.deepEqual(undo.undo(), { ok: true, effective: true, label: "first", selection: null }); run.flush(); run.check("both undone", plain);
  assert.deepEqual(undo.redo(), { ok: true, effective: true, label: "first", selection: null }); run.flush(); run.check("first redone", withP1);
  assert.deepEqual(undo.redo(), { ok: true, effective: true, label: "second", selection: null }); run.flush(); run.check("second redone", both);
}));

const RACES: readonly { readonly name: string; readonly change: unknown; readonly after: Reading }[] = [
  { name: "renames the picture", change: setRecord("gallery", "G1", "picture", picture("Renamed", "a"), "Bob", "rename"),
    after: state([["R1", "ab", ["Renamed"]], ["R2", "cd", []]], [["G1", "Renamed", "a"]]) },
  { name: "adds a video link to the picture", change: setRecord("gallery", "G1", "links", [{ href: "https://example.com/v" }], "Bob", "link"),
    after: state([["R1", "ab", ["P1+https://example.com/v"]], ["R2", "cd", []]], [["G1", "P1", "a"]]) },
  { name: "removes the picture", change: deleteRecord("gallery", "G1", "Bob", "drop"), after: plain },
  { name: "removes the beat", change: removeBeat("gone", "Bob"), after: state([["R2", "cd", []]], [["G1", "P1", "a"]], [["R1", ["P1"]]]) }
];

for (const order of ORDERS) for (const race of RACES) {
  test(`rule 58: the undo racing another writer who ${race.name} is used up on every copy and the redo is used up too: ${order}`, () => scenario(order, run => {
    const added = run.command(run.set.a, add("G1", "P1", "a")); run.flush();
    run.send(run.set.b, race.change);
    const undone = run.reverse(added, true);
    run.flush(); run.check("after the race", race.after);
    run.usedUp(undone, "redo used up", race.after);
  }));
}

function listed(handle: SharedDocumentHandle, by: string): readonly string[] {
  const found = [...collabState(handle).roots.removalRecords.entries()].map(([key, raw]) => readSharedRemovalCommand(key, raw))
    .filter(record => record?.kind === "remove" && record.by === by);
  assert.equal(found.length, 1); const record = found[0]; assert.ok(record?.kind === "remove"); return record.gallery;
}

for (const order of ORDERS) test(`a removal of the beat that listed the picture keeps it after the beat is restored, and the redo stays used up: ${order}`, () => scenario(order, run => {
  const added = run.command(run.set.a, add("G1", "P1", "a")); run.flush();
  run.send(run.set.b, removeBeat("gone", "Bob"));
  const undone = run.reverse(added, true); run.flush();
  const removal = [...collabState(run.set.b).roots.removalRecords.keys()][0]; assert.ok(removal);
  run.send(run.set.b, { kind: "restore", id: "back", by: "Bob", removals: [removal] }); run.flush();
  run.check("restored with the picture", withP1);
  run.usedUp(undone, "redo used up", withP1);
  run.send(run.set.c, removeBeat("again", "Carol")); run.flush();
  assert.deepEqual(listed(run.set.c, "Carol"), ["G1", "R1:slot:0"]);
  run.check("removed again with the picture", state([["R2", "cd", []]], [["G1", "P1", "a"]], [["R1", ["P1"]]]));
}));

for (const order of ORDERS) test(`a picture brought back by a racing rename is listed by a later removal of its beat on a third copy: ${order}`, () => scenario(order, run => {
  const added = run.command(run.set.a, add("G1", "P1", "a")); run.flush();
  run.send(run.set.b, setRecord("gallery", "G1", "picture", picture("Renamed", "a"), "Bob", "rename"));
  run.reverse(added, true); run.flush();
  run.send(run.set.c, removeBeat("gone", "Carol")); run.flush();
  assert.deepEqual(listed(run.set.c, "Carol"), ["G1", "R1:slot:0"]);
  run.check("removed with the renamed picture", state([["R2", "cd", []]], [["G1", "Renamed", "a"]], [["R1", ["Renamed"]]]));
}));

for (const order of ORDERS) test(`a removal and restore of the beat seen before the undo do not bring the picture back: ${order}`, () => scenario(order, run => {
  const added = run.command(run.set.a, add("G1", "P1", "a")); run.flush();
  run.send(run.set.b, removeBeat("gone", "Bob")); run.flush();
  assert.deepEqual(listed(run.set.a, "Bob"), ["G1", "R1:slot:0"]);
  const removal = [...collabState(run.set.b).roots.removalRecords.keys()][0]; assert.ok(removal);
  run.send(run.set.b, { kind: "restore", id: "back", by: "Bob", removals: [removal] }); run.flush(); run.check("restored", withP1);
  const undone = run.reverse(added, true); run.flush(); run.check("undone", plain);
  run.reverse(undone, true); run.flush(); run.check("redone", withP1);
}));

for (const order of ORDERS) test(`two writers removed the picture apart: one undo puts it back, and after its redo the other undo is used up, not refused: ${order}`, () => scenario(order, run => {
  run.command(run.set.a, add("G1", "P1", "a")); run.flush();
  const mine = run.command(run.set.a, deleteRecord("gallery", "G1", "Alice", "drop")), theirs = run.command(run.set.b, deleteRecord("gallery", "G1", "Bob", "drop-b"));
  run.flush(); run.check("removed by both", plain);
  const undone = run.reverse(mine, true); run.flush(); run.check("put back", withP1);
  run.reverse(undone, true); run.flush(); run.check("taken away again", plain);
  const before = encodeSharedState(run.set.b);
  const done = reverseSharedUndoRecord(run.set.b, theirs, { by: "Bob", nextId: () => "bob-undo" });
  assert.deepEqual([done.ok, done.ok && done.effective], [true, false]); assert.deepEqual(encodeSharedState(run.set.b), before);
  run.flush(); run.check("still away", plain);
}));

test("the retirement is not a field: a hand-made creation, change or clear of it is refused and nothing is written", () => scenario("D1", run => {
  run.command(run.set.a, add("G1", "P1", "a"));
  const before = encodeSharedState(run.set.a);
  const refused = [createRecord("gallery", "G2", { beat: "R1", rank: "1", retired: { observed: "[]", seen: [] } }, "Alice", "hand-create"),
    setRecord("gallery", "G1", "retired", { observed: "[]", seen: [] }, "Alice", "hand-set"),
    { kind: "record-set", id: "hand-clear", by: "Alice", target: { collection: "gallery", record: "G1" }, field: "retired", clear: true }]
    .map(value => { const result = executeSharedOperations(run.set.a, [operation(value)], { base: readSharedRevision(run.set.a) }); return result.ok ? result : { ok: false, reason: result.reason }; });
  assert.deepEqual(refused, [{ ok: false, reason: "invalid-record-field" }, { ok: false, reason: "immutable-record-field" }, { ok: false, reason: "immutable-record-field" }]);
  assert.deepEqual(encodeSharedState(run.set.a), before);
}));

for (const order of ORDERS) test(`typing in the beat while the undo is in flight is no change to the picture: the undo holds: ${order}`, () => scenario(order, run => {
  const added = run.command(run.set.a, add("G1", "P1", "a")); run.flush();
  run.send(run.set.b, typed);
  const undone = run.reverse(added, true); run.flush();
  run.check("typing kept, picture undone", state([["R1", "abX", []], ["R2", "cd", []]], []));
  run.reverse(undone, true); run.flush(); run.check("redone", state([["R1", "abX", ["P1"]], ["R2", "cd", []]], [["G1", "P1", "a"]]));
}));

for (const order of ORDERS) test(`a beat removed after seeing the undo does not list the picture, its restore leaves it undone, and the redo brings it back: ${order}`, () => scenario(order, run => {
  const added = run.command(run.set.a, add("G1", "P1", "a")); run.flush();
  const undone = run.reverse(added, true); run.flush();
  run.send(run.set.b, removeBeat("gone", "Bob")); run.flush();
  run.check("removed without the picture", state([["R2", "cd", []]], [], [["R1", []]]));
  const [removal, stored] = [...collabState(run.set.c).roots.removalRecords.entries()][0] ?? []; assert.ok(removal);
  const record = readSharedRemovalCommand(removal, stored); assert.ok(record?.kind === "remove");
  assert.deepEqual(record.gallery, ["R1:slot:0"]);
  run.send(run.set.b, { kind: "restore", id: "back", by: "Bob", removals: [removal] }); run.flush();
  run.check("restored without the picture", plain);
  run.reverse(undone, true); run.flush(); run.check("redone", withP1);
}));

for (const order of ORDERS) test(`the undo is used up when the picture was changed before it, or its beat is removed: ${order}`, () => scenario(order, run => {
  const added = run.command(run.set.a, add("G1", "P1", "a")); run.flush();
  run.send(run.set.b, setRecord("gallery", "G1", "picture", picture("Renamed", "a"), "Bob", "rename")); run.flush();
  const renamed = state([["R1", "ab", ["Renamed"]], ["R2", "cd", []]], [["G1", "Renamed", "a"]]);
  run.usedUp(added, "changed before the undo", renamed);
  const again = run.command(run.set.a, add("G2", "P2", "b", "0000000002")); run.flush();
  run.send(run.set.b, removeBeat("gone", "Bob")); run.flush();
  run.usedUp(again, "beat removed before the undo", state([["R2", "cd", []]], [["G1", "Renamed", "a"], ["G2", "P2", "b"]], [["R1", ["Renamed", "P2"]]]));
}));

for (const order of ORDERS) test(`a picture removed is put back as the same record, the redo takes it away again, and an undo again brings it back: ${order}`, () => scenario(order, run => {
  run.command(run.set.a, add("G1", "P1", "a")); run.flush();
  const removed = run.command(run.set.a, deleteRecord("gallery", "G1", "Alice", "drop")); run.flush(); run.check("removed", plain);
  assert.deepEqual(removed.parts.map(part => part.kind), ["record-delete"]);
  const undone = run.reverse(removed, true); run.flush(); run.check("put back", withP1);
  const redone = run.reverse(undone, true); run.flush(); run.check("taken away again", plain);
  run.reverse(redone, true); run.flush(); run.check("back again", withP1);
}));

for (const order of ORDERS) test(`a late joiner from a state with the picture undone sees it hidden and agrees when the racing rename arrives: ${order}`, () => {
  const run = start(order);
  const late = createMonitoredSharedDocument();
  try {
    const added = run.command(run.set.a, add("G1", "P1", "a")); run.flush();
    run.send(run.set.b, setRecord("gallery", "G1", "picture", picture("Renamed", "a"), "Bob", "rename"));
    run.reverse(added, true);
    collabState(late).doc.clientID = 9;
    assert.ok(applySharedUpdate(late, encodeSharedState(run.set.a)).ok);
    assert.deepEqual(read(late), plain);
    const deliver = deliveryReplica(late);
    run.flush();
    for (const update of [encodeSharedState(run.set.b), encodeSharedState(run.set.a)]) deliver.apply(update);
    const renamed = state([["R1", "ab", ["Renamed"]], ["R2", "cd", []]], [["G1", "Renamed", "a"]]);
    assert.deepEqual(read(late), renamed);
    run.check("every copy", renamed);
  } finally { destroySharedDocument(late); run.close(); }
});

const removedWith = (pictures: string[]) => state([["R2", "cd", []]], pictures.length ? [["G1", "P1", "a"]] : [], [["R1", pictures]]);
const LISTS: readonly { readonly name: string; readonly hidden: boolean; readonly values: readonly unknown[]; readonly listed: readonly string[]; readonly after: Reading }[] = [
  { name: "a shown picture retired, then its beat removed", hidden: false, listed: [], after: removedWith([]),
    values: [{ kind: "gallery-retire", record: "G1", id: "retire", by: "Alice" }, removeBeat("gone", "Alice")] },
  { name: "a hidden picture restored, then its beat removed", hidden: true, listed: ["G1"], after: removedWith(["P1"]),
    values: [{ kind: "gallery-restore", record: "G1", id: "restore", by: "Alice" }, removeBeat("gone", "Alice")] },
  { name: "a hidden picture shown by a field change, retired, then its beat removed", hidden: true, listed: [], after: removedWith([]),
    values: [setRecord("gallery", "G1", "custom", "wake", "Alice", "wake"), { kind: "gallery-retire", record: "G1", id: "retire", by: "Alice" }, removeBeat("gone", "Alice")] }
];

for (const order of ORDERS) for (const list of LISTS) for (const apart of [false, true]) test(`${list.name}, ${apart ? "as separate lists" : "as one list"}: the removal lists what the readers show: ${order}`, () => scenario(order, run => {
  const added = run.command(run.set.a, add("G1", "P1", "a")); run.flush();
  if (list.hidden) { run.reverse(added, true); run.flush(); }
  if (apart) for (const value of list.values) run.send(run.set.a, value); else run.send(run.set.a, ...list.values);
  assert.deepEqual(listed(run.set.a, "Alice").filter(key => !key.includes(":slot:")), list.listed);
  run.flush(); run.check("after", list.after);
}));

for (const order of ORDERS) test(`an old redo cannot take back another writer's later change: Bob's rename of the hidden picture is a field change, its undo keeps the picture shown, and Alice's redo is used up: ${order}`, () => scenario(order, run => {
  const added = run.command(run.set.a, add("G1", "P1", "a")); run.flush();
  const redo = run.reverse(added, true); run.flush(); run.check("hidden", plain);
  const renamed = run.command(run.set.b, setRecord("gallery", "G1", "picture", picture("Renamed", "a"), "Bob", "change"));
  assert.deepEqual(renamed.parts, [{ kind: "record-field", target: { collection: "gallery", record: "G1" }, field: "picture",
    prior: { value: picture("P1", "a") }, written: { value: picture("Renamed", "a") } }]);
  run.flush(); run.check("shown renamed", state([["R1", "ab", ["Renamed"]], ["R2", "cd", []]], [["G1", "Renamed", "a"]]));
  run.reverse(renamed, true, run.set.b); run.flush(); run.check("the old name, still shown", withP1);
  run.usedUp(redo, "redo used up", withP1);
}));

for (const order of ORDERS) test(`a split undone after a picture was added to its new beat and undone is still effective: ${order}`, () => scenario(order, run => {
  const split = run.command(run.set.a, { kind: "split", id: "split", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" },
    at: { left: null, right: flowBaseReference("R1", "audioText", 1), affinity: "before" }, observed: [flowBaseReference("R1", "audioText", 0, 2)], boundary: "R3", beat: "R3", fields: {} });
  run.flush();
  const beat = "structure_1_00730070006c00690074_beat_0";
  assert.deepEqual(split.parts.flatMap(part => part.kind === "beat-split" ? [part.beat] : []), [beat]);
  const added = run.command(run.set.a, createRecord("gallery", "G1", { beat, rank: "1", picture: picture("P1", "a") }, "Alice", "add-G1")); run.flush();
  run.check("split, picture added", state([["R1", "a", []], [beat, "b", ["P1"]], ["R2", "cd", []]], [["G1", "P1", "a"]]));
  run.reverse(added, true); run.flush(); run.check("split, picture undone", state([["R1", "a", []], [beat, "b", []], ["R2", "cd", []]], []));
  run.reverse(split, true); run.flush(); run.check("original script", plain);
}));

for (const order of ORDERS) test(`a beat restore undone after a picture was added to the beat and undone is still effective: ${order}`, () => scenario(order, run => {
  run.command(run.set.a, removeBeat("gone", "Alice")); run.flush();
  const restore = run.command(run.set.a, { kind: "restore", id: "restore", by: "Alice", removals: [...collabState(run.set.a).roots.removalRecords.keys()] }); run.flush();
  const added = run.command(run.set.a, add("G1", "P1", "a")); run.flush();
  run.reverse(added, true); run.flush(); run.check("restored, picture undone", plain);
  run.reverse(restore, true); run.flush(); run.check("removed again", removedWith([]));
}));

const DECLARED_LIMITS: readonly string[] = [];

function violated(handle: SharedDocumentHandle, reading: Reading, renamed: ReadonlySet<string>): string[] {
  const shown = [...reading.rows, ...reading.recovery].flatMap(entry => entry[entry.length - 1] as string[]).sort();
  const stored = collabState(handle).roots, found: string[] = [];
  if (JSON.stringify(shown) !== JSON.stringify(reading.records.map(record => String(record[1])).sort())) found.push("shown pictures differ from the pictures read");
  if ([...renamed].some(key => !reading.records.some(record => record[0] === key))) found.push("a picture another writer renamed is hidden");
  if ([...stored.removalRecords.entries()].some(([key, raw]) => { const record = readSharedRemovalCommand(key, raw); return record?.kind === "remove" && record.gallery.some(listed => !stored.gallery.has(listed)); })) {
    found.push("a removal lists a picture that is not stored");
  }
  return found;
}

test("seeded adds, undos, redos, renames, beat removals and restores by three writers, delivered one message at a time, agree on every copy and a late joiner", t => {
  let seed = 0x58a1, steps = 0;
  const ran = { add: 0, undo: 0, redo: 0, effective: 0, rename: 0, remove: 0, restore: 0, delivered: 0 }, violations = new Set<string>();
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
  for (let sample = 0; sample < 12; sample++) for (const order of ORDERS) {
    const run = start(order), late = createMonitoredSharedDocument(), undo: SharedUndoRecord[] = [], redo: SharedUndoRecord[] = [];
    const digits = new Map<string, string>(), renamed = new Set<string>();
    let ids = 0, removal: string | null = null;
    try {
      for (let step = 0; step < 20; step++, steps++) {
        const action = [0, 0, 1, 1, 1, 2, 3, 3, 3, 4, 5, 5][random(12)];
        if (action === 0 && digits.size < 16) {
          const key = "G" + digits.size, digit = "0123456789abcdef"[digits.size] ?? "0";
          digits.set(key, digit); undo.push(run.command(run.set.a, add(key, key, digit, String(digits.size).padStart(10, "0")))); redo.splice(0); ran.add++;
        } else if (action === 1 || action === 2) {
          const record = (action === 1 ? undo : redo).pop();
          if (!record) continue;
          const done = reverseSharedUndoRecord(run.set.a, record, { by: "Alice", nextId: () => "u" + ++ids });
          assert.equal(done.ok ? null : done.reason, null); if (!done.ok) break;
          (action === 1 ? redo : undo).push(done.inverse); ran[action === 1 ? "undo" : "redo"]++; if (done.effective) ran.effective++; run.compare();
        } else if (action === 3) {
          const stored = [...collabState(run.set.b).roots.gallery.keys()].filter(key => digits.has(key)).sort(), key = stored[random(Math.max(1, stored.length))];
          if (!key) continue;
          run.send(run.set.b, setRecord("gallery", key, "picture", picture(key + "/b" + step, digits.get(key) ?? "0"), "Bob", "rename" + step)); renamed.add(key); ran.rename++;
        } else if (action === 4) {
          const roots = collabState(run.set.c).roots, before = new Set(roots.removalRecords.keys());
          if (projectSharedDocumentWithRecovery(run.set.c).document.rows.some(row => row.id === "R1")) {
            run.send(run.set.c, removeBeat("gone" + step, "Carol")); removal = [...roots.removalRecords.keys()].find(key => !before.has(key)) ?? null; ran.remove++;
          } else if (removal) { run.send(run.set.c, { kind: "restore", id: "back" + step, by: "Carol", removals: [removal] }); ran.restore++; }
        } else {
          const pending = run.set.queue.pending, message = pending[random(Math.max(1, pending.length))];
          if (message) { run.set.queue.deliver(message.id, random(2) + 1); run.compare(); ran.delivered++; }
        }
      }
      run.flush();
      collabState(late).doc.clientID = 9;
      assert.ok(applySharedUpdate(late, encodeSharedState(run.set.a)).ok);
      const handles = [run.set.a, run.set.b, run.set.c, late], readings = handles.map(read);
      readings.forEach((reading, index) => {
        assert.deepEqual(reading, readings[0], "seed=" + seed + " " + order + " copy " + index);
        const handle = handles[index]; assert.ok(handle);
        for (const found of violated(handle, reading, renamed)) violations.add(found);
      });
    } finally { destroySharedDocument(late); run.close(); }
  }
  assert.deepEqual([...violations].sort(), DECLARED_LIMITS);
  assert.deepEqual({ steps, ...ran }, { steps: 720, add: 120, undo: 82, redo: 14, effective: 84, rename: 24, remove: 40, restore: 20, delivered: 88 });
  t.diagnostic(JSON.stringify({ seed: "0x58a1", histories: 36, steps, ...ran }));
});
