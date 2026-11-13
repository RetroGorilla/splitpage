import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { createRecord, deleteRecord } from "./record-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { assertIncremental, captureIncrementalReplica, nativeText } from "./incremental-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { SharedProjectionSource } from "../../../src/adapters/collab/projection-source.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { IdentityBook, checkModel } from "../../collab/checker.ts";
import type { CollabCharacter, CollabModel } from "../../collab/checker.ts";
import { commentsRemovedOracle, commentsRestoredOracle } from "../../collab/oracles/oracles.ts";

const runtime = createFlowLoadRuntime();
const hex = (value: string) => value.split("").map(unit => unit.charCodeAt(0).toString(16).padStart(4, "0")).join("");
const native = (client: number, id: string, role: string) => "structure_" + client + "_" + hex(id) + "_" + role + "_0";
const REMOVAL = native(1, "gone", "removal"), OTHER = native(2, "gone2", "removal"), RB = native(2, "cut", "beat");
const shown = (id: unknown) => id === RB ? "Rb" : id;
const span = (id: string, words: string) => `<span class="cmt-anchor" data-cmt="${id}">${words}</span>`;
const comment = (id: string, author: string, extra: Record<string, unknown> = {}) => ({ id, anchorId: id, rowId: "R1", field: "audioText", author, body: "", createdAt: 0, ...extra });
const t11 = { rows: [{ id: "R1", audioText: "a" + span("C1", "b" + span("C2", "c")) + span("C2", "d") }, { id: "R2", audioText: "ef" }] };
const t11Records = (c2: Record<string, unknown> = {}) => [createRecord("comments", "C1", { anchorId: "C1", rowId: "R1", field: "audioText", createdAt: 0, text: "" }),
  createRecord("comments", "C2", { anchorId: "C2", rowId: "R1", field: "audioText", createdAt: 0, text: "", ...c2 }, "Bob"),
  createRecord("replies", '["C1","r1"]', { id: "r1", commentId: "C1", createdAt: 0, text: "" }, "Bob")];
const remove = (beat: string, id = "gone", by = "Alice", length = 4) => ({ kind: "remove", id, by, removalKind: "beat", targets: [beat],
  observed: [flowBaseReference(beat, "audioText", 0, length)], boundaries: [beat], components: [], gallery: [], at: 1 });
const restore = (removal: string, by = "Carol") => ({ kind: "restore", id: "back" + removal.length + by, by, removals: [removal] });
const split = { kind: "split", id: "cut", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" },
  at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" }, observed: [], boundary: "Rb", beat: "Rb", fields: {} };

function send(handle: SharedDocumentHandle, ...ops: unknown[]): void {
  assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
function setup(source: Record<string, unknown>) {
  const set = replicas(3, source), handles = [set.a, set.b, set.c];
  for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle); registerSharedRecordHandlers(handle); }
  return { set, handles };
}
function summary(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { rows: document.rows.map(row => shown(row.id)),
    comments: (document.comments as unknown as Record<string, unknown>[]).map(value => [value.id, shown(value.rowId), value.field, (value.replies as { id: string }[]).map(reply => reply.id)]),
    recovery: recovery.map(entry => entry.kind === "removed-beat" ? [shown(entry.row.id), entry.comments ?? []]
      : entry.kind === "comment-without-words" ? [entry.kind, entry.comment, entry.rowId, entry.field]
        : entry.kind === "reply-without-comment" ? [entry.kind, entry.reply, entry.commentId] : [entry.kind]) };
}

function model(handle: SharedDocumentHandle, book: IdentityBook, carets: Record<string, string>): CollabModel {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  const source = new SharedProjectionSource(handle); source.begin();
  const blocks = source.blocks().filter(block => block.kind === "b" && !block.reason && block.id !== null); source.cache.end();
  const characters = (id: string): CollabCharacter[] => (blocks.find(block => block.id === id)?.units ?? []).flatMap(unit => {
    if (typeof unit.value !== "string" || !unit.identity) return [];
    const marks = Object.fromEntries(unit.marks.filter(mark => mark.kind === "comment" && typeof mark.value === "string").map(mark => ["c:" + String(mark.value), true] as const).sort());
    return [{ identity: { client: unit.identity.client, clock: unit.identity.clock }, notation: book.notation(unit.identity), value: unit.value, marks, beat: String(shown(id)) }];
  });
  const row = (id: string) => ({ id: String(shown(id)), characters: characters(id) });
  const visible = document.rows.map(value => value.id);
  const caret = (notation: string) => {
    const wanted = book.identity(notation), at = blocks.findIndex(block => block.units.some(unit => unit.identity?.client === wanted.client && unit.identity.clock === wanted.clock));
    const owner = blocks[at]?.id ?? "";
    if (visible.includes(owner)) return { beat: String(shown(owner)), offset: characters(owner).findIndex(char => char.notation === notation) };
    return { beat: String(shown(blocks.slice(at + 1).find(block => visible.includes(block.id ?? ""))?.id)), offset: 0 };
  };
  const listed = new Set(recovery.flatMap(entry => entry.kind === "removed-beat" ? entry.comments ?? [] : entry.kind === "comment-without-words" ? [entry.comment] : []));
  const replies = new Map(readSharedRecords(handle, "replies").map(record => [record.key, record.fields]));
  return {
    rows: visible.map(row),
    carets: Object.fromEntries(Object.entries(carets).map(([name, notation]) => [name, caret(notation)])),
    recovery: recovery.flatMap(entry => entry.kind !== "removed-beat" || !entry.removal ? [] : [{ row: row(String(entry.row.id)), by: entry.removal.by,
      edited: entry.removal.edited.map(identity => book.notation(identity)), ...entry.splitBy ? { splitBy: entry.splitBy } : {} }]),
    records: {
      comments: Object.fromEntries((document.comments as unknown as Record<string, unknown>[]).map(value => [value.id, { author: value.author, createdAt: value.createdAt,
        text: value.body, rowId: shown(value.rowId), field: value.field, recovery: listed.has(String(value.id)),
        replies: (value.replies as Record<string, unknown>[]).map(reply => ({ id: reply.id, commentId: value.id, author: reply.author, createdAt: reply.createdAt, text: reply.body })) }])),
      recoveryReplies: recovery.flatMap(entry => {
        if (entry.kind !== "reply-without-comment") return [];
        const fields = replies.get(entry.reply) ?? {};
        return [{ id: fields.id, commentId: fields.commentId, author: fields.author, createdAt: fields.createdAt, text: fields.text }];
      })
    }
  };
}

for (const order of ["D1", "D2", "D3", "dup", "rev"] as const) test(`T11 removed/split and restored: comment records follow their words into recovery and back on every copy and a late joiner: ${order}`, () => {
  const { set, handles } = setup(t11), book = new IdentityBook();
  try {
    send(set.a, ...t11Records()); set.queue.flush("D1");
    const { projector } = captureIncrementalReplica(set.c);
    for (const [segment, names] of [["b:R1", ["s1", "s2", "s3", "s4"]], ["b:R2", ["s5", "s6"]]] as const) names.forEach((name, offset) => {
      const identity = Y.createRelativePositionFromTypeIndex(nativeText(set.a, segment), offset).item; assert.ok(identity); book.bind(name, identity);
    });
    const carets = { A: "s1", B: "s3" };
    const read = (expected: typeof commentsRemovedOracle) => (handle: SharedDocumentHandle) => { const value = model(handle, book, carets); checkModel(value, expected, book, order); return value; };
    send(set.a, remove("R1")); send(set.b, split); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("T11 removed/split", order, handles, read(commentsRemovedOracle));
    assert.deepEqual(summary(set.a).recovery, [["R1", ["C1"]], ["Rb", ["C2"]]]);
    send(set.a, restore(REMOVAL, "Alice")); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("T11 restored", order, handles, read(commentsRestoredOracle));
  } finally { set.close(); }
});

const spanning = { rows: [{ id: "R1", audioText: span("C1", "ab") }, { id: "R2", audioText: span("C1", "cd") }, { id: "R3", audioText: "ef" }], comments: [comment("C1", "Alice")] };

for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 47, answer 1: a comment with words left in the script stays active at its first live cell: ${order}`, () => {
  const { set, handles } = setup(spanning);
  try {
    const { projector } = captureIncrementalReplica(set.c);
    send(set.a, remove("R1", "gone", "Alice", 2)); set.queue.flush(order); assertIncremental(set.c, projector);
    const expected = { rows: ["R2", "R3"], comments: [["C1", "R2", "audioText", []]], recovery: [["R1", []]] };
    agree("half live", order, handles, summary, expected);
    send(set.c, restore(REMOVAL)); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("restored", order, handles, summary, { rows: ["R1", "R2", "R3"], comments: [["C1", "R1", "audioText", []]], recovery: [] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 47, answer 3: words in two removed beats that share no removal list the comment under the first only, and either restore anchors it there: ${order}`, () => {
  const { set, handles } = setup(spanning);
  try {
    const { projector } = captureIncrementalReplica(set.c);
    send(set.a, remove("R1", "gone", "Alice", 2)); send(set.b, remove("R2", "gone2", "Bob", 2)); set.queue.flush(order); assertIncremental(set.c, projector);
    const both = { rows: ["R3"], comments: [["C1", "R1", "audioText", []]], recovery: [["R1", ["C1"]], ["R2", []]] };
    agree("two removals", order, handles, summary, both);
    send(set.c, restore(OTHER)); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("second restored", order, handles, summary, { rows: ["R2", "R3"], comments: [["C1", "R2", "audioText", []]], recovery: [["R1", []]] });
    send(set.c, restore(REMOVAL)); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("both restored", order, handles, summary, { rows: ["R1", "R2", "R3"], comments: [["C1", "R1", "audioText", []]], recovery: [] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 47, answers 6 and 8: a comment and a reply from a writer who had not seen the removal travel with the beat, resolved comments too, and nothing is edited: ${order}`, () => {
  const { set, handles } = setup(t11);
  try {
    send(set.a, ...t11Records({ resolution: { resolved: true, resolvedAt: "2026-11-12", resolvedBy: "Bob" } })); set.queue.flush("D1");
    const { projector } = captureIncrementalReplica(set.c);
    send(set.a, remove("R1"));
    send(set.b, createRecord("replies", '["C1","r2"]', { id: "r2", commentId: "C1", createdAt: 0, text: "" }, "Bob"),
      createRecord("comments", "C3", { anchorId: "C3", rowId: "R1", field: "audioText", createdAt: 0, text: "" }, "Bob"),
      { kind: "mark", id: "note", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" }, observed: [flowBaseReference("R1", "audioText", 0, 1)], mark: { kind: "comment", id: "C3", value: true } });
    set.queue.flush(order); assertIncremental(set.c, projector);
    const read = (handle: SharedDocumentHandle) => ({ ...summary(handle), edited: projectSharedDocumentWithRecovery(handle).recovery.flatMap(entry => entry.kind === "removed-beat" ? entry.removal?.edited ?? [] : []),
      resolved: (projectSharedDocumentWithRecovery(handle).document.comments as unknown as Record<string, unknown>[]).filter(value => value.resolved === true).map(value => value.id) });
    const expected = { rows: ["R2"], comments: [["C1", "R1", "audioText", ["r1", "r2"]], ["C2", "R1", "audioText", []], ["C3", "R1", "audioText", []]],
      recovery: [["R1", ["C1", "C2", "C3"]]], edited: [], resolved: ["C2"] };
    agree("unseen comment and reply", order, handles, read, expected);
    send(set.c, restore(REMOVAL)); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("restored", order, handles, read, { ...expected, rows: ["R1", "R2"], recovery: [] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`a comment whose words are gone is listed at its stored place, comments with no text anchor never are, and a reply without its comment is listed until the comment returns: ${order}`, () => {
  const source = { rows: [{ id: "R1", audioText: "a" + span("C1", "b") }, { id: "R2", audioText: "cd" }],
    comments: [comment("C1", "Alice", { replies: [{ id: "r1", author: "Bob", body: "", createdAt: 0 }] }), comment("C9", "Bob", { rowId: "R2", field: "visualText" }),
      { id: "K1", kind: "conflict", conflictField: "audioText", rowId: "R1", field: "audioText", author: "Alice", body: "", createdAt: 0 },
      { id: "T1", rowId: null, field: "title", author: "Alice", body: "", createdAt: 0 }] };
  const { set, handles } = setup(source);
  try {
    const { projector } = captureIncrementalReplica(set.c);
    const gone = ["comment-without-words", "C9", "R2", "visualText"];
    agree("stored place", order, handles, summary, { rows: ["R1", "R2"], comments: [["C1", "R1", "audioText", ["r1"]], ["C9", "R2", "visualText", []], ["K1", "R1", "audioText", []], ["T1", null, "title", []]],
      recovery: [gone] });
    send(set.a, deleteRecord("comments", "C1")); set.queue.flush(order); assertIncremental(set.c, projector);
    const orphan = { rows: ["R1", "R2"], comments: [["C9", "R2", "visualText", []], ["K1", "R1", "audioText", []], ["T1", null, "title", []]],
      recovery: [gone, ["reply-without-comment", '["C1","r1"]', "C1"]] };
    agree("reply without comment", order, handles, summary, orphan);
    send(set.a, createRecord("comments", "C1", { anchorId: "C1", rowId: "R2", field: "audioText", createdAt: 0, text: "" }, "Alice", "again")); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("comment back", order, handles, summary, { rows: ["R1", "R2"], comments: [["C1", "R1", "audioText", ["r1"]], ["C9", "R2", "visualText", []], ["K1", "R1", "audioText", []], ["T1", null, "title", []]],
      recovery: [gone] });
  } finally { set.close(); }
});
