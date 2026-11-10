import assert from "node:assert/strict";
import type { BufferHarness } from "../../src/buffer-harness.ts";
import type { DeliveryOrder } from "../../src/delivery.ts";
import { RecordBufferHarness } from "../../src/undo-records/buffer.ts";
import { bufferOracles } from "../buffer-oracles.ts";
import type { BufferTrace } from "../buffer-oracles.ts";
import { finishTrace, stageTrace } from "../buffer-runner.ts";
import type { ReplacementIntentFixture } from "../buffer-replacements.ts";

export function bufferOrders(orders: readonly DeliveryOrder[]): DeliveryOrder[] {
  return orders.includes("late-C") ? [...orders] : [...orders, "late-C"];
}

export function runBufferTrace(trace: BufferTrace, order: DeliveryOrder): RecordBufferHarness {
  const harness = new RecordBufferHarness(bufferOracles[trace].seed);
  // why: the shared step script is typed on the library-backed harness; this harness exposes the same public members.
  const shared = harness as unknown as BufferHarness;
  try {
    const names = stageTrace(shared, trace, order);
    finishTrace(shared, trace, order, names);
    return harness;
  } catch (error) {
    harness.destroy();
    throw error;
  }
}

export function runReplacement(fixture: ReplacementIntentFixture, order: DeliveryOrder): RecordBufferHarness {
  const harness = new RecordBufferHarness([{ id: "R1", text: "the the" }]);
  try {
    const alice = harness.alice;
    alice.paint("R1", 4, 7);
    alice.dispatch({ type: "beforeinput", from: 4, to: 7, data: fixture.data, names: fixture.names });
    if (fixture.remote !== null) harness.bob.editor.insert("R1", fixture.remote, "n", ["b1"]);
    if (order !== "D1") harness.queue.deliverFrom("B", order);
    assert.deepEqual(alice.plan(), { from: 4, to: 7, insert: fixture.data });
    alice.commit(fixture.names);
    harness.queue.flush(order);
    if (order === "late-C") harness.lateJoin();
    harness.check(fixture.expected);
    alice.undo();
    harness.queue.flush(order);
    harness.check(fixture.undo);
    assert.equal(alice.dirty, false);
    assert.equal(harness.queue.pending.length, 0);
    return harness;
  } catch (error) {
    harness.destroy();
    throw error;
  }
}

export function attempt(run: () => RecordBufferHarness): string | null {
  try {
    const harness = run();
    try {
      assert.equal(harness.alice.undoManager.undoStack.length, 0);
      assert.equal(harness.alice.commands.undoStack.length, 0);
      assert.equal(harness.alice.commands.redoStack.length, 1);
    } finally {
      harness.destroy();
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
