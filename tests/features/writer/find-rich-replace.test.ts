import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { searchFlow, replaceFlowMatches, visualMatchHighlight } from "../../../src/features/writer/flow-find.ts";
import type { FlowDoc, FlowPorts } from "../../../src/core/flow/flow.ts";

const ports: FlowPorts = { cells: html => fromHtml(html ?? ""), newId: () => "unused", hasVisual: () => false };
const cases = [
  { name: "bold", before: "<strong>red</strong>", after: "<strong>blue</strong>" },
  { name: "direction", before: '<span class="stage-dir">red</span>', after: '<span class="stage-dir">blue</span>' },
  { name: "comment", before: '<span class="cmt-anchor" data-cmt="c">red</span>', after: '<span class="cmt-anchor" data-cmt="c">blue</span>' }
];

for (const example of cases) {
  for (const all of [false, true]) {
    test((all ? "Replace All" : "Replace") + " preserves a whole " + example.name + " word's marks", () => {
      const doc: FlowDoc = { rows: [{ id: "a", audioText: example.before + " " + example.before }], comments: [{ id: "c", rowId: "a", field: "audioText" }] };
      const matches = searchFlow(doc, "red", false, false, ports).matches;
      const result = replaceFlowMatches(doc, all ? matches : matches.slice(0, 1), "blue", ports);
      assert.ok(result && "rows" in result);
      assert.equal(result.rows[0]?.audioText, example.after + " " + (all ? example.after : example.before));
      assert.deepEqual(result.removedComments, []);
      assert.equal(doc.rows[0]?.audioText, example.before + " " + example.before);
    });
  }
}

test("a cross-tick replacement inherits only the first replaced character's marks", () => {
  const doc: FlowDoc = { rows: [
    { id: "a", audioText: '<strong><span class="cmt-anchor" data-cmt="c">red</span></strong>' },
    { id: "b", audioText: "<em>fox</em> tail", visualText: "keep" }
  ], comments: [{ id: "c", rowId: "a", field: "audioText" }] };
  const result = replaceFlowMatches(doc, searchFlow(doc, "red fox", false, false, ports).matches, "blue", ports);
  assert.ok(result && "rows" in result);
  assert.deepEqual(fromHtml(result.rows[0]?.audioText ?? ""), [{ text: "blue", marks: { cmt: ["c"], b: true } }]);
  assert.equal(result.rows[1]?.audioText, " tail");
  assert.equal(result.rows[1]?.visualText, "keep");
  assert.deepEqual(result.rows.map(row => row.id), ["a", "b"]);
});

test("visual highlights expand B-roll markers into the box's displayed-text offsets", () => {
  const doc: FlowDoc = { rows: [{ id: "a", audioText: "", visualText: '<span class="broll-key" data-broll-id="bsabcdef" contenteditable="false">B-roll:</span> A <strong>red</strong> sky' }], comments: [] };
  const match = searchFlow(doc, "red", false, true, ports).matches[0];
  assert.ok(match && match.kind === "visual");
  assert.deepEqual({ from: match.from, to: match.to }, { from: 4, to: 7 });
  assert.deepEqual(visualMatchHighlight(doc, match, ports), { from: 10, to: 13 });
});
