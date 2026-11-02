import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createUndoHistory } from "../application/editing/undo/history.ts";
import { cellRuns } from "./_cell-runs.mjs";

function setup(olderRedo) {
  const history = createUndoHistory(cellRuns);
  const live = { rows: [{ id: "r1", audioText: "Third.", status: "todo" }] };
  if (olderRedo) {
    history.record([{ op: "rowField", rowId: "r1", key: "status", before: "todo", after: "shot" }], 0);
    live.rows[0].status = "shot";
    assert.equal(history.undo(live).ok, true);
  }
  const mark = history.markCell("r1", "audioText", "Third.");
  function type(text, at) {
    history.record([{ op: "rowField", rowId: "r1", key: "audioText", before: live.rows[0].audioText, after: text }], at);
    live.rows[0].audioText = text;
  }
  return { history, live, mark, type };
}

for (const olderRedo of [false, true]) {
  for (const resume of ["none", "update", "redo"]) {
    test(`cancel after undoing its own composition update discards cancelled redo (older=${olderRedo}, resume=${resume}) (#459)`, () => {
      const { history, live, mark, type } = setup(olderRedo);
      type("Third.ね", 5000);
      assert.equal(history.undo(live).ok, true);
      assert.equal(live.rows[0].audioText, "Third.");
      if (resume === "redo") {
        assert.equal(history.redo(live).ok, true);
        assert.equal(history.undo(live).ok, true);
      }
      if (resume !== "none") {
        type("Third.こ", 6100);
        type("Third.", 7200);
      }
      history.dropEmptySince(mark, true);
      assert.deepEqual(history.sizes(), { undo: 0, redo: olderRedo ? 1 : 0 });
      if (olderRedo) {
        assert.equal(history.redo(live).ok, true);
        assert.equal(live.rows[0].status, "shot");
      }
      assert.equal(history.redo(live).empty, true);
      assert.equal(live.rows[0].audioText, "Third.");
    });
  }
}

test("cancelled selection replacement keeps its deletion undoable and no cancelled redo (#459)", () => {
  const { history, live, mark, type } = setup(true);
  type("Thiね", 5000);
  assert.equal(history.undo(live).ok, true);
  type("Thiこ", 6100);
  history.dropEmptySince(mark, true);
  type("Thi", 7200);
  history.dropEmptySince(mark, true);
  assert.deepEqual(history.sizes(), { undo: 1, redo: 0 });
  assert.equal(history.undo(live).ok, true);
  assert.equal(live.rows[0].audioText, "Third.");
  assert.equal(history.redo(live).ok, true);
  assert.equal(live.rows[0].audioText, "Thi");
  assert.equal(history.redo(live).empty, true);
});

test("a merge that forgets an older redo cannot be reversed by cancelling composition (#459)", () => {
  const { history, live, mark, type } = setup(true);
  type("Third.ね", 5000);
  assert.equal(history.undo(live).ok, true);
  history.forget({ rowFields: { "r1\u0000status": true }, structure: false, doc: {}, items: {} });
  type("Third.こ", 6100);
  type("Third.", 7200);
  history.dropEmptySince(mark, true);
  assert.deepEqual(history.sizes(), { undo: 0, redo: 0 });
  assert.equal(history.redo(live).empty, true);
});
