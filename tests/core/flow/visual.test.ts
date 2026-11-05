import { test } from "node:test";
import assert from "node:assert/strict";
import { beatPos, caretAt } from "../../../src/core/flow/flow.ts";
import { setVisualForRange } from "../../../src/core/flow/visual.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import "../../../src/test/_dom.mjs";
import type { FlowDoc, FlowPorts } from "../../../src/core/flow/flow.ts";

for (const backwards of [false, true]) {
  test("a visual isolates selected narration in one result, " + (backwards ? "backward" : "forward"), () => {
    let id = 0;
    const ports: FlowPorts = { cells: html => fromHtml(html ?? ""), newId: () => "new" + ++id, hasVisual: row => !!row.visualText };
    const doc: FlowDoc = { rows: [{ id: "a", audioText: "Alpha Bravo Charlie", visualText: "Original", paragraphStart: true, status: "shot" }], comments: [] };
    const first = beatPos("a", 6), last = beatPos("a", 11);
    const result = setVisualForRange(doc, { anchor: backwards ? last : first, head: backwards ? first : last }, "Harbour", ports);
    assert.ok(result && "rows" in result);
    assert.deepEqual(result.rows.map(row => [row.audioText, row.visualText]), [["Alpha ", "Original"], ["Bravo", "Harbour"], [" Charlie", ""]]);
    assert.equal(result.rows[0]?.status, "shot");
    assert.equal(result.rows[0]?.paragraphStart, true);
    assert.equal(result.rows[1]?.paragraphStart, undefined);
    assert.equal(doc.rows.length, 1);
    assert.equal(doc.rows[0]?.audioText, "Alpha Bravo Charlie");
  });
  test("a visual refuses a selection across beats, " + (backwards ? "backward" : "forward"), () => {
    const ports: FlowPorts = { cells: html => fromHtml(html ?? ""), newId: () => "new", hasVisual: row => !!row.visualText };
    const doc: FlowDoc = { rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "Bravo" }], comments: [] };
    const first = beatPos("a", 2), last = beatPos("b", 3);
    assert.deepEqual(setVisualForRange(doc, { anchor: backwards ? last : first, head: backwards ? first : last }, "Harbour", ports), { refused: "Visuals must stay within one beat." });
    assert.equal(doc.rows[0]?.visualText, undefined);
  });
}

test("a caret visual changes its beat without splitting or changing metadata", () => {
  const ports: FlowPorts = { cells: html => fromHtml(html ?? ""), newId: () => "new", hasVisual: row => !!row.visualText };
  const doc: FlowDoc = { rows: [{ id: "a", audioText: "Alpha", visualText: "Original", status: "shot", lengthSeconds: 4 }], comments: [] };
  const range = caretAt(beatPos("a", 2));
  const result = setVisualForRange(doc, range, "Harbour", ports);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows, [{ ...doc.rows[0], visualText: "Harbour" }]);
  assert.deepEqual(result.selection, range);
});
