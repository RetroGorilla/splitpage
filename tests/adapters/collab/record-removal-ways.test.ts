import test from "node:test";
import assert from "node:assert/strict";
import { agree, operation, replicas } from "./executor-support.ts";
import { assertIncremental, captureIncrementalReplica } from "./incremental-support.ts";
import { pictureA } from "./projection-record-support.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { sharedRecoveryRecordRestore } from "../../../src/core/collab/recovery.ts";
import type { SharedDeletedRecordEntry } from "../../../src/core/collab/recovery.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const ORDERS = ["D1", "rev", "dup"] as const;
type Order = typeof ORDERS[number];

interface Listed {
  readonly name: string;
  readonly collection: "shots" | "gallery";
  readonly record: string;
  readonly field: "props" | "links";
  readonly fields: Record<string, unknown>;
  readonly item: (name: string) => Record<string, unknown>;
  readonly added: Record<string, unknown>;
}
const LISTED: readonly Listed[] = [
  { name: "a b-roll shot's props", collection: "shots", record: "S9", field: "props",
    fields: { id: "S9", name: "City", status: "unshot", origin: "list", props: [{ id: "pr1", name: "Cup" }] }, item: name => ({ id: "pr1", name }), added: { id: "pr2", name: "New" } },
  { name: "a picture's video links", collection: "gallery", record: "G9", field: "links",
    fields: { beat: "R1", rank: "1", picture: { imageRef: pictureA, name: "" }, links: [{ href: "https://example.com/v", name: "Cup" }] },
    item: name => ({ href: "https://example.com/v", name }), added: { href: "https://example.com/w", name: "New" } }
];

const list = (kind: Listed, value: readonly unknown[], by: string, id: string) =>
  ({ kind: "record-set", id, by, target: { collection: kind.collection, record: kind.record }, field: kind.field, value });
const clear = (kind: Listed, by: string, id: string) => ({ kind: "record-set", id, by, target: { collection: kind.collection, record: kind.record }, field: kind.field, clear: true });
const remove = (kind: Listed, by: string, id: string) => ({ kind: "record-delete", id, by, target: { collection: kind.collection, record: kind.record } });

// why: one row per way a record or a list entry stops being shown; a new way is one more row.
interface Way {
  readonly name: string;
  readonly alice: (kind: Listed) => readonly Record<string, unknown>[];
  readonly bob: (kind: Listed) => Record<string, unknown>;
  readonly after?: (kind: Listed) => readonly Record<string, unknown>[];
  readonly value: string;
}
const WAYS: readonly Way[] = [
  { name: "the entry is taken out of its list", alice: kind => [list(kind, [], "Alice", "out")], bob: kind => list(kind, [kind.item("Mug")], "Bob", "rename"), value: "Mug" },
  { name: "the list is cleared", alice: kind => [clear(kind, "Alice", "clear")], bob: kind => list(kind, [kind.item("Mug")], "Bob", "rename"), value: "Mug" },
  { name: "the record is removed", alice: kind => [remove(kind, "Alice", "gone")], bob: kind => list(kind, [kind.item("Mug")], "Bob", "rename"), value: "Mug" },
  { name: "the record is removed while an entry is added", alice: kind => [remove(kind, "Alice", "gone")],
    bob: kind => list(kind, [kind.item("Cup"), kind.added], "Bob", "add"), value: "New" },
  { name: "the record is removed after the entry's removal raced an edit", alice: kind => [list(kind, [], "Alice", "out")],
    bob: kind => list(kind, [kind.item("Mug")], "Bob", "rename"), after: kind => [remove(kind, "Alice", "gone")], value: "Mug" },
  { name: "the entry is taken out and the record removed, both unseen by the editor", alice: kind => [list(kind, [], "Alice", "out"), remove(kind, "Alice", "gone")],
    bob: kind => list(kind, [kind.item("Mug")], "Bob", "rename"), value: "Mug" }
];

function world(order: Order) {
  const run = replicas(3), handles = [run.a, run.b, run.c];
  for (const handle of handles) { registerSharedRecordHandlers(handle); registerSharedRemovalHandlers(handle); registerSharedUndoOperationHandlers(handle); }
  const projector = captureIncrementalReplica(run.c).projector;
  const flush = () => { run.queue.flush(order); assertIncremental(run.c, projector); };
  const send = (handle: SharedDocumentHandle, raw: unknown) => assert.deepEqual(executeSharedOperations(handle, [operation(raw)], { base: readSharedRevision(handle) }), { ok: true });
  const command = (handle: SharedDocumentHandle, raw: unknown): SharedUndoRecord => {
    const done = executeSharedCommand(handle, [operation(raw)], { label: "records", selection: null, typing: null }, { base: readSharedRevision(handle) });
    assert.deepEqual(done.result, { ok: true }); assert.ok(done.record); return done.record;
  };
  return { run, handles, flush, send, command, close: () => { projector.dispose(); run.close(); } };
}

function names(kind: Listed, handle: SharedDocumentHandle): readonly string[] {
  const found = readSharedRecords(handle, kind.collection).find(item => item.key === kind.record);
  return ((found?.fields[kind.field] ?? []) as { fields: { name?: string } }[]).map(entry => String(entry.fields.name));
}
function holders(handle: SharedDocumentHandle, value: string): SharedDeletedRecordEntry[] {
  return projectSharedDocumentWithRecovery(handle).recovery.filter((entry): entry is SharedDeletedRecordEntry =>
    entry.kind === "deleted-record" && JSON.stringify(entry.fields).includes(JSON.stringify(value)));
}

function raced(kind: Listed, way: Way, order: Order) {
  const w = world(order);
  w.send(w.run.b, { kind: "record-create", id: "make", by: "Bob", target: { collection: kind.collection, record: kind.record }, fields: kind.fields }); w.flush();
  const removals = way.alice(kind).map(raw => w.command(w.run.a, raw));
  w.send(w.run.b, way.bob(kind)); w.flush();
  for (const raw of way.after?.(kind) ?? []) { removals.push(w.command(w.run.a, raw)); w.flush(); }
  return { ...w, removals };
}

for (const way of WAYS) for (const kind of LISTED) for (const order of ORDERS) {
  test(`${way.name}, in ${kind.name}: an edit made without seeing it is held in exactly one recovery entry on every copy and a late joiner: ${order}`, () => {
    const w = raced(kind, way, order);
    try {
      agree("held once", order, w.handles, handle => ({ shown: names(kind, handle).includes(way.value), held: holders(handle, way.value).length,
        entries: projectSharedDocumentWithRecovery(handle).recovery.filter(entry => entry.kind === "deleted-record").length }), { shown: false, held: 1, entries: 1 });
    } finally { w.close(); }
  });

  test(`${way.name}, in ${kind.name}: a restore of that entry shows the edit again, and no entry holds it: ${order}`, () => {
    const w = raced(kind, way, order);
    try {
      const [entry] = holders(w.run.c, way.value); assert.ok(entry);
      const restore = sharedRecoveryRecordRestore(entry, [], { id: "back", by: "Carol" }); assert.ok(restore);
      w.send(w.run.c, restore); w.flush();
      agree("restored", order, w.handles, handle => ({ shown: names(kind, handle).includes(way.value), held: holders(handle, way.value).length }), { shown: true, held: 0 });
    } finally { w.close(); }
  });

  test(`${way.name}, in ${kind.name}: the remover's undo brings the record back with the edit: ${order}`, () => {
    const w = raced(kind, way, order);
    try {
      let count = 0;
      for (const record of [...w.removals].reverse()) {
        const done = reverseSharedUndoRecord(w.run.a, record, { by: "Alice", nextId: () => "undo-" + ++count });
        assert.ok(done.ok && done.effective, JSON.stringify(done)); w.flush();
      }
      agree("undone", order, w.handles, handle => ({ shown: names(kind, handle).includes(way.value), held: holders(handle, way.value).length }), { shown: true, held: 0 });
    } finally { w.close(); }
  });
}
