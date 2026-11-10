import { test } from "node:test";
import assert from "node:assert/strict";
import { searchFlow } from "../../../src/features/writer/flow-find.ts";
import { replaceFlowMatches } from "../../../src/core/flow/find-replace.ts";
import { beatPos } from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowPorts } from "../../../src/core/flow/flow.ts";

const ports: FlowPorts = {
  cells: html => html ? [{ text: html, marks: {} }] : [],
  newId: () => "unused",
  hasVisual: row => !!row.visualText
};
const doc: FlowDoc = {
  rows: [
    { id: "a", audioText: "red fox", visualText: "red sky", status: "shot" },
    { id: "b", audioText: "jumps red", visualText: "fox" },
    { id: "c", audioText: "fox", paragraphStart: true }
  ],
  sections: [{ id: "scene", name: "red title", firstSceneId: "a" }],
  comments: [{ id: "comment", rowId: "b", field: "audioText" }]
};

test("flow Find adds visuals only when requested and keeps document order", () => {
  const plain = searchFlow(doc, "red", false, false, ports);
  assert.deepEqual(plain.matches.map(hit => hit.kind), ["narration", "narration", "narration"]);
  const all = searchFlow(doc, "red", false, true, ports);
  assert.deepEqual(all.matches.map(hit => hit.kind), ["narration", "visual", "narration", "narration"]);
  assert.deepEqual(all.matches[1], { kind: "visual", rowId: "a", from: 0, to: 3 });
  assert.equal(searchFlow(doc, "RED", true, true, ports).matches.length, 0);
});

test("cross-tick replacement keeps every beat, its metadata and the paragraph boundary", () => {
  const found = searchFlow(doc, "fox jumps", false, false, ports);
  assert.equal(found.matches.length, 1);
  const result = replaceFlowMatches(doc, found.matches, "cat", ports);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows.map(row => row.audioText), ["red cat", " red", "fox"]);
  assert.deepEqual(result.rows.map(row => row.id), ["a", "b", "c"]);
  assert.equal(result.rows[0]?.status, "shot");
  assert.equal(result.rows[1]?.visualText, "fox");
  assert.equal(result.rows[2]?.paragraphStart, true);
  assert.deepEqual(result.removedComments, []);
  assert.deepEqual(doc.rows.map(row => row.audioText), ["red fox", "jumps red", "fox"]);
});

test("lone spaces exclude painted gaps and phrases stop at paragraph boundaries", () => {
  const spaces = searchFlow(doc, " ", false, false, ports).matches;
  assert.equal(spaces.length, 3);
  assert.equal(searchFlow(doc, "red fox", false, false, ports).matches.length, 1);
  assert.equal(searchFlow(doc, "jumps red fox", false, false, ports).matches.length, 0);
  const changed = replaceFlowMatches(doc, spaces, "_", ports);
  assert.ok(changed && "rows" in changed);
  assert.deepEqual(changed.rows.map(row => row.audioText), ["red_fox", "jumps_red", "fox"]);
});

test("Replace All covers headings, narration and opted-in visuals in one pure result", () => {
  const result = replaceFlowMatches(doc, searchFlow(doc, "red", false, true, ports).matches, "blue", ports);
  assert.ok(result && "rows" in result);
  assert.equal(result.sections?.[0]?.name, "blue title");
  assert.equal(result.rows[0]?.visualText, "blue sky");
  assert.deepEqual(result.rows.map(row => row.audioText), ["blue fox", "jumps blue", "fox"]);
  assert.deepEqual(result.selection, { anchor: { kind: "heading", sceneId: "scene", offset: 4 }, head: { kind: "heading", sceneId: "scene", offset: 4 } });
});

test("an overlong scene-name replacement refuses the entire batch", () => {
  const result = replaceFlowMatches(doc, searchFlow(doc, "red", false, true, ports).matches, "x".repeat(201), ports);
  assert.ok(result && "refused" in result);
  assert.equal(doc.rows[0]?.visualText, "red sky");
});

test("tags and atoms stop narration matches, including at ticks, and count tags separately", () => {
  const marked: FlowPorts = {
    ...ports,
    cells: html => html === "tag" ? [{ text: "fox", marks: { tag: "prop:fox" } }] :
      html === "atom" ? [{ text: "B-roll:", marks: {}, atom: "broll", id: "shot" }] : ports.cells(html)
  };
  const script: FlowDoc = { rows: [{ id: "a", audioText: "red", visualText: "tag" }, { id: "b", audioText: "tag" }, { id: "c", audioText: "atom" }, { id: "d", audioText: "fox" }], comments: [] };
  assert.equal(searchFlow(script, "red fox", false, false, marked).matches.length, 0);
  assert.equal(searchFlow(script, "fox", false, false, marked).inTags, 1);
  const found = searchFlow(script, "fox", false, true, marked);
  assert.equal(found.inTags, 2);
  assert.deepEqual(found.matches, [{ kind: "narration", range: { anchor: beatPos("d", 0), head: beatPos("d", 3) } }]);
});

test("replacement offsets stay correct for repeated Unicode text and different replacement lengths", () => {
  let seed = 6042;
  const choices = ["red", "red red", "🦊red", "red🦊", "RED", " "];
  for (let trial = 0; trial < 100; trial++) {
    const words = Array.from({ length: 6 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return choices[seed % choices.length] as string;
    }).join(" ");
    const replacement = trial % 2 ? "🦊blue" : "";
    const script: FlowDoc = { rows: [{ id: "a", audioText: words, visualText: words }], comments: [] };
    const matches = searchFlow(script, "red", true, true, ports).matches;
    const result = replaceFlowMatches(script, matches, replacement, ports);
    if (!matches.length) { assert.equal(result, null); continue; }
    assert.ok(result && "rows" in result);
    assert.equal(result.rows[0]?.audioText, words.replaceAll("red", replacement), "narration trial " + trial);
    assert.equal(result.rows[0]?.visualText, words.replaceAll("red", replacement), "visual trial " + trial);
  }
});
