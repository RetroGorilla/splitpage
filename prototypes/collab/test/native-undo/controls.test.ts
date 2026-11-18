import assert from "node:assert/strict";
import test from "node:test";
import type * as Y from "yjs";
import { runHistory } from "../../src/native-undo/generator.ts";
import type { HistoryOptions } from "../../src/native-undo/generator.ts";
import { CheckFailure } from "../../src/native-undo/harness.ts";
import type { Copy, World, WriteCommand } from "../../src/native-undo/harness.ts";
import { settled, world } from "./kit.ts";

const SEEDS = Array.from({ length: 10 }, (_, seed) => seed);
const options = { steps: 40, pace: "batched", modes: ["forward", "reverse", "twice"] } as const;
const PLAIN = SEEDS.map(seed => runHistory({ seed, ...options }));

function failures(prepare: (world: World) => void): (string | null)[] {
  return SEEDS.map(seed => {
    try {
      runHistory({ seed, ...options, prepare });
      return null;
    } catch (error) {
      assert.ok(error instanceof CheckFailure, String(error));
      return error.message.split("\n")[0] as string;
    }
  });
}

test("control: the same ten generated histories pass unchanged, and between them redo something and edit records", () => {
  assert.deepEqual(failures(() => undefined), SEEDS.map(() => null));
  assert.ok(PLAIN.filter(result => result.stats.redone > 0).length >= 3);
  assert.ok(PLAIN.filter(result => result.steps.some(step => step.act === "command" && step.parts.some(part => part.do === "field"))).length >= 3);
});

test("input control: typing that silently does nothing fails every generated history", () => {
  const found = failures(w => { for (const copy of w.copies) copy.layer.type = () => undefined; });
  assert.ok(found.every(message => message !== null && /created 0 items; the model expected/.test(message)), found.join("\n"));
});

test("input control: undo that silently does nothing fails every generated history", () => {
  const found = failures(w => { for (const copy of w.copies) copy.layer.undo = () => null; });
  assert.ok(found.every(message => message !== null && /undo: the library applied entry null; the model expected \d+/.test(message)), found.join("\n"));
});

test("input control: redo that silently does nothing fails exactly the generated histories in which a redo applies", () => {
  const found = failures(w => { for (const copy of w.copies) copy.layer.redo = () => null; });
  assert.deepEqual(found.map(message => message !== null), PLAIN.map(result => result.stats.redone > 0));
  assert.ok(found.every(message => message === null || /redo: the library applied entry null; the model expected \d+/.test(message)), found.join("\n"));
});

test("input control: a record field write that silently does nothing fails exactly the generated histories that write one", () => {
  const found = failures(w => { for (const copy of w.copies) copy.layer.setRecordField = () => undefined; });
  const writes = PLAIN.map(result => result.steps.some(step => step.act === "command" && step.parts.some(part => part.do === "field")));
  assert.deepEqual(found.map(message => message !== null), writes);
  assert.ok(found.every(message => message === null || /created 0 items; the model expected 1/.test(message)), found.join("\n"));
});

const GENERATED = (["batched", "continuous"] as const).flatMap(pace =>
  Array.from({ length: 300 }, (_, seed): HistoryOptions => ({ ...options, pace, seed })));
const baseline = GENERATED.map(history => runHistory(history).stats.writes);
const noOps: Record<WriteCommand, (copy: Copy) => void> = {
  type: ({ layer }) => { layer.type = () => undefined; },
  erase: ({ layer }) => { layer.erase = () => undefined; },
  format: ({ replica }) => { replica.format = () => undefined; },
  split: ({ replica }) => { replica.split = () => undefined; },
  join: ({ replica }) => {
    const setField = replica.setField.bind(replica);
    replica.setField = (beat, field, value) => { if (field !== "joined") setField(beat, field, value); };
    replica.unjoin = () => undefined;
  },
  field: ({ layer }) => { layer.setRecordField = () => undefined; },
  undo: ({ layer }) => { layer.undo = () => null; },
  redo: ({ layer }) => { layer.redo = () => null; }
};

for (const [command, mute] of Object.entries(noOps) as [WriteCommand, (copy: Copy) => void][]) {
  test(`generated no-op control: ${command} fails every history with an effective write`, t => {
    let used = 0, failed = 0, otherFailures = 0;
    const missed: string[] = [];
    for (const [index, history] of GENERATED.entries()) {
      const changed = baseline[index]?.has(command);
      if (changed) used++;
      try {
        runHistory({ ...history, prepare: w => { w.copies.forEach(mute); } });
        if (changed) missed.push(`${history.pace}/${history.seed}`);
      } catch (error) {
        assert.ok(error instanceof CheckFailure, String(error));
        if (changed) failed++; else otherFailures++;
      }
    }
    t.diagnostic(`${command}: ${used} used, ${failed} failed with an effective write, ${otherFailures} other failures`);
    assert.ok(used > 0);
    assert.deepEqual(missed, []);
    assert.equal(failed, used);
  });
}

function base(): World {
  const w = world([{ id: "R1", audioText: "abcd", visualText: "vw" }]);
  w.command("A", [{ do: "record", root: "tags", id: "T1", fields: { name: "Alpha" } }]);
  w.type("B", "R1", "audioText", 2, "XY");
  settled(w, "base");
  return w;
}

test("output control: a character another person typed, dropped on every copy, fails the check", () => {
  const w = base(), a = w.copy("A").replica;
  a.doc.transact(() => { a.cell("R1", "audioText").text.delete(2, 1); }, "tamper");
  w.settle();
  assert.throws(() => w.check(), (error: Error) => error instanceof CheckFailure && /character "X" \(.*typed by B\) is missing/.test(error.message));
});

test("output control: a record field dropped on every copy fails the check", () => {
  const w = base(), a = w.copy("A").replica;
  a.doc.transact(() => { (a.doc.getMap<Y.Map<unknown>>("tags").get("T1") as Y.Map<unknown>).delete("name"); }, "tamper");
  w.settle();
  assert.throws(() => w.check(), (error: Error) => error instanceof CheckFailure && /\.name .* is missing/.test(error.message));
});

test("output control: an undo stack one entry short fails the check", () => {
  const w = base();
  w.copy("B").layer.manager.undoStack.pop();
  assert.throws(() => w.check(), (error: Error) => error instanceof CheckFailure && /B after check: stacks 0\/0, the model expected 1\/0/.test(error.message));
});

test("output control: a change one copy never sends fails the check", () => {
  const w = base(), a = w.copy("A").replica;
  a.doc.transact(() => { a.cell("R1", "audioText").text.insert(0, "Z"); }, "remote");
  assert.throws(() => w.check(), (error: Error) => error instanceof CheckFailure && /copies differ/.test(error.message));
});

test("output control: a second Yjs update event during one press fails", () => {
  const w = base(), b = w.copy("B");
  b.layer.manager.on("stack-item-popped", () => { b.replica.doc.transact(() => { b.replica.doc.getMap("meta").set("touched", true); }, "tamper"); });
  assert.throws(() => w.undo("B"), (error: Error) => error instanceof CheckFailure && /2 Yjs update events|made 2 Yjs update events/.test(error.message));
});

test("output control: missing counts in the layer fail against the observed Yjs update event", () => {
  const w = base(), b = w.copy("B");
  Object.defineProperty(b.layer, "updates", { get: () => 0, set: () => undefined });
  assert.throws(() => w.undo("B"), (error: Error) => error instanceof CheckFailure && /layer's update count differs/.test(error.message));
});

test("output control: the same wrongly ordered rows on every copy fail the model projection", () => {
  const w = world();
  for (const replica of w.copies.map(copy => copy.replica)) {
    const rows = replica.rows.bind(replica);
    replica.rows = () => rows().reverse();
  }
  const joiner = w.joiner.bind(w);
  w.joiner = () => {
    const replica = joiner(), rows = replica.rows.bind(replica);
    replica.rows = () => rows().reverse();
    return replica;
  };
  assert.throws(() => w.check(), (error: Error) => error instanceof CheckFailure && /projected row order/.test(error.message));
});

test("mutant layer: tracking remote changes as one's own is caught", () => {
  const w = base();
  w.copy("A").layer.manager.trackedOrigins.add("remote");
  w.type("B", "R1", "audioText", 0, "Q");
  w.settle();
  assert.throws(() => w.check(), (error: Error) => error instanceof CheckFailure && /A after check: stacks 2\/0, the model expected 1\/0/.test(error.message));
});

test("mutant layer: a delete filter that lets undo delete a created cell is caught", () => {
  const w = world([{ id: "R1", audioText: "abcd", visualText: "vw" }]);
  w.copy("A").layer.manager.deleteFilter = () => true;
  w.command("A", [{ do: "split", beat: "R1", at: 2, created: "S1" }]);
  assert.throws(() => w.undo("A"), (error: Error) => error instanceof CheckFailure && /root:beats.S1 .* is missing/.test(error.message));
});
