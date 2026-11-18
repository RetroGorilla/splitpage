import assert from "node:assert/strict";
import test from "node:test";
import type * as Y from "yjs";
import type { CreationRule, RecordRoot } from "../../src/native-undo/layer.ts";
import type { World } from "../../src/native-undo/harness.ts";
import { records, seen, settled, world } from "./kit.ts";

const ROWS = [{ id: "R1", audioText: "abcd", visualText: "vw" }];
const RULES: readonly CreationRule[] = ["keep-always", "keep-holding"];

for (const rule of RULES) test(`${rule}: A undoes a split while B's typing in the new visual cell is still in flight`, () => {
  const w = world(ROWS, { creations: rule });
  w.command("A", [{ do: "split", beat: "R1", at: 2, created: "S1" }]); settled(w, "split");
  w.type("B", "S1", "visualText", 0, "V");
  w.undo("A");
  w.settle();
  const losses = w.check("crossing");
  if (rule === "keep-always") {
    assert.deepEqual(seen(w), ["R1: abcd / vw (todo)", "recovery S1:  / V"]);
    assert.deepEqual(losses, []);
    w.redo("A");
    assert.deepEqual(settled(w, "redo"), ["R1: ab / vw (todo)", "S1: cd / V (todo)"]);
  } else {
    assert.deepEqual(seen(w), ["R1: abcd / vw (todo)"]);
    assert.deepEqual(losses.map(loss => [loss.what.split(" in ")[0], loss.author, loss.by, loss.unseen]), [["character \"V\"", "B", "A", true]]);
    w.redo("A");
    assert.deepEqual(settled(w, "redo"), ["R1: ab / vw (todo)", "S1: cd (todo)"]);
  }
});

const CREATED: readonly [RecordRoot, string][] = [["people", "P1"], ["tags", "T1"], ["comments", "C1"]];

for (const rule of RULES) for (const [root, id] of CREATED) test(`${rule}: A undoes creating ${root}/${id} while B's field write is in flight`, () => {
  const w = world(ROWS, { creations: rule });
  w.command("A", [{ do: "record", root, id, fields: { name: "made by A" } }]); settled(w, "created");
  w.command("B", [{ do: "field", root, id, key: "colour", value: "blue" }]);
  w.undo("A");
  w.settle();
  const losses = w.check("crossing");
  assert.deepEqual(records(w)[root], rule === "keep-always" ? { [id]: { colour: "blue" } } : {});
  assert.equal(losses.length, rule === "keep-always" ? 0 : 1);
  w.redo("A"); settled(w, "redo");
  assert.deepEqual(records(w)[root], rule === "keep-always" ? { [id]: { name: "made by A", colour: "blue" } } : { [id]: { name: "made by A" } });
});

test("keep-always: a record created and undone with nobody else touching it is not shown on any copy or a late joiner", () => {
  const w = world(ROWS);
  w.command("A", [{ do: "record", root: "tags", id: "T1", fields: { name: "made by A", colour: "red" } }]);
  w.undo("A"); settled(w, "undone");
  for (const name of ["A", "B", "C"]) assert.deepEqual(records(w, name).tags, {});
  const late = w.joiner();
  assert.equal(late.doc.getMap("tags").size, 1);
  assert.equal(w.snapshot(late), w.snapshot(w.copy("B").replica));
  late.destroy();
});

// why: a write made through a reference taken before another copy's undo and redo of the creation arrived
function agree(w: World): void {
  w.settle();
  const late = w.joiner(), first = w.snapshot(w.copy("A").replica);
  for (const replica of [...w.copies.map(copy => copy.replica), late]) assert.equal(w.snapshot(replica), first);
  late.destroy();
}

for (const rule of RULES) test(`${rule}: B undoes and redoes a split; A types into the new visual cell through the reference it held`, () => {
  const w = world(ROWS, { creations: rule });
  w.command("B", [{ do: "split", beat: "R1", at: 2, created: "S1" }]); settled(w, "split");
  const a = w.copy("A").replica, held = a.visuals.get("S1") as Y.Text;
  w.undo("B"); w.redo("B"); w.settle();
  a.doc.transact(() => { held.insert(0, "Y"); }, a.origin);
  agree(w);
  assert.equal(a.visuals.get("S1") === held, rule === "keep-always");
  assert.deepEqual(seen(w), rule === "keep-always" ? ["R1: ab / vw (todo)", "S1: cd / Y (todo)"] : ["R1: ab / vw (todo)", "S1: cd (todo)"]);
});

for (const rule of RULES) test(`${rule}: B undoes and redoes a split; A sets a field on the new beat's record through the reference it held`, () => {
  const w = world(ROWS, { creations: rule });
  w.command("B", [{ do: "split", beat: "R1", at: 2, created: "S1" }]); settled(w, "split");
  const a = w.copy("A").replica, held = a.beats.get("S1") as Y.Map<unknown>;
  w.undo("B"); w.redo("B"); w.settle();
  a.doc.transact(() => { held.set("status", "ready"); }, a.origin);
  agree(w);
  assert.deepEqual(seen(w), ["R1: ab / vw (todo)", `S1: cd (${rule === "keep-always" ? "ready" : "todo"})`]);
});

for (const rule of RULES) test(`${rule}: B undoes and redoes creating a person; A sets a field through the reference it held`, () => {
  const w = world(ROWS, { creations: rule });
  w.command("B", [{ do: "record", root: "people", id: "P1", fields: { name: "Bea" } }]); settled(w, "created");
  const a = w.copy("A").replica, held = a.doc.getMap<Y.Map<unknown>>("people").get("P1") as Y.Map<unknown>;
  w.undo("B"); w.redo("B"); w.settle();
  a.doc.transact(() => { held.set("colour", "blue"); }, a.origin);
  agree(w);
  assert.deepEqual(records(w).people, rule === "keep-always" ? { P1: { name: "Bea", colour: "blue" } } : { P1: { name: "Bea" } });
});

for (const rule of RULES) test(`${rule}: the same writes resolved by id after the redo arrive are kept`, () => {
  const w = world(ROWS, { creations: rule });
  w.command("B", [{ do: "split", beat: "R1", at: 2, created: "S1" }, { do: "record", root: "people", id: "P1", fields: { name: "Bea" } }]); settled(w, "created");
  w.undo("B"); w.redo("B"); settled(w, "undone and redone");
  w.type("A", "S1", "visualText", 0, "Y");
  w.command("A", [{ do: "field", root: "people", id: "P1", key: "colour", value: "blue" }, { do: "set", beat: "S1", key: "status", value: "ready" }]);
  assert.deepEqual(settled(w, "written by id"), ["R1: ab / vw (todo)", "S1: cd / Y (ready)"]);
  assert.deepEqual(records(w).people, { P1: { name: "Bea", colour: "blue" } });
});
