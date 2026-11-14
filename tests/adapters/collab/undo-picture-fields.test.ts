import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { createRecord, deleteRecord, setRecord } from "./record-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const ORDERS = ["D1", "rev", "dup"] as const;
const SOURCE = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] };
const sha = (letter: string) => letter.repeat(64);
const picture = (name: string, letter = "a") => ({ imageRef: { sha256: sha(letter) }, name });
const rename = (name: string, by: string, id: string) => setRecord("gallery", "G1", "picture", picture(name), by, id);
const removeBeat = (id: string, by: string) => ({ kind: "remove", id, by, removalKind: "beat", targets: ["R1"],
  observed: [flowBaseReference("R1", "audioText", 0, 2)], boundaries: ["R1"], components: [], gallery: [], at: 0 });

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
      const fields = record.fields as { readonly beat?: string; readonly picture?: { readonly name?: string }; readonly links?: readonly { readonly fields: { readonly href?: string } }[] };
      return [record.key, fields.beat ?? null, fields.picture?.name ?? null, (fields.links ?? []).map(link => link.fields.href ?? null)];
    }) };
}
type Reading = ReturnType<typeof read>;
const state = (rows: unknown[][], records: unknown[][], recovery: unknown[][] = []) => ({ rows, recovery, records }) as Reading;
const named = (name: string, links: string[] = []) =>
  state([["R1", "ab", [name + (links.length ? "+" + links.join(",") : "")]], ["R2", "cd", []]], [["G1", "R1", name, links]]);
const P1 = named("P1");

function scenario(order: typeof ORDERS[number], body: (run: ReturnType<typeof start>) => void) {
  const run = start(order);
  try { body(run); } finally { run.close(); }
}

function start(order: typeof ORDERS[number]) {
  const set = replicas(3, SOURCE), handles = [set.a, set.b, set.c], incremental = handles.map(handle => captureIncrementalReplica(handle));
  handles.forEach(handle => { registerSharedRemovalHandlers(handle); registerSharedRecordHandlers(handle); registerSharedUndoOperationHandlers(handle); });
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
  const command = (handle: SharedDocumentHandle, value: unknown): SharedUndoRecord => {
    const execution = executeSharedCommand(handle, [operation(value)], { label: "picture", selection: null, typing: null }, { base: readSharedRevision(handle) });
    assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); return execution.record;
  };
  let count = 0;
  const reverse = (record: SharedUndoRecord, effective: boolean, handle = set.a) => {
    const done = reverseSharedUndoRecord(handle, record, { by: "Alice", nextId: () => "undo-" + ++count });
    assert.ok(done.ok, JSON.stringify(done)); assert.equal(done.effective, effective); compare(); return done.inverse;
  };
  const check = (label: string, expected: Reading) => agree(label, order, handles, read, expected);
  const usedUp = (record: SharedUndoRecord, label: string, expected: Reading, handle = set.a) => {
    const before = [encodeSharedState(handle), encodeSharedStateVector(handle), readSharedRevision(handle)];
    const inverse = reverse(record, false, handle);
    assert.deepEqual([encodeSharedState(handle), encodeSharedStateVector(handle), readSharedRevision(handle)], before); flush(); check(label, expected); return inverse;
  };
  send(set.a, createRecord("gallery", "G1", { beat: "R1", rank: "0000000001", picture: picture("P1") }, "Alice", "add-G1")); flush();
  return { set, flush, send, command, reverse, check, usedUp, close: () => { incremental.forEach(value => value.projector.dispose()); set.close(); } };
}

test("the part: a change to a picture's caption records the field with the value before and after", () => scenario("D1", run => {
  const renamed = run.command(run.set.a, rename("Renamed", "Alice", "rename"));
  assert.deepEqual(renamed.parts, [{ kind: "record-field", target: { collection: "gallery", record: "G1" }, field: "picture",
    prior: { value: { imageRef: { sha256: sha("a") }, name: "P1" } }, written: { value: { imageRef: { sha256: sha("a") }, name: "Renamed" } } }]);
  const linked = run.command(run.set.a, setRecord("gallery", "G1", "links", [{ href: "https://example.com/v" }], "Alice", "link"));
  assert.deepEqual(linked.parts, [{ kind: "record-field", target: { collection: "gallery", record: "G1" }, field: "links",
    prior: { value: [] }, written: { value: [{ href: "https://example.com/v" }] } }]);
}));

for (const order of ORDERS) test(`a caption change is undone on every copy, redone, and undone again: ${order}`, () => scenario(order, run => {
  const renamed = run.command(run.set.a, rename("Renamed", "Alice", "rename")); run.flush(); run.check("renamed", named("Renamed"));
  const undone = run.reverse(renamed, true); run.flush(); run.check("undone", P1);
  const redone = run.reverse(undone, true); run.flush(); run.check("redone", named("Renamed"));
  run.reverse(redone, true); run.flush(); run.check("undone again", P1);
}));

for (const order of ORDERS) test(`a video link added to a picture is undone and redone: ${order}`, () => scenario(order, run => {
  const linked = run.command(run.set.a, setRecord("gallery", "G1", "links", [{ href: "https://example.com/v" }], "Alice", "link")); run.flush();
  run.check("linked", named("P1", ["https://example.com/v"]));
  const undone = run.reverse(linked, true); run.flush(); run.check("undone", P1);
  run.reverse(undone, true); run.flush(); run.check("redone", named("P1", ["https://example.com/v"]));
}));

for (const order of ORDERS) test(`a picture moved to another beat is moved back by the undo and again by the redo: ${order}`, () => scenario(order, run => {
  const moved = run.command(run.set.a, setRecord("gallery", "G1", "beat", "R2", "Alice", "move")); run.flush();
  const there = state([["R1", "ab", []], ["R2", "cd", ["P1"]]], [["G1", "R2", "P1", []]]);
  run.check("moved", there);
  const undone = run.reverse(moved, true); run.flush(); run.check("moved back", P1);
  run.reverse(undone, true); run.flush(); run.check("moved again", there);
}));

for (const order of ORDERS) test(`two pictures put in another order are put back by the undo: ${order}`, () => scenario(order, run => {
  run.send(run.set.a, createRecord("gallery", "G2", { beat: "R1", rank: "0000000002", picture: picture("P2", "b") }, "Alice", "add-G2")); run.flush();
  const both = state([["R1", "ab", ["P1", "P2"]], ["R2", "cd", []]], [["G1", "R1", "P1", []], ["G2", "R1", "P2", []]]);
  run.check("both", both);
  const reordered = run.command(run.set.a, setRecord("gallery", "G2", "rank", "0000000000", "Alice", "reorder")); run.flush();
  run.check("reordered", state([["R1", "ab", ["P2", "P1"]], ["R2", "cd", []]], [["G2", "R1", "P2", []], ["G1", "R1", "P1", []]]));
  run.reverse(reordered, true); run.flush(); run.check("put back", both);
}));

for (const order of ORDERS) test(`the undo is used up when another writer changed the caption first, and their caption stays: ${order}`, () => scenario(order, run => {
  const renamed = run.command(run.set.a, rename("Renamed", "Alice", "rename")); run.flush();
  run.send(run.set.b, rename("Bobby", "Bob", "bob-rename")); run.flush();
  run.usedUp(renamed, "used up", named("Bobby"));
}));

for (const order of ORDERS) test(`a change to another field of the picture leaves the caption's undo whole: ${order}`, () => scenario(order, run => {
  const renamed = run.command(run.set.a, rename("Renamed", "Alice", "rename")); run.flush();
  run.send(run.set.b, setRecord("gallery", "G1", "links", [{ href: "https://example.com/b" }], "Bob", "bob-link")); run.flush();
  run.reverse(renamed, true); run.flush(); run.check("caption undone, link kept", named("P1", ["https://example.com/b"]));
}));

for (const order of ORDERS) test(`the undo is used up when the picture was removed: ${order}`, () => scenario(order, run => {
  const renamed = run.command(run.set.a, rename("Renamed", "Alice", "rename")); run.flush();
  run.send(run.set.b, deleteRecord("gallery", "G1", "Bob", "drop")); run.flush();
  run.usedUp(renamed, "used up", state([["R1", "ab", []], ["R2", "cd", []]], []));
}));

for (const order of ORDERS) test(`a caption in a removed beat is undone in recovery and the beat comes back with it: ${order}`, () => scenario(order, run => {
  const renamed = run.command(run.set.a, rename("Renamed", "Alice", "rename")); run.flush();
  run.send(run.set.b, removeBeat("gone", "Bob")); run.flush();
  run.check("removed", state([["R2", "cd", []]], [["G1", "R1", "Renamed", []]], [["R1", ["Renamed"]]]));
  run.reverse(renamed, true); run.flush(); run.check("undone in recovery", state([["R2", "cd", []]], [["G1", "R1", "P1", []]], [["R1", ["P1"]]]));
  const removal = [...collabState(run.set.b).roots.removalRecords.keys()][0]; assert.ok(removal);
  run.send(run.set.b, { kind: "restore", id: "back", by: "Bob", removals: [removal] }); run.flush(); run.check("restored", P1);
}));

for (const order of ORDERS) test(`an undo racing an unseen caption from a writer with a higher client id: the other caption stays on every copy: ${order}`, () => scenario(order, run => {
  const renamed = run.command(run.set.a, rename("Renamed", "Alice", "rename")); run.flush();
  run.send(run.set.b, rename("Bobby", "Bob", "bob-rename"));
  run.reverse(renamed, true); run.flush(); run.check("Bob's caption stays", named("Bobby"));
}));

for (const order of ORDERS) test(`declared: an undo from a higher client id racing an unseen caption stays, as for every record field: ${order}`, () => scenario(order, run => {
  const renamed = run.command(run.set.c, rename("Carla", "Carol", "carol-rename")); run.flush();
  run.send(run.set.b, rename("Bobby", "Bob", "bob-rename"));
  run.reverse(renamed, true, run.set.c); run.flush(); run.check("Carol's undo stays", P1);
}));

test("a visual's field change stays refused by name and nothing is written", () => scenario("D1", run => {
  run.send(run.set.a, createRecord("visuals", "V1", { beat: "R1", rank: "1" }, "Alice", "add-V1"));
  const records = [run.command(run.set.a, setRecord("visuals", "V1", "rank", "2", "Alice", "visual-rank"))];
  const before = encodeSharedState(run.set.a);
  assert.deepEqual(records.map(record => reverseSharedUndoRecord(run.set.a, record, { by: "Alice", nextId: () => "refused" })),
    [{ ok: false, reason: "undo-unsupported:record-field:visuals" }]);
  assert.deepEqual(encodeSharedState(run.set.a), before);
}));
