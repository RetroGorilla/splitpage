import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import type { UndoControl } from "../../../src/application/editing/undo-control.ts";
import { sharedPorts } from "../../../src/bootstrap/wiring/shared-ports.ts";
import { migrateRows } from "../../../src/js/02-state.js";
import {
  breakUndoCoalescing,
  flushEdits,
  lastUndoEntry,
  noteEdit,
  legacyUndoPorts,
  redo,
  startUndo,
  undo,
  undoSizes
} from "../../../src/legacy/undo-bridge.ts";
import { heldDocument, liveSession, startSessionBridge } from "../../../src/legacy/session-bridge.ts";
import { createUndoAdapter, routeReplays } from "../../../src/legacy/undo-adapter.ts";

const control: UndoControl = sharedPorts().undo;

function open(t: TestContext) {
  t.after(startUndo(legacyUndoPorts()));
  const stop = startSessionBridge({
    entry: (raw) => migrateRows(raw),
    undo: { adapter: createUndoAdapter(), route: routeReplays },
    effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: () => {} },
    capability: { edit: () => ({ allowed: true }) },
    editor: { name: () => "Undo control" },
    records: () => null,
    attribution: { attribute: () => null },
    report: (error) => { throw error; },
    timers: { now: () => 1000, start: () => 0, stop: () => {} }
  });
  t.after(stop);
  liveSession().adopt({
    title: "Undo control",
    rows: [{ id: "r1", visualText: "", audioText: "a", updatedAt: "" }]
  });
  const doc = heldDocument();
  assert.ok(doc);
  const row = doc.rows[0];
  assert.ok(row);
  return row;
}

test("undo control exposes exactly the five legacy functions without wrappers", () => {
  assert.equal(sharedPorts().undo, control);
  assert.deepEqual(Object.keys(control).sort(), ["breakCoalescing", "flush", "last", "redo", "undo"]);
  assert.equal(control.breakCoalescing, breakUndoCoalescing);
  assert.equal(control.flush, flushEdits);
  assert.equal(control.undo, undo);
  assert.equal(control.redo, redo);
  assert.equal(control.last, lastUndoEntry);
});

test("flush records pending edits and last returns the original entry without breaking coalescing", (t) => {
  t.mock.method(Date, "now", () => 1000);
  const row = open(t);
  assert.equal(control.last(), null);
  assert.deepEqual(control.undo(), { ok: false, empty: true });
  assert.deepEqual(control.redo(), { ok: false, empty: true });
  row.audioText = "ab";
  noteEdit();
  assert.deepEqual(undoSizes(), { undo: 0, redo: 0 });
  assert.equal(control.flush(), undefined);
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  const entry = lastUndoEntry();
  assert.ok(entry);
  assert.equal(control.last(), entry);
  row.audioText = "abc";
  noteEdit();
  assert.equal(control.last(), entry);
  assert.deepEqual(entry.steps, [{ op: "rowField", rowId: "r1", key: "audioText", before: "a", after: "abc" }]);
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  assert.equal(control.flush(), undefined);
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
});

test("breakCoalescing flushes before the boundary and undo and redo replay the same entries", (t) => {
  t.mock.method(Date, "now", () => 1000);
  const row = open(t);
  row.audioText = "ab";
  noteEdit();
  assert.equal(control.flush(), undefined);
  row.audioText = "abc";
  noteEdit();
  assert.equal(control.breakCoalescing(), undefined);
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  const first = lastUndoEntry();
  assert.ok(first);
  assert.deepEqual(first.steps, [{ op: "rowField", rowId: "r1", key: "audioText", before: "a", after: "abc" }]);
  row.audioText = "abcd";
  noteEdit();
  assert.deepEqual(control.undo(), {
    ok: true,
    steps: [{ op: "rowField", rowId: "r1", key: "audioText", before: "abcd", after: "abc" }]
  });
  assert.equal(row.audioText, "abc");
  assert.deepEqual(undoSizes(), { undo: 1, redo: 1 });
  assert.equal(control.last(), first);
  assert.deepEqual(control.redo(), {
    ok: true,
    steps: [{ op: "rowField", rowId: "r1", key: "audioText", before: "abc", after: "abcd" }]
  });
  assert.equal(row.audioText, "abcd");
  assert.deepEqual(undoSizes(), { undo: 2, redo: 0 });
});
