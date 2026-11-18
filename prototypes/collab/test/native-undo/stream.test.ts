import assert from "node:assert/strict";
import test from "node:test";
import type { Delivery } from "../../src/native-undo/harness.ts";
import { narration, settled, world } from "./kit.ts";

const ROWS = [{ id: "R1", audioText: "--" }, { id: "R2", audioText: "==" }];

for (const mode of ["forward", "reverse", "twice"] as const satisfies readonly Delivery[]) test(`undo and redo while another person's keystrokes arrive one by one (${mode})`, () => {
  const w = world(ROWS);
  let typedByB = 0;
  for (let round = 0; round < 30; round++) {
    w.clock += 150;
    const b = w.copy("B").replica, beat = round % 3 === 0 ? "R2" : "R1", cell = b.cell(beat, "audioText");
    w.type("B", beat, "audioText", Math.floor((cell.end - cell.start) / 2), "q"); typedByB++;
    w.deliver("B", "A", mode, 1);
    const a = w.copy("A").replica.cell("R1", "audioText");
    if (round % 7 === 6) w.undo("A");
    else if (round % 7 === 3) w.redo("A");
    else w.type("A", "R1", "audioText", a.end - a.start, round % 4 === 3 ? " " : "w");
    w.deliver("A", "B", mode, 1);
    w.deliver("A", "C", mode, 1); w.deliver("B", "C", mode, 1);
  }
  settled(w, "end");
  const text = narration(w, "R1") + narration(w, "R2");
  assert.equal([...text].filter(char => char === "q").length, typedByB);
  while (w.undo("A")) w.deliver("A", "B", mode, 1);
  settled(w, "all of A undone");
  assert.equal(narration(w, "R1").replace(/q/g, ""), "--");
  assert.equal([...narration(w, "R1") + narration(w, "R2")].filter(char => char === "q").length, typedByB);
});

test("undo of a group whose letters another person's letters arrived between takes back only one's own", () => {
  const w = world(ROWS);
  for (const char of "word") {
    w.clock += 100;
    const a = w.copy("A").replica.cell("R1", "audioText");
    w.type("A", "R1", "audioText", a.end - a.start - 1, char);
    w.settle();
    const b = w.copy("B").replica.cell("R1", "audioText");
    w.type("B", "R1", "audioText", b.end - b.start - 1, char.toUpperCase());
    w.settle();
  }
  assert.equal(narration(w, "R1"), "-wWoOrRdD-");
  assert.ok(w.undo("A"));
  assert.deepEqual(settled(w, "undo"), ["R1: -WORD- (todo)", "R2: == (todo)"]);
  assert.ok(w.redo("A"));
  assert.deepEqual(settled(w, "redo"), ["R1: -wWoOrRdD- (todo)", "R2: == (todo)"]);
});
