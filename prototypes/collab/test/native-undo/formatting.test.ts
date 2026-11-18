import assert from "node:assert/strict";
import test from "node:test";
import { narration, settled, world } from "./kit.ts";

test("finding F1: B bolds abcd, A types plain oo inside it having seen the bold, B undoes: the part after A's letters stays bold", () => {
  const w = world([{ id: "R1", audioText: "abcd" }]);
  w.command("B", [{ do: "format", beat: "R1", field: "audioText", from: 0, to: 4, mark: "b", on: true }]); settled(w, "bold");
  w.type("A", "R1", "audioText", 2, "oo"); settled(w, "plain inside");
  assert.equal(narration(w, "R1"), "[ab|b]oo[cd|b]");
  assert.ok(w.undo("B"));
  settled(w, "undo");
  assert.equal(narration(w, "R1"), "aboo[cd|b]");
  assert.deepEqual(w.stats.markMismatches.map(mismatch => [mismatch.char.split(" ")[1], mismatch.kind, mismatch.expected]), [["\"c\"", "b", false], ["\"d\"", "b", false]]);
});

test("finding F2: A types tagged text next to C's tagged typing, taking C's tag; C's undo of that typing takes the tag off A's letter", () => {
  const w = world([{ id: "R1", audioText: "abcd", visualText: "xy" }]);
  w.type("C", "R1", "visualText", 1, "run", ["t:T1"]); settled(w, "C typed");
  w.type("A", "R1", "visualText", 3, "s", ["t:T1"]); settled(w, "A typed");
  assert.equal(w.copy("A").replica.rows()[0]?.visual.map(item => item.insert).join(""), "xrusny");
  assert.ok(w.undo("C"));
  settled(w, "C undo");
  const visual = w.copy("B").replica.rows()[0]?.visual ?? [];
  assert.deepEqual(visual.map(item => [item.insert, Object.keys(item.attributes ?? {}).length > 0]), [["xsy", false]]);
  assert.equal(w.stats.markMismatches.length, 1);
});
