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
import { createMonitoredSharedDocument } from "./helpers.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { readSharedStatus } from "../../../src/adapters/collab/status.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { sharedRecoveryDiscardOperation, sharedRecoveryRecordRestore } from "../../../src/core/collab/recovery.ts";
import type { SharedDeletedRecordEntry } from "../../../src/core/collab/recovery.ts";
import type { SharedContentRef, SharedRecordCollection } from "../../../src/core/collab/operations.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const ORDERS = ["D1", "rev", "dup"] as const;
type Order = typeof ORDERS[number];
const COMMAND = { label: "records", selection: null, typing: null };
const set = (collection: SharedRecordCollection, record: string, field: string, value: unknown, by: string, id: string) =>
  ({ kind: "record-set", id, by, target: { collection, record }, field, value });

interface Kind {
  readonly name: string;
  readonly collection: SharedDeletedRecordEntry["collection"];
  readonly record: string;
  readonly fields: Record<string, unknown>;
  readonly remove: (by: string) => Record<string, unknown>;
  readonly edit: Record<string, unknown>;
  readonly other: Record<string, unknown>;
  readonly value: (handle: SharedDocumentHandle) => unknown;
  readonly entry: (fields: Readonly<Record<string, unknown>>) => unknown;
  readonly edited: unknown;
  readonly before: unknown;
  readonly changed: readonly string[];
  readonly both: readonly string[];
  readonly nested?: { readonly field: "props" | "links"; readonly entry: string };
  readonly bothValue?: unknown;
}
const fieldOf = (collection: SharedRecordCollection, record: string, read: (fields: Readonly<Record<string, unknown>>) => unknown) =>
  (handle: SharedDocumentHandle) => { const found = readSharedRecords(handle, collection).find(item => item.key === record); return found ? read(found.fields) : null; };
const deleting = (collection: SharedRecordCollection, record: string) => (by: string) => ({ kind: "record-delete", id: "gone", by, target: { collection, record } });
const props = (fields: Readonly<Record<string, unknown>>) => (fields.props as { fields: { name: string } }[]).map(prop => prop.fields.name);
const caption = (fields: Readonly<Record<string, unknown>>) => (fields.picture as { name?: string }).name;

const KINDS: readonly Kind[] = [
  { name: "a b-roll shot's notes", collection: "shots", record: "S9", fields: { id: "S9", name: "City", status: "unshot", origin: "list", props: [] },
    remove: deleting("shots", "S9"), edit: set("shots", "S9", "notes", "dusk", "Bob", "bob"), other: set("shots", "S9", "desc", "wide", "Carol", "carol"),
    value: fieldOf("shots", "S9", fields => fields.notes ?? null), entry: fields => fields.notes ?? null, edited: "dusk", before: null, changed: ["notes"], both: ["desc", "notes"] },
  { name: "a b-roll shot's status", collection: "shots", record: "S9", fields: { id: "S9", name: "City", status: "unshot", origin: "list", props: [] },
    remove: deleting("shots", "S9"), edit: { kind: "status", id: "bob", by: "Bob", target: { scope: "shot", record: "S9" }, value: "shot", parents: [] },
    other: set("shots", "S9", "notes", "dusk", "Carol", "carol"),
    value: handle => readSharedRecords(handle, "shots").some(item => item.key === "S9") ? readSharedStatus(handle, { scope: "shot", record: "S9" as SharedContentRef }) : null,
    entry: fields => fields.name, edited: "shot", before: "unshot", changed: ["status"], both: ["notes", "status"] },
  { name: "a tag's notes", collection: "tags", record: "t_9", fields: { id: "t_9", cat: "prop", name: "Mug", status: "needed" },
    remove: deleting("tags", "t_9"), edit: set("tags", "t_9", "notes", "blue", "Bob", "bob"), other: set("tags", "t_9", "name", "Mugs", "Carol", "carol"),
    value: fieldOf("tags", "t_9", fields => fields.notes ?? null), entry: fields => fields.notes ?? null, edited: "blue", before: null, changed: ["notes"], both: ["name", "notes"] },
  { name: "a person's name", collection: "people", record: "P9", fields: { id: "P9", name: "Ada" },
    remove: deleting("people", "P9"), edit: set("people", "P9", "name", "Adah", "Bob", "bob"), other: set("people", "P9", "extra", '{"c":1}', "Carol", "carol"),
    value: fieldOf("people", "P9", fields => fields.name), entry: fields => fields.name, edited: "Adah", before: "Ada", changed: ["name"], both: ["extra", "name"] },
  { name: "a comment's words", collection: "comments", record: "C9", fields: { id: "C9", author: "Bob", createdAt: 0, text: "hi", rowId: "R1", field: "audioText" },
    remove: deleting("comments", "C9"), edit: set("comments", "C9", "text", "hello", "Bob", "bob"), other: set("comments", "C9", "assignee", "Carol", "Carol", "carol"),
    value: fieldOf("comments", "C9", fields => fields.text), entry: fields => fields.text, edited: "hello", before: "hi", changed: ["text"], both: ["assignee", "text"] },
  { name: "a reply's words", collection: "replies", record: '["C9","r9"]', fields: { id: "r9", commentId: "C9", author: "Bob", createdAt: 0, text: "x" },
    remove: deleting("replies", '["C9","r9"]'), edit: set("replies", '["C9","r9"]', "text", "xy", "Bob", "bob"), other: set("replies", '["C9","r9"]', "extra", '{"c":1}', "Carol", "carol"),
    value: fieldOf("replies", '["C9","r9"]', fields => fields.text), entry: fields => fields.text, edited: "xy", before: "x", changed: ["text"], both: ["extra", "text"] },
  { name: "a picture's caption", collection: "gallery", record: "G9", fields: { beat: "R1", rank: "1", picture: { imageRef: pictureA, name: "" }, links: [] },
    remove: deleting("gallery", "G9"), edit: set("gallery", "G9", "picture", { imageRef: pictureA, name: "cap" }, "Bob", "bob"),
    other: set("gallery", "G9", "links", [{ href: "https://example.com/v", name: "v" }], "Carol", "carol"),
    value: fieldOf("gallery", "G9", caption), entry: caption, edited: "cap", before: "", changed: ["picture"], both: ["links", "picture"] },
  { name: "a prop of a b-roll shot", collection: "shots", record: "S9", fields: { id: "S9", name: "City", status: "unshot", origin: "list", props: [{ id: "pr1", name: "Cup" }] },
    remove: by => set("shots", "S9", "props", [], by, "gone"), edit: set("shots", "S9", "props", [{ id: "pr1", name: "Mug" }], "Bob", "bob"),
    other: set("shots", "S9", "props", [{ id: "pr1", name: "Mugs" }], "Carol", "carol"),
    value: fieldOf("shots", "S9", fields => props(fields)[0] ?? null), entry: fields => fields.name, edited: "Mug", before: "Cup", changed: ["value"], both: ["value"], bothValue: "Mugs",
    nested: { field: "props", entry: "pr1" } }
];

function world(order: Order) {
  const run = replicas(3), handles = [run.a, run.b, run.c];
  for (const handle of handles) { registerSharedRecordHandlers(handle); registerSharedRemovalHandlers(handle); registerSharedUndoOperationHandlers(handle); }
  const projector = captureIncrementalReplica(run.c).projector;
  const flush = () => { run.queue.flush(order); assertIncremental(run.c, projector); };
  const send = (handle: SharedDocumentHandle, raw: unknown) => assert.deepEqual(executeSharedOperations(handle, [operation(raw)], { base: readSharedRevision(handle) }), { ok: true });
  const command = (handle: SharedDocumentHandle, raw: unknown): SharedUndoRecord => {
    const done = executeSharedCommand(handle, [operation(raw)], COMMAND, { base: readSharedRevision(handle) });
    assert.deepEqual(done.result, { ok: true }); assert.ok(done.record); return done.record;
  };
  let undone = 0;
  const reverse = (handle: SharedDocumentHandle, record: SharedUndoRecord, by: string) => {
    const done = reverseSharedUndoRecord(handle, record, { by, nextId: () => by + "-undo-" + ++undone }); assert.ok(done.ok, JSON.stringify(done)); return done;
  };
  return { run, handles, flush, send, command, reverse, close: () => { projector.dispose(); run.close(); } };
}
type World = ReturnType<typeof world>;

function entries(handle: SharedDocumentHandle): SharedDeletedRecordEntry[] {
  return projectSharedDocumentWithRecovery(handle).recovery.filter((entry): entry is SharedDeletedRecordEntry => entry.kind === "deleted-record");
}
const shown = (kind: Kind) => (handle: SharedDocumentHandle) => ({ value: kind.value(handle),
  recovery: entries(handle).map(entry => ({ collection: entry.collection, record: entry.record, field: entry.field, entry: entry.entry, by: entry.by, changed: entry.changed, value: kind.entry(entry.fields) })) });
const listed = (kind: Kind, changed = kind.changed, value: unknown = kind.entry({ ...kind.fields, notes: kind.edited, text: kind.edited, name: kind.edited, picture: { name: kind.edited } })) =>
  [{ collection: kind.collection, record: kind.record, field: kind.nested?.field ?? null, entry: kind.nested?.entry ?? null, by: "Alice", changed: [...changed], value }];

function raced(kind: Kind, order: Order, body: (w: World, removal: SharedUndoRecord, edit: SharedUndoRecord) => void, unseen: (w: World) => void = () => undefined) {
  const w = world(order);
  try {
    w.send(w.run.b, { kind: "record-create", id: "make", by: "Bob", target: { collection: kind.collection, record: kind.record }, fields: kind.fields }); w.flush();
    const removal = w.command(w.run.a, kind.remove("Alice")), edit = w.command(w.run.b, kind.edit); unseen(w); w.flush();
    body(w, removal, edit);
  } finally { w.close(); }
}

function entryValue(kind: Kind): unknown {
  return kind.name === "a b-roll shot's status" ? "City" : kind.name === "a prop of a b-roll shot" ? "Mug" : kind.edited;
}

for (const kind of KINDS) for (const order of ORDERS) {
  test(`removal and an unseen edit of ${kind.name}: removal wins, and one recovery entry on every copy and a late joiner holds the edit: ${order}`, () => raced(kind, order, w => {
    agree("raced", order, w.handles, shown(kind), { value: null, recovery: listed(kind, kind.changed, entryValue(kind)) });
  }));

  test(`a restore of the entry for ${kind.name} brings it back once, with the edit, and a second restore is refused: ${order}`, () => raced(kind, order, w => {
    const [entry] = entries(w.run.c); assert.ok(entry);
    const restore = sharedRecoveryRecordRestore(entry, [], { id: "back", by: "Carol" }); assert.ok(restore);
    w.send(w.run.c, restore); w.flush();
    agree("restored", order, w.handles, shown(kind), { value: kind.edited, recovery: [] });
    const again = operation({ ...restore, id: "again" });
    assert.deepEqual(executeSharedOperations(w.run.a, [again]), { ok: false, index: 0, operation: again, reason: "record-not-deleted" });
  }));

  test(`a discard of the entry for ${kind.name} removes it from every copy and leaves the removal standing: ${order}`, () => raced(kind, order, w => {
    const [entry] = entries(w.run.a); assert.ok(entry);
    const discard = sharedRecoveryDiscardOperation(entry, { id: "drop", by: "Alice" }); assert.ok(discard);
    w.send(w.run.a, discard); w.flush();
    agree("discarded", order, w.handles, shown(kind), { value: null, recovery: [] });
  }));

  test(`the remover's undo brings ${kind.name} back with the other person's edit, and redo removes it with no entry: ${order}`, () => raced(kind, order, (w, removal) => {
    const undo = w.reverse(w.run.a, removal, "Alice"); assert.equal(undo.effective, true); w.flush();
    agree("undone", order, w.handles, shown(kind), { value: kind.edited, recovery: [] });
    assert.ok(undo.ok);
    const redo = w.reverse(w.run.a, undo.inverse, "Alice"); assert.equal(redo.effective, true); w.flush();
    agree("redone", order, w.handles, shown(kind), { value: null, recovery: [] });
  }));

  test(`the editor's own undo of an edit to ${kind.name} is used up while the removal stands, and the edit stays in recovery: ${order}`, () => raced(kind, order, (w, _removal, edit) => {
    const before = encodeSharedState(w.run.b);
    assert.equal(w.reverse(w.run.b, edit, "Bob").effective, false);
    assert.deepEqual(encodeSharedState(w.run.b), before); w.flush();
    agree("used up", order, w.handles, shown(kind), { value: null, recovery: listed(kind, kind.changed, entryValue(kind)) });
  }));

  test(`a plain removal of ${kind.name} lists nothing, and its undo brings it back as it was: ${order}`, () => {
    const w = world(order);
    try {
      w.send(w.run.b, { kind: "record-create", id: "make", by: "Bob", target: { collection: kind.collection, record: kind.record }, fields: kind.fields }); w.flush();
      const removal = w.command(w.run.a, kind.remove("Alice")); w.flush();
      agree("removed", order, w.handles, shown(kind), { value: null, recovery: [] });
      assert.equal(w.reverse(w.run.a, removal, "Alice").effective, true); w.flush();
      agree("undone", order, w.handles, shown(kind), { value: kind.before, recovery: [] });
    } finally { w.close(); }
  });

  test(`two people editing ${kind.name} while a third removes it leave one entry with both edits: ${order}`, () => raced(kind, order, w => {
    const [entry, extra] = entries(w.run.a);
    assert.equal(extra, undefined); assert.ok(entry); assert.deepEqual(entry.changed, kind.both);
    agree("both", order, w.handles, handle => entries(handle).map(item => item.changed), [[...kind.both]]);
    const restore = sharedRecoveryRecordRestore(entry, [], { id: "back", by: "Carol" }); assert.ok(restore);
    w.send(w.run.b, restore); w.flush();
    agree("both restored", order, w.handles, shown(kind), { value: kind.bothValue ?? kind.edited, recovery: [] });
  }, w => w.send(w.run.c, kind.other)));

  test(`an edit that arrives after a discard of ${kind.name} shows the entry again: ${order}`, () => {
    const away = createMonitoredSharedDocument();
    try {
      raced(kind, order, w => {
        const [entry] = entries(w.run.a); assert.ok(entry);
        const discard = sharedRecoveryDiscardOperation(entry, { id: "drop", by: "Alice" }); assert.ok(discard);
        w.send(w.run.a, discard); w.flush();
        agree("discarded", order, w.handles, handle => entries(handle).length, 0);
        for (const handle of w.handles) assert.ok(applySharedUpdate(handle, encodeSharedState(away)).ok);
        agree("shown again", order, w.handles, handle => entries(handle).map(item => item.changed), [[...kind.both]]);
      }, w => {
        assert.ok(applySharedUpdate(away, encodeSharedState(w.run.c)).ok); registerSharedRecordHandlers(away); w.send(away, kind.other);
      });
    } finally { destroySharedDocument(away); }
  });
}

test("a person whose removal raced a rename, and whom a tag names as owner, is listed once, as the record, and its restore is refused while another person has the name", () => raced(KINDS[3] as Kind, "D1", w => {
  w.send(w.run.c, { kind: "record-create", id: "twin", by: "Carol", target: { collection: "people", record: "P8" }, fields: { id: "P8", name: "adah" } }); w.flush();
  const listedKinds = projectSharedDocumentWithRecovery(w.run.a).recovery.map(entry => entry.kind).filter(kind => kind === "deleted-person" || kind === "deleted-record");
  assert.deepEqual(listedKinds, ["deleted-record"]);
  const [entry] = entries(w.run.a); assert.ok(entry);
  assert.equal(sharedRecoveryRecordRestore(entry, readSharedRecords(w.run.a, "people").map(item => item.fields), { id: "back", by: "Carol" }), null);
}, w => w.send(w.run.c, set("tags", "t_1", "owner", "P9", "Carol", "own"))));

test("stored size: a removal keeps the record and adds its mark; an edit that raced it adds only its own write", () => {
  const sizes: Record<string, unknown> = {};
  for (const kind of [KINDS[0], KINDS[3]] as Kind[]) {
    const w = world("D1");
    try {
      w.send(w.run.b, { kind: "record-create", id: "make", by: "Bob", target: { collection: kind.collection, record: kind.record }, fields: kind.fields }); w.flush();
      const start = encodeSharedState(w.run.a).length;
      w.send(w.run.a, kind.remove("Alice"));
      const removed = encodeSharedState(w.run.a).length;
      w.send(w.run.b, kind.edit); w.flush();
      const edited = encodeSharedState(w.run.a).length;
      sizes[kind.collection] = { removal: removed - start, edit: edited - removed };
    } finally { w.close(); }
  }
  assert.deepEqual(sizes, { shots: { removal: 161, edit: 17 }, people: { removal: 126, edit: 9 } });
});

for (const order of ORDERS) test(`a tag created again with the id of a removed tag that an edit raced comes back with that edit: ${order}`, () => raced(KINDS[2] as Kind, order, w => {
  w.send(w.run.a, { kind: "record-create", id: "again", by: "Alice", target: { collection: "tags", record: "t_9" }, fields: { id: "t_9", cat: "prop", name: "Mug", notes: "plain" } }); w.flush();
  agree("created again", order, w.handles, handle => ({ notes: readSharedRecords(handle, "tags").find(item => item.key === "t_9")?.fields.notes ?? null, recovery: entries(handle).length }),
    { notes: "blue", recovery: 0 });
}));

for (const order of ORDERS) test(`a removed shot refuses a new status from someone who has seen the removal, and writes nothing: ${order}`, () => {
  const w = world(order);
  try {
    w.send(w.run.b, { kind: "record-create", id: "make", by: "Bob", target: { collection: "shots", record: "S9" }, fields: KINDS[0]?.fields }); w.flush();
    w.send(w.run.a, deleting("shots", "S9")("Alice")); w.flush();
    const status = operation({ kind: "status", id: "late", by: "Bob", target: { scope: "shot", record: "S9" }, value: "shot", parents: [] }), before = encodeSharedState(w.run.b);
    assert.deepEqual(executeSharedOperations(w.run.b, [status]), { ok: false, index: 0, operation: status, reason: "missing-status-target" });
    assert.deepEqual(encodeSharedState(w.run.b), before);
  } finally { w.close(); }
});

for (const order of ORDERS) test(`a reorder made without seeing a removal is no edit, so nothing is listed: ${order}`, () => {
  const w = world(order);
  try {
    w.send(w.run.b, { kind: "record-create", id: "make", by: "Bob", target: { collection: "shots", record: "S9" }, fields: KINDS[0]?.fields }); w.flush();
    w.send(w.run.a, deleting("shots", "S9")("Alice")); w.send(w.run.b, set("shots", "S9", "rank", "0000000009", "Bob", "move")); w.flush();
    agree("reordered", order, w.handles, handle => entries(handle).length, 0);
  } finally { w.close(); }
});

for (const order of ORDERS) test(`the entry for a shot whose status was set without seeing its removal shows the status a restore will give: ${order}`, () => raced(KINDS[1] as Kind, order, w => {
  agree("status shown", order, w.handles, handle => entries(handle).map(entry => [entry.changed, entry.fields.status]), [[["status"], "shot"]]);
}));
