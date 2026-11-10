import assert from "node:assert/strict";
import { test } from "node:test";
import { recordTiming, runDoubleDelete, runEmptyBeatInsert, runHeldSelection, runIdenticalRemoval, runIdenticalRemovalRedo,runIdenticalTag, runInsideRange, runJoinRedo, runJoinTargetRemoved, runLaterFormat, runLongChain, runPositionControl, runRedoAfterRemote, runRedoneMarkReversed, runRedoneRecovery, runRejoin, runRemovedAfterInsert, runRemovedSplit, runReRemoval, runRestoredChain, runSequentialStatus, runSplitAtEnd, runStatusRedo, runThrowingUndo } from "./cases.ts";
import type { CaseResult } from "./cases.ts";

const identicalOrders = ["D1", "dup", "rev", "late-C"] as const;
const followOrders = ["D2", "dup", "late-C"] as const;
const everyOrder = ["D1", "D2", "dup", "rev", "late-C"] as const;

function passes(result: CaseResult): void {
  assert.equal(result.failure, null, result.history.join("\n"));
  assert.ok(result.checks >= 2);
}

for (const order of everyOrder) {
  test(`split at the end of a beat and its undo ${order}`, () => passes(runSplitAtEnd(order)));
  test(`insert into an empty beat and its undo ${order}`, () => passes(runEmptyBeatInsert(order)));
  test(`a 64-step restoration chain still resolves for an older format record ${order}`, () => passes(runLongChain(order)));
  test(`a held selection mapped through the history follows restorations ${order}`, () => passes(runHeldSelection(order)));
  test(`join redo returns the join that won before the undo ${order}`, () => passes(runJoinRedo(order)));
  test(`open question: status redo reasserts a status that had not applied ${order}`, () => passes(runStatusRedo(order)));
  test(`limit: recovery lists a redone character as edited after the removal ${order}`, () => {
    assert.match(runRedoneRecovery(order).failure ?? "", /recovery\[0\]\.edited\[0\]: expected <missing>, got "a1\*"/);
  });
  test(`limit: format undo overwrites the other writer's later bold ${order}`, () => {
    assert.match(runLaterFormat(order).failure ?? "", /Alice undone\/client\d+\.rows\[0\]\.characters\[1\]\.marks\.b: expected true, got <missing>/);
  });
}

test("an undo that throws keeps its entry and writes nothing; the entry below it still undoes", () => passes(runThrowingUndo()));

for (const mark of ["tag", "comment"] as const) {
  test(`limit: a redone ${mark} is lost when the writer's undo and redo updates arrive in reverse`, () => {
    assert.match(runRedoneMarkReversed(mark).failure ?? "", /redone\/client\d+\.rows\[0\]\.characters\[0\]\.marks\.(tag|c:C1): expected (true|"P"), got <missing>/);
  });
}

for (const order of everyOrder) for (const swapped of [false, true]) {
  test(`reader regression: a removal racing an unseen insert retains the edit ${order}, swapped=${swapped}`, () => passes(runRemovedAfterInsert(order, swapped)));
  test(`reader regression: an inherited removal retains the splitter with a direct removal ${order}, swapped=${swapped}`, () => passes(runRemovedSplit(order, swapped)));
  test(`reader regression: a joined source stays inside the removed target ${order}, swapped=${swapped}`, () => passes(runJoinTargetRemoved(order, swapped)));
}

test("a command records after its transaction: an afterTransaction listener sees the edit while the history is still empty", () => {
  const timing = recordTiming();
  assert.ok(timing.listenerSaw.length > 0);
  assert.ok(timing.listenerSaw.every(length => length === 0));
  assert.equal(timing.after, 1);
});

for (const order of identicalOrders) {
  for (const swapped of [false, true]) {
    for (const first of ["Alice", "Bob"] as const) {
      const ids = swapped ? "swapped client ids" : "normal client ids";
      test(`identical simultaneous removal ${order}, ${ids}: ${first}'s undo restores, the other's is consumed`, () => passes(runIdenticalRemoval(order, swapped, first)));
      test(`identical simultaneous tag ${order}, ${ids}: ${first}'s undo untags, the other's is consumed`, () => passes(runIdenticalTag(order, swapped, first)));
    }
  }
  test(`intentional rejoin after both joins were retired ${order}`, () => passes(runRejoin(order)));
  test(`redo of an identical removal restores both writers' removal entries ${order}`, () => passes(runIdenticalRemovalRedo(order)));
  test(`intentional re-removal after both removals were undone ${order}`, () => passes(runReRemoval(order)));
  test(`mechanism control: removal undo without its own-entry check restores the later re-removal ${order}`, () => {
    assert.match(runReRemoval(order, "retire-without-own-entry").failure ?? "", /consumed identical undo reached an older step or wrote state/);
  });
  for (const first of ["Alice", "Bob"] as const) {
    test(`a delete the other writer also made ${order}, ${first} first: both undos restore each character once`, () => passes(runDoubleDelete(order, first, false)));
  }
}

for (const order of followOrders) {
  test(`undo after the other writer typed inside the undone insertion ${order}: their character stays`, () => passes(runInsideRange(order)));
  test(`redo after undo with a remote insertion elsewhere ${order}`, () => passes(runRedoAfterRemote(order, false)));
  test(`redo after undo with a remote insertion at the undone gap ${order}: each character once, replicas agree`, () => passes(runRedoAfterRemote(order, true)));
}

test("identity records survive a remote insertion before the undone text", () => passes(runPositionControl()));

for (const order of followOrders) {
  test(`older records follow a character the same writer's undo restored ${order}: three undos, three redos`, () => passes(runRestoredChain(order)));
  test(`mechanism control: without the shared restoration map an older format record misses the restored character ${order}`, () => {
    assert.match(runRestoredChain(order, "no-restoration-record").failure ?? "", /format undone changed nothing/);
  });
}

test("control: a record holding positions undoes the wrong characters after a remote insertion", () => {
  assert.match(runPositionControl("positions").failure ?? "", /undone\/client\d+\.rows\[0\]\.characters/);
});

for (const order of followOrders) {
  test(`control: undo that deletes the whole inserted span removes the other writer's character ${order}`, () => {
    assert.match(runInsideRange(order, "span-delete").failure ?? "", /undone\/client\d+\.rows\[0\]\.characters\[2\]/);
  });
}

for (const order of identicalOrders) {
  for (const first of ["Alice", "Bob"] as const) {
    test(`control: an ineffective identical undo that falls through reaches an older step ${order}, ${first} first`, () => {
      assert.match(runIdenticalRemoval(order, false, first, "fall-through").failure ?? "", /consumed identical undo reached an older step/);
      assert.match(runIdenticalTag(order, false, first, "fall-through").failure ?? "", /consumed identical undo reached an older step/);
    });
    test(`mechanism control: without shared restoration records the second undo duplicates a character ${order}, ${first} first`, () => {
      assert.match(runDoubleDelete(order, first, false, "no-restoration-record").failure ?? "", /both undone\/client\d+\.rows\[0\]\.characters/);
    });
    test(`mechanism control: per-writer tag occurrence keys keep identical tags apart ${order}, ${first} first`, () => {
      assert.match(runIdenticalTag(order, false, first, undefined, true).failure ?? "", /tagged\/client\d+\.rows\[0\]\.characters\[4\]\.marks/);
    });
  }
  test(`mechanism control: join undo without its own-entry check retires the later rejoin ${order}`, () => {
    assert.match(runRejoin(order, "retire-without-own-entry").failure ?? "", /consumed identical undo reached an older step or wrote state/);
  });
  test(`limit: concurrent undos of a doubly deleted character restore it twice ${order}`, () => {
    assert.match(runDoubleDelete(order, "Alice", true).failure ?? "", /both undone\/client\d+\.rows\[0\]\.characters\[3\]/);
  });
}

for (const order of ["D2", "late-C"] as const) {
  test(`limit: under main's status rule a writer's second status undo changes nothing ${order}`, () => {
    assert.match(runSequentialStatus(order).failure ?? "", /second undo\/client\d+\.rows\[0\]\.status: expected "todo", got "ready"/);
  });
}
