import { test } from "node:test";
import assert from "node:assert/strict";
import { createEditorSelection, createSelectionModel } from "../../../src/application/editing/selection.ts";
import { cellKeys } from "../../../src/core/text/selection.ts";
import type { SelectionField } from "../../../src/core/text/selection.ts";

function fakeDocument() {
  const doc = {
    epoch: 1,
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Mine one." },
      { id: "r2", visualText: "Close", audioText: "Mine two." }
    ]
  };
  const model = createSelectionModel({
    epoch: () => doc.epoch,
    order: () => doc.rows.map((r) => r.id),
    keys: (rowId: string, field: SelectionField) => {
      const row = doc.rows.find((r) => r.id === rowId);
      return row ? cellKeys([{ text: row[field], marks: {} }]) : null;
    }
  });
  return { doc, model };
}

const taken = (rowId: string, anchor: number, head: number, text: string, epoch = 1) => ({
  epoch: epoch,
  order: ["r1", "r2"],
  rowId: rowId,
  field: "audioText" as const,
  anchor: anchor,
  head: head,
  affinity: "backward" as const,
  keys: cellKeys([{ text: text, marks: {} }])
});

test("a remembered selection carries the document epoch and resolves against the document as it is now", () => {
  const { doc, model } = fakeDocument();
  const sel = model.remember(taken("r2", 5, 5, "Mine two."));
  assert.deepEqual(sel, { epoch: 1, rowId: "r2", field: "audioText", anchor: 5, head: 5, affinity: "backward" });
  const second = doc.rows[1];
  assert.ok(second);
  second.audioText = "Now Mine two.";
  assert.deepEqual(model.resolve(), { epoch: 1, rowId: "r2", field: "audioText", anchor: 9, head: 9, affinity: "backward" });
  assert.equal(model.snapshot()?.keys.join(""), "Mine two.", "resolving does not move what the selection was taken against");
});

test("the selection is taken against the text the editor showed, so typing not yet in the model still maps", () => {
  const { model } = fakeDocument();
  model.remember(taken("r1", 10, 10, "Mine one!!."));
  assert.equal(model.resolve()?.head, 8, "the two typed characters are not in the model: the caret between them falls back to the word before them");
  model.remember(taken("r1", 11, 11, "Mine one!!."));
  assert.equal(model.resolve()?.head, 9, "the caret after the full stop stays after it");
});

test("the selection keeps the epoch and the scene order the editor was drawn from, not the document's newer ones", () => {
  const { doc, model } = fakeDocument();
  doc.epoch = 2;
  model.remember(taken("r1", 2, 2, "Mine one.", 1));
  assert.equal(model.resolve(), null, "drawn from the old document: nothing to place in the new one");
  model.remember(taken("r2", 2, 2, "Mine two.", 2));
  doc.rows.splice(1, 1);
  assert.deepEqual(model.resolve(), { epoch: 2, rowId: "r1", field: "audioText", anchor: 9, head: 9, affinity: "backward" },
    "the scene the editor showed after r1 is gone: the end of r1");
});

test("a new document epoch drops the selection for good; forget drops it too", () => {
  const { doc, model } = fakeDocument();
  model.remember(taken("r1", 2, 2, "Mine one."));
  doc.epoch = 2;
  assert.equal(model.resolve(), null);
  doc.epoch = 1;
  assert.equal(model.resolve(), null, "it does not come back when the counter would match again");
  model.remember(taken("r1", 2, 2, "Mine one."));
  model.forget();
  assert.equal(model.resolve(), null);
  assert.equal(model.snapshot(), null);
});

function fakeEditor() {
  const doc = { epoch: 1, rows: [{ id: "r1", audioText: "Mine one." }] };
  const editor = createEditorSelection<object, string, string>({
    epoch: () => doc.epoch,
    order: () => doc.rows.map((r) => r.id),
    keys: (rowId: string, field: SelectionField) => {
      const row = doc.rows.find((r) => r.id === rowId);
      return row && field === "audioText" ? cellKeys([{ text: row.audioText, marks: {} }]) : null;
    }
  });
  return { doc, editor };
}

test("the editor selection remembers and resolves like the model it is built on", () => {
  const { doc, editor } = fakeEditor();
  editor.remember(taken("r1", 4, 4, "Mine one."));
  assert.equal(editor.snapshot()?.selection.head, 4);
  assert.equal(editor.resolve()?.head, 4);
  doc.epoch = 2;
  assert.equal(editor.resolve(), null, "a new document drops it");
  editor.remember(taken("r1", 4, 4, "Mine one.", 2));
  editor.forget();
  assert.equal(editor.resolve(), null);
});

test("a painted surface keeps the epoch it was painted at; an unpainted one reads the document's epoch now", () => {
  const { doc, editor } = fakeEditor();
  const rows = {};
  const writer = {};
  editor.notePainted(rows);
  doc.epoch = 3;
  assert.equal(editor.paintedEpoch(rows), 1);
  assert.equal(editor.paintedEpoch(writer), 3);
  editor.notePainted(rows);
  assert.equal(editor.paintedEpoch(rows), 3, "painting again takes the new epoch");
});

test("the link target is held with its cell until it is dropped, and a new hold replaces the old one", () => {
  const { editor } = fakeEditor();
  assert.equal(editor.heldLink(), null);
  editor.holdLink("range a", "cell a");
  assert.deepEqual(editor.heldLink(), { range: "range a", cell: "cell a" });
  editor.holdLink("range b", "cell b");
  assert.deepEqual(editor.heldLink(), { range: "range b", cell: "cell b" });
  editor.dropLink();
  assert.equal(editor.heldLink(), null);
  editor.dropLink();
  assert.equal(editor.heldLink(), null, "dropping twice is harmless");
});
