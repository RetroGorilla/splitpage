import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import * as flow from "../../../src/core/flow/flow.ts";
import { setVisualForRange } from "../../../src/core/flow/visual.ts";
import { replaceFlowMatches } from "../../../src/core/flow/find-replace.ts";
import type { FlowReplacementMatch } from "../../../src/core/flow/find-replace.ts";
import type { FlowDoc, FlowPorts, FlowRange, FlowPos, FlowClipboardSlice, FlowOutcome, FlowRow } from "../../../src/core/flow/flow.ts";
import type { Marks, MarkName, Run } from "../../../src/core/text/runs.ts";
import { cellLength } from "../../../src/core/text/runs.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { findInCell } from "../../../src/core/text/search.ts";
import { createFlowLoadRuntime } from "./load.ts";
import { fixture, offsets, reference, generator } from "./operations.test.ts";
import { applyFlowOperations } from "./operation-applier.ts";
import { flowOperationCoverage } from "../collab/coverage-fixture.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";

const rt = createFlowLoadRuntime(), cells = rt.ports.cells;
const names = ["replaceRange", "typeWithMarks", "pasteText", "pasteFlowRange", "replaceFlowMatches", "replaceAll", "setMarkAcross", "setVisualForRange", "selectionToOwnBeat", "insertBeats", "moveBeats", "sentenceParagraphs"] as const;
type RangeOperationName = typeof names[number];
interface RangeOperationCase {
  name: RangeOperationName;
  seed: string;
  doc: FlowDoc;
  range: FlowRange;
  pos: FlowPos;
  text: string;
  piece: readonly Run[];
  marks: Marks;
  clip: FlowClipboardSlice;
  matches: readonly FlowReplacementMatch[];
  needle: string;
  whole: boolean;
  mark?: MarkName;
}
function ports(record: boolean): FlowPorts {
  let next = 0;
  return { ...rt.ports, newId: () => "minted" + ++next, ...(record ? { operations: { id: "range", by: "Writer" } } : {}) };
}
function runRange(input: RangeOperationCase, ports: FlowPorts): FlowOutcome {
  const { doc, range, pos, text } = input;
  switch (input.name) {
    case "replaceRange": return flow.replaceRange(doc, range, input.piece, ports, input.whole);
    case "typeWithMarks": return flow.typeWithMarks(doc, pos, text, input.marks, ports);
    case "pasteText": return flow.pasteText(doc, range, text.split("\n\n"), ports);
    case "pasteFlowRange": return flow.pasteFlowRange(doc, range, input.clip, ports);
    case "replaceFlowMatches": return replaceFlowMatches(doc, input.matches, text, ports);
    case "setMarkAcross": return flow.setMarkAcross(doc, range, input.mark ?? "b", ports);
    case "setVisualForRange": return setVisualForRange(doc, range, toHtml(input.piece), ports);
    case "selectionToOwnBeat": return flow.selectionToOwnBeat(doc, range, ports);
    case "insertBeats": return flow.insertBeats(doc, pos, input.clip.rows, ports);
    case "moveBeats": return flow.moveBeats(doc, doc.rows.slice(0, 1).map(row => row.id), pos, ports);
    case "sentenceParagraphs": {
      const rows = flow.sentenceParagraphs(doc, ports);
      return { rows: rows.slice(), sections: flow.normalizedSections(doc.sections), removedComments: [], selection: range, ...(rows.ops ? { ops: rows.ops } : {}) };
    }
    case "replaceAll": return flow.replaceAll(doc, input.needle, text, false, ports);
  }
}
function checkRange(input: RangeOperationCase): { kinds: string[]; changed: boolean } {
  const before = structuredClone(input.doc), plain = runRange(input, ports(false)), described = runRange(input, ports(true));
  assert.deepEqual(input.doc, before, "input mutation");
  if (!described || !("rows" in described)) {
    assert.deepEqual(described, plain);
    return { kinds: [], changed: false };
  }
  const { ops, ...rest } = described;
  assert.ok(ops);
  assert.ok(!plain || !("ops" in plain));
  assert.deepEqual(rest, plain, "recording-off result differs");
  assert.equal(new Set(ops.map(op => op.id)).size, ops.length);
  for (const op of ops) assert.ok(readOperation(JSON.parse(JSON.stringify(op)) as unknown), "invalid operation " + JSON.stringify(op));
  assert.deepEqual(applyFlowOperations(input.doc, ops, cells), {
    rows: described.rows, sections: described.sections, removedComments: described.removedComments
  });
  assert.deepEqual(input.doc, before, "applier mutated base");
  return { kinds: ops.map(op => op.kind), changed: !isDeepStrictEqual(before.rows, described.rows)
    || !isDeepStrictEqual(before.sections, described.sections) || described.removedComments.length > 0 };
}
function reducedRange(input: RangeOperationCase): RangeOperationCase {
  let current = structuredClone(input);
  for (const row of input.doc.rows) {
    const next = { ...current, doc: { ...current.doc, rows: current.doc.rows.filter(item => item.id !== row.id) } };
    const positions = [next.pos, next.range.anchor, next.range.head, ...next.matches.flatMap(match => match.kind === "narration" ? [match.range.anchor, match.range.head] : [flow.beatPos(match.rowId, 0)])];
    if (!next.doc.rows.length || positions.some(pos => pos.kind === "beat" ? !next.doc.rows.some(row => row.id === pos.rowId)
      : !Array.isArray(next.doc.sections) || !next.doc.sections.some((scene: { id: string; firstSceneId: string }) => scene.id === pos.sceneId && next.doc.rows.some(row => row.id === scene.firstSceneId)))) continue;
    try { checkRange(next); } catch { current = next; }
  }
  return current;
}
function rangeCase(doc: FlowDoc, range: FlowRange, seed: string, index: number): RangeOperationCase {
  const text = ["", "X", "😀", "first\nline\n\nnext\n\n", "\u200bMarked"][index % 5] as string;
  const marks: Marks = { b: true, cmt: ["quote", "other"], href: "https://example.com/", tag: "t:props:Box", innerTags: ["t:props:Red"] };
  const rows = doc.rows.slice(0, 2).map(row => ({ ...row, id: "copy:" + row.id }));
  const clip = index % 3 ? { rows, text, wholeIds: rows.map(row => row.id),
    headers: index % 2 ? [{ index: 0, scene: { id: "copied", name: "Copied 😀", firstSceneId: rows[0]?.id ?? "" } }] : [] }
    : { rows: [], text, wholeIds: [], headers: [{ index: 0, scene: { id: "copied", name: "Header 😀", firstSceneId: "unused" } }] };
  const needle = ["a", "Alpha", " ", "😀", "red"][index % 5] as string;
  const matches: FlowReplacementMatch[] = flow.findInFlow(doc, needle, false, ports(false)).map(hit => ({ kind: "narration", range: hit.range }));
  for (const row of doc.rows) for (const hit of findInCell(cells(row.visualText), needle, false)) matches.push({ kind: "visual", rowId: row.id, ...hit });
  return { name: "replaceRange", seed, doc, range, pos: range.head, text, marks, piece: text ? [{ text, marks }] : [], clip, matches, needle, whole: !!(index % 2) };
}

test("range operations reproduce rows, sections and removed comments over retained generators", t => {
  const counts = new Map(names.map(name => [name, 0])), edits = new Map(names.map(name => [name, 0]));
  const kinds = new Map(names.map(name => [name, new Set<string>()]));
  function counted(input: RangeOperationCase): void {
    try {
      const result = checkRange(input);
      counts.set(input.name, (counts.get(input.name) ?? 0) + 1);
      if (result.changed) edits.set(input.name, (edits.get(input.name) ?? 0) + 1);
      for (const kind of result.kinds) kinds.get(input.name)?.add(kind);
    } catch (cause) { throw new Error("seed=" + input.seed + " function=" + input.name + " reduced=" + JSON.stringify(reducedRange(input)), { cause }); }
  }
  function exercise(doc: FlowDoc, range: FlowRange, seed: string, index: number): void {
    for (const name of names) counted({ ...rangeCase(doc, range, seed, index), name });
  }
  for (let seed = 1; seed <= 240; seed++) {
    const { doc, pick } = fixture(seed), a = pick(doc.rows.length), b = a + pick(doc.rows.length - a);
    const first = doc.rows[a] as FlowRow, last = doc.rows[b] as FlowRow, starts = offsets(first), from = starts[pick(starts.length)] as number;
    const ends = offsets(last).filter(offset => a !== b || offset >= from), to = ends[pick(ends.length)] as number;
    const range = { anchor: flow.beatPos(first.id, from), head: flow.beatPos(last.id, to) };
    exercise(doc, seed % 2 ? range : { anchor: range.head, head: range.anchor }, "fuzz:" + seed, seed);
  }
  for (let seed = 1; seed <= 300; seed++) {
    const { doc, positions, pick } = reference(seed);
    for (let operation = 0; operation < 6; operation++) exercise(doc,
      { anchor: positions[pick(positions.length)] as FlowPos, head: positions[pick(positions.length)] as FlowPos }, "reference:" + seed + ":" + operation, seed + operation);
  }
  let typingSeed = 371;
  for (let i = 0; i < 160; i++) {
    typingSeed = (Math.imul(typingSeed, 1664525) + 1013904223) >>> 0;
    const generated = generator("typing-reference.test.ts", '    const text = "Narration"', "    const result = replaceRange", "{ rows, from, to }", { seed: typingSeed, beatPos: flow.beatPos }) as
      { rows: FlowRow[]; from: FlowPos; to: FlowPos };
    exercise({ rows: generated.rows, sections: [{ id: "s", name: "Scene", firstSceneId: "a" }], comments: [] },
      i % 2 ? { anchor: generated.to, head: generated.from } : { anchor: generated.from, head: generated.to }, "typing:" + typingSeed, i);
  }
  for (const prefix of ["", "A", "AB", "word "]) for (const field of ["beat", "heading"] as const) {
    const text = prefix + "😀B", inside = prefix.length + 1;
    const doc: FlowDoc = { rows: [{ id: "a", audioText: text, visualText: text }, { id: "b", audioText: text }],
      sections: [{ id: "s", name: text, firstSceneId: "a" }], comments: [] };
    const pos = (offset: number) => field === "beat" ? flow.beatPos("a", offset) : flow.headingPos("s", offset);
    for (const [from, to] of [[inside, inside], [inside, inside + 1], [inside - 1, inside], [0, text.length], [inside, text.length]] as const) {
      const range = { anchor: pos(from), head: pos(to) };
      for (const direction of [range, { anchor: range.head, head: range.anchor }]) {
        exercise(doc, direction, "surrogate:" + field + ":" + prefix.length, from + to);
        counted({ ...rangeCase(doc, direction, "surrogate-find:" + field + ":" + prefix.length, 1), name: "replaceFlowMatches",
          matches: [{ kind: "narration", range: direction }, { kind: "visual", rowId: "a", from, to }] });
      }
    }
  }
  for (let seed = 1; seed <= 120; seed++) {
    const image = { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" };
    const doc = generator("round-four-fuzz.test.ts", "    const mode = (seed - 1) % 6", "    const out = edited(joinWithPrevious", "doc", { seed, image, rt, covered: new Set<string>() }) as FlowDoc;
    exercise(doc, { anchor: flow.beatPos("a", 0), head: flow.beatPos("b", 0) }, "round-four:" + seed, seed);
  }
  const rich: Run[] = [{ text: "SFX: Red\u{1f600}\n", marks: { cue: true, b: true, cmt: ["quote"], href: "https://example.com/", tag: "t:props:Box", innerTags: ["t:props:Red"] } },
    { atom: "broll", id: "key", text: "B-ROLL: Shot", marks: { i: true, cmt: ["quote"] } },
    { atom: "who", name: "Sam", text: "@Sam", marks: { cmt: ["quote"] } },
    { text: "tail\nnext", marks: { i: true, dir: true } }];
  const richDoc: FlowDoc = { rows: [{ id: "a", audioText: toHtml(rich) }, { id: "b", audioText: toHtml(rich), paragraphStart: true }], comments: [{ id: "quote", anchorId: "quote", rowId: "a" }] };
  const richRange = { anchor: flow.beatPos("a", 1), head: flow.beatPos("b", cellLength(rich) - 1) };
  for (const name of names) counted({ ...rangeCase(richDoc, richRange, "rich-paste", 1), name, piece: rich });
  for (const mark of ["b", "i", "u", "s", "hl", "dir", "cue", "cmt", "href", "tag"] as const) counted({
    ...rangeCase(richDoc, richRange, "mark-identity:" + mark, 1), name: "setMarkAcross", mark
  });
  const retainedDoc: FlowDoc = { rows: [{ id: "a", audioText: "Original" }, { id: "b", audioText: "Destination" }], comments: [] };
  const retainedRange = { anchor: flow.beatPos("a", 0), head: flow.beatPos("b", 0) };
  for (const name of ["pasteFlowRange", "insertBeats"] as const) counted({ ...rangeCase(retainedDoc, retainedRange, "supplied-original-id", 1), name,
    clip: { rows: [retainedDoc.rows[0] as FlowRow], wholeIds: ["a"], headers: [], text: "Original" } });
  for (const name of ["A\ud83d", "\ude00B"]) counted({ ...rangeCase(retainedDoc, flow.caretAt(flow.beatPos("b", 0)), "raw-heading:" + JSON.stringify(name), 1), name: "pasteFlowRange",
    clip: { rows: [], wholeIds: [], text: name, headers: [{ index: 0, scene: { id: "raw", name, firstSceneId: "unused" } }] } });
  const markedDoc: FlowDoc = { rows: [{ id: "a", audioText: toHtml([{ text: "tag", marks: { tag: "t:props:Box", innerTags: ["t:props:Red"], cmt: ["one", "two"], href: "https://example.com/" } }]) }], comments: [] };
  const markedRange = { anchor: flow.beatPos("a", 0), head: flow.beatPos("a", 3) };
  for (const mark of ["tag", "cmt", "href"] as const) counted({ ...rangeCase(markedDoc, markedRange, "clear-identity:" + mark, 1), name: "setMarkAcross", mark });
  const headingDoc: FlowDoc = { rows: [{ id: "a", audioText: "Title" }], sections: [{ id: "s", name: "Title", firstSceneId: "a" }], comments: [] };
  const headingRange = { anchor: flow.headingPos("s", 0), head: flow.headingPos("s", 5) };
  for (const name of names) counted({ ...rangeCase(headingDoc, headingRange, "empty-heading", 0), name, needle: "Title",
    matches: [{ kind: "narration", range: headingRange }] });
  const floors = { replaceRange: 2360, typeWithMarks: 1560, pasteText: 2360, pasteFlowRange: 2400, replaceFlowMatches: 1120, replaceAll: 930, setMarkAcross: 1590, setVisualForRange: 500, selectionToOwnBeat: 230, insertBeats: 1600, moveBeats: 1630, sentenceParagraphs: 400 };
  for (const name of names) {
    const row = flowOperationCoverage.find(row => row[0] === name);
    assert.ok(row);
    assert.deepEqual([...kinds.get(name) ?? []].sort(), row[2].split(" | ").filter(part => part !== "whole-field today, needs package 9" && part !== "partial-segment-move").flatMap(part => part.split(",")).sort(), name + " exact kinds");
    assert.ok((edits.get(name) ?? 0) >= floors[name], name + " changing edit floor");
    assert.equal(counts.get(name), name === "replaceFlowMatches" ? 2482 : name === "setMarkAcross" ? 2415 : name === "pasteFlowRange" ? 2405 : name === "insertBeats" ? 2403 : 2402, name + " call count");
    t.diagnostic(name + ": " + counts.get(name) + " calls, " + edits.get(name) + " changing edits, 0 mismatches");
  }
});
