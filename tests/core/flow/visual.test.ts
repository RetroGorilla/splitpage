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

test("a collapsed standalone visual edit reads row ids only for the edit", () => {
  let idReads = 0;
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    get id() { idReads++; return "row" + index; }, audioText: "Body", visualText: "Original"
  }));
  const ports: FlowPorts = { cells: html => fromHtml(html ?? ""), newId: () => "unused", hasVisual: row => !!row.visualText };
  const result = setVisualForRange({ rows, comments: [] }, caretAt(beatPos("row999", 0)), "Harbour", ports);
  assert.equal(idReads, 1001);
  assert.ok(result && "rows" in result);
  assert.equal(result.rows.length, 1000);
  assert.equal(result.rows[999]?.visualText, "Harbour");
  assert.equal(result.rows[0], rows[0]);
});

test("seeded visual selections preserve narration, scene membership and the original beat's metadata", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const narration = "Before " + "word ".repeat(seed % 8 + 1) + "after";
    const from = seed % narration.length;
    const to = from + 1 + seed % (narration.length - from);
    let next = 0;
    const ports: FlowPorts = { cells: html => fromHtml(html ?? ""), newId: () => "new" + ++next, hasVisual: row => !!row.visualText };
    const scene = { id: "scene", name: "Harbour", firstSceneId: "a" };
    const row = { id: "a", audioText: narration, visualText: "Original", status: "shot", lengthSeconds: 4, paragraphStart: true };
    const doc: FlowDoc = { rows: [row], sections: [scene], comments: [] };
    const a = beatPos("a", from), h = beatPos("a", to);
    for (const range of [{ anchor: a, head: h }, { anchor: h, head: a }]) {
      const result = setVisualForRange(doc, range, "Drone", ports);
      assert.ok(result && "rows" in result, "seed " + seed);
      assert.equal(result.rows.map(beat => beat.audioText).join(""), narration);
      assert.equal(new Set(result.rows.map(beat => beat.id)).size, result.rows.length);
      const chosen = result.rows.find(beat => beat.visualText === "Drone");
      assert.equal(chosen?.audioText, narration.slice(from, to));
      assert.equal(result.sections?.[0]?.firstSceneId, result.rows[0]?.id);
      if (from || to < narration.length) {
        const original = result.rows.find(beat => beat.id === "a");
        assert.equal(original?.visualText, "Original");
        assert.equal(original?.status, "shot");
        assert.equal(original?.lengthSeconds, 4);
      }
      assert.deepEqual(doc, { rows: [row], sections: [scene], comments: [] });
    }
  }
});
