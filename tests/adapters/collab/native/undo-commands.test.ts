import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { formatNativeText } from "../../../../src/adapters/collab/native/format-commands.ts";
import { anchorNativeText, typeNativeText, deleteNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { openNativeUndo } from "../../../../src/adapters/collab/native/undo-commands.ts";
import { ScriptNet, convertedScript, edit, joinedScript } from "./helpers.ts";
import { caret, remove, rowsOf, split, stateOf, structureScript } from "./structure-harness.ts";

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
  const { a, b } = fixture(), history = openNativeUndo(a);
  try {
    for (const ch of ["x", "y"]) {
      assert.equal(typeNativeText(a, caret(a, "A", 0), ch, {}).kind, "written");
      history.stopCapturing();
    }
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
  const { a, b, net } = fixture(), history = openNativeUndo(a);
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

for (const direction of ["undo", "redo"] as const) {
  test(`${direction} holds the document busy through afterAllTransactions`, () => {
    const { a, b } = fixture(), history = openNativeUndo(a);
    try {
      for (const ch of ["x", "y"]) {
        assert.equal(typeNativeText(a, caret(a, "A", 0), ch, {}).kind, "written");
        history.stopCapturing();
      }
      if (direction === "redo") assert.equal(history.undo().kind, "written");
      const at = caret(a, "B", 0), before = stateOf(a);
      let nested = 0;
      a.doc.once("afterAllTransactions", () => {
        const atEvent = stateOf(a);
        assert.deepEqual(history[direction](), { kind: "refused", reason: "busy" });
        assert.deepEqual(typeNativeText(a, at, "z", {}), { kind: "recovery", reason: "busy", runs: [{ text: "z", marks: {} }] });
        assert.deepEqual(stateOf(a), atEvent);
        nested++;
      });
      assert.equal(history[direction]().kind, "written");
      assert.equal(nested, 1);
      assert.notDeepEqual(stateOf(a), before);
      assert.deepEqual(rowsOf(a), [direction === "undo" ? "A: xa" : "A: yxa", "B: b"]);
      assert.equal(history.undoStack.length, direction === "undo" ? 1 : 2);
      assert.equal(history.redoStack.length, direction === "undo" ? 1 : 0);
    } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
  });

  test(`typing refuses ${direction} in a beforeAllTransactions listener registered before opening`, () => {
    const seed = convertedScript(structureScript({ A: "a", B: "b" }), 1);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed.doc));
    seed.doc.destroy();
    let armed = false, calls = 0;
    doc.on("beforeAllTransactions", () => {
      if (!armed) return;
      const before = stateOf(a);
      assert.deepEqual(history[direction](), { kind: "refused", reason: "busy" });
      assert.deepEqual(stateOf(a), before);
      calls++;
    });
    const a = openNativeScript(doc), history = openNativeUndo(a);
    try {
      assert.equal(typeNativeText(a, caret(a, "A", 0), "x", {}).kind, "written");
      if (direction === "redo") assert.equal(history.undo().kind, "written");
      history.stopCapturing();
      const at = caret(a, "A", 0);
      armed = true;
      assert.equal(typeNativeText(a, at, "y", {}).kind, "written");
      armed = false;
      assert.equal(calls, 1);
      assert.deepEqual(rowsOf(a), [direction === "undo" ? "A: yxa" : "A: ya", "B: b"]);
      assert.equal(history.redoStack.length, 0);
      assert.equal(history.undo().kind, "written");
      assert.deepEqual(rowsOf(a), [direction === "undo" ? "A: xa" : "A: a", "B: b"]);
    } finally { history.destroy(); doc.destroy(); }
  });
}

test("the history constructor never coerces surplus arguments", () => {
  for (const makeExtra of [() => Symbol(), () => ({ valueOf() { throw new Error("unexpected coercion"); } }),
    (close: () => void) => ({ valueOf() { close(); return 0; } })]) {
    const { a, b } = fixture();
    const invoke = Reflect.apply as (fn: typeof openNativeUndo, receiver: undefined, args: unknown[]) => ReturnType<typeof openNativeUndo>;
    const history = invoke(openNativeUndo, undefined, [a, makeExtra(a.close)]);
    try {
      for (const ch of ["x", "y"]) assert.equal(typeNativeText(a, caret(a, "A", 0), ch, {}).kind, "written");
      assert.equal(a.closed(), false);
      assert.equal(history.undo().kind, "written");
      assert.deepEqual(rowsOf(a), ["A: a", "B: b"]);
    } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
  }
});

test("an empty redo ends the typing group and outcomes expose only immutable entry numbers", () => {
  const { a, b } = fixture(), history = openNativeUndo(a);
  try {
    assert.equal(typeNativeText(a, caret(a, "A", 0), "x", {}).kind, "written");
    const before = stateOf(a);
    assert.deepEqual(history.redo(), { kind: "unchanged" });
    assert.deepEqual(stateOf(a), before);
    assert.equal(typeNativeText(a, caret(a, "A", 0), "y", {}).kind, "written");
    const first = history.undo();
    assert.equal(first.kind, "written");
    assert.deepEqual(first, { kind: "written", entry: first.entry });
    assert.equal(typeof first.entry, "number");
    assert.equal(Reflect.set(first, "entry", { insertions: [] }), false);
    assert.equal(Reflect.set(history.undoStack, "0", -1), false);
    assert.deepEqual(rowsOf(a), ["A: xa", "B: b"]);
    assert.equal(history.undo().kind, "written");
    assert.deepEqual(rowsOf(a), ["A: a", "B: b"]);
    assert.equal(history.redo().kind, "written");
    assert.equal(history.redo().kind, "written");
    assert.deepEqual(rowsOf(a), ["A: yxa", "B: b"]);
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("E3: bold undo and redo cross a split the undoer has not seen", () => {
  const { a, b, net } = fixture(), history = openNativeUndo(a);
  try {
    const where = anchorNativeText(a, { beat: "A", cell: "narration" }, 0, 1);
    assert.equal(where.kind, "anchored");
    assert.equal(formatNativeText(a, where.range, { kind: "plain", mark: "b", on: true }).kind, "written");
    const n = split(b, "A", 0);
    assert.equal(history.undo().kind, "written");
    net.deliver(a, b);
    assert.deepEqual(b.reader.row(n)?.narration, [{ text: "a", marks: {} }]);
    assert.equal(a.reader.row(n), null);
    assert.equal(history.redo().kind, "written");
    net.settle();
    for (const copy of [a, b]) assert.deepEqual(copy.reader.row(n)?.narration, [{ text: "a", marks: { b: true } }]);
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("E3: deletion undo restores letters around another writer's insertion", () => {
  const { a, b, net } = fixture(), history = openNativeUndo(a);
  try {
    assert.equal(typeNativeText(a, caret(a, "A", 1), "bcd", {}).kind, "written");
    history.stopCapturing();
    net.settle();
    const deletion = anchorNativeText(a, { beat: "A", cell: "narration" }, 1, 3);
    assert.equal(deletion.kind, "anchored");
    assert.equal(deleteNativeText(a, deletion.range).kind, "written");
    assert.equal(typeNativeText(b, caret(b, "A", 2), "X", {}).kind, "written");
    net.settle();
    assert.equal(a.reader.row("A")?.audioText, "aXd");
    assert.equal(history.undo().kind, "written");
    net.settle();
    for (const copy of [a, b]) assert.equal(copy.reader.row("A")?.audioText, "abXcd");
    assert.equal(history.redo().kind, "written");
    net.settle();
    for (const copy of [a, b]) assert.equal(copy.reader.row("A")?.audioText, "aXd");
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("E3: a peer edit in an unseen visual cell is lost when the creator undoes its split", () => {
  const { a, b, net } = fixture(), history = openNativeUndo(a);
  try {
    const n = split(a, "A", 0);
    net.settle();
    assert.equal(edit(b, { beat: n, cell: "visual" }, 0, 0, [{ text: "V", marks: {} }]).kind, "written");
    assert.equal(b.roots.visuals.get(n)?.toString(), "V");
    assert.equal(history.undo().kind, "written");
    net.settle();
    for (const copy of [a, b]) {
      assert.deepEqual(rowsOf(copy), ["A: a", "B: b"]);
      assert.equal(copy.roots.visuals.has(n), false);
    }
    assert.equal(history.redo().kind, "written");
    net.settle();
    for (const copy of [a, b]) {
      assert.deepEqual(rowsOf(copy), ["A: ", `${n}: a`, "B: b"]);
      assert.equal(copy.roots.visuals.get(n)?.toString(), "");
    }
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

for (const direction of ["undo", "redo"] as const) {
  test(`${direction} reports the transaction's write when history is destroyed before it can capture the inverse`, () => {
    const { a, b } = fixture(), history = openNativeUndo(a);
    try {
      assert.equal(typeNativeText(a, caret(a, "A", 0), "x", {}).kind, "written");
      if (direction === "redo") assert.equal(history.undo().kind, "written");
      const entry = (direction === "undo" ? history.undoStack : history.redoStack).at(-1);
      assert.equal(typeof entry, "number");
      const before = stateOf(a);
      a.doc.once("beforeTransaction", history.destroy);
      assert.deepEqual(history[direction](), { kind: "written", entry });
      assert.notDeepEqual(stateOf(a), before);
      assert.equal(a.reader.row("A")?.audioText, direction === "undo" ? "a" : "xa");
      assert.equal((direction === "undo" ? history.redoStack : history.undoStack).length, 0);
    } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
  });
}

const INTERRUPTED_EVENTS = [
  "beforeTransaction", "afterTransactionCleanup", "update", "beforeAllTransactions", "afterAllTransactions"
] as const;

for (const phase of INTERRUPTED_EVENTS) for (const action of ["typing", "undo", "redo"] as const) {
  test(`stock Yjs interruption: ${phase} throwing during ${action} leaves later commands busy`, () => {
    const seed = convertedScript(structureScript({ A: "a" }), 1);
    const doc = new Y.Doc(), failure = new Error(phase);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed.doc));
    seed.doc.destroy();
    let armed = false;
    const listener = () => { if (armed) throw failure; };
    if (phase === "afterAllTransactions") doc.on(phase, listener);
    const a = openNativeScript(doc), history = openNativeUndo(a);
    try {
      assert.equal(typeNativeText(a, caret(a, "A", 0), "x", {}).kind, "written");
      if (action === "redo") assert.equal(history.undo().kind, "written");
      const at = caret(a, "A", 0);
      if (phase !== "afterAllTransactions") doc.on(phase, listener);
      armed = true;
      const run = () => action === "typing" ? typeNativeText(a, at, "y", {}) : history[action]();
      assert.throws(run, failure);
      armed = false;
      const before = stateOf(a);
      assert.deepEqual(typeNativeText(a, at, "z", {}), { kind: "recovery", reason: "busy", runs: [{ text: "z", marks: {} }] });
      assert.deepEqual(history.undo(), { kind: "refused", reason: "busy" });
      assert.deepEqual(stateOf(a), before);
    } finally { history.destroy(); doc.destroy(); }
  });
}

test("a completed Yjs cleanup releases command admission even when afterTransaction throws", () => {
  const { a, b } = fixture(), history = openNativeUndo(a);
  const failure = new Error("observer failure");
  try {
    assert.equal(typeNativeText(a, caret(a, "A", 0), "x", {}).kind, "written");
    a.doc.once("afterTransaction", () => { throw failure; });
    assert.throws(history.undo, failure);
    assert.equal(typeNativeText(a, caret(a, "B", 0), "z", {}).kind, "written");
    assert.equal(a.reader.row("B")?.audioText, "zb");
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("a guarded callback failure after the document event clears is deferred until the next command", () => {
  const { a, b } = fixture(), history = openNativeUndo(a);
  const failure = new Error("reader close failed");
  try {
    a.reader.close = () => { throw failure; };
    const at = caret(a, "A", 0);
    a.doc.once("afterAllTransactions", () => { a.doc.destroy(); });
    assert.equal(typeNativeText(a, at, "x", {}).kind, "written");
    assert.throws(history.undo, failure);
    assert.deepEqual(history.undo(), { kind: "refused", reason: "closed" });
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("explicit capture lasts past 500 ms; the binding and both stack summaries are frozen", async () => {
  const { a, b } = fixture(), history = openNativeUndo(a);
  try {
    assert.equal(Reflect.set(history, "redo", history.undo), false);
    assert.equal(typeNativeText(a, caret(a, "A", 0), "x", {}).kind, "written");
    await new Promise<void>(resolve => setTimeout(resolve, 525));
    assert.equal(typeNativeText(a, caret(a, "A", 0), "y", {}).kind, "written");
    assert.equal(Reflect.set(history.undoStack, "0", -1), false);
    assert.equal(history.undoStack.length, 1);
    assert.equal(history.undo().kind, "written");
    assert.equal(a.reader.row("A")?.audioText, "a");
    assert.equal(Reflect.set(history.redoStack, "0", -1), false);
    assert.equal(history.redo().kind, "written");
    assert.equal(a.reader.row("A")?.audioText, "yxa");
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

function peerDuringLocal(phase: "beforeTransaction" | "afterTransaction" | "update" | "afterAllTransactions",
  action: "typing" | "undo" | "redo" | "empty") {
  const { a, b, net } = fixture(), history = openNativeUndo(a);
  try {
    if (action === "undo" || action === "redo") {
      assert.equal(typeNativeText(a, caret(a, "A", 0), "x", {}).kind, "written");
      if (action === "redo") assert.equal(history.undo().kind, "written");
    }
    const at = caret(a, "A", 0);
    assert.equal(typeNativeText(b, caret(b, "B", 0), "P", {}).kind, "written");
    const packet = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
    a.doc.once(phase, () => { Y.applyUpdate(a.doc, packet, "remote"); });
    const outcome = action === "typing" ? typeNativeText(a, at, "x", {}) : history[action === "redo" ? "redo" : "undo"]();
    assert.equal(outcome.kind, "written");
    assert.equal(a.reader.row("B")?.audioText, "Pb");
    if (action === "empty") {
      assert.deepEqual(outcome, { kind: "written", entry: null });
      assert.equal(history.redoStack.length, 1);
    }
    net.settle();
    assert.equal(b.reader.row("B")?.audioText, "Pb");
    const inverse = action === "undo" || action === "empty" ? history.redo() : history.undo();
    assert.equal(inverse.kind, "written");
    net.settle();
    const expected = phase === "beforeTransaction" ? "b" : "Pb";
    for (const copy of [a, b]) assert.equal(copy.reader.row("B")?.audioText, expected);
    net.agree();
  } finally { history.destroy(); a.doc.destroy(); b.doc.destroy(); }
}

test("stock Yjs: peer packets nested in beforeTransaction are captured under the local origin", () => {
  for (const action of ["typing", "undo", "redo", "empty"] as const) peerDuringLocal("beforeTransaction", action);
});

test("stock Yjs: peer packets during cleanup and afterAllTransactions keep their remote origin", () => {
  for (const phase of ["afterTransaction", "update", "afterAllTransactions"] as const) {
    for (const action of ["typing", "undo", "redo"] as const) peerDuringLocal(phase, action);
  }
});
