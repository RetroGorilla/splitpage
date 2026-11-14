import { test } from "node:test";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../application/session/shared-session-support.ts";
import { createSharedBufferedText } from "../../src/adapters/collab/buffer.ts";
import { resolveSharedBufferedSelection } from "../../src/adapters/collab/buffer-selection.ts";
import { readSharedPaintedText } from "../../src/adapters/collab/paint-base.ts";
import { resolveSharedAnchor } from "../../src/adapters/collab/anchors.ts";
import { registerSharedUndoOperationHandlers } from "../../src/adapters/collab/undo-handlers.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import type { SharedUndoOutcome } from "../../src/application/editing/undo/shared-undo.ts";
import { sharedUndoActions } from "../../src/application/editing/undo/shared-undo-actions.ts";
import { sharedUndoOwner } from "../../src/bootstrap/wiring/ports/shared-undo.ts";
import { bufferReaders, bufferStamps } from "./buffer-readers.ts";

type Order = "D1" | "rev" | "dup" | "D3";
type Peer = "none" | "inside" | "before" | "after";
type Caret = readonly [number, number];

interface Literal {
  readonly edited: string;
  readonly undone: string;
  readonly restored: number;
  readonly caret: number;
}

const ORDERS: readonly Order[] = ["D1", "rev", "dup", "D3"];
const PEER_AT: Record<Peer, number | null> = { none: null, inside: 2, before: 0, after: 4 };

const DELETE: Record<Peer, Literal> = {
  none: { edited: "ad", undone: "abcd", restored: 3, caret: 1 },
  inside: { edited: "aXd", undone: "abXcd", restored: 4, caret: 1 },
  before: { edited: "Xad", undone: "Xabcd", restored: 4, caret: 2 },
  after: { edited: "adX", undone: "abcdX", restored: 3, caret: 1 }
};

const REPLACE: Record<Peer, Literal> = {
  none: { edited: "aZd", undone: "abcd", restored: 3, caret: 2 },
  inside: { edited: "aZXd", undone: "abXcd", restored: 4, caret: 2 },
  before: { edited: "XaZd", undone: "Xabcd", restored: 4, caret: 3 },
  after: { edited: "aZdX", undone: "abcdX", restored: 3, caret: 2 }
};

function world() {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }]);
  [h.a, h.b].forEach(registerSharedUndoOperationHandlers);
  let reversals = 0, serial = 0;
  const owner = sharedUndoOwner(h.a, () => ({ id: "undo" + ++reversals, by: "Alice" }), () => 0, error => { throw error; });
  const harness = sharedHarness(adapterReplica(h.a, owner));
  const port = createSharedBufferedText(h.a, harness.session, { target: id => h.target(id), author: () => ({ id: "buffer" + ++serial, by: "Alice" }),
    readers: bufferReaders, stamps: bufferStamps("Alice") });
  const actions = sharedUndoActions(harness.session, owner);
  const text = (handle: SharedDocumentHandle): string => h.characters(handle, "R1").map(char => char.value).join("");
  const painted = readSharedPaintedText(h.b, h.target("R1")); assert.ok(painted);
  const own = painted.identity(3); assert.ok(own);
  const peerCaret = (): number => { const at = resolveSharedAnchor(h.b, own); assert.notEqual(at, "gone"); return at === "gone" ? -1 : at.offset; };
  const peer = (at: number | null): void => {
    if (at !== null) h.execute("B", [h.insertion("B", "R1", h.point("B", "R1", at), "X")], ["b1"]);
  };
  const edit = (insert: string, at: number | null, order: Order): void => {
    const base = readSharedPaintedText(h.a, h.target("R1")); assert.ok(base);
    const open = port.open("R1", base); assert.ok(open);
    open.replace(1, 3, insert);
    if (order === "D3") { peer(at); h.queue.flush("D1"); }
    assert.equal(open.commit([{ text: "a" + insert + "d", marks: {} }]).kind, "applied");
    if (order !== "D3") peer(at);
    h.queue.flush(order === "D3" ? "D1" : order); h.join();
  };
  const step = (outcome: SharedUndoOutcome): Caret | null => {
    h.queue.flush("D1");
    assert.ok(outcome.ok && outcome.effective, JSON.stringify(outcome));
    if (!outcome.ok || !outcome.effective || !outcome.selection) return null;
    const range = resolveSharedBufferedSelection(h.a, [outcome.selection.anchor, outcome.selection.focus]); assert.ok(range);
    assert.deepEqual([range.anchor, range.head].map(pos => pos.kind === "beat" ? pos.rowId : pos.kind), ["R1", "R1"]);
    return [range.anchor.offset, range.head.offset];
  };
  const all = (): string[] => [text(h.a), text(h.b), text(h.c)];
  return { h, owner, port, actions, edit, step, all, peerCaret, close: () => { harness.session.dispose(); h.destroy(); } };
}

function run(name: string, insert: string, literals: Record<Peer, Literal>): void {
  for (const peer of Object.keys(PEER_AT) as Peer[]) for (const order of ORDERS) test(`undo selection, ${name}, peer ${peer}: ${order}`, () => {
    const w = world(), literal = literals[peer], restored: Caret = [literal.restored, literal.restored];
    try {
      const own = w.peerCaret();
      w.edit(insert, PEER_AT[peer], order);
      assert.deepEqual(w.all(), [literal.edited, literal.edited, literal.edited]);
      assert.equal(w.peerCaret(), literal.edited.indexOf("d"));
      assert.deepEqual([w.step(w.actions.undo()), w.all()], [restored, [literal.undone, literal.undone, literal.undone]]);
      assert.equal(w.peerCaret(), literal.undone.indexOf("d"));
      assert.deepEqual([w.step(w.actions.redo()), w.all()], [[literal.caret, literal.caret], [literal.edited, literal.edited, literal.edited]]);
      assert.deepEqual([w.step(w.actions.undo()), w.all()], [restored, [literal.undone, literal.undone, literal.undone]]);
      assert.deepEqual([own, w.peerCaret(), w.owner.sizes()], [3, literal.undone.indexOf("d"), { undo: 0, redo: 1, dropped: 0 }]);
    } finally { w.close(); }
  });
}

run("delete a selection", "", DELETE);
run("replace a selection", "Z", REPLACE);

for (const order of ORDERS) test(`undo selection, typing at a caret: undo leaves the caret before the typing, redo after it: ${order}`, () => {
  const w = world();
  try {
    const base = readSharedPaintedText(w.h.a, w.h.target("R1")); assert.ok(base);
    const open = w.port.open("R1", base); assert.ok(open);
    open.replace(2, 2, "Z");
    if (order === "D3") { w.h.execute("B", [w.h.insertion("B", "R1", w.h.point("B", "R1", 0), "X")], ["b1"]); w.h.queue.flush("D1"); }
    assert.equal(open.commit([{ text: "abZcd", marks: {} }]).kind, "applied");
    if (order !== "D3") w.h.execute("B", [w.h.insertion("B", "R1", w.h.point("B", "R1", 0), "X")], ["b1"]);
    w.h.queue.flush(order === "D3" ? "D1" : order); w.h.join();
    assert.deepEqual([w.step(w.actions.undo()), w.all()], [[3, 3], ["Xabcd", "Xabcd", "Xabcd"]]);
    assert.deepEqual([w.step(w.actions.redo()), w.all()], [[4, 4], ["XabZcd", "XabZcd", "XabZcd"]]);
  } finally { w.close(); }
});

test("undo selection, rule 90: a used-up step moves no caret, and the step before it still places one", () => {
  const w = world();
  try {
    w.edit("", null, "D1");
    const base = readSharedPaintedText(w.h.a, w.h.target("R2")); assert.ok(base);
    const open = w.port.open("R2", base); assert.ok(open);
    open.replace(2, 2, "x");
    assert.equal(open.commit([{ text: "efx", marks: {} }]).kind, "applied");
    w.h.queue.flush("D1");
    w.h.execute("B", [w.h.deletion("B", "R2", w.h.range("B", "R2", 2, 3))]);
    w.h.queue.flush("D1");
    assert.deepEqual(w.actions.undo(), { ok: true, effective: false, label: "typing", selection: null, reason: "used-up" });
    assert.deepEqual([w.step(w.actions.undo()), w.all(), w.owner.sizes()], [[3, 3], ["abcd", "abcd", "abcd"], { undo: 0, redo: 1, dropped: 0 }]);
  } finally { w.close(); }
});
