import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beatPos, caretAt, enterInHeading, finalizeHeading, findInFlow, flowOf, headingPos, insertBeats,
  joinWithPrevious, logicalText, moveBeats, pasteText, renameHeading, replaceAll, replaceMatch, replaceRange,
  selectionToOwnBeat, sentenceParagraphs, setMarkAcross
} from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowEdit, FlowOutcome, FlowPorts, FlowRow } from "../../../src/core/flow/flow.ts";
import { createRichText } from "../../../src/adapters/richtext/richtext.ts";
import { createImageIngestion } from "../../../src/core/document/media.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { MAX_MORE } from "../../../src/core/document/gallery.ts";
import { projection } from "../../../src/core/text/runs.ts";
import { jsdomParser } from "../../adapters/richtext/jsdom.mjs";
import { countingIds } from "../migrate-ports.ts";

const rich = createRichText({ DOMParser: jsdomParser(), images: createImageIngestion(() => null), ids: countingIds() });
const cells = rich.createCellReader(deepFreeze, { media: true });
const row = (id: string, audioText = "", extra: Partial<FlowRow> = {}): FlowRow => ({ id, audioText, visualText: "", ...extra });
const doc = (rows: readonly FlowRow[], sections?: unknown): FlowDoc => ({ rows, sections, comments: [] });
function ports(): FlowPorts {
  let next = 0;
  return { cells, newId: () => "new" + ++next, hasVisual: beat => !!beat.visualText || !!beat.imageRef };
}
function edit(out: FlowOutcome): FlowEdit {
  assert.ok(out && "rows" in out, JSON.stringify(out));
  return out;
}
const ids = (out: FlowEdit) => out.rows.map(beat => beat.id);
const words = (out: FlowEdit) => out.rows.map(beat => projection(cells(beat.audioText)));

test("inserting mid-beat keeps the target visual and splits only its narration", () => {
  const out = edit(insertBeats(doc([row("a", "BeforeAfter", { visualText: "Desk", status: "shot" })]), beatPos("a", 6), [row("b", "Block", { status: "ready" })], ports()));
  assert.deepEqual(words(out), ["Before", "Block", "After"]);
  assert.equal(out.rows[0]?.visualText, "Desk");
  assert.equal(out.rows[0]?.status, "shot");
  assert.equal(out.rows[2]?.visualText, "");
  assert.ok(out.rows.every(beat => !beat.paragraphStart));
});

test("inserting at either paragraph edge preserves separate paragraphs and scene membership", () => {
  for (const pos of [beatPos("a", 0), beatPos("a", 5)]) {
    const out = edit(insertBeats(doc([row("a", "Alpha"), row("b", "Bravo", { paragraphStart: true })], [{ id: "s", name: "Scene", firstSceneId: "a" }]), pos, [row("c", "Block")], ports()));
    assert.equal(out.rows.find(beat => beat.id === "c")?.paragraphStart, true);
    assert.equal(out.rows.find(beat => beat.id === "b")?.paragraphStart, true);
    assert.equal(out.sections?.[0]?.firstSceneId, pos.offset === 0 ? "c" : "a");
  }
});

test("moving an implicit whole paragraph keeps it separate and preserves every row id", () => {
  const original = doc([row("a", "One"), row("b", "Two"), row("c", "Three", { paragraphStart: true }), row("d", "Four", { paragraphStart: true })]);
  const out = edit(moveBeats(original, ["a", "b"], beatPos("d", 0), ports()));
  assert.deepEqual(ids(out), ["c", "a", "b", "d"]);
  assert.equal(out.rows[1]?.paragraphStart, true);
  assert.equal(out.rows[3]?.paragraphStart, true);
});

test("moving a paragraph's first beat passes its start to the survivor and flows in mid-paragraph", () => {
  const out = edit(moveBeats(doc([row("a", "One"), row("b", "Two", { paragraphStart: true }), row("c", "Three"), row("d", "Four")]), ["b"], beatPos("d", 2), ports()));
  assert.equal(out.rows.find(beat => beat.id === "c")?.paragraphStart, true);
  assert.ok(!out.rows.find(beat => beat.id === "b")?.paragraphStart);
  assert.deepEqual(words(out), ["One", "Three", "Fo", "Two", "ur"]);
});

test("heading positions support insertion before a header and inside its words", () => {
  const original = doc([row("a", "Narration")], [{ id: "s", name: "Scene tail", firstSceneId: "a" }]);
  const before = edit(insertBeats(original, headingPos("s", 0), [row("b", "Block")], ports()));
  assert.equal(before.sections?.[0]?.firstSceneId, "a");
  const inside = edit(insertBeats(original, headingPos("s", 5), [row("b", "Block")], ports()));
  assert.equal(inside.sections?.[0]?.name, "Scene");
  assert.equal(inside.sections?.[0]?.firstSceneId, "b");
  assert.deepEqual(words(inside), ["Block", " tail", "Narration"]);
});

test("sentence flags use the previous beat and implicit scene starts, and leave already flagged documents alone", () => {
  const original = doc([row("a", "One.<br>"), row("b", "Two"), row("c", "Three!"), row("d", ""), row("e", "End")], [{ id: "s", name: "Scene", firstSceneId: "c" }]);
  const rows = sentenceParagraphs(original, ports());
  assert.deepEqual(rows.filter(beat => beat.paragraphStart).map(beat => beat.id), ["b", "d"]);
  const flagged = { ...original, rows };
  assert.equal(sentenceParagraphs(flagged, ports()), rows);
  assert.ok(original.rows.every(beat => !beat.paragraphStart));
});

test("Find shares literal matching, stops at tags and atoms, and never matches a display gap alone", () => {
  const original = doc([row("a", "Alpha"), row("b", "beta <strong>word</strong>"), row("c", '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Desk">Desk</span> tail')]);
  assert.equal(logicalText(original, { anchor: beatPos("a", 0), head: beatPos("b", 9) }, ports()), "Alpha beta word");
  const match = findInFlow(original, "ALPHA beta", false, ports());
  assert.equal(match.length, 1);
  assert.equal(findInFlow(original, " ", false, ports()).length, 2);
  assert.equal(findInFlow(original, "Desk", false, ports()).length, 0);
  assert.equal(findInFlow(original, "word Desk", false, ports()).length, 0);
  const out = edit(replaceMatch(original, (match[0] as { range: Parameters<typeof replaceMatch>[1] }).range, "New", ports()));
  assert.deepEqual(ids(out), ["a", "b", "c"]);
  assert.deepEqual(words(out).slice(0, 2), ["New", " word"]);
});

test("formatting makes one decision across beats, keeping the direction and comments", () => {
  const original = doc([row("a", "<strong>Alpha</strong>"), row("b", '<span class="cmt-anchor" data-cmt="c">Bravo</span>')]);
  const range = { anchor: beatPos("b", 5), head: beatPos("a", 0) };
  const marked = edit(setMarkAcross(original, range, "b", ports()));
  assert.deepEqual(marked.selection, range);
  assert.ok(marked.rows.every(beat => cells(beat.audioText).every(run => run.marks.b)));
  const unmarked = edit(setMarkAcross({ ...original, rows: marked.rows }, range, "b", ports()));
  assert.ok(unmarked.rows.every(beat => cells(beat.audioText).every(run => !run.marks.b)));
  assert.ok(unmarked.rows[1]?.audioText?.includes('data-cmt="c"'));
});

test("whole-beat deletion removes its comments except a mark surviving elsewhere", () => {
  const original: FlowDoc = { ...doc([row("a", '<span class="cmt-anchor" data-cmt="shared">Alpha</span>'), row("b", '<span class="cmt-anchor" data-cmt="shared">Bravo</span>'), row("c", "End")]),
    comments: [{ id: "shared", rowId: "b" }, { id: "gone", rowId: "b" }] };
  const out = edit(replaceRange(original, { anchor: beatPos("a", 5), head: beatPos("c", 0) }, [], ports()));
  assert.deepEqual(out.removedComments, ["gone"]);
  assert.deepEqual(ids(out), ["a", "c"]);
});

test("scene header, picture limit and 201-character scene name refusals leave the input untouched", () => {
  const image = (i: number) => ({ imageRef: { sha256: i.toString(16).padStart(64, "0"), width: 1, height: 1, mime: "image/png" } });
  const original = doc([row("a", "Alpha", { moreImages: Array.from({ length: MAX_MORE + 1 }, (_, i) => image(i + 1)) }), row("b", "Bravo", { moreImages: [image(100)] })], [{ id: "s", name: "Scene", firstSceneId: "b" }]);
  const before = JSON.stringify(original);
  assert.ok("refused" in (joinWithPrevious(original, "b", ports()) as object));
  assert.ok("refused" in (joinWithPrevious({ ...original, sections: undefined }, "b", ports()) as object));
  assert.ok("refused" in (renameHeading(original, "s", "x".repeat(201), 0) as object));
  assert.ok("refused" in (replaceRange(original, caretAt(headingPos("s", 0)), [{ text: "x".repeat(201), marks: {} }], ports()) as object));
  assert.equal(JSON.stringify(original), before);
  assert.equal(edit(renameHeading(original, "s", "x".repeat(200), 200)).sections?.[0]?.name.length, 200);
});

test("Replace All refuses atomically when one scene name would exceed its limit", () => {
  const original = doc([row("a", "x"), row("b", "x")], [{ id: "s", name: "x" + "a".repeat(199), firstSceneId: "b" }]);
  const before = JSON.stringify(original);
  assert.ok("refused" in (replaceAll(original, "x", "long", false, ports()) as object));
  assert.equal(JSON.stringify(original), before);
});

test("headings, own-beat cuts and full deletion leave real nonempty scene membership", () => {
  const original = doc([row("a", "# Heading"), row("b", "AlphaBeta", { visualText: "Desk" })]);
  const headed = edit(finalizeHeading(original, "a", 9, null, ports()));
  assert.equal(headed.sections?.[0]?.firstSceneId, "b");
  const cut = edit(selectionToOwnBeat({ ...original, rows: headed.rows, sections: headed.sections }, { anchor: beatPos("b", 0), head: beatPos("b", 5) }, ports()));
  assert.equal(cut.sections?.[0]?.firstSceneId, cut.rows[0]?.id);
  assert.equal(cut.rows[1]?.visualText, "Desk");
  const entered = edit(enterInHeading({ ...original, rows: cut.rows, sections: cut.sections }, headingPos(headed.sections?.[0]?.id ?? "", 4), ports()));
  assert.ok(entered.rows.length);
  assert.ok(flowOf({ ...original, rows: entered.rows, sections: entered.sections }).length);
});

test("moving a block crossing a paragraph start preserves the source's surviving paragraph", () => {
  const original = doc([row("a", "A"), row("b", "B"), row("c", "C", { paragraphStart: true }), row("d", "D"), row("e", "E", { paragraphStart: true })]);
  const out = edit(moveBeats(original, ["b", "c"], beatPos("e", 1), ports()));
  assert.equal(out.rows.find(beat => beat.id === "d")?.paragraphStart, true);
  assert.deepEqual(ids(out), ["a", "d", "e", "b", "c"]);
});

test("pasting several paragraphs at a heading end retains every paragraph and the original body", () => {
  const original = doc([row("a", "Body")], [{ id: "s", name: "Title", firstSceneId: "a" }]);
  const out = edit(pasteText(original, caretAt(headingPos("s", 5)), [" one", "two", "three"], ports()));
  assert.equal(out.sections?.[0]?.name, "Title one");
  assert.deepEqual(words(out), ["two", "three", "Body"]);
  assert.equal(out.rows.find(beat => beat.id === "a")?.paragraphStart, true);
});

test("deleting a whole header and its first beat removes that beat's visual and comments", () => {
  const original: FlowDoc = { ...doc([row("a", "A", { visualText: "VISUAL" }), row("b", "B")], [{ id: "s", name: "Title", firstSceneId: "a" }]),
    comments: [{ id: "c", rowId: "a" }] };
  const out = edit(replaceRange(original, { anchor: headingPos("s", 0), head: beatPos("a", 1) }, [], ports()));
  assert.deepEqual(ids(out), ["b"]);
  assert.deepEqual(out.removedComments, ["c"]);
  assert.equal(out.sections, undefined);
});

test("scene-name limits count code points while caret offsets remain UTF-16", () => {
  const original = doc([row("a")], [{ id: "s", name: "Title", firstSceneId: "a" }]);
  const name = "😀".repeat(200);
  const renamed = edit(renameHeading(original, "s", name, name.length));
  assert.equal(renamed.sections?.[0]?.name, name);
  assert.equal(renamed.selection.head.offset, 400);
  const replaced = edit(replaceRange(original, { anchor: headingPos("s", 0), head: headingPos("s", 5) }, [{ text: name, marks: {} }], ports()));
  assert.equal(replaced.sections?.[0]?.name, name);
  assert.ok("refused" in (renameHeading(original, "s", name + "x", 0) as object));
});

test("a partial heading survives deletion of its last beat with a real empty beat", () => {
  for (const preceding of [[], [row("before", "Before")]]) {
    const original = doc([...preceding, row("a", "A", { visualText: "VISUAL" })], [{ id: "s", name: "Title", firstSceneId: "a" }]);
    const out = edit(replaceRange(original, { anchor: headingPos("s", 2), head: beatPos("a", 1) }, [], ports()));
    assert.ok(out.rows.length);
    assert.ok(!ids(out).includes("a"));
    assert.equal(out.sections?.[0]?.name, "Ti");
    assert.equal(out.sections?.[0]?.firstSceneId, out.rows[out.rows.length - 1]?.id);
    assert.deepEqual(out.selection, caretAt(headingPos("s", 2)));
    assert.equal(out.rows[out.rows.length - 1]?.visualText, "");
  }
});
