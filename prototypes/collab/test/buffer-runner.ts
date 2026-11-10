import assert from "node:assert/strict";
import type { BufferHarness } from "../src/buffer-harness.ts";
import type { DeliveryOrder } from "../src/delivery.ts";
import { bufferOracles } from "./buffer-oracles.ts";
import type { BufferTrace } from "./buffer-oracles.ts";

export function stageTrace(harness: BufferHarness, trace: BufferTrace, order: DeliveryOrder): readonly string[] {
  const fixture = bufferOracles[trace];
  const alice = harness.alice;
  const bob = harness.bob.editor;
  alice.paint(fixture.beat, fixture.from, fixture.to);
  if (trace === "T04" || trace === "T04 removed") {
    alice.dispatch({ type: "compositionstart", from: 2, to: 2 });
    alice.dispatch({ type: "compositionupdate", data: "x" });
    if (trace === "T04") {
      bob.insert("R1", 0, "Z", ["b1"]);
      bob.deleteIdentities(["s4"]);
    } else bob.remove("R1", "rB", "Bob");
  } else if (trace === "T01 composition") {
    alice.dispatch({ type: "compositionstart", from: 1, to: 3 });
    alice.dispatch({ type: "compositionupdate", data: "β" });
    bob.insert("R1", 2, "X", ["b1"]);
  } else if (trace === "T02") {
    alice.paintHeld = true;
    bob.insert("R1", 0, "X", ["b1"]);
    harness.queue.deliverFrom("B", order);
    assert.equal(alice.nativeValue, "ab");
    assert.equal(alice.editor.characters().map(character => character.value).join(""), "Xab");
    alice.dispatch({ type: "beforeinput", from: 2, to: 2, data: "c", names: ["a1"] });
    assert.ok(alice.history.includes("cancel stale beforeinput; apply intended model edit through painted identities"));
    return ["a1"];
  } else if (trace === "T02 boundary") {
    alice.dispatch({ type: "beforeinput", from: 0, to: 0, data: "Z", names: ["a1"] });
    bob.insert("R1", 2, "Y", ["b1"]);
  } else if (trace === "T03") {
    for (let end = 7; end > 3; end--) alice.dispatch({ type: "beforeinput", from: end - 1, to: end, data: "", selection: [end, end], names: [] });
    bob.format("R1", 0, 3, { b: true });
  } else if (trace === "T03 replace") {
    alice.dispatch({ type: "beforeinput", from: 4, to: 7, data: "a", names: ["a1"] });
    bob.insert("R1", 7, "n", ["b1"]);
  } else {
    alice.dispatch({ type: "beforeinput", from: 1, to: 3, data: "", names: [] });
    bob.insert("R1", 2, "X", ["b1"]);
  }
  if (order !== "D1") harness.queue.deliverFrom("B", order);
  if (trace === "T04" || trace === "T04 removed") alice.dispatch({ type: "compositionupdate", data: "xy" });
  return trace === "T04" || trace === "T04 removed" ? ["a1", "a2"] : trace === "T01 composition" || trace === "T02 boundary" || trace === "T03 replace" ? ["a1"] : [];
}

export function finishTrace(harness: BufferHarness, trace: BufferTrace, order: DeliveryOrder, names: readonly string[]): void {
  const alice = harness.alice;
  if (alice.composing) alice.dispatch({ type: "compositionend", names: [...names] });
  else if (alice.dirty) alice.commit(names);
  harness.queue.flush(order);
  if (order === "late-C") harness.lateJoin();
  harness.check(bufferOracles[trace].expected);
  alice.undo();
  harness.queue.flush(order);
  harness.check(bufferOracles[trace].undo);
  assert.equal(harness.queue.pending.length, 0);
  for (const session of harness.sessions.values()) {
    assert.equal(session.heldBytes, 0);
    assert.equal(session.held.length, 0);
  }
}
