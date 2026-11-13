import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation, ref } from "./executor-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { readSharedActiveDiscards } from "../../../src/adapters/collab/discard.ts";
import { deleteRecord } from "./record-support.ts";
import { assertIncremental, captureIncrementalReplica, nativeText } from "./incremental-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { encodeSharedState, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { sharedRecoveryDiscardOperation, sharedRecoveryEntryName } from "../../../src/core/collab/recovery.ts";
import type { SharedRecoveryDiscard } from "../../../src/core/collab/operations.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const hex = (value: string) => value.split("").map(unit => unit.charCodeAt(0).toString(16).padStart(4, "0")).join("");
const native = (client: number, id: string, role: string) => "structure_" + client + "_" + hex(id) + "_" + role + "_0";
const REMOVAL = native(1, "gone", "removal");
const span = (id: string, words: string) => `<span class="cmt-anchor" data-cmt="${id}">${words}</span>`;
const comment = (id: string, extra: Record<string, unknown>) => ({ id, anchorId: id, rowId: "R1", field: "audioText", author: "Alice", body: "", createdAt: 0, ...extra });
const SOURCE = { rows: [{ id: "R1", audioText: "a" + span("C1", "b") }, { id: "R2", audioText: "cd" }],
  comments: [comment("C1", { quotedText: "b", replies: [{ id: "r1", author: "Bob", body: "", createdAt: 0 }] }), comment("C9", { rowId: "R2", quotedText: "gone" })] };
const remove = (id: string, by: string) => operation({ kind: "remove", id, by, removalKind: "beat", targets: ["R1"],
  observed: [flowBaseReference("R1", "audioText", 0, 2)], boundaries: ["R1"], components: [], gallery: [], at: 0 });
const restore = (by: string, ...removals: string[]) => operation({ kind: "restore", id: "back" + by, by, removals: removals.length ? removals : [REMOVAL] });
const writer = (by: string) => { let next = 0; return { by, nextId: () => by + "-undo-" + next++ }; };
const removeBoth = operation({ kind: "remove", id: "gone", by: "Alice", removalKind: "beat", targets: ["R1", "R2"],
  observed: [flowBaseReference("R1", "audioText", 0, 2), flowBaseReference("R2", "audioText", 0, 2)], boundaries: ["R1", "R2"], components: [], gallery: [], at: 0 });

function send(handle: SharedDocumentHandle, ...ops: ReturnType<typeof operation>[]): void {
  assert.deepEqual(executeSharedOperations(handle, ops, { base: readSharedRevision(handle) }), { ok: true });
}
function discards(handle: SharedDocumentHandle, id: string, kinds: readonly string[]): SharedRecoveryDiscard[] {
  return projectSharedDocumentWithRecovery(handle).recovery.filter(entry => kinds.includes(entry.kind))
    .flatMap((entry, index) => { const made = sharedRecoveryDiscardOperation(entry, { id: id + index, by: "Bob" }); return made ? [made] : []; });
}
function setup() {
  const set = replicas(3, SOURCE), handles = [set.a, set.b, set.c];
  for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedRecordHandlers(handle); }
  return { set, handles, projector: captureIncrementalReplica(set.c).projector };
}
function summary(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { rows: document.rows.map(row => row.id), recovery: recovery.map(entry => { const name = sharedRecoveryEntryName(entry); return name.kind + " " + name.key; }) };
}
function state(handle: SharedDocumentHandle) {
  const { discards, retiredDiscards } = collabState(handle).roots;
  return { ...summary(handle), active: readSharedActiveDiscards(discards, retiredDiscards).length, retired: retiredDiscards.size };
}
function named(handle: SharedDocumentHandle, id: string, key: string): SharedRecoveryDiscard[] {
  return projectSharedDocumentWithRecovery(handle).recovery.flatMap(entry => {
    const name = sharedRecoveryEntryName(entry), made = name.kind + " " + name.key === key ? sharedRecoveryDiscardOperation(entry, { id, by: "Bob" }) : null;
    return made ? [made] : [];
  });
}

for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 52: a discarded removed beat is hidden on every copy; undo shows it and redo hides it again: ${order}`, t => {
  const { set, handles, projector } = setup();
  try {
    send(set.a, remove("gone", "Alice")); set.queue.flush(order);
    const before = encodeSharedState(set.b).length, made = executeSharedCommand(set.b, discards(set.b, "d", ["removed-beat"]), { label: "discard", selection: null, typing: null });
    assert.deepEqual(made.result, { ok: true }); assert.ok(made.record); set.queue.flush(order); assertIncremental(set.c, projector);
    const discarded = encodeSharedState(set.b).length;
    const hidden = { rows: ["R2"], recovery: ["comment-without-words C9"] };
    agree("discarded", order, handles, summary, hidden);
    const undone = reverseSharedUndoRecord(set.b, made.record, writer("Bob"));
    assert.ok(undone.ok && undone.effective); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("discard undone", order, handles, summary, { rows: ["R2"], recovery: ["removed-beat R1", "comment-without-words C9"] });
    const redone = reverseSharedUndoRecord(set.b, undone.inverse, writer("Bob"));
    assert.ok(redone.ok && redone.effective); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("discard redone", order, handles, summary, hidden);
    t.diagnostic(JSON.stringify({ discardBytes: discarded - before, undoRedoBytes: encodeSharedState(set.b).length - discarded }));
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 52: a removal the discarder had not seen shows the beat again, and a restore made beside a discard wins: ${order}`, () => {
  const { set, handles, projector } = setup();
  try {
    send(set.c, remove("gone2", "Carol")); send(set.a, remove("gone", "Alice")); set.queue.deliverFrom("A", order);
    send(set.b, ...discards(set.b, "d", ["removed-beat"])); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("unseen removal", order, handles, summary, { rows: ["R2"], recovery: ["removed-beat R1", "comment-without-words C9"] });
    const other = replicas(3, SOURCE), copies = [other.a, other.b, other.c];
    try {
      for (const handle of copies) registerSharedRemovalHandlers(handle);
      send(other.a, remove("gone", "Alice")); other.queue.flush(order);
      send(other.b, ...discards(other.b, "d", ["removed-beat"])); send(other.c, restore("Carol")); other.queue.flush(order);
      agree("restore beside a discard", order, copies, summary, { rows: ["R1", "R2"], recovery: ["comment-without-words C9"] });
    } finally { other.close(); }
  } finally { set.close(); }
});

const REMOVAL2 = native(3, "gone2", "removal"), DISCARD = { label: "discard", selection: null, typing: null };
for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 52 as amended: a restore of a discarded removal is accepted and retires the discard; its undo removes the beats again by a new removal and leaves the discard retired, and the discard's undo is used up: ${order}`, () => {
  for (const together of [true, false]) {
    const { set, handles, projector } = setup(), label = together ? "removed together" : "second removal";
    try {
      if (together) { send(set.a, removeBoth); set.queue.flush(order); } else { send(set.c, remove("gone2", "Carol")); send(set.a, remove("gone", "Alice")); set.queue.deliverFrom("A", order); }
      const made = executeSharedCommand(set.b, named(set.b, "d", "removed-beat R1"), DISCARD);
      assert.ok(made.result.ok && made.record); set.queue.flush(order); assertIncremental(set.c, projector);
      agree(label + " discarded", order, handles, state, together ? { rows: [], recovery: ["removed-beat R2", "comment-without-words C9"], active: 1, retired: 0 }
        : { rows: ["R2"], recovery: ["removed-beat R1", "comment-without-words C9"], active: 1, retired: 0 });
      const restored = executeSharedCommand(set.c, [together ? restore("Carol") : restore("Carol", REMOVAL, REMOVAL2)], { label: "restore", selection: null, typing: null });
      assert.deepEqual(restored.result, { ok: true }); assert.ok(restored.record); set.queue.flush(order); assertIncremental(set.c, projector);
      const back = { rows: ["R1", "R2"], recovery: ["comment-without-words C9"], active: 0, retired: 1 };
      agree(label + " restored", order, handles, state, back);
      const undoRestore = reverseSharedUndoRecord(set.c, restored.record, writer("Carol"));
      assert.ok(undoRestore.ok && undoRestore.effective); set.queue.flush(order); assertIncremental(set.c, projector);
      const again = undoRestore.inverse.parts[0];
      assert.ok(again?.kind === "remove" && again.removal !== REMOVAL && again.removal !== REMOVAL2);
      const removedAgain = together ? { rows: [], recovery: ["removed-beat R1", "removed-beat R2", "comment-without-words C9"], active: 0, retired: 1 }
        : { rows: ["R2"], recovery: ["removed-beat R1", "comment-without-words C9"], active: 0, retired: 1 };
      agree(label + " restore undone", order, handles, state, removedAgain);
      const bytes = [encodeSharedState(set.b), encodeSharedState(set.c)];
      const usedUp = reverseSharedUndoRecord(set.b, made.record, writer("Bob"));
      assert.ok(usedUp.ok && !usedUp.effective); assert.deepEqual([encodeSharedState(set.b), encodeSharedState(set.c)], bytes);
      set.queue.flush(order); assertIncremental(set.c, projector);
      agree(label + " undone", order, handles, state, removedAgain);
    } finally { set.close(); }
  }
});

const TAGGED = { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }] }, RB = native(2, "cut", "beat");
function tagged(handle: SharedDocumentHandle, key: string, from: number, to: number): void {
  const address = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
  const record = prepareSharedMarkRecord(handle, address, key, from, to, { type: "add", mark: { kind: "tag", id: ref("z"), value: ref("t_gone") } });
  assert.ok(record); assert.deepEqual(writeSharedMarkRecord(handle, address, key, record), { ok: true });
}
for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 52 as amended: two parts of one tag occurrence are named by their first characters, and a split inside an occurrence lists the split-off part on its own: ${order}`, () => {
  for (const split of [false, true]) {
    const set = replicas(3, TAGGED), handles = [set.a, set.b, set.c];
    try {
      for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, createFlowLoadRuntime()); }
      if (split) tagged(set.a, "all", 0, 4); else { tagged(set.a, "p0", 0, 1); tagged(set.a, "p1", 3, 4); }
      set.queue.flush(order);
      agree("listed", order, handles, summary, { rows: ["R1", "R2"], recovery: split ? ['deleted-tag ["z","1:13"]'] : ['deleted-tag ["z","1:13"]', 'deleted-tag ["z","1:16"]'] });
      send(set.b, ...named(set.b, "d", 'deleted-tag ["z","1:13"]')); set.queue.flush(order);
      agree("first discarded", order, handles, summary, { rows: ["R1", "R2"], recovery: split ? [] : ['deleted-tag ["z","1:16"]'] });
      if (!split) continue;
      send(set.b, operation({ kind: "split", id: "cut", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" },
        at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" }, observed: [], boundary: "Rb", beat: "Rb", fields: {} }));
      set.queue.flush(order);
      agree("split inside", order, handles, summary, { rows: ["R1", RB, "R2"], recovery: ['deleted-tag ["z","1:15"]'] });
    } finally { set.close(); }
  }
});

for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 52: comments, replies and fragments are discarded by name; a fragment whose first character is deleted shows again: ${order}`, () => {
  const { set, handles, projector } = setup();
  try {
    send(set.a, operation(deleteRecord("comments", "C1")));
    transactSharedDocument(set.a, "local-command", () => {
      const roots = collabState(set.a).roots, beat = new Y.Map<unknown>(), segment = new Y.Map<unknown>();
      beat.set("id", "[]"); beat.set("segment", "empty"); roots.beats.set("[]", beat);
      segment.set("head", { b: "[]" }); segment.set("text", new Y.Text("Kept")); segment.set("markRecords", new Y.Map<unknown>());
      roots.segments.set("empty", segment); roots.order.insert(0, ["empty"]);
    }); set.queue.flush(order);
    const listed = summary(set.b).recovery;
    assert.deepEqual(listed, ['unprojectable-fragment ["empty","1:103"]', "comment-without-words C9", 'reply-without-comment ["C1","r1"]']);
    const made = executeSharedCommand(set.b, discards(set.b, "d", ["unprojectable-fragment", "comment-without-words", "reply-without-comment"]), { label: "discard", selection: null, typing: null });
    assert.ok(made.result.ok && made.record); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("all discarded", order, handles, summary, { rows: ["R1", "R2"], recovery: [] });
    transactSharedDocument(set.c, "local-command", () => nativeText(set.c, "empty").delete(0, 1)); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("fragment renamed", order, handles, summary, { rows: ["R1", "R2"], recovery: ['unprojectable-fragment ["empty","1:104"]'] });
    const undone = reverseSharedUndoRecord(set.b, made.record, writer("Bob")); assert.ok(undone.ok); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("discards undone", order, handles, summary, { rows: ["R1", "R2"], recovery: ['unprojectable-fragment ["empty","1:104"]', "comment-without-words C9", 'reply-without-comment ["C1","r1"]'] });
  } finally { set.close(); }
});

test("assumed rule 52 as amended: seeded discards, undos, redos and restores by any copy agree with a counting model on every copy and a late joiner", t => {
  let seed = 0x52d1, steps = 0;
  const ran = { discard: 0, undo: 0, redo: 0, restored: 0 };
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
  for (let sample = 0; sample < 8; sample++) for (const order of ["D1", "rev", "dup"] as const) {
    const { set, handles, projector } = setup(), undo = handles.map((): SharedUndoRecord[] => []), redo = handles.map((): SharedUndoRecord[] => []);
    let active = 0, removal = "gone";
    try {
      send(set.a, remove(removal, "Alice")); set.queue.flush(order);
      for (let step = 0; step < 12; step++, steps++) {
        const actor = random(2), handle = handles[actor], action = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3][random(10)]; assert.ok(handle);
        if (action === 0 && active === 0) {
          const made = executeSharedCommand(handle, discards(handle, "d" + steps, ["removed-beat"]), { label: "discard", selection: null, typing: null });
          assert.ok(made.result.ok && made.record); undo[actor]?.push(made.record); redo[actor]?.splice(0); active++; ran.discard++;
        } else if (action === 1 || action === 2) {
          const record = (action === 1 ? undo : redo)[actor]?.pop();
          if (record) { const done = reverseSharedUndoRecord(handle, record, writer("W" + actor + steps)); assert.equal(done.ok ? null : done.reason, null); if (!done.ok) break; (action === 1 ? redo : undo)[actor]?.push(done.inverse); active += action === 1 ? -1 : 1; ran[action === 1 ? "undo" : "redo"]++; }
        } else if (action === 3) {
          const result = executeSharedOperations(handle, [restore("W" + actor + steps, native(1, removal, "removal"))], { base: readSharedRevision(handle) });
          assert.deepEqual(result.ok ? "restored" : result.reason, "restored"); ran.restored++; set.queue.flush(order); assertIncremental(set.c, projector);
          agree("seed=" + seed, order, handles, handle => ({ ...state(handle), retired: null }), { rows: ["R1", "R2"], recovery: ["comment-without-words C9"], active: 0, retired: null });
          // why: the restore used up every discard record held for undo, so the history starts again on a fresh removal.
          for (const stack of [...undo, ...redo]) stack.splice(0);
          active = 0; removal = "gone" + steps; send(set.a, remove(removal, "Alice"));
        }
        set.queue.flush(order); assertIncremental(set.c, projector);
        agree("seed=" + seed, order, handles, summary, { rows: ["R2"], recovery: [...active ? [] : ["removed-beat R1"], "comment-without-words C9"] });
      }
    } finally { set.close(); }
  }
  assert.deepEqual({ steps, ...ran }, { steps: 288, discard: 45, undo: 21, redo: 6, restored: 45 });
  t.diagnostic(JSON.stringify({ seed: "0x52d1", histories: 24, steps, ...ran }));
});

test("assumed rule 52: a scene with no beats is not discardable, and a discard naming an unknown removal is refused, changing nothing", () => {
  const { set } = setup();
  try {
    const bytes = encodeSharedState(set.a);
    const refuse = (raw: unknown) => { const result = executeSharedOperations(set.a, [operation(raw)], { base: readSharedRevision(set.a) }); return result.ok ? null : result.reason; };
    assert.equal(refuse({ kind: "discard", id: "s", by: "Bob", entry: { kind: "scene-with-no-beats", key: "H1" }, removals: [] }), "not-discardable");
    assert.equal(refuse({ kind: "discard", id: "u", by: "Bob", entry: { kind: "removed-beat", key: "R1" }, removals: ["unknown"] }), "invalid-removal-record");
    assert.equal(refuse({ kind: "discard", id: "e", by: "Bob", entry: { kind: "removed-beat", key: "R1" }, removals: [] }), "invalid-discard");
    assert.equal(refuse({ kind: "discard-retire", id: "r", by: "Bob", discard: "missing" }), "missing-discard");
    assert.deepEqual(encodeSharedState(set.a), bytes);
  } finally { set.close(); }
});
