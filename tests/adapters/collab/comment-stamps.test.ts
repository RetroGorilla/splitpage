import { test } from "node:test";
import assert from "node:assert/strict";
import { addCommentCommand, addReplyCommand, setCommentAssigneeCommand, toggleResolveCommand } from "../../../src/application/commands/comments.ts";
import type { Command } from "../../../src/application/session/document-session.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { bufferStamps } from "../../collab/buffer-readers.ts";
import { agree, operation } from "./executor-support.ts";
import { recordReplicas } from "./record-support.ts";
import { assertIncremental } from "./incremental-support.ts";

const ORDERS = ["D1", "rev", "dup", "late-C"] as const;
const at = (second: number): string => "2026-11-12T10:00:0" + second + ".000Z";
const SOURCE = { title: "Title", rows: [{ id: "R1", audioText: "abZ", status: "todo" }],
  comments: [{ id: "C1", author: "Alice", createdAt: at(0), rowId: "R1", field: "audioText", anchorId: "C1", body: "note", resolved: false, resolvedAt: null, resolvedBy: null }] };
const OPEN = { resolved: false, resolvedAt: null, resolvedBy: null };

function copy(handle: SharedDocumentHandle, by: string, second: number, prefix = by + ":") {
  const harness = sharedHarness(adapterReplica(handle)), stamps = bufferStamps(by, () => at(second));
  let serial = 0;
  const shared = { author: () => ({ id: prefix + ++serial, by }) };
  const run = (command: Command): string => harness.session.run(command).kind;
  return { harness, toggle: () => run(toggleResolveCommand("C1", stamps, shared)), assign: (name: string) => run(setCommentAssigneeCommand("C1", name, stamps.clock, shared)),
    run, shared, stamps, dispose: () => harness.session.dispose() };
}

function comment(handle: SharedDocumentHandle, id = "C1"): Record<string, unknown> | undefined {
  return projectSharedDocumentWithRecovery(handle).document.comments.find(entry => entry.id === id);
}
function resolution(handle: SharedDocumentHandle): Record<string, unknown> {
  const shown = comment(handle);
  return { resolved: shown?.resolved, resolvedAt: shown?.resolvedAt, resolvedBy: shown?.resolvedBy };
}
function stored(handle: SharedDocumentHandle): string[] {
  const record = collabState(handle).roots.comments.get("C1") as { keys: () => Iterable<string> } | undefined; assert.ok(record);
  return [...record.keys()].filter(key => key.startsWith("resolution")).sort();
}

test("a resolve sends its stamp and updatedAt in one list, and a reopen written after seeing it replaces it even with an earlier clock", () => {
  for (const order of ORDERS) {
    const run = recordReplicas(2, SOURCE), a = copy(run.a, "Alice", 5), b = copy(run.b, "Bob", 1);
    try {
      assert.equal(a.toggle(), "applied");
      assert.deepEqual(a.harness.executed.map(entry => entry.operations.map(item => item.kind === "record-set" ? [item.field, "value" in item ? item.value : null] : item.kind)),
        [[["resolution-stamp", { at: at(5), by: "Alice", resolution: { resolved: true, resolvedAt: at(5), resolvedBy: "Alice" } }], ["updatedAt", at(5)]]]);
      run.queue.flush(order);
      agree("resolve", order, [run.a, run.b], (handle): Record<string, unknown> => ({ ...resolution(handle), updatedAt: comment(handle)?.updatedAt, stored: stored(handle) }),
        { resolved: true, resolvedAt: at(5), resolvedBy: "Alice", updatedAt: at(5), stored: ["resolution:1"] });
      assert.equal(b.toggle(), "applied");
      run.queue.flush(order);
      agree("reopen after seeing", order, [run.a, run.b], (handle): Record<string, unknown> => ({ ...resolution(handle), updatedAt: comment(handle)?.updatedAt, stored: stored(handle) }),
        { ...OPEN, updatedAt: at(1), stored: ["resolution:2"] });
    } finally { a.dispose(); b.dispose(); run.close(); }
  }
});

const CONCURRENT = [
  { a: ["Alice", 5], b: ["Bob", 1], prefix: false, shown: { resolved: true, resolvedAt: at(5), resolvedBy: "Alice" } },
  { a: ["Alice", 1], b: ["Bob", 5], prefix: false, shown: OPEN },
  { a: ["Alice", 3], b: ["Bob", 3], prefix: false, shown: OPEN },
  { a: ["Bob", 3], b: ["Alice", 3], prefix: false, shown: { resolved: true, resolvedAt: at(3), resolvedBy: "Bob" } },
  { a: ["Alice", 5], b: ["Bob", 1], prefix: true, shown: { resolved: true, resolvedAt: at(5), resolvedBy: "Alice" } },
  { a: ["Alice", 1], b: ["Bob", 5], prefix: true, shown: OPEN }
] as const;

test("a resolve and a reopen written without seeing each other: every copy shows the later time, then the later name, and incremental equals full", () => {
  for (const { a: [first, early], b: [second, late], prefix, shown } of CONCURRENT) for (const order of ORDERS) {
    const run = recordReplicas(2, SOURCE), a = copy(run.a, first, early, prefix ? "native_" : undefined), b = copy(run.b, second, late, prefix ? "native_" : undefined);
    const projector = createSharedIncrementalProjector(run.b);
    try {
      assert.equal(a.toggle(), "applied");
      assert.equal(b.toggle(), "applied"); assert.equal(b.toggle(), "applied");
      run.queue.flush(order);
      agree(first + " resolves, " + second + " reopens", order, [run.a, run.b], handle => ({ shown: resolution(handle), stored: stored(handle) }),
        { shown, stored: ["resolution:1", "resolution:2"] });
      assertIncremental(run.b, projector);
    } finally { projector.dispose(); a.dispose(); b.dispose(); run.close(); }
  }
});

test("concurrent assignee changes: updatedAt follows the stored field, as today, and is not chosen by time", () => {
  for (const order of ORDERS) {
    const run = recordReplicas(2, SOURCE), a = copy(run.a, "Alice", 5), b = copy(run.b, "Bob", 1);
    try {
      assert.equal(a.assign("Jo"), "applied"); assert.equal(b.assign("Max"), "applied");
      run.queue.flush(order);
      agree("assignee", order, [run.a, run.b], handle => [comment(handle)?.assignee, comment(handle)?.updatedAt], ["Max", at(1)]);
    } finally { a.dispose(); b.dispose(); run.close(); }
  }
});

test("a stored resolution that a resolve step could not write never hides a valid one, and a step carrying one is refused", () => {
  const run = recordReplicas(2, SOURCE), a = copy(run.a, "Alice", 5), loaded = createMonitoredSharedDocument();
  try {
    assert.equal(a.toggle(), "applied");
    run.queue.flush("D1");
    transactSharedDocument(run.b, "local-command", () => {
      const record = collabState(run.b).roots.comments.get("C1") as { set: (key: string, value: unknown) => void } | undefined; assert.ok(record);
      record.set("resolution:0", { at: 9e15, by: "R", resolution: { resolved: false } });
    });
    run.queue.flush("D1");
    assert.deepEqual(applySharedUpdate(loaded, encodeSharedState(run.a)), { ok: true });
    for (const handle of [run.a, loaded]) {
      assert.deepEqual(stored(handle), ["resolution:0", "resolution:1"]);
      assert.deepEqual(resolution(handle), { resolved: true, resolvedAt: at(5), resolvedBy: "Alice" });
    }
    const before = encodeSharedState(run.a);
    const result = executeSharedOperations(run.a, [operation({ kind: "record-set", id: "bad", by: "Alice", target: { collection: "comments", record: "C1" },
      field: "resolution-stamp", value: { at: 9e15, by: "R", resolution: { resolved: false } } })]);
    assert.deepEqual([result.ok, !result.ok && result.reason], [false, "invalid-record-field"]);
    assert.deepEqual(encodeSharedState(run.a), before);
  } finally { a.dispose(); destroySharedDocument(loaded); run.close(); }
});

test("undo of a comment edit puts the edit back and leaves updatedAt and the resolution; a resolve alone records nothing to undo", () => {
  const run = recordReplicas(2, SOURCE);
  try {
    for (const handle of [run.a, run.b, run.c]) registerSharedUndoOperationHandlers(handle);
    const replica = adapterReplica(run.a);
    let record: SharedUndoRecord | null = null;
    const harness = sharedHarness({ ...replica, execute: (operations, options) => {
      const execution = executeSharedCommand(run.a, operations, { label: "comment", selection: null, typing: null }, options);
      record = execution.record;
      return execution.result;
    } });
    const executed = (command: Command): SharedUndoRecord | null => {
      record = null;
      assert.equal(harness.session.run(command).kind, "applied");
      return record;
    };
    const author = { author: () => ({ id: "Alice:1", by: "Alice" }) };
    assert.equal(executed(toggleResolveCommand("C1", bufferStamps("Alice", () => at(1)), author)), null);
    const edit = executed(setCommentAssigneeCommand("C1", "Jo", { nowIso: () => at(2) }, author)); assert.ok(edit);
    assert.deepEqual(edit.parts.map(part => part.kind === "record-field" ? [part.kind, part.field] : [part.kind]), [["record-field", "assignee"]]);
    let serial = 0;
    const undoer = { by: "Alice", nextId: () => "undo:" + ++serial };
    const reversal = reverseSharedUndoRecord(run.a, edit, undoer);
    assert.ok(reversal.ok && reversal.effective);
    run.queue.flush("D1");
    const read = (handle: SharedDocumentHandle): Record<string, unknown> => ({ assignee: comment(handle)?.assignee, updatedAt: comment(handle)?.updatedAt, ...resolution(handle) });
    agree("undone", "D1", [run.a, run.b], read, { assignee: "", updatedAt: at(2), resolved: true, resolvedAt: at(1), resolvedBy: "Alice" });
    const redo = reverseSharedUndoRecord(run.a, reversal.inverse, undoer);
    assert.equal(redo.ok && redo.effective, true);
    run.queue.flush("D1");
    agree("redone", "D1", [run.a, run.b], read, { assignee: "Jo", updatedAt: at(2), resolved: true, resolvedAt: at(1), resolvedBy: "Alice" });
    harness.session.dispose();
  } finally { run.close(); }
});

test("a shared comment and reply carry createdAt once, in their own records, and every copy shows them as written", () => {
  for (const order of ORDERS) {
    const run = recordReplicas(2, SOURCE), a = copy(run.a, "Alice", 3);
    const added = { id: "C2", author: "Alice", createdAt: at(1), rowId: "R1", field: "audioText", anchorId: "C2", body: "hi", quotedText: "ab", resolved: false,
      resolvedAt: null, resolvedBy: null, future: 1 };
    try {
      assert.equal(a.run(addCommentCommand(added, a.shared)), "applied");
      assert.equal(a.run(addReplyCommand("C2", { id: "r1", author: "Alice", createdAt: at(2), body: "ok" }, a.stamps.clock, a.shared)), "applied");
      assert.deepEqual(a.harness.executed.map(entry => entry.operations.map(item => item.kind === "record-create" ? item.kind + ":" + item.target.collection
        : item.kind === "record-set" ? item.kind + ":" + item.field : item.kind)),
        [["record-create:comments"], ["record-create:replies", "record-set:updatedAt"]]);
      run.queue.flush(order);
      agree("added", order, [run.a, run.b], handle => comment(handle, "C2"), { id: "C2", rowId: "R1", field: "audioText", anchorId: "C2", quotedText: "ab", author: "Alice",
        body: "hi", resolved: false, resolvedBy: null, resolvedAt: null, createdAt: at(1), updatedAt: at(3),
        replies: [{ id: "r1", author: "Alice", body: "ok", createdAt: at(2) }], future: 1 });
    } finally { a.dispose(); run.close(); }
  }
});
