import test from "node:test";
import assert from "node:assert/strict";
import type { SharedRecordCollection } from "../../../src/core/collab/operations.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import { encodeSharedState, observeSharedTransactions } from "../../../src/adapters/collab/document.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { executeSharedCommand, reverseSharedUndoRecord, SHARED_UNDO_RECORDS, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { operation } from "./executor-support.ts";
import { createRecord, deleteRecord, recordReplicas, setRecord } from "./record-support.ts";

const COMMAND = { label: "record", selection: null, typing: null };
type Writer = { by: string; nextId: () => string };

function command(handle: SharedDocumentHandle, ...operations: unknown[]): SharedUndoRecord {
  const execution = executeSharedCommand(handle, operations.map(operation), COMMAND);
  assert.deepEqual(execution.result, { ok: true });
  assert.ok(execution.record);
  return execution.record;
}

function writer(by: string): Writer {
  let serial = 0;
  return { by, nextId: () => by + "-reversal-" + ++serial };
}

function reversed(handle: SharedDocumentHandle, record: SharedUndoRecord, by: Writer): { effective: boolean; inverse: SharedUndoRecord } {
  const reversal = reverseSharedUndoRecord(handle, record, by);
  assert.ok(reversal.ok);
  return { effective: reversal.effective, inverse: reversal.inverse };
}

function usedUp(handle: SharedDocumentHandle, record: SharedUndoRecord, by: Writer): void {
  const before = encodeSharedState(handle);
  assert.equal(reversed(handle, record, by).effective, false);
  assert.deepEqual(encodeSharedState(handle), before);
}

function one(handle: SharedDocumentHandle, collection: SharedRecordCollection, key: string): unknown {
  return readSharedRecords(handle, collection).find(item => item.key === key)?.fields ?? null;
}

const CREATED: readonly { collection: SharedRecordCollection; key: string; by: string; fields: Record<string, unknown>; read: Record<string, unknown> }[] = [
  { collection: "comments", key: "C1", by: "Alice", fields: { createdAt: 0, text: "", rowId: "R1", field: "audioText" },
    read: { id: "C1", rowId: "R1", field: "audioText", author: "Alice", createdAt: 0, text: "" } },
  { collection: "replies", key: '["C0","r1"]', by: "Bob", fields: { id: "r1", commentId: "C0", createdAt: 0, text: "" },
    read: { id: "r1", commentId: "C0", author: "Bob", createdAt: 0, text: "" } },
  { collection: "people", key: "P1", by: "Alice", fields: { name: "Alice" }, read: { id: "P1", name: "Alice" } },
  { collection: "tags", key: "t_new", by: "Alice", fields: { cat: "prop", name: "Mug" }, read: { id: "t_new", cat: "prop", name: "Mug", status: "needed" } },
  { collection: "shots", key: "S2", by: "Alice", fields: { name: "Mug", origin: "list" }, read: { id: "S2", name: "Mug", status: "unshot", origin: "list", props: [] } }
];

test("the five record kinds an undo covers: a creation is undone by removal and redone with the same fields, each as one local undo", () => {
  assert.deepEqual(SHARED_UNDO_RECORDS, ["comments", "replies", "people", "tags", "shots"]);
  assert.deepEqual(["record-create", "record-delete", "record-field", "structure"].map(supportsSharedUndoPart), [true, true, true, false]);
  for (const item of CREATED) {
    const run = recordReplicas();
    try {
      const alice = writer("Alice"), origins: (string | null)[] = [];
      const stop = observeSharedTransactions(run.a, origin => { origins.push(origin); });
      const created = command(run.a, createRecord(item.collection, item.key, item.fields, item.by));
      assert.deepEqual(created.parts.map(part => part.kind), ["record-create"], item.collection);
      assert.deepEqual(one(run.a, item.collection, item.key), item.read, item.collection);
      const undone = reversed(run.a, created, alice);
      assert.equal(undone.effective, true, item.collection);
      assert.equal(one(run.a, item.collection, item.key), null, item.collection);
      assert.deepEqual(undone.inverse.parts.map(part => part.kind), ["record-delete"], item.collection);
      const redone = reversed(run.a, undone.inverse, alice);
      assert.equal(redone.effective, true, item.collection);
      assert.deepEqual(one(run.a, item.collection, item.key), item.read, item.collection);
      usedUp(run.a, undone.inverse, alice);
      stop();
      assert.deepEqual(origins, ["local-command", "local-undo", "local-undo"], item.collection);
      run.queue.flush("rev");
      assert.deepEqual(one(run.b, item.collection, item.key), item.read, item.collection);
    } finally { run.close(); }
  }
});

test("a field change is undone to the earlier value and redone; a field that was absent is cleared again", () => {
  const run = recordReplicas();
  try {
    const alice = writer("Alice");
    command(run.a, createRecord("people", "P1", { name: "Alice" }));
    const renamed = command(run.a, setRecord("people", "P1", "name", "Alicia"));
    assert.deepEqual(renamed.parts, [{ kind: "record-field", target: { collection: "people", record: "P1" }, field: "name", prior: { value: "Alice" }, written: { value: "Alicia" } }]);
    const undone = reversed(run.a, renamed, alice);
    assert.equal(undone.effective, true);
    assert.deepEqual(one(run.a, "people", "P1"), { id: "P1", name: "Alice" });
    assert.equal(reversed(run.a, undone.inverse, alice).effective, true);
    assert.deepEqual(one(run.a, "people", "P1"), { id: "P1", name: "Alicia" });
    const noted = command(run.a, setRecord("people", "P1", "nick", "Al"));
    assert.deepEqual(noted.parts, [{ kind: "record-field", target: { collection: "people", record: "P1" }, field: "nick", prior: { clear: true }, written: { value: "Al" } }]);
    assert.deepEqual(one(run.a, "people", "P1"), { id: "P1", name: "Alicia", nick: "Al" });
    assert.equal(reversed(run.a, noted, alice).effective, true);
    assert.deepEqual(one(run.a, "people", "P1"), { id: "P1", name: "Alicia" });
    const same = executeSharedCommand(run.a, [operation(setRecord("people", "P1", "name", "Alicia"))], COMMAND);
    assert.deepEqual(same, { result: { ok: true }, record: null });
  } finally { run.close(); }
});

test("a removal is undone by putting the record back with the fields it had; another person's comment comes back as theirs", () => {
  const run = recordReplicas();
  try {
    const alice = writer("Alice");
    command(run.b, createRecord("comments", "C1", { createdAt: 0, text: "Look here", rowId: "R1", field: "audioText" }, "Bob"));
    run.queue.flush("D1");
    const removed = command(run.a, deleteRecord("comments", "C1"));
    assert.deepEqual(removed.parts, [{ kind: "record-delete", target: { collection: "comments", record: "C1" },
      fields: { author: "Bob", createdAt: 0, field: "audioText", id: "C1", rowId: "R1", text: "Look here" } }]);
    assert.equal(one(run.a, "comments", "C1"), null);
    const undone = reversed(run.a, removed, alice);
    assert.equal(undone.effective, true);
    assert.deepEqual(one(run.a, "comments", "C1"), { id: "C1", rowId: "R1", field: "audioText", author: "Bob", createdAt: 0, text: "Look here" });
    usedUp(run.a, removed, alice);
    assert.equal(reversed(run.a, undone.inverse, alice).effective, true);
    assert.equal(one(run.a, "comments", "C1"), null);
    run.queue.flush("D1");
    assert.equal(one(run.b, "comments", "C1"), null);
  } finally { run.close(); }
});

test("one command that creates a record and sets its field is one creation; undo removes it", () => {
  const run = recordReplicas();
  try {
    const made = command(run.a, createRecord("people", "P1", { name: "Alice" }), setRecord("people", "P1", "name", "Alicia"));
    assert.deepEqual(made.parts, [{ kind: "record-create", target: { collection: "people", record: "P1" }, fields: { id: "P1", name: "Alicia" } }]);
    assert.equal(reversed(run.a, made, writer("Alice")).effective, true);
    assert.equal(one(run.a, "people", "P1"), null);
  } finally { run.close(); }
});

for (const order of deliveryOrders) {
  test(`${order}: an undo is used up when the record no longer holds what the command wrote, and every copy agrees`, () => {
    const run = recordReplicas();
    try {
      const alice = writer("Alice"), bob = writer("Bob");
      const created = command(run.a, createRecord("people", "P1", { name: "Alice" }));
      run.queue.flush(order);
      command(run.b, setRecord("people", "P1", "name", "Bobby", "Bob"));
      run.queue.flush(order);
      usedUp(run.a, created, alice);
      const renamed = command(run.a, setRecord("people", "P1", "name", "Alicia"));
      run.queue.flush(order);
      const again = command(run.b, setRecord("people", "P1", "name", "Robert", "Bob", "set-again"));
      run.queue.flush(order);
      usedUp(run.a, renamed, alice);
      assert.equal(reversed(run.b, again, bob).effective, true);
      run.queue.flush(order);
      for (const handle of [run.a, run.b]) assert.deepEqual(one(handle, "people", "P1"), { id: "P1", name: "Alicia" });
    } finally { run.close(); }
  });

  test(`${order}: the same removal by two people is one change; the first undo puts the record back and the other is used up`, () => {
    const run = recordReplicas();
    try {
      const alice = writer("Alice"), bob = writer("Bob");
      command(run.a, createRecord("people", "P1", { name: "Alice" }));
      run.queue.flush(order);
      const byAlice = command(run.a, deleteRecord("people", "P1")), byBob = command(run.b, deleteRecord("people", "P1", "Bob"));
      run.queue.flush(order);
      for (const handle of [run.a, run.b]) assert.equal(one(handle, "people", "P1"), null);
      assert.equal(reversed(run.a, byAlice, alice).effective, true);
      run.queue.flush(order);
      usedUp(run.b, byBob, bob);
      for (const handle of [run.a, run.b]) assert.deepEqual(one(handle, "people", "P1"), { id: "P1", name: "Alice" });
    } finally { run.close(); }
  });
}

test("a gallery slot and a visual are refused by name and nothing is written", () => {
  const run = recordReplicas();
  try {
    for (const [collection, key, fields] of [["gallery", "G1", { beat: "R1", rank: "1", picture: {}, links: [] }], ["visuals", "V1", { beat: "R1", rank: "1" }]] as const) {
      const created = command(run.a, createRecord(collection, key, fields));
      assert.deepEqual(created.parts.map(part => part.kind), ["record-create"]);
      const before = encodeSharedState(run.a);
      assert.deepEqual(reverseSharedUndoRecord(run.a, created, writer("Alice")), { ok: false, reason: "undo-unsupported:record-create:" + collection });
      assert.deepEqual(encodeSharedState(run.a), before);
    }
  } finally { run.close(); }
});
