import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addReplyCommand, deleteCommentCommand, toggleResolveCommand, unwrapCommentAnchorCommand } from "../../../src/application/commands/comments.ts";
import type { SharedCommentPorts } from "../../../src/application/commands/comments.ts";
import type { RewritePlanner } from "../../../src/application/commands/document-edit.ts";
import type { Command } from "../../../src/application/session/document-session.ts";
import { sharedCommentPorts } from "../../../src/bootstrap/wiring/ports/shared-comments.ts";
import { sharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { sharedUndoOwner } from "../../../src/bootstrap/wiring/ports/shared-undo.ts";
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
import { sharedCommentMarkRemovals, sharedCommentRewriteRefused } from "../../../src/core/collab/comment-mark-operations.ts";
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
const TOKEN = '<span class="broll-key" data-broll-id="S1" contenteditable="false">B-roll:</span>';
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
    const found = doc.rows.find(r => r.id === rowId);
    if (!found) return [];
    const box = document.createElement("div");
    box.innerHTML = String(found[field] ?? "");
    const span = box.querySelector('.cmt-anchor[data-cmt="' + id + '"]');
    if (!span) return [];
    span.replaceWith(...span.childNodes);
    return [{ rowId, field, html: box.innerHTML }];
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
  { name: "unwrap a comment's anchor", make: s => unwrapCommentAnchorCommand(unwrapping("R1", "audioText", "C1"), s && { ports: s, anchor: "C1" }),
    operations: [mark(0, "audioText", "C1", 1, 3)],
    after: { audio: "abcd" }, recovery: [{ kind: "comment-without-words", comment: "C1", rowId: "R1", field: "audioText" }] }
];

function setup(source: Record<string, unknown> = SOURCE) {
  const set = replicas(2, source);
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
  assert.equal(unwrapCommentAnchorCommand(unwrapping("R1", "audioText", "C9"), { ports: counting, anchor: "C9" }).plan(live, capabilities()), null);
  assert.equal(asked, 0);
  const nobody: SharedCommentPorts = { author: () => null, cells };
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
    assert.deepEqual(a.session.run(unwrapCommentAnchorCommand(rewrite, { ports: ports(h.a, "Alice"), anchor: "C1" })), { kind: "rejected", reason: "comment-unwrap-rewrite" });
    assert.deepEqual(a.session.run(deleteCommentCommand("C1", () => [{ rowId: "R1", field: "audioText", html: "<b>abcd</b>" }], ports(h.a, "Alice"))), { kind: "rejected", reason: "comment-unwrap-rewrite" });
    assert.deepEqual(a.session.run(deleteCommentCommand("C1", () => [{ rowId: "R1", field: "title", html: "abcd" }], ports(h.a, "Alice"))), { kind: "rejected", reason: "comment-unwrap-rewrite" });
    assert.deepEqual(a.session.run(deleteCommentCommand("C1", () => [{ rowId: "R9", field: "audioText", html: "abcd" }], ports(h.a, "Alice"))), { kind: "rejected", reason: "comment-unwrap-rewrite" });
    assert.deepEqual(a.session.run(deleteCommentCommand("C1", () => [{ rowId: "R1", field: "visualText", html: "xyz" }], ports(h.a, "Alice"))), { kind: "rejected", reason: "comment-unwrap-rewrite" });
    assert.deepEqual(a.executed, []);
    assert.deepEqual(encodeSharedState(h.a), before);
  } finally { a.session.dispose(); h.close(); }
});

test("comment mark removals cover every span of the comment's mark in every cell and no other comment's mark", () => {
  const removal = (owner: string, field: "audioText" | "visualText", spans: readonly [number, number][]) => ({ kind: "mark", target: { owner, segment: owner, field },
    observed: spans.map(([from, to]) => flowBaseReference(owner, field, from, to)), mark: { kind: "comment", id: "C1", value: null } });
  assert.deepEqual(sharedCommentMarkRemovals("C1", [
    { owner: "R1", field: "audioText", runs: cells(anchor("C1", "ab") + "c" + anchor("C1", "d")) },
    { owner: "R1", field: "visualText", runs: cells(anchor("C2", "x")) },
    { owner: "R3", field: "audioText", runs: cells("a" + anchor("C0", "b" + anchor("C1", "c")) + anchor("C1", "d") + TOKEN + anchor("C1", TOKEN)) }
  ]), [removal("R1", "audioText", [[0, 2], [3, 4]]), removal("R3", "audioText", [[2, 4], [5, 6]])]);
  assert.deepEqual(sharedCommentMarkRemovals("C1", [{ owner: "R1", field: "audioText", runs: cells("ab") }]), []);
});

test("an unwrap rewrite may only take away the comment's own marks, on words and on tokens", () => {
  const refused = (before: string, after: string) => sharedCommentRewriteRefused("C1", [{ owner: "R1", field: "audioText", before: cells(before), after: cells(after) }]);
  assert.equal(refused(anchor("C1", "ab") + "c" + anchor("C1", "d"), "abc" + anchor("C1", "d")), false);
  assert.equal(refused(anchor("C1", TOKEN + "b"), TOKEN + "b"), false);
  assert.equal(refused(anchor("C1", "a" + TOKEN + "b"), "a" + TOKEN + "b"), false);
  assert.equal(refused(anchor("C1", "ab" + TOKEN), "ab" + TOKEN), false);
  assert.equal(refused(anchor("C1", "ab"), "ab "), true);
  assert.equal(refused(anchor("C1", "ab"), "aB"), true);
  assert.equal(refused("ab", anchor("C1", "ab")), true);
  assert.equal(refused(anchor("C2", "ab"), "ab"), true);
  assert.equal(refused(anchor("C1", TOKEN), '<span class="broll-key" data-broll-id="S2" contenteditable="false">B-roll:</span>'), true);
});

const comment = (id: string, quotedText: string, createdAt: string, replies: readonly Fields[] = []) => ({ id, author: "Ann", createdAt, rowId: "R1", field: "audioText", anchorId: id,
  body: "note", quotedText, resolved: false, resolvedAt: null, resolvedBy: null, replies });
const splitAt = (id: string, owner: string, offset: number, beat: string) => ({ kind: "split", id, by: "Bob", target: { owner, segment: owner, field: "audioText" },
  at: { left: flowBaseReference("R1", "audioText", offset), right: null, affinity: "after" }, observed: [], boundary: beat, beat, fields: {} });
const JOIN = { kind: "join", id: "joined", by: "Bob", from: "R2", into: "R1", glue: " " };
interface Scenario { readonly name: string; readonly source: Record<string, unknown>; readonly prep: readonly unknown[]; readonly make: (shared: SharedCommentPorts | undefined) => Command }
const deleting = (s: SharedCommentPorts | undefined) => deleteCommentCommand("C1", unwrapping("R1", "audioText", "C1"), s);
const unwrapC1 = (s: SharedCommentPorts | undefined) => unwrapCommentAnchorCommand(unwrapping("R1", "audioText", "C1"), s && { ports: s, anchor: "C1" });
const single = (audio: string, r2 = "ef") => ({ rows: [{ id: "R1", audioText: audio }, { id: "R2", audioText: r2 }], comments: [comment("C1", "bc", at(0), [REPLY])] });
const scenarios: readonly Scenario[] = [
  { name: "delete after a split between the anchor's words", source: SOURCE, prep: [splitAt("cut", "R1", 1, "Rb")], make: deleting },
  { name: "unwrap after a split between the anchor's words", source: SOURCE, prep: [splitAt("cut", "R1", 1, "Rb")], make: unwrapC1 },
  { name: "delete one of two overlapping anchors", source: { rows: [{ id: "R1", audioText: "a" + anchor("C0", "b" + anchor("C1", "c")) + anchor("C1", "d") }, { id: "R2", audioText: "ef" }],
    comments: [comment("C0", "bc", at(3)), comment("C1", "cd", at(0))] }, prep: [], make: deleting },
  { name: "delete an anchor in three fragments across two splits", source: single("a" + anchor("C1", "bcd") + "e"),
    prep: [splitAt("cut", "R1", 1, "Rb"), splitAt("cut2", "structure_2_006300750074_beat_0", 2, "Rc")], make: deleting },
  { name: "delete an anchor with a fragment in a joined beat", source: single("a" + anchor("C1", "bc") + "d", anchor("C1", "e") + "f"), prep: [JOIN], make: deleting },
  { name: "delete an anchor that starts with a B-roll token", source: single("a" + anchor("C1", TOKEN + "bc") + "d"), prep: [], make: deleting },
  { name: "delete an anchor with a B-roll token inside", source: single("a" + anchor("C1", "b" + TOKEN + "c") + "d"), prep: [], make: deleting },
  { name: "delete an anchor that ends with a B-roll token", source: single("a" + anchor("C1", "bc" + TOKEN) + "d"), prep: [], make: deleting },
  { name: "unwrap an anchor with a B-roll token inside", source: single("a" + anchor("C1", "b" + TOKEN + "c") + "d"), prep: [], make: unwrapC1 }
];

const SPLIT = "structure_2_006300750074_beat_0", SPLIT2 = "structure_2_0063007500740032_beat_0";
const split = (id: string, audio: string) => ({ id, status: "todo", visualText: "", audioText: audio, imageRef: null });
const docOf = (rows: readonly Fields[], comments: readonly Fields[]) => ({ schema: 2, title: "", docId: "d00000000000000000000000000000000", rows, comments,
  people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 });
const markOn = (index: number, owner: string, spans: readonly [number, number][]) => ({ kind: "mark", target: { owner, segment: owner, field: "audioText" },
  observed: spans.map(([from, to]) => flowBaseReference(owner, "audioText", from, to)), mark: { kind: "comment", id: "C1", value: null }, id: "w1_1:" + index, by: "Alice" });
const DELETES = [remove(0, "replies", "[\"C1\",\"r1\"]"), remove(1, "comments", "C1")];
const C0 = { ...C1, id: "C0", anchorId: "C0", createdAt: at(3), updatedAt: at(3), replies: [] };
const R2 = row("R2", { audioText: "ef" });
const WITHOUT_WORDS = [{ kind: "comment-without-words", comment: "C1", rowId: "R1", field: "audioText" }];
const EXPECTED: Readonly<Record<string, { readonly operations: readonly unknown[]; readonly document: Fields; readonly recovery: readonly unknown[] }>> = {
  "delete after a split between the anchor's words": { operations: [markOn(0, "R1", [[1, 2]]), markOn(1, SPLIT, [[0, 1]]), ...DELETES],
    document: docOf([row("R1", { audioText: "ab", visualText: R1_VISUAL }), split(SPLIT, "cd"), R2], [C2]), recovery: [] },
  "unwrap after a split between the anchor's words": { operations: [markOn(0, "R1", [[1, 2]]), markOn(1, SPLIT, [[0, 1]])],
    document: docOf([row("R1", { audioText: "ab", visualText: R1_VISUAL }), split(SPLIT, "cd"), R2], [C1, C2]), recovery: WITHOUT_WORDS },
  "delete one of two overlapping anchors": { operations: [markOn(0, "R1", [[2, 4]]), remove(0, "comments", "C1")],
    document: docOf([row("R1", { audioText: "a" + anchor("C0", "bc") + "d" }), R2], [C0]), recovery: [] },
  "delete an anchor in three fragments across two splits": { operations: [markOn(0, "R1", [[1, 2]]), markOn(1, SPLIT, [[0, 1]]), markOn(2, SPLIT2, [[0, 1]]), ...DELETES],
    document: docOf([row("R1", { audioText: "ab" }), split(SPLIT, "c"), split(SPLIT2, "de"), R2], []), recovery: [] },
  "delete an anchor with a fragment in a joined beat": { operations: [{ ...markOn(0, "R1", [[1, 3]]), observed: [flowBaseReference("R1", "audioText", 1, 3), flowBaseReference("R1", "audioText", 5, 6)] }, ...DELETES],
    document: docOf([row("R1", { audioText: "abcd ef" })], []), recovery: [] },
  "delete an anchor that starts with a B-roll token": { operations: [markOn(0, "R1", [[1, 4]]), ...DELETES],
    document: docOf([row("R1", { audioText: "a" + TOKEN + "bcd" }), R2], []), recovery: [] },
  "delete an anchor with a B-roll token inside": { operations: [markOn(0, "R1", [[1, 4]]), ...DELETES],
    document: docOf([row("R1", { audioText: "ab" + TOKEN + "cd" }), R2], []), recovery: [] },
  "delete an anchor that ends with a B-roll token": { operations: [markOn(0, "R1", [[1, 4]]), ...DELETES],
    document: docOf([row("R1", { audioText: "abc" + TOKEN + "d" }), R2], []), recovery: [] },
  "unwrap an anchor with a B-roll token inside": { operations: [markOn(0, "R1", [[1, 4]])],
    document: docOf([row("R1", { audioText: "ab" + TOKEN + "cd" }), R2], [C1]), recovery: WITHOUT_WORDS }
};

function owned(handle: SharedDocumentHandle) {
  const author = sharedAuthorPort({ handle: () => handle, name: () => "Alice" });
  const owner = sharedUndoOwner(handle, () => author.next(), () => 0, error => { throw error; });
  return { owner, harness: sharedHarness(adapterReplica(handle, owner)), ports: { author: () => author.next(), cells } };
}

for (const scenario of scenarios) for (const order of ORDERS) {
  test(`shared comment command removes every fragment of the comment's mark: ${scenario.name}, ${order}; undo puts every fragment back`, () => {
    const h = setup(scenario.source), { owner, harness, ports: shared } = owned(h.a), expected = EXPECTED[scenario.name];
    assert.ok(expected);
    try {
      if (scenario.prep.length) send(h.b, ...scenario.prep);
      flush(h.queue, order);
      const before = agreeing("before", [h.a, h.b], order);
      assert.equal(harness.session.run(scenario.make(shared)).kind, "applied");
      assert.deepEqual(harness.executed.map(entry => entry.operations), [expected.operations]);
      flush(h.queue, order);
      assert.deepEqual(agreeing(scenario.name, [h.a, h.b], order), { document: expected.document, recovery: expected.recovery });
      assert.deepEqual(owner.sizes().undo, 1);
      assert.ok(owner.undo().ok);
      flush(h.queue, order);
      assert.deepEqual(agreeing("undone", [h.a, h.b], order), before);
      assert.ok(owner.redo().ok);
      flush(h.queue, order);
      assert.deepEqual(agreeing("redone", [h.a, h.b], order), { document: expected.document, recovery: expected.recovery });
    } finally { harness.session.dispose(); h.close(); }
  });
}

for (const literal of cases) test(`shared comment command records one owner undo entry, and undo through the owner restores the document: ${literal.name}`, () => {
  const h = setup(), { owner, harness, ports: shared } = owned(h.a);
  try {
    assert.equal(harness.session.run(literal.make(shared)).kind, "applied");
    assert.deepEqual(owner.sizes().undo, 1);
    assert.ok(owner.undo().ok);
    flush(h.queue, "D1");
    assert.deepEqual(agreeing(literal.name, [h.a, h.b]), { document: documentWith({}), recovery: [] });
  } finally { harness.session.dispose(); h.close(); }
});
