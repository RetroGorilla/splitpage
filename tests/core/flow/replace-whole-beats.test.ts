import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { beatPos, replaceRange } from "../../../src/core/flow/flow.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";

for (const backward of [false, true]) {
  test(`typing over fully selected beats removes their metadata (${backward ? "backward" : "forward"})`, () => {
    const rows = [
      { id: "a", audioText: '<span class="cmt-anchor" data-cmt="gone">Alpha</span>', visualText: "First", status: "shot" },
      { id: "b", audioText: "Bravo", visualText: "Second", status: "ready" }
    ];
    const from = beatPos("a", 0), to = beatPos("b", 5);
    const result = replaceRange({ rows, comments: [{ id: "gone", rowId: "a", anchorId: "gone" }] },
      backward ? { anchor: to, head: from } : { anchor: from, head: to }, [{ text: "New", marks: {} }],
      { cells: html => fromHtml(html ?? ""), hasVisual: row => !!row.visualText, newId: () => "new" }, true);
    assert.ok(result && "rows" in result);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.id, "new");
    assert.equal(result.rows[0]?.audioText, "New");
    assert.equal(result.rows[0]?.visualText, "");
    assert.notEqual(result.rows[0]?.status, "shot");
    assert.deepEqual(result.removedComments, ["gone"]);
    assert.equal(result.notice, "Removed 2 beats: 2 with visuals, 1 filmed");
    assert.deepEqual(result.selection, { anchor: beatPos("new", 3), head: beatPos("new", 3) });
  });
}

for (const backward of [false, true]) {
  test(`replacement joins a partial tail to the new beat (${backward ? "backward" : "forward"})`, () => {
    const rows = [{ id: "p", audioText: "Before" }, { id: "a", audioText: "Alpha", paragraphStart: true },
      { id: "b", audioText: "Bravo", paragraphStart: true, visualText: "Keep" }, { id: "z", audioText: "After" }];
    const from = beatPos("a", 0), to = beatPos("b", 2);
    const result = replaceRange({ rows, comments: [], sections: [{ id: "s", name: "Scene", firstSceneId: "a" }] },
      backward ? { anchor: to, head: from } : { anchor: from, head: to }, [{ text: "New", marks: {} }],
      { cells: html => fromHtml(html ?? ""), hasVisual: row => !!row.visualText, newId: () => "new" }, true);
    assert.ok(result && "rows" in result);
    assert.deepEqual(result.rows.map(row => row.audioText), ["Before", "New", "avo", "After"]);
    assert.equal(result.rows[1]?.paragraphStart, true);
    assert.ok(!result.rows[2]?.paragraphStart);
    assert.equal(result.rows[2]?.visualText, "Keep");
    assert.equal(result.sections?.[0]?.firstSceneId, "new");
  });
}
