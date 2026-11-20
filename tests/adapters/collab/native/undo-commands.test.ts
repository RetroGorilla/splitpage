import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { anchorNativeText, typeNativeText, deleteNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { openNativeUndo } from "../../../../src/adapters/collab/native/undo-commands.ts";
import { ScriptNet, convertedScript, joinedScript } from "./helpers.ts";
import { caret, remove, rowsOf, stateOf, structureScript } from "./structure-harness.ts";

function fixture() {
  const a = convertedScript(structureScript({ A: "a", B: "b" }), 1), b = joinedScript(a, 2);
  return { a, b, net: new ScriptNet([a, b]) };
}

test("E3: one press applies one group and publishes one update; empty presses leave the encoded state intact", () => {
  const { a, b, net } = fixture(), history = openNativeUndo(a);
  let updates = 0;
  a.doc.on("update", () => { updates++; });
  try {
    for (const value of ["x", "y"]) assert.equal(typeNativeText(a, caret(a, "A", 0), value, {}).kind, "written");
    history.stopCapturing();
    assert.equal(typeNativeText(a, caret(a, "A", 0), "z", {}).kind, "written");
    const start = updates;
    const first = history.undo();
    assert.equal(first.kind, "written");
    assert.ok(Object.isFrozen(first));
    assert.deepEqual(rowsOf(a), ["A: yxa", "B: b"]);
    assert.equal(updates, start + 1);
    assert.equal(history.undo().kind, "written");
    assert.deepEqual(rowsOf(a), ["A: a", "B: b"]);
    assert.equal(updates, start + 2);
    const before = stateOf(a), empty = history.undo();
    assert.deepEqual(empty, { kind: "unchanged" });
    assert.ok(Object.isFrozen(empty));
    assert.deepEqual(stateOf(a), before);
    assert.equal(updates, start + 2);
    assert.equal(history.redo().kind, "written");
    assert.deepEqual(rowsOf(a), ["A: yxa", "B: b"]);
    assert.equal(updates, start + 3);
    net.settle();
    assert.deepEqual(rowsOf(b), rowsOf(a));
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("E3: undo and redo refuse a busy script and a closed handle without consuming steps or writing", () => {
  const { a, b } = fixture(), history = openNativeUndo(a, 0);
  try {
    for (const ch of ["x", "y"]) assert.equal(typeNativeText(a, caret(a, "A", 0), ch, {}).kind, "written");
    assert.equal(history.undo().kind, "written");
    const before = stateOf(a);
    const check = (reason: "busy" | "closed") => {
      for (const press of [history.undo, history.redo]) {
        const result = press();
        assert.deepEqual(result, { kind: "refused", reason });
        assert.ok(Object.isFrozen(result));
        assert.deepEqual(stateOf(a), before);
        assert.equal(history.undoStack.length, 1);
        assert.equal(history.redoStack.length, 1);
      }
    };
    a.doc.transact(() => check("busy"), a.origin);
    a.close();
    check("closed");
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("a closed reader or disposed undo binding refuses both presses while the script is still open", () => {
  for (const close of ["reader", "undo"] as const) {
    const { a, b } = fixture(), history = openNativeUndo(a);
    try {
      assert.equal(typeNativeText(a, caret(a, "A", 0), "x", {}).kind, "written");
      const before = stateOf(a);
      if (close === "reader") a.reader.close(); else history.destroy();
      assert.equal(a.closed(), false);
      assert.deepEqual(history.undo(), { kind: "refused", reason: "closed" });
      assert.deepEqual(history.redo(), { kind: "refused", reason: "closed" });
      assert.deepEqual(stateOf(a), before);
    } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
  }
});

test("E11: one press passes over a group that removed all it typed", () => {
  const { a, b } = fixture(), history = openNativeUndo(a);
  try {
    assert.equal(typeNativeText(a, caret(a, "A", 0), "x", {}).kind, "written");
    history.stopCapturing();
    assert.equal(typeNativeText(a, caret(a, "B", 0), "y", {}).kind, "written");
    const range = anchorNativeText(a, { beat: "B", cell: "narration" }, 0, 1);
    assert.equal(range.kind, "anchored");
    assert.equal(deleteNativeText(a, range.range).kind, "written");
    assert.equal(history.undoStack.length, 2);
    let updates = 0;
    a.doc.on("update", () => { updates++; });
    assert.equal(history.undo().kind, "written");
    assert.deepEqual(rowsOf(a), ["A: a", "B: b"]);
    assert.equal(updates, 1);
    assert.equal(history.undoStack.length, 0);
    assert.equal(history.redoStack.length, 1);
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("E14: a press on a cut row changes its stored visual while the outline stays the same", () => {
  const { a, b, net } = fixture(), history = openNativeUndo(a, 0);
  try {
    const visual = a.roots.visuals.get("B");
    assert.ok(visual);
    a.doc.transact(() => visual.insert(0, "x", {}), a.origin);
    remove(b, "B");
    net.settle();
    assert.deepEqual(rowsOf(a), ["A: a"]);
    assert.equal(visual.toString(), "x");
    assert.equal(history.undo().kind, "written");
    assert.equal(visual.toString(), "");
    assert.deepEqual(rowsOf(a), ["A: a"]);
    net.settle();
    assert.equal(b.roots.visuals.get("B")?.toString(), "");
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("only this script's command origin and writable roots enter its history", () => {
  const { a, b, net } = fixture(), history = openNativeUndo(a);
  try {
    a.doc.transact(() => {
      a.roots.births.set("test", true);
      a.roots.edited.set("test", true);
    }, a.origin);
    assert.equal(typeNativeText(b, caret(b, "B", 0), "y", {}).kind, "written");
    net.settle();
    assert.equal(history.undo().kind, "unchanged");
    assert.equal(typeNativeText(a, caret(a, "A", 0), "x", {}, { at: "2026-11-19T00:00:00.000Z", by: "writer" }).kind, "written");
    const stamp = a.roots.edited.get("A");
    assert.ok(stamp);
    assert.equal(history.undo().kind, "written");
    assert.deepEqual(rowsOf(a), ["A: a", "B: yb"]);
    assert.equal(a.roots.births.get("test"), true);
    assert.deepEqual(a.roots.edited.get("A"), stamp);
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("appendix B: nesting a library press under its own origin loses redo capture", () => {
  const doc = new Y.Doc(), text = doc.getText("example"), origin = {};
  const manager = new Y.UndoManager(text, { trackedOrigins: new Set([origin]) });
  try {
    doc.transact(() => text.insert(0, "a"), origin);
    doc.transact(() => assert.ok(manager.undo()), manager);
    assert.equal(text.toString(), "");
    assert.equal(manager.undoStack.length, 1);
    assert.equal(manager.redoStack.length, 0);
  } finally { doc.destroy(); }
});

test("stock press limitation: closure inside beforeTransaction cannot cancel the manager's write", () => {
  for (const direction of ["undo", "redo"] as const) {
    const { a, b } = fixture(), history = openNativeUndo(a);
    try {
      assert.equal(typeNativeText(a, caret(a, "A", 0), "x", {}).kind, "written");
      if (direction === "redo") assert.equal(history.undo().kind, "written");
      const before = stateOf(a);
      a.doc.once("beforeTransaction", () => a.close());
      assert.equal(history[direction]().kind, "written");
      assert.equal(a.closed(), true);
      assert.notDeepEqual(stateOf(a), before);
    } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
  }
});
