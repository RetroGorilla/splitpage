import { test } from "node:test";
import assert from "node:assert/strict";
import { addReplyCommand, deleteCommentCommand, toggleResolveCommand, unwrapCommentAnchorCommand } from "../../../src/application/commands/comments.ts";
import type { SharedCommentPorts } from "../../../src/application/commands/comments.ts";
import type { RewritePlanner } from "../../../src/application/commands/document-edit.ts";
import type { Command } from "../../../src/application/session/document-session.ts";
import { sharedCommentPorts } from "../../../src/bootstrap/wiring/ports/shared-comments.ts";
import { sharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { createSharedDocument, applySharedUpdate, destroySharedDocument, encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import { sharedCommentMarkRemovals } from "../../../src/core/collab/comment-mark-operations.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { replicas, operation } from "../../adapters/collab/executor-support.ts";
import { sharedHarness, adapterReplica } from "../session/shared-session-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { bufferStamps } from "../../collab/buffer-readers.ts";

type Fields = Record<string, unknown>;
type Who = "Alice" | "Bob";
const ORDERS = ["D1", "rev", "dup"] as const;
const cells = createFlowLoadRuntime().cells;
const anchor = (id: string, text: string) => '<span class="cmt-anchor" data-cmt="' + id + '">' + text + "</span>";
const at = (second: number) => "2026-11-13T10:00:0" + second + ".000Z";
const R1_AUDIO = "a" + anchor("C1", "bc") + "d", R1_VISUAL = "x" + anchor("C2", "yz");
const REPLY = { id: "r1", author: "Bob", body: "ok", createdAt: at(1) };
const C1 = { id: "C1", rowId: "R1", field: "audioText", anchorId: "C1", quotedText: "bc", author: "Ann", body: "note", resolved: false, resolvedBy: null, resolvedAt: null,
  assignee: "", createdAt: at(0), updatedAt: at(0), kind: "anchor", replies: [REPLY] };
const C2 = { id: "C2", rowId: "R1", field: "visualText", anchorId: "C2", quotedText: "yz", author: "Ann", body: "pic", resolved: false, resolvedBy: null, resolvedAt: null,
  assignee: "", createdAt: at(2), updatedAt: at(2), kind: "anchor", replies: [] };
const SOURCE = {
  rows: [{ id: "R1", audioText: R1_AUDIO, visualText: R1_VISUAL }, { id: "R2", audioText: "ef" }],
  comments: [
    { id: "C1", author: "Ann", createdAt: at(0), rowId: "R1", field: "audioText", anchorId: "C1", body: "note", quotedText: "bc", resolved: false, resolvedAt: null, resolvedBy: null, replies: [REPLY] },
    { id: "C2", author: "Ann", createdAt: at(2), rowId: "R1", field: "visualText", anchorId: "C2", body: "pic", quotedText: "yz", resolved: false, resolvedAt: null, resolvedBy: null }
  ]
};

function row(id: string, fields: Fields): Fields {
  return { id, status: "todo", visualText: "", imageRef: null, updatedAt: "", updatedBy: null, ...fields };
}
interface Shape { readonly audio?: string; readonly visual?: string; readonly comments?: readonly Fields[]; readonly gone?: boolean }
function documentWith(shape: Shape): Fields {
  const r1 = row("R1", { visualText: shape.visual ?? R1_VISUAL, audioText: shape.audio ?? R1_AUDIO });
  return { schema: 2, title: "", docId: "d00000000000000000000000000000000", rows: [...shape.gone ? [] : [r1], row("R2", { audioText: "ef" })],
    comments: shape.comments ?? [C1, C2], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 };
}

function unwrapping(rowId: string, field: string, id: string): RewritePlanner {
  return function (doc) {
    const found = doc.rows.find(r => r.id === rowId), html = String(found?.[field] ?? ""), wrapped = anchor(id, "");
    const start = html.indexOf(wrapped.slice(0, -7));
    if (start === -1) return [];
    const close = html.indexOf("</span>", start), open = html.indexOf(">", start) + 1;
    return [{ rowId, field, html: html.slice(0, start) + html.slice(open, close) + html.slice(close + 7) }];
  };
}

const mark = (index: number, field: string, id: string, from: number, to: number) => ({ kind: "mark", target: { owner: "R1", segment: "R1", field },
  observed: [flowBaseReference("R1", field as "audioText", from, to)], mark: { kind: "comment", id, value: null }, id: "w1_1:" + index, by: "Alice" });
const remove = (index: number, collection: string, record: string) => ({ kind: "record-delete", id: "w1_1:delete:" + index, by: "Alice", target: { collection, record } });

interface CommentLiteral {
  readonly name: string;
  readonly make: (shared: SharedCommentPorts | undefined) => Command;
  readonly operations: readonly unknown[];
  readonly after: Shape;
  readonly recovery: readonly unknown[];
}

const cases: readonly CommentLiteral[] = [
  { name: "delete a comment with a reply", make: s => deleteCommentCommand("C1", unwrapping("R1", "audioText", "C1"), s),
    operations: [mark(0, "audioText", "C1", 1, 3), remove(0, "replies", "[\"C1\",\"r1\"]"), remove(1, "comments", "C1")],
    after: { audio: "abcd", comments: [C2] }, recovery: [] },
  { name: "delete a comment anchored in a visual cell", make: s => deleteCommentCommand("C2", unwrapping("R1", "visualText", "C2"), s),
    operations: [mark(0, "visualText", "C2", 1, 3), remove(0, "comments", "C2")],
    after: { visual: "xyz", comments: [C1] }, recovery: [] },
  { name: "unwrap a comment's anchor", make: s => unwrapCommentAnchorCommand(unwrapping("R1", "audioText", "C1"), s),
    operations: [mark(0, "audioText", "C1", 1, 3)],
    after: { audio: "abcd" }, recovery: [{ kind: "comment-without-words", comment: "C1", rowId: "R1", field: "audioText" }] }
];

function setup() {
  const set = replicas(2, SOURCE);
  for (const handle of [set.a, set.b, set.c]) registerSharedOperationFamilies(handle, { cells: createFlowLoadRuntime().cells });
  return set;
}
function ports(handle: SharedDocumentHandle, name: Who): SharedCommentPorts {
  const author = sharedAuthorPort({ handle: () => handle, name: () => name });
  const shared = sharedCommentPorts({ handle: () => handle, author: () => author.next(), cells })();
  assert.ok(shared);
  return shared;
}
function project(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { document, recovery: recovery.map(entry => entry.kind === "removed-beat" ? { removed: entry.row } : entry) };
}
function late(handle: SharedDocumentHandle) {
  const joiner = createSharedDocument();
  try { assert.equal(applySharedUpdate(joiner, encodeSharedState(handle)).ok, true); return project(joiner); } finally { destroySharedDocument(joiner); }
}
function agreeing(label: string, handles: readonly SharedDocumentHandle[], order: typeof ORDERS[number] = "D1") {
  const readings = handles.map((handle, index) => ({ order, replica: index ? "B" as const : "A" as const, output: project(handle) }));
  assertReplicasAgree(label, [...readings, { order: "late-C", replica: "C", output: late(handles[0] as SharedDocumentHandle) }]);
  return readings[0]?.output;
}
function flush(queue: ReturnType<typeof replicas>["queue"], order: typeof ORDERS[number]) {
  for (let round = 0; round < 100 && queue.pending.length; round++) {
    const messages = [...queue.pending];
    if (order === "rev") messages.reverse();
    for (const message of messages) queue.deliver(message.id, order === "dup" ? 2 : 1);
  }
  assert.equal(queue.pending.length, 0);
}
function send(handle: SharedDocumentHandle, ...values: unknown[]) {
  assert.deepEqual(executeSharedOperations(handle, values.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
function typing(offset: number) {
  return { kind: "text-insert", id: "typed", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" },
    at: { left: null, right: flowBaseReference("R1", "audioText", offset), affinity: "before" }, content: [{ value: "X", marks: [] }] };
}
function removal() {
  return { kind: "remove", id: "removed", by: "Bob", removalKind: "beat", targets: ["R1"], observed: [flowBaseReference("R1", "audioText", 0, 4)],
    boundaries: ["R1"], components: [], gallery: [], at: 0 };
}
const capabilities = () => createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
function standalone(before: Fields, command: Command): Fields {
  const live: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...structuredClone(before) };
  const plan = command.plan(live, capabilities());
  assert.ok(plan && !("refused" in plan) && plan.shared === undefined);
  plan.apply(live);
  return live as unknown as Fields;
}

for (const literal of cases) test(`shared comment command literal: ${literal.name}`, () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  try {
    const before = project(h.a).document;
    assert.deepEqual(before, documentWith({}));
    assert.equal(a.session.run(literal.make(ports(h.a, "Alice"))).kind, "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), [literal.operations]);
    flush(h.queue, "D1");
    const expected = documentWith(literal.after);
    assert.deepEqual(agreeing(literal.name, [h.a, h.b]), { document: expected, recovery: literal.recovery });
    assert.deepEqual(a.session.read(doc => doc), expected);
    assert.deepEqual(b.session.read(doc => doc), expected);
    assert.deepEqual(standalone(before, literal.make(undefined)), expected);
  } finally { a.session.dispose(); b.session.dispose(); h.close(); }
});

for (const literal of cases) for (const order of ORDERS) {
  test(`shared comment command races typing in its beat: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      assert.equal(a.session.run(literal.make(ports(h.a, "Alice"))).kind, "applied");
      send(h.b, typing(0));
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order),
        { document: documentWith({ ...literal.after, audio: "X" + (literal.after.audio ?? R1_AUDIO) }), recovery: literal.recovery });
    } finally { a.session.dispose(); h.close(); }
  });
  test(`shared comment command races removal of its beat: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      assert.equal(a.session.run(literal.make(ports(h.a, "Alice"))).kind, "applied");
      send(h.b, removal());
      flush(h.queue, order);
      const removed = row("R1", { audioText: literal.after.audio ?? R1_AUDIO, visualText: literal.after.visual ?? R1_VISUAL });
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order),
        { document: documentWith({ ...literal.after, gone: true }), recovery: [{ removed }, ...literal.recovery] });
    } finally { a.session.dispose(); h.close(); }
  });
  test(`shared comment command races the same command from the other copy: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
    try {
      assert.equal(a.session.run(literal.make(ports(h.a, "Alice"))).kind, "applied");
      assert.equal(b.session.run(literal.make(ports(h.b, "Bob"))).kind, "applied");
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), { document: documentWith(literal.after), recovery: literal.recovery });
    } finally { a.session.dispose(); b.session.dispose(); h.close(); }
  });
}

for (const literal of cases) test(`shared comment command as one list equals separate lists: ${literal.name}`, () => {
  const together = setup(), apart = setup();
  try {
    send(together.a, ...literal.operations);
    for (const value of literal.operations) send(apart.a, value);
    const expected = { document: documentWith(literal.after), recovery: literal.recovery };
    assert.deepEqual(project(together.a), expected);
    assert.deepEqual(project(apart.a), expected);
  } finally { together.close(); apart.close(); }
});

for (const literal of cases) test(`shared comment command undo and redo: ${literal.name}`, () => {
  const h = setup();
  try {
    const execution = executeSharedCommand(h.a, literal.operations.map(operation) as SharedOperation[], { label: literal.name, selection: null, typing: null }, { base: readSharedRevision(h.a) });
    assert.deepEqual(execution.result, { ok: true });
    assert.ok(execution.record);
    let count = 0;
    const undone = reverseSharedUndoRecord(h.a, execution.record, { by: "Alice", nextId: () => "undo-" + ++count });
    assert.ok(undone.ok, JSON.stringify(undone));
    flush(h.queue, "D1");
    assert.deepEqual(agreeing(literal.name, [h.a, h.b]), { document: documentWith({}), recovery: [] });
    assert.ok(undone.inverse);
    const redone = reverseSharedUndoRecord(h.a, undone.inverse, { by: "Alice", nextId: () => "redo-" + ++count });
    assert.ok(redone.ok, JSON.stringify(redone));
    flush(h.queue, "D1");
    assert.deepEqual(agreeing(literal.name, [h.a, h.b]), { document: documentWith(literal.after), recovery: literal.recovery });
  } finally { h.close(); }
});

for (const order of ORDERS) {
  test(`deleting a comment while the other copy types inside its anchor leaves the typed letter unmarked: ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      assert.equal(a.session.run(cases[0]?.make(ports(h.a, "Alice")) as Command).kind, "applied");
      send(h.b, typing(2));
      flush(h.queue, order);
      assert.deepEqual(agreeing("inside", [h.a, h.b], order), { document: documentWith({ audio: "abXcd", comments: [C2] }), recovery: [] });
    } finally { a.session.dispose(); h.close(); }
  });
  test(`rule 49: deleting a comment while the other copy resolves it leaves no comment and no recovery: ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
    try {
      assert.equal(a.session.run(cases[0]?.make(ports(h.a, "Alice")) as Command).kind, "applied");
      assert.equal(b.session.run(toggleResolveCommand("C1", bufferStamps("Bob", () => at(5)), ports(h.b, "Bob"))).kind, "applied");
      flush(h.queue, order);
      assert.deepEqual(agreeing("resolve", [h.a, h.b], order), { document: documentWith({ audio: "abcd", comments: [C2] }), recovery: [] });
    } finally { a.session.dispose(); b.session.dispose(); h.close(); }
  });
  test(`deleting a comment while the other copy replies to it: ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
    try {
      assert.equal(a.session.run(cases[0]?.make(ports(h.a, "Alice")) as Command).kind, "applied");
      assert.equal(b.session.run(addReplyCommand("C1", { id: "r2", author: "Bob", body: "late", createdAt: at(6) }, bufferStamps("Bob", () => at(6)).clock, ports(h.b, "Bob"))).kind, "applied");
      flush(h.queue, order);
      assert.deepEqual(agreeing("reply", [h.a, h.b], order), { document: documentWith({ audio: "abcd", comments: [C2] }),
        recovery: [{ kind: "reply-without-comment", reply: "[\"C1\",\"r2\"]", commentId: "C1" }] });
    } finally { a.session.dispose(); b.session.dispose(); h.close(); }
  });
}

test("comment delete and unwrap with no author, or no shared ports, plan as before and ask no author when nothing changes", () => {
  let asked = 0;
  const counting: SharedCommentPorts = { author: () => { asked++; return { id: "w9_1", by: "Alice" }; }, cells };
  const live: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...structuredClone(documentWith({})) };
  assert.equal(deleteCommentCommand("C9", unwrapping("R1", "audioText", "C9"), counting).plan(live, capabilities()), null);
  assert.equal(unwrapCommentAnchorCommand(unwrapping("R1", "audioText", "C9"), counting).plan(live, capabilities()), null);
  assert.equal(asked, 0);
  const nobody: SharedCommentPorts = { author: () => null, cells: () => { throw new Error("no cells expected"); } };
  for (const literal of cases) {
    const plan = literal.make(nobody).plan(live, capabilities());
    assert.ok(plan && !("refused" in plan) && plan.shared === undefined, literal.name);
  }
  assert.equal(sharedCommentPorts({ handle: () => null, author: () => ({ id: "w9_1", by: "Alice" }), cells })(), null);
});

test("an unwrap rewrite that changes more than comment marks is refused by name and writes nothing", () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a));
  try {
    const before = encodeSharedState(h.a);
    const rewrite: RewritePlanner = () => [{ rowId: "R1", field: "audioText", html: "abcd!" }];
    assert.deepEqual(a.session.run(unwrapCommentAnchorCommand(rewrite, ports(h.a, "Alice"))), { kind: "rejected", reason: "comment-unwrap-rewrite" });
    assert.deepEqual(a.session.run(deleteCommentCommand("C1", () => [{ rowId: "R1", field: "audioText", html: "<b>abcd</b>" }], ports(h.a, "Alice"))), { kind: "rejected", reason: "comment-unwrap-rewrite" });
    assert.deepEqual(a.session.run(deleteCommentCommand("C1", () => [{ rowId: "R1", field: "title", html: "abcd" }], ports(h.a, "Alice"))), { kind: "rejected", reason: "comment-unwrap-rewrite" });
    assert.deepEqual(a.executed, []);
    assert.deepEqual(encodeSharedState(h.a), before);
  } finally { a.session.dispose(); h.close(); }
});

test("comment mark removals group each anchor's offsets into spans and refuse any other change", () => {
  const unwrap = (before: string, after: string) => sharedCommentMarkRemovals([{ owner: "R1", field: "audioText", before: cells(before), after: cells(after) }]);
  const removal = (id: string, spans: readonly [number, number][]) => ({ kind: "mark", target: { owner: "R1", segment: "R1", field: "audioText" },
    observed: spans.map(([from, to]) => flowBaseReference("R1", "audioText", from, to)), mark: { kind: "comment", id, value: null } });
  assert.deepEqual(unwrap(anchor("C1", "ab") + "c" + anchor("C1", "d"), "abcd"), { operations: [removal("C1", [[0, 2], [3, 4]])] });
  assert.deepEqual(unwrap(anchor("C2", "a") + anchor("C1", "b"), "ab"), { operations: [removal("C1", [[1, 2]]), removal("C2", [[0, 1]])] });
  assert.deepEqual(unwrap("ab", "ab"), { operations: [] });
  assert.deepEqual(unwrap(anchor("C1", "ab"), "ab "), { refused: "comment-unwrap-rewrite" });
  assert.deepEqual(unwrap(anchor("C1", "ab"), "aB"), { refused: "comment-unwrap-rewrite" });
  assert.deepEqual(unwrap("ab", anchor("C1", "ab")), { refused: "comment-unwrap-rewrite" });
});
