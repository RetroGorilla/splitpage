import { test } from "node:test";
import assert from "node:assert/strict";
import { beatPos, replaceRange } from "../../../src/core/flow/flow.ts";

for (const backward of [false, true]) {
  for (const heading of [false, true]) {
  test(`deletion preserves an empty exclusive endpoint (${backward ? "backward" : "forward"}, heading ${heading})`, () => {
    const endpoint = { id: "b", audioText: "", visualText: "", status: "shot",
      imageRef: { sha256: "b".repeat(64), mime: "image/png", width: 1, height: 1 } };
    const from = beatPos("a", 0), to = beatPos("b", 0);
    const result = replaceRange({ rows: [{ id: "a", audioText: "Alpha" }, endpoint, { id: "c", audioText: "Charlie" }],
      sections: heading ? [{ id: "scene", name: "Next scene", firstSceneId: "c" }] : undefined,
      comments: [{ id: "comment", rowId: "b" }] }, backward ? { anchor: to, head: from } : { anchor: from, head: to }, [],
    { cells: html => html ? [{ text: html, marks: {} }] : [], hasVisual: row => !!row.imageRef, newId: () => "new" });
    assert.ok(result && "rows" in result);
    assert.deepEqual(result.rows.map(row => row.id), ["b", "c"]);
    assert.deepEqual(result.rows[0], endpoint);
    assert.deepEqual(result.removedComments, []);
    assert.equal(result.notice, "Removed 1 beat");
    assert.deepEqual(result.sections, heading ? [{ id: "scene", name: "Next scene", firstSceneId: "c" }] : undefined);
  });
  }
  test(`deletion includes the visual-only last beat (${backward ? "backward" : "forward"})`, () => {
    const from = beatPos("a", 0), to = beatPos("b", 0);
    const result = replaceRange({ rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "", status: "shot",
      imageRef: { sha256: "b".repeat(64), mime: "image/png", width: 1, height: 1 } }], comments: [{ id: "comment", rowId: "b" }] },
      backward ? { anchor: to, head: from } : { anchor: from, head: to }, [],
      { cells: html => html ? [{ text: html, marks: {} }] : [], hasVisual: row => !!row.imageRef, newId: () => "new" });
    assert.ok(result && "rows" in result);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.id, "new");
    assert.equal(result.rows[0]?.audioText, "");
    assert.ok(!result.rows[0]?.imageRef);
    assert.deepEqual(result.removedComments, ["comment"]);
  });
}
