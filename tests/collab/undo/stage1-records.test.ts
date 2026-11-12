import test from "node:test";
import assert from "node:assert/strict";
import { deliveryOrders } from "../delivery.ts";
import {
  runConcurrentStatus, runDoubleDelete, runEmptyBeatInsert, runHeldSelection, runHonestDeletion, runIdenticalTag, runInsideRange, runLaterFormat, runLongChain,
  runPositionControl, runRedoAfterRemote, runRestoredChain, runSemanticStatus, runSequentialStatus, runStatusPrior, runStatusRedo, runStatusUsedUp, runT21, runT21Scalar,
  runThrowingUndo
} from "./cases.ts";
import type { UndoWriter } from "./cases.ts";
import { UNDO_WORLDS } from "./scenario.ts";
import type { UndoScenario } from "./scenario.ts";

const WRITERS: readonly UndoWriter[] = ["Alice", "Bob"];
const UNDO_LISTS: readonly (readonly UndoWriter[])[] = [["Alice"], ["Bob"], ["Alice", "Bob"], ["Bob", "Alice"]];

function everyOrder(checks: number, run: (order: typeof deliveryOrders[number]) => UndoScenario): void {
  let runs = 0;
  for (const order of deliveryOrders) {
    assert.equal(run(order).checks, checks, order);
    runs++;
  }
  assert.equal(runs, 6);
}

for (const kind of UNDO_WORLDS) {
  const on = kind.suffix;
  test("Stage 1 record fixture: undo after the other writer typed inside the undone insertion" + on, () => everyOrder(2, order => runInsideRange(order, kind)));
  test("Stage 1 record fixture: undo after a remote insertion before the undone text" + on, () => everyOrder(1, order => runPositionControl(order, kind)));
  test("Stage 1 record fixture: redo after undo with a remote insertion elsewhere" + on, () => everyOrder(4, order => runRedoAfterRemote(order, false, kind)));
  test("Stage 1 record fixture: redo after undo with a remote insertion at the undone gap" + on, () => everyOrder(3, order => runRedoAfterRemote(order, true, kind)));
  test("Stage 1 record fixture: insert into an empty beat, then undo" + on, () => everyOrder(2, order => runEmptyBeatInsert(order, kind)));
  test("Stage 1 record fixture: bold one character, delete and undo it 64 times, then undo the bold" + on, () => everyOrder(1, order => runLongChain(order, kind)));
  test("Stage 1 record fixture: an undo that throws keeps its entry" + on, () => everyOrder(2, order => runThrowingUndo(order, kind)));
  test("Stage 1 record fixture: a selection held over deleted and restored text follows the restored characters" + on, () => everyOrder(1, order => runHeldSelection(order, kind)));
  test("Stage 1 record fixture: insert, bold and delete one character; three undos and three redos" + on, () => everyOrder(7, order => runRestoredChain(order, kind)));
  test("Stage 1 record fixture: honest deletion of a stale span, then undo" + on, () => everyOrder(2, order => runHonestDeletion(order, kind)));
  test("Stage 1 T21: bold over a range the other writer typed into, then undo" + on, () => everyOrder(2, order => runT21(order, kind)));
  test("Stage 1 T21 scalar: the undo of a status that lost a conflict is used up; the next undo removes the earlier insertion" + on, () => everyOrder(3, order => runT21Scalar(order, kind)));
  test("Stage 1 record fixture, former limit later-format: a format undo leaves the other writer's later formatting" + on, () => everyOrder(2, order => runLaterFormat(order, kind)));
  test("Stage 1 record fixture, former limit sequential-status: a writer's second status undo reaches the first value" + on, () => everyOrder(3, order => runSequentialStatus(order, kind)));
  test("Stage 1 record fixture: status prior value after an identical undo" + on, () => everyOrder(1, order => runStatusPrior(order, kind)));
  test("Stage 1 record fixture: an identical-status undo that changes nothing is used up before the earlier insertion" + on, () => everyOrder(3, order => runStatusUsedUp(order, kind)));

  for (const first of WRITERS) {
    test(`Stage 1 record fixture: delete also made by the other writer, ${first} undoes first` + on, () => everyOrder(2, order => runDoubleDelete(order, first, false, kind)));
    test(`Stage 1 record fixture: identical tag, ${first} undoes first` + on, () => everyOrder(4, order => runIdenticalTag(order, first, kind)));
    for (const same of [true, false]) {
      test(`Stage 1 record fixture: ${same ? "identical" : "different"} concurrent statuses, ${first} undoes first` + on, () => everyOrder(same ? 3 : 5, order => runConcurrentStatus(order, same, first, kind)));
    }
  }

  for (const identical of [true, false]) for (const undo of UNDO_LISTS) {
    test(`Stage 1 record fixture: semantic undo ${undo.join(", ")} of ${identical ? "identical" : "different"} two-event status branches` + on, () => everyOrder(2, order => runSemanticStatus(order, identical, undo, kind)));
  }

  test("Stage 1 record fixture, former limit status-redo-conflict: the undo of a status that lost a conflict is used up, so nothing is left to redo" + on, () => everyOrder(3, order => runStatusRedo(order, kind)));
}
