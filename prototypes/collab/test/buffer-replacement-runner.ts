import assert from "node:assert/strict";
import type { BufferHarness } from "../src/buffer-harness.ts";
import type { DeliveryOrder } from "../src/delivery.ts";
import type { ReplacementIntentFixture } from "./buffer-replacements.ts";

export function runReplacementIntent(harness: BufferHarness, fixture: ReplacementIntentFixture, order: DeliveryOrder): void {
  const alice = harness.alice;
  alice.paint("R1", 4, 7);
  alice.dispatch({ type: "beforeinput", from: 4, to: 7, data: fixture.data, names: fixture.names });
  if (fixture.remote !== null) harness.bob.editor.insert("R1", fixture.remote, "n", ["b1"]);
  if (order !== "D1") harness.queue.deliverFrom("B", order);
  assert.deepEqual(alice.plan(), { from: 4, to: 7, insert: fixture.data });
  alice.commit(fixture.names);
  harness.queue.flush(order);
  harness.check(fixture.expected);
  for (const session of harness.sessions.values()) {
    const live = session.editor.characters();
    for (const name of ["s5", "s6", "s7"]) assert.equal(live.some(character => harness.identities.notation(character.identity) === name), false);
  }
  alice.undo();
  harness.queue.flush(order);
  harness.check(fixture.undo);
  assert.equal(alice.dirty, false);
  assert.equal(harness.queue.pending.length, 0);
}
