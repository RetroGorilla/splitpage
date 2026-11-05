import { test } from "node:test";
import assert from "node:assert/strict";
import { beatPos, replaceRange } from "../../../src/core/flow/flow.ts";

test("seeded typing replacements keep outside words, scene anchors and partial-beat metadata", () => {
  let seed = 371;
  for (let i = 0; i < 160; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const text = "Narration" + seed;
    const offset = 1 + seed % (text.length - 1);
    const rows = [{ id: "p", audioText: "Before" }, { id: "a", audioText: "Selected", visualText: "Removed", status: "shot", paragraphStart: true },
      { id: "b", audioText: text, visualText: "Kept", status: "ready", paragraphStart: true }, { id: "z", audioText: "After" }];
    const from = beatPos("a", 0), to = beatPos("b", offset);
    const result = replaceRange({ rows, sections: [{ id: "s", name: "Scene", firstSceneId: "a" }], comments: [] },
      i % 2 ? { anchor: to, head: from } : { anchor: from, head: to }, [{ text: "New", marks: {} }],
      { cells: html => html ? [{ text: html, marks: {} }] : [], hasVisual: row => !!row.visualText, newId: () => "new" }, true);
    assert.ok(result && "rows" in result, "seed " + seed);
    assert.deepEqual(result.rows.map(row => row.id), ["p", "new", "b", "z"]);
    assert.deepEqual(result.rows.map(row => row.audioText), ["Before", "New", text.slice(offset), "After"]);
    assert.equal(result.rows[0], rows[0]);
    assert.equal(result.rows[3], rows[3]);
    assert.equal(result.rows[1]?.visualText, "");
    assert.equal(result.rows[1]?.paragraphStart, true);
    assert.equal(result.rows[2]?.visualText, "Kept");
    assert.equal(result.rows[2]?.status, "ready");
    assert.ok(!result.rows[2]?.paragraphStart);
    assert.equal(result.sections?.[0]?.firstSceneId, "new");
  }
});
