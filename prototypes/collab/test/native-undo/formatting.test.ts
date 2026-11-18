import assert from "node:assert/strict";
import test from "node:test";
import { narration, settled, world } from "./kit.ts";

for (const scheme of ["act", "name"] as const) {
  test(`F1 with ${scheme} keys: plain insertion inside someone else's bold leaves the tail bold after undo`, () => {
    const w = world([{ id: "R1", audioText: "abcd" }], { scheme });
    w.command("B", [{ do: "format", beat: "R1", field: "audioText", from: 0, to: 4, mark: "b", on: true }]);
    assert.deepEqual(settled(w, "bold"), ["R1: [abcd|b] (todo)"]);
    w.type("A", "R1", "audioText", 2, "oo");
    assert.deepEqual(settled(w, "typed"), ["R1: [ab|b]oo[cd|b] (todo)"]);
    assert.ok(w.undo("B"));
    assert.deepEqual(settled(w, "undid bold"), ["R1: aboo[cd|b] (todo)"]);
    assert.equal(narration(w, "R1"), "aboo[cd|b]");
    assert.deepEqual(w.stats.markMismatches.map(mismatch => [mismatch.char.split(" ")[1], mismatch.kind, mismatch.expected]), [["\"c\"", "b", false], ["\"d\"", "b", false]]);
    assert.equal(w.stats.formatRemains, 1);
  });

  test(`F2 with ${scheme} keys: undo removes another person's inherited tag while keeping their text`, () => {
    const w = world([{ id: "R1", audioText: "abcd", visualText: "xy" }], { scheme });
    w.type("C", "R1", "visualText", 1, "run", ["t:T1"]);
    assert.deepEqual(settled(w, "tagged typing"), ["R1: abcd / x[run|t:T1]y (todo)"]);
    w.type("A", "R1", "visualText", 3, "s", ["t:T1"]);
    assert.deepEqual(settled(w, "typed inside tag"), ["R1: abcd / x[rusn|t:T1]y (todo)"]);
    assert.equal(w.copy("A").replica.rows()[0]?.visual.map(item => item.insert).join(""), "xrusny");
    assert.ok(w.undo("C"));
    assert.deepEqual(settled(w, "undid tagged typing"), ["R1: abcd / xsy (todo)"]);
    const visual = w.copy("B").replica.rows()[0]?.visual ?? [];
    assert.deepEqual(visual.map(item => [item.insert, Object.keys(item.attributes ?? {}).length > 0]), [["xsy", false]]);
    assert.equal(w.stats.markMismatches.length, 1);
    assert.equal(w.stats.inheritedTagLost, 1);
  });
}
