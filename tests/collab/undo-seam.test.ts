import { test } from "node:test";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../application/session/shared-session-support.ts";
import { createSharedBufferedText, SHARED_TYPING_LABEL } from "../../src/adapters/collab/buffer.ts";
import { readSharedPaintedText } from "../../src/adapters/collab/paint-base.ts";
import { observeSharedTransactions } from "../../src/adapters/collab/document.ts";
import { registerSharedUndoOperationHandlers } from "../../src/adapters/collab/undo-handlers.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import type { SharedUndo } from "../../src/application/editing/undo/shared-undo.ts";
import { sharedUndoActions } from "../../src/application/editing/undo/shared-undo-actions.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import type { Command } from "../../src/application/session/document-session.ts";
import { readOperation } from "../../src/core/collab/read-operation.ts";
import { sharedUndoOwner } from "../../src/bootstrap/wiring/ports/shared-undo.ts";
import { bufferReaders, bufferStamps } from "./buffer-readers.ts";

const ORDERS = ["D1", "rev", "dup"] as const;

function world() {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }]);
  [h.a, h.b].forEach(registerSharedUndoOperationHandlers);
  let reversals = 0, serial = 0;
  const undoReported: unknown[] = [];
  const owner = sharedUndoOwner(h.a, () => ({ id: "undo" + ++reversals, by: "Alice" }), () => 0, error => { undoReported.push(error); });
  const performed: string[] = [];
  const counted: Pick<SharedUndo, "perform"> = { perform: run => { performed.push("perform"); owner.perform(run); } };
  const harness = sharedHarness(adapterReplica(h.a, counted));
  const port = createSharedBufferedText(h.a, harness.session, { target: id => h.target(id), author: () => ({ id: "buffer" + ++serial, by: "Alice" }),
    readers: bufferReaders, stamps: bufferStamps("Alice") });
  const actions = sharedUndoActions(harness.session, owner);
  const text = (handle: SharedDocumentHandle, row: string): string => h.characters(handle, row).map(char => char.value).join("");
  const type = (row: string, from: number, to: number, insert: string, after: string): string => {
    const painted = readSharedPaintedText(h.a, h.target(row)); assert.ok(painted);
    const edit = port.open(row, painted); assert.ok(edit);
    edit.replace(from, to, insert);
    return edit.commit([{ text: after, marks: {} }]).kind;
  };
  const both = (row: string): string[] => [text(h.a, row), text(h.b, row)];
  return { h, owner, performed, harness, actions, text, type, both, undoReported, close: () => { harness.session.dispose(); h.destroy(); } };
}

function lengthCommand(undo: boolean): Command {
  const operation = readOperation({ kind: "scalar", id: "len1", by: "Alice", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 });
  assert.ok(operation);
  return { name: "length", needs: "edit", plan: () => ({ changes: changeSet({ cells: [{ rowId: "R1", field: "lengthSeconds" }] }),
    apply: () => { throw new Error("standalone"); }, shared: undo ? { operations: [operation] } : { operations: [operation], undo: false } }) };
}

for (const order of ORDERS) test(`D32: typed text, a remote change, undo and redo through the real owner take back only the typing: ${order}`, () => {
  const w = world();
  try {
    assert.equal(w.type("R1", 1, 3, "Z", "aZd"), "applied");
    assert.deepEqual([w.performed, w.owner.sizes(), w.harness.described.map(entry => [entry?.label, entry?.typing, entry?.selection !== null])],
      [["perform"], { undo: 1, redo: 0, dropped: 0 }, [[SHARED_TYPING_LABEL, "Z", true]]]);
    w.h.execute("B", [w.h.insertion("B", "R2", w.h.point("B", "R2", 1), "X")], ["b1"]);
    w.h.queue.flush(order);
    assert.deepEqual([w.both("R1"), w.both("R2")], [["aZd", "aZd"], ["eXf", "eXf"]]);
    const undone = w.actions.undo();
    assert.deepEqual(undone.ok && [undone.effective, undone.label], [true, SHARED_TYPING_LABEL]);
    w.h.queue.flush(order);
    assert.deepEqual([w.both("R1"), w.both("R2"), w.owner.sizes(), w.harness.published.at(-1)?.kind], [["abcd", "abcd"], ["eXf", "eXf"], { undo: 0, redo: 1, dropped: 0 }, "replay"]);
    const redone = w.actions.redo();
    assert.deepEqual(redone.ok && redone.effective, true);
    w.h.queue.flush(order);
    assert.deepEqual([w.both("R1"), w.both("R2"), w.owner.sizes(), w.performed.length], [["aZd", "aZd"], ["eXf", "eXf"], { undo: 1, redo: 0, dropped: 0 }, 1]);
  } finally { w.close(); }
});

test("D32: two keystrokes in a row are one typing group, undone in one step", () => {
  const w = world();
  try {
    assert.equal(w.type("R1", 4, 4, "x", "abcdx"), "applied");
    assert.equal(w.type("R1", 5, 5, "y", "abcdxy"), "applied");
    assert.deepEqual([w.performed.length, w.owner.sizes().undo, w.harness.described.map(entry => entry?.typing)], [2, 1, ["x", "y"]]);
    const undone = w.actions.undo();
    assert.equal(undone.ok, true);
    assert.deepEqual([w.text(w.h.a, "R1"), w.owner.sizes()], ["abcd", { undo: 0, redo: 1, dropped: 0 }]);
  } finally { w.close(); }
});

test("D32 (b): a plan with undo: false goes to the replica without a description and records nothing", () => {
  const w = world();
  try {
    assert.equal(w.harness.session.run(lengthCommand(false)).kind, "applied");
    assert.deepEqual([w.harness.described, w.performed, w.owner.sizes().undo], [[null], [], 0]);
  } finally { w.close(); }
});

test("D32 (a): a shared plan without its own description is recorded under the command's name, with no selection or typing key", () => {
  const w = world();
  try {
    assert.equal(w.harness.session.run(lengthCommand(true)).kind, "applied");
    assert.deepEqual([w.harness.described, w.performed, w.owner.sizes().undo], [[{ label: "length", selection: null, typing: null }], ["perform"], 1]);
  } finally { w.close(); }
});

test("D32 (d): undo and redo pass the session's admission first; a refusing admission leaves both stacks and the text as they are", () => {
  const w = world();
  try {
    assert.equal(w.type("R1", 4, 4, "x", "abcdx"), "applied");
    let allow = false, asked = 0;
    w.harness.session.beforeCommand(() => { asked++; return allow; });
    assert.deepEqual(w.actions.undo(), { ok: false, reason: "buffer-pending" });
    assert.deepEqual([asked, w.text(w.h.a, "R1"), w.owner.sizes()], [1, "abcdx", { undo: 1, redo: 0, dropped: 0 }]);
    allow = true;
    assert.equal(w.actions.undo().ok, true);
    assert.deepEqual([asked, w.text(w.h.a, "R1")], [2, "abcd"]);
    allow = false;
    assert.deepEqual(w.actions.redo(), { ok: false, reason: "buffer-pending" });
    assert.deepEqual([asked, w.text(w.h.a, "R1"), w.owner.sizes()], [3, "abcd", { undo: 0, redo: 1, dropped: 0 }]);
  } finally { w.close(); }
});

test("D32 (d): undo on a disposed session is refused by the admission and reverses nothing", () => {
  const w = world();
  try {
    assert.equal(w.type("R1", 4, 4, "x", "abcdx"), "applied");
    w.harness.session.dispose();
    assert.deepEqual(w.actions.undo(), { ok: false, reason: "disposed" });
    assert.deepEqual([w.text(w.h.a, "R1"), w.owner.sizes().undo], ["abcdx", 1]);
  } finally { w.h.destroy(); }
});

test("a replica built without an undo owner executes as before and records nothing", () => {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }]);
  const harness = sharedHarness(adapterReplica(h.a));
  try {
    assert.equal(harness.session.run(lengthCommand(true)).kind, "applied");
    assert.deepEqual(harness.described, [{ label: "length", selection: null, typing: null }]);
  } finally { harness.session.dispose(); h.destroy(); }
});

const length = (w: ReturnType<typeof world>): unknown => w.harness.session.read(doc => doc?.rows.find(row => row.id === "R1")?.["lengthSeconds"]);
const throwing = (handle: SharedDocumentHandle): (() => void) => observeSharedTransactions(handle, () => { throw new Error("listener"); });

test("D32: a document callback that throws after a command commits leaves the record with the owner, and the error is still reported", () => {
  const w = world();
  try {
    const stop = throwing(w.h.a);
    const outcome = w.harness.session.run(lengthCommand(true));
    stop();
    assert.deepEqual([outcome.kind, outcome.kind === "committed" ? outcome.errors.map(String) : null, w.harness.reported.map(String), length(w), w.owner.sizes().undo],
      ["committed", ["Error: listener"], ["Error: listener"], 7, 1]);
    assert.equal(w.actions.undo().ok, true);
    assert.deepEqual([length(w), w.owner.sizes()], [undefined, { undo: 0, redo: 1, dropped: 0 }]);
  } finally { w.close(); }
});

test("D32 (b): a recovery write whose document callback throws still records nothing", () => {
  const w = world();
  try {
    const stop = throwing(w.h.a);
    const outcome = w.harness.session.run(lengthCommand(false));
    stop();
    assert.deepEqual([outcome.kind, length(w), w.performed, w.owner.sizes().undo], ["committed", 7, [], 0]);
  } finally { w.close(); }
});

test("D32 (d): an undo or redo whose document callback throws moves the stack once, as the document moved, and reports the error", () => {
  const w = world();
  try {
    assert.equal(w.type("R1", 4, 4, "x", "abcdx"), "applied");
    const stop = throwing(w.h.a);
    assert.equal(w.actions.undo().ok, true);
    assert.deepEqual([w.text(w.h.a, "R1"), w.owner.sizes(), w.undoReported.map(String)], ["abcd", { undo: 0, redo: 1, dropped: 0 }, ["Error: listener"]]);
    assert.equal(w.actions.redo().ok, true);
    stop();
    assert.deepEqual([w.text(w.h.a, "R1"), w.owner.sizes(), w.undoReported.map(String)], ["abcdx", { undo: 1, redo: 0, dropped: 0 }, ["Error: listener", "Error: listener"]]);
  } finally { w.close(); }
});

test("D32: an owner whose own perform throws after the command ran leaves the change standing and reports the failure", () => {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }]);
  const standIn: Pick<SharedUndo, "perform"> = { perform: run => { run(); throw new Error("perform"); } };
  const harness = sharedHarness(adapterReplica(h.a, standIn));
  try {
    const outcome = harness.session.run(lengthCommand(true));
    assert.deepEqual([outcome.kind, outcome.kind === "committed" ? outcome.errors.map(String) : null, harness.reported.map(String),
      harness.session.read(doc => doc?.rows[0]?.["lengthSeconds"])], ["committed", ["Error: perform"], ["Error: perform"], 7]);
  } finally { harness.session.dispose(); h.destroy(); }
});
