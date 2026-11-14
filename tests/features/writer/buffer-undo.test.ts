import { test } from "node:test";
import assert from "node:assert/strict";
import { bufferedWriter } from "./buffer-support.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import type { SharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { sharedUndoActions } from "../../../src/application/editing/undo/shared-undo-actions.ts";
import { sharedUndoOwner } from "../../../src/bootstrap/wiring/ports/shared-undo.ts";

function writerWithUndo() {
  const held: { owner: SharedUndo | null } = { owner: null };
  let serial = 0;
  const page = bufferedWriter("ab", true, undefined, undefined, { undo: h => {
    registerSharedUndoOperationHandlers(h.a);
    const owner = sharedUndoOwner(h.a, () => ({ id: "undo" + ++serial, by: "Alice" }), () => 0);
    held.owner = owner;
    return owner;
  } });
  const made = held.owner;
  assert.ok(made);
  return { page, owner: made, actions: sharedUndoActions(page.a.session, made) };
}

test("D32 (d): Ctrl+Z with a keystroke the field has not committed yet commits it through the admission first, then takes it back", () => {
  const { page, owner, actions } = writerWithUndo();
  try {
    assert.equal(page.native(2, 2, "x", undefined, "insertText", "R1", false), true);
    assert.deepEqual([page.text(), page.a.executed.length, owner.sizes().undo], ["ab", 0, 0]);
    const undone = actions.undo();
    assert.deepEqual(undone.ok && [undone.effective, undone.label], [true, "typing"]);
    assert.deepEqual([page.text(), page.a.executed.length, page.a.described.map(entry => entry?.typing), owner.sizes()],
      ["ab", 1, ["x"], { undo: 0, redo: 1, dropped: 0 }]);
    assert.equal(actions.redo().ok, true);
    assert.deepEqual([page.text(), owner.sizes(), page.reports], ["abx", { undo: 1, redo: 0, dropped: 0 }, []]);
  } finally { page.close(); }
});

test("D32: Writer typing reaches the one undo stack, and one undo takes back the typing group", () => {
  const { page, owner, actions } = writerWithUndo();
  try {
    assert.equal(page.native(2, 2, "x"), true);
    assert.equal(page.native(3, 3, "y"), true);
    assert.deepEqual([page.text(), owner.sizes().undo], ["abxy", 1]);
    assert.equal(actions.undo().ok, true);
    assert.deepEqual([page.text(), owner.sizes(), page.reports], ["ab", { undo: 0, redo: 1, dropped: 0 }, []]);
  } finally { page.close(); }
});
