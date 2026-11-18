import assert from "node:assert/strict";
import test from "node:test";
import type * as Y from "yjs";
import { runHistory } from "../../src/native-undo/generator.ts";
import { CheckFailure } from "../../src/native-undo/harness.ts";
import type { World } from "../../src/native-undo/harness.ts";
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

test("output control: a second change notification during one press fails", () => {
  const w = base(), b = w.copy("B");
  b.layer.manager.on("stack-item-popped", () => { b.replica.doc.transact(() => { b.replica.doc.getMap("meta").set("touched", true); }, "tamper"); });
  assert.throws(() => w.undo("B"), (error: Error) => error instanceof CheckFailure && /2 change notifications|made 2 change notifications/.test(error.message));
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
  w.undo("A");
  w.settle();
  assert.throws(() => w.check(), (error: Error) => error instanceof CheckFailure);
});
