import test from "node:test";
import assert from "node:assert/strict";
import { agree, operation, replicas } from "./executor-support.ts";
import { assertIncremental, captureIncrementalReplica } from "./incremental-support.ts";
import { pictureA } from "./projection-record-support.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
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
  readonly carol?: (kind: Listed) => Record<string, unknown>;
  readonly after?: (kind: Listed) => readonly Record<string, unknown>[];
  readonly value: string | null;
  readonly undone?: { readonly shown: boolean; readonly held: number };
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
    bob: kind => list(kind, [kind.item("Mug")], "Bob", "rename"), value: "Mug" },
  { name: "the record and one of its entries are removed apart at the same moment, and nobody edits", alice: kind => [remove(kind, "Alice", "gone")],
    bob: kind => list(kind, [], "Bob", "out"), value: null },
  { name: "the record and one of its entries are removed apart while a third person renames that entry", alice: kind => [remove(kind, "Alice", "gone")],
    bob: kind => list(kind, [], "Bob", "out"), carol: kind => list(kind, [kind.item("Mug")], "Carol", "rename"), value: "Mug", undone: { shown: false, held: 1 } }
];
const listedEntries = (handle: SharedDocumentHandle) => projectSharedDocumentWithRecovery(handle).recovery.filter(entry => entry.kind === "deleted-record").length;

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
  w.send(w.run.b, way.bob(kind)); if (way.carol) w.send(w.run.c, way.carol(kind)); w.flush();
  for (const raw of way.after?.(kind) ?? []) { removals.push(w.command(w.run.a, raw)); w.flush(); }
  return { ...w, removals };
}

const shownRecord = (kind: Listed, handle: SharedDocumentHandle) => readSharedRecords(handle, kind.collection).some(item => item.key === kind.record);
for (const way of WAYS.filter(item => item.value === null)) for (const kind of LISTED) for (const order of ORDERS) {
  test(`${way.name}, in ${kind.name}: nothing is listed on any copy or a late joiner, and the remover's undo brings the record back without that entry: ${order}`, () => {
    const w = raced(kind, way, order);
    try {
      agree("nothing listed", order, w.handles, handle => ({ record: shownRecord(kind, handle), entries: listedEntries(handle) }), { record: false, entries: 0 });
      let count = 0;
      for (const record of [...w.removals].reverse()) assert.ok(reverseSharedUndoRecord(w.run.a, record, { by: "Alice", nextId: () => "undo-" + ++count }).ok);
      w.flush();
      agree("undone", order, w.handles, handle => ({ record: shownRecord(kind, handle), names: names(kind, handle), entries: listedEntries(handle) }), { record: true, names: [], entries: 0 });
    } finally { w.close(); }
  });
}

for (const way of WAYS) for (const kind of LISTED) for (const order of ORDERS) {
  const value = way.value;
  if (value === null) continue;
  test(`${way.name}, in ${kind.name}: an edit made without seeing it is held in exactly one recovery entry on every copy and a late joiner: ${order}`, () => {
    const w = raced(kind, way, order);
    try {
      agree("held once", order, w.handles, handle => ({ shown: names(kind, handle).includes(value), held: holders(handle, value).length, entries: listedEntries(handle) }),
        { shown: false, held: 1, entries: 1 });
    } finally { w.close(); }
  });

  test(`${way.name}, in ${kind.name}: a restore of that entry shows the edit again, and no entry holds it: ${order}`, () => {
    const w = raced(kind, way, order);
    try {
      const [entry] = holders(w.run.c, value); assert.ok(entry);
      const restore = sharedRecoveryRecordRestore(entry, [], { id: "back", by: "Carol" }); assert.ok(restore);
      w.send(w.run.c, restore); w.flush();
      agree("restored", order, w.handles, handle => ({ shown: names(kind, handle).includes(value), held: holders(handle, value).length }), { shown: true, held: 0 });
    } finally { w.close(); }
  });

  test(`${way.name}, in ${kind.name}: the remover's undo brings the record back with the edit, or leaves it held where another removal keeps it: ${order}`, () => {
    const w = raced(kind, way, order);
    try {
      let count = 0;
      for (const record of [...w.removals].reverse()) {
        const done = reverseSharedUndoRecord(w.run.a, record, { by: "Alice", nextId: () => "undo-" + ++count });
        assert.ok(done.ok && done.effective, JSON.stringify(done)); w.flush();
      }
      agree("undone", order, w.handles, handle => ({ shown: names(kind, handle).includes(value), held: holders(handle, value).length }), way.undone ?? { shown: true, held: 0 });
    } finally { w.close(); }
  });
}

// why: a removal racing an edit inside a beat whose creation is then undone, and a restore after it, must leave every
// incremental copy showing what an encoded reload shows; one row per kind of child record a creation watches.
interface Child {
  readonly name: string;
  readonly collection: "comments" | "gallery";
  readonly record: string;
  readonly fields: (beat: string) => Record<string, unknown>;
  readonly edit: Record<string, unknown>;
}
const CHILDREN: readonly Child[] = [
  { name: "a comment", collection: "comments", record: "C1", fields: beat => ({ id: "C1", rowId: beat, field: "audioText", author: "Bob", createdAt: 0, text: "Note" }),
    edit: { kind: "record-set", id: "edit", by: "Bob", target: { collection: "comments", record: "C1" }, field: "text", value: "Edited" } },
  { name: "a picture", collection: "gallery", record: "G1", fields: beat => ({ beat, rank: "1", picture: { imageRef: { sha256: "c".repeat(64) }, name: "" }, links: [] }),
    edit: { kind: "record-set", id: "edit", by: "Bob", target: { collection: "gallery", record: "G1" }, field: "picture", value: { imageRef: { sha256: "c".repeat(64) }, name: "Edited" } } }
];
const runtime = createFlowLoadRuntime();
for (const child of CHILDREN) for (const copies of [2, 3] as const) for (const order of ORDERS) {
  test(`${child.name} of a beat removed while edited, the beat's creation undone, then the record restored: ${copies} copies show what an encoded reload shows: ${order}`, () => {
    const run = replicas(copies), handles = copies === 3 ? [run.a, run.b, run.c] : [run.a, run.b];
    for (const handle of handles) registerSharedOperationFamilies(handle, { cells: runtime.cells });
    const projectors = handles.map(handle => captureIncrementalReplica(handle).projector);
    const send = (handle: SharedDocumentHandle, raw: unknown) => assert.deepEqual(executeSharedOperations(handle, [operation(raw)], { base: readSharedRevision(handle) }), { ok: true });
    const settle = (label: string, expect?: (reload: ReturnType<typeof projectSharedDocumentWithRecovery>) => void) => {
      run.queue.flush(order);
      const late = createMonitoredSharedDocument();
      try {
        assert.equal(applySharedUpdate(late, encodeSharedState(run.a)).ok, true);
        const reload = projectSharedDocumentWithRecovery(late);
        handles.forEach((handle, index) => {
          const step = projectors[index]?.read(); assert.ok(step);
          assert.deepEqual({ document: step.document, recovery: step.recovery }, reload, label + ": incremental copy " + index);
          assert.deepEqual(projectSharedDocumentWithRecovery(handle), reload, label + ": copy " + index);
        });
        expect?.(reload);
      } finally { destroySharedDocument(late); }
    };
    try {
      const created = executeSharedCommand(run.a, [operation({ kind: "segment-create", id: "add", by: "Alice", beat: "N1", segment: "N1",
        at: { left: "R1", right: null, affinity: "after" }, fields: { audioText: "x", status: "todo" } })], { label: "create", selection: null, typing: null }, { base: readSharedRevision(run.a) });
      assert.deepEqual(created.result, { ok: true }); assert.ok(created.record);
      const part = created.record.parts[0]; assert.ok(part?.kind === "beat-create"); settle("created");
      send(run.b, { kind: "record-create", id: "child", by: "Bob", target: { collection: child.collection, record: child.record }, fields: child.fields(part.beat) }); settle("child");
      send(run.a, { kind: "record-delete", id: "gone", by: "Alice", target: { collection: child.collection, record: child.record } }); send(run.b, child.edit);
      settle("raced", reload => assert.equal(reload.recovery.filter(entry => entry.kind === "deleted-record" && JSON.stringify(entry.fields).includes("Edited")).length, 1));
      assert.ok(reverseSharedUndoRecord(run.a, created.record, { by: "Alice", nextId: () => "undo" }).ok); settle("creation undone");
      const entry = projectSharedDocumentWithRecovery(run.b).recovery.find(item => item.kind === "deleted-record"); assert.ok(entry);
      const restore = sharedRecoveryRecordRestore(entry, [], { id: "back", by: "Bob" }); assert.ok(restore);
      send(run.b, restore);
      settle("restored", reload => {
        assert.ok(reload.document.rows.some(row => row.id === part.beat));
        assert.ok(JSON.stringify(reload.document).includes("Edited"));
        assert.equal(reload.recovery.filter(item => item.kind === "deleted-record").length, 0);
      });
    } finally { projectors.forEach(projector => projector.dispose()); run.close(); }
  });
}

// why: an entry's rank only orders its list, so renumbering it after another person's removal, or a deliberate reorder,
// is no edit of the record around it; rows for lists of two and three entries.
interface Many { readonly kind: Listed; readonly entries: readonly Record<string, unknown>[] }
const PROPS = [{ id: "pr1", name: "Cup" }, { id: "pr2", name: "Plate" }, { id: "pr3", name: "Bowl" }];
const LINKS = [{ href: "https://example.com/1", name: "Cup" }, { href: "https://example.com/2", name: "Plate" }, { href: "https://example.com/3", name: "Bowl" }];
const MANY: readonly Many[] = ([2, 3] as const).flatMap(count => [
  { kind: { name: `a b-roll shot with ${count} props`, collection: "shots" as const, record: "S9", field: "props" as const,
    fields: { id: "S9", name: "City", status: "unshot", origin: "list", props: PROPS.slice(0, count) }, item: (name: string) => ({ id: "pr1", name }), added: { id: "pr9", name: "New" } },
  entries: PROPS.slice(0, count) },
  { kind: { name: `a picture with ${count} video links`, collection: "gallery" as const, record: "G9", field: "links" as const,
    fields: { beat: "R1", rank: "1", picture: { imageRef: pictureA, name: "" }, links: LINKS.slice(0, count) }, item: (name: string) => ({ href: "https://example.com/1", name }),
    added: { href: "https://example.com/9", name: "New" } },
  entries: LINKS.slice(0, count) }
]);
for (const { kind, entries } of MANY) for (const order of ORDERS) {
  const [first, ...rest] = entries; assert.ok(first);
  const race = (bob: readonly unknown[], carol?: readonly unknown[]) => {
    const w = world(order);
    w.send(w.run.b, { kind: "record-create", id: "make", by: "Bob", target: { collection: kind.collection, record: kind.record }, fields: kind.fields }); w.flush();
    w.command(w.run.a, remove(kind, "Alice", "gone")); w.send(w.run.b, list(kind, bob, "Bob", "change"));
    if (carol) w.send(w.run.c, list(kind, carol, "Carol", "rename"));
    w.flush(); return w;
  };
  test(`${kind.name} removed while another person takes its first entry out, and nobody edits: nothing is listed on any copy or a late joiner: ${order}`, () => {
    const w = race(rest);
    try { agree("renumbered", order, w.handles, handle => ({ record: shownRecord(kind, handle), entries: listedEntries(handle) }), { record: false, entries: 0 }); } finally { w.close(); }
  });
  test(`${kind.name} removed while another person takes its first entry out and a third renames that entry: only the entry is listed: ${order}`, () => {
    const w = race(rest, [{ ...first, name: "Mug" }, ...rest]);
    try {
      agree("renamed", order, w.handles, handle => ({ entries: listedEntries(handle), held: holders(handle, "Mug").map(entry => [entry.field, entry.entry !== null]) }),
        { entries: 1, held: [[kind.field, true]] });
    } finally { w.close(); }
  });
  test(`${kind.name} removed while another person reorders its entries, and nobody edits: nothing is listed on any copy or a late joiner: ${order}`, () => {
    const w = race([...entries].reverse());
    try { agree("reordered", order, w.handles, handle => ({ record: shownRecord(kind, handle), entries: listedEntries(handle) }), { record: false, entries: 0 }); } finally { w.close(); }
  });
}
