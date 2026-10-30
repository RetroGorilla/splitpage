import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bulkDeleteArmed,
  clearProductionSelection,
  deleteConfirmation,
  disarmBulkDelete,
  productionEditingStarted,
  productionSelection,
  pruneProductionSelection,
  resetProductionPanelState,
  tagPanelState,
  selectedKeys,
  startProductionEditing
} from "../../src/bootstrap/wiring/production-editing-owners.ts";
import { wireProductionEditing } from "../../src/bootstrap/wiring/production-editing.ts";

function clock() {
  const pending = new Map<unknown, () => void>();
  let serial = 0;
  return {
    pending,
    start(run: () => void): unknown { const id = ++serial; pending.set(id, run); return id; },
    stop(handle: unknown): void { pending.delete(handle); }
  };
}

test("production editing is explicit, rejects duplicate starts and exposes one owner for each responsibility", () => {
  const timers = clock();
  assert.equal(productionEditingStarted(), false);
  assert.throws(deleteConfirmation, /not started yet/);
  assert.throws(productionSelection, /not started yet/);
  const stop = wireProductionEditing(timers);
  try {
    assert.equal(productionEditingStarted(), true);
    assert.throws(() => startProductionEditing(timers), /already started/);
    assert.equal(deleteConfirmation(), deleteConfirmation());
    assert.equal(productionSelection(), productionSelection());
    deleteConfirmation().arm("row", "r1", () => {});
    productionSelection().toggle("hat");
    productionSelection().arm(() => {});
    assert.deepEqual(selectedKeys(), ["hat"]);
    assert.equal(bulkDeleteArmed(), true);
    disarmBulkDelete();
    assert.equal(bulkDeleteArmed(), false);
    productionSelection().arm(() => {});
    pruneProductionSelection([]);
    assert.deepEqual(selectedKeys(), []);
    assert.equal(bulkDeleteArmed(), false);
    productionSelection().toggle("coat");
    clearProductionSelection();
    assert.deepEqual(selectedKeys(), []);
    assert.equal(productionSelection().anchorKey(), null);
    productionSelection().arm(() => assert.fail("disposed"));
    stop();
    assert.equal(timers.pending.size, 0);
    assert.equal(productionEditingStarted(), false);
    assert.throws(deleteConfirmation, /not started yet/);
    assert.throws(selectedKeys, /not started yet/);
    const stopAgain = startProductionEditing(timers);
    try {
      stop();
      assert.equal(productionEditingStarted(), true);
      assert.equal(deleteConfirmation().armedId("row"), null);
      assert.deepEqual(selectedKeys(), []);
    } finally {
      stopAgain();
    }
  } finally {
    stop();
  }
  assert.equal(productionEditingStarted(), false);
});

test("release clears the bridge and attempts every timer cancellation even when a port throws", () => {
  const stopped: unknown[] = [];
  let serial = 0;
  const stop = startProductionEditing({
    start() { return ++serial; },
    stop(handle) { stopped.push(handle); if (handle === 1) throw new Error("stop failed"); }
  });
  deleteConfirmation().arm("row", "r1", () => {});
  deleteConfirmation().arm("comment", "c1", () => {});
  deleteConfirmation().arm("tag", "t1", () => {});
  productionSelection().arm(() => {});
  stopped.length = 0;
  assert.throws(stop, /Delete confirmation timers failed to stop/);
  assert.deepEqual(stopped, [1, 2, 3, 4]);
  assert.equal(productionEditingStarted(), false);
  stop();
});
test("panel reset clears tag UI, tag confirmation and production selection in order, retaining row and comment confirmations", () => {
  const seen: unknown[] = [];
  let serial = 0;
  const stop = startProductionEditing({
    start() { return ++serial; },
    stop(handle) { seen.push([handle, panel.tagRenamingKey(), selection.selectedKeys()]); }
  });
  const selection = productionSelection();
  const panel = tagPanelState();
  try {
    deleteConfirmation().arm("row", "r1", () => {});
    deleteConfirmation().arm("comment", "c1", () => {});
    deleteConfirmation().arm("tag", "t1", () => {});
    productionSelection().toggle("hat");
    productionSelection().arm(() => {});
    panel.setTagRenaming("hat");
    panel.setTagAddingPerson("hat");
    panel.setTagExpanded("hat");
    panel.setProductionGroupBy("person");
    seen.length = 0;
    resetProductionPanelState();
    assert.deepEqual(seen, [[3, null, ["hat"]], [4, null, []]]);
    assert.equal(deleteConfirmation().armedId("tag"), null);
    assert.equal(deleteConfirmation().armedId("row"), "r1");
    assert.equal(deleteConfirmation().armedId("comment"), "c1");
    assert.equal(panel.tagRenamingKey(), null);
    assert.equal(panel.tagAddingPersonKey(), null);
    assert.equal(panel.tagExpandedKey(), null);
    assert.equal(panel.productionGroupBy(), "cat");
    assert.deepEqual(selectedKeys(), []);
    assert.equal(productionSelection().anchorKey(), null);
    assert.equal(bulkDeleteArmed(), false);
  } finally {
    stop();
  }
});