import test from "node:test";
import assert from "node:assert/strict";
import { deliveryOrders } from "../delivery.ts";
import {
  runConcurrentStatus, runDoubleDelete, runEmptyBeatInsert, runHeldSelection, runHonestDeletion, runIdenticalTag, runInsideRange, runLaterFormat, runLongChain,
  runPositionControl, runRedoAfterRemote, runRestoredChain, runSemanticStatus, runSequentialStatus, runStatusPrior, runStatusRedo, runStatusUsedUp, runT21, runT21Scalar,
  runThrowingUndo
} from "./cases.ts";
import type { UndoWriter } from "./cases.ts";
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

test("Stage 1 record fixture: undo after the other writer typed inside the undone insertion", () => everyOrder(2, runInsideRange));
test("Stage 1 record fixture: undo after a remote insertion before the undone text", () => everyOrder(1, runPositionControl));
test("Stage 1 record fixture: redo after undo with a remote insertion elsewhere", () => everyOrder(4, order => runRedoAfterRemote(order, false)));
test("Stage 1 record fixture: redo after undo with a remote insertion at the undone gap", () => everyOrder(3, order => runRedoAfterRemote(order, true)));
test("Stage 1 record fixture: insert into an empty beat, then undo", () => everyOrder(2, runEmptyBeatInsert));
test("Stage 1 record fixture: bold one character, delete and undo it 64 times, then undo the bold", () => everyOrder(1, runLongChain));
test("Stage 1 record fixture: an undo that throws keeps its entry", () => everyOrder(2, runThrowingUndo));
test("Stage 1 record fixture: a selection held over deleted and restored text follows the restored characters", () => everyOrder(1, runHeldSelection));
test("Stage 1 record fixture: insert, bold and delete one character; three undos and three redos", () => everyOrder(7, runRestoredChain));
test("Stage 1 record fixture: honest deletion of a stale span, then undo", () => everyOrder(2, runHonestDeletion));
test("Stage 1 T21: bold over a range the other writer typed into, then undo", () => everyOrder(2, runT21));
test("Stage 1 T21 scalar: the undo of a status that lost a conflict is used up; the next undo removes the earlier insertion", () => everyOrder(3, runT21Scalar));
test("Stage 1 record fixture, former limit later-format: a format undo leaves the other writer's later formatting", () => everyOrder(2, runLaterFormat));
test("Stage 1 record fixture, former limit sequential-status: a writer's second status undo reaches the first value", () => everyOrder(3, runSequentialStatus));
test("Stage 1 record fixture: status prior value after an identical undo", () => everyOrder(1, runStatusPrior));
test("Stage 1 record fixture: an identical-status undo that changes nothing is used up before the earlier insertion", () => everyOrder(3, runStatusUsedUp));

for (const first of WRITERS) {
  test(`Stage 1 record fixture: delete also made by the other writer, ${first} undoes first`, () => everyOrder(2, order => runDoubleDelete(order, first, false)));
  test(`Stage 1 record fixture: identical tag, ${first} undoes first`, () => everyOrder(4, order => runIdenticalTag(order, first)));
  for (const same of [true, false]) {
    test(`Stage 1 record fixture: ${same ? "identical" : "different"} concurrent statuses, ${first} undoes first`, () => everyOrder(same ? 3 : 5, order => runConcurrentStatus(order, same, first)));
  }
}

for (const identical of [true, false]) for (const undo of UNDO_LISTS) {
  test(`Stage 1 record fixture: semantic undo ${undo.join(", ")} of ${identical ? "identical" : "different"} two-event status branches`, () => everyOrder(2, order => runSemanticStatus(order, identical, undo)));
}

test("Stage 1 record fixture, former limit status-redo-conflict: the undo of a status that lost a conflict is used up, so nothing is left to redo", () => everyOrder(3, runStatusRedo));
