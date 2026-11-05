import { test } from "node:test";
import assert from "node:assert/strict";
import { createRichText } from "../../../src/adapters/richtext/richtext.ts";
import { createImageIngestion } from "../../../src/core/document/media.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { beatPos, deleteForwardAt, enterInHeading, headingPos, joinWithPrevious, replaceRange } from "../../../src/core/flow/flow.ts";
import { rowSlots } from "../../../src/core/document/gallery.ts";
import type { FlowDoc, FlowPorts, FlowPos, FlowRange } from "../../../src/core/flow/flow.ts";
import type { DocumentScene } from "../../../src/core/document/scenes.ts";
import { flowCommand } from "../../../src/application/commands/flow.ts";
import { createUndo } from "../../../src/application/editing/undo/undo.ts";
import { syncCommentAnchors } from "../../../src/core/text/anchors.ts";
import { jsdomParser } from "../../adapters/richtext/jsdom.mjs";
import { countingIds, migratedThenSet } from "../migrate-ports.ts";
import { harness, runConfined } from "../../application/session-fakes.ts";
import { observedFlowContent, referenceReplacement } from "./reference.ts";

const rich = createRichText({ DOMParser: jsdomParser(), images: createImageIngestion(() => null), ids: countingIds() });
const cells = rich.createCellReader(deepFreeze, { media: true });
function ports(): FlowPorts {
  let made = 0;
  return { cells, newId: () => "new" + ++made, hasVisual: row => !!row.visualText || !!row.imageRef };
}
const stamps = { clock: { nowIso: () => "2026-11-04T12:00:00Z" }, editor: { name: () => "Editor" } };
const row = (id: string, audioText: string, visualText = "") => ({ id, audioText, visualText });
const scene = (id: string, firstSceneId: string) => ({ id, firstSceneId, name: "Title" });
const marked = (word: string) => '<span class="cmt-anchor" data-cmt="quote">' + word + "</span>";

const reviewShapes: { finding: number; doc: FlowDoc; range: FlowRange; text: string }[] = [
  { finding: 1, doc: { rows: [row("a", "Before"), row("b", marked("Alpha")), row("c", marked("Bravo"))], comments: [{ id: "thread", anchorId: "quote", rowId: "b" }] }, range: { anchor: beatPos("a", 6), head: beatPos("c", 0) }, text: "" },
  { finding: 2, doc: { rows: [row("a", "Body"), row("b", "Next")], sections: [scene("s", "a"), scene("t", "b")], comments: [] }, range: { anchor: beatPos("a", 0), head: headingPos("t", 0) }, text: "" },
  { finding: 3, doc: { rows: [row("a", "Before"), row("b", "Body")], sections: [scene("s", "b")], comments: [] }, range: { anchor: beatPos("a", 6), head: beatPos("b", 0) }, text: "" },
  { finding: 4, doc: { rows: [row("a", "Body")], sections: [scene("s", "a")], comments: [] }, range: { anchor: headingPos("s", 2), head: beatPos("a", 2) }, text: "X" },
  { finding: 5, doc: { rows: [row("a", "", "Visual"), row("b", "Body")], sections: [scene("s", "a")], comments: [] }, range: { anchor: headingPos("s", 0), head: beatPos("b", 4) }, text: "" }
];

function compare(doc: FlowDoc, range: FlowRange, text: string): void {
  const p = ports();
  const expected = referenceReplacement(doc, range, text, p);
  const out = replaceRange(doc, range, text ? [{ text, marks: {} }] : [], p);
  assert.ok(out && "rows" in out, JSON.stringify(out));
  const next: FlowDoc = { rows: out.rows, sections: out.sections, comments: doc.comments.filter(comment => !out.removedComments.includes(comment.id)) };
  assert.deepEqual(observedFlowContent(next, doc, p), expected);
}

for (const shape of reviewShapes) {
  test("reference property R2-" + shape.finding + ": linear replacement preserves expected content", () => {
    compare(shape.doc, shape.range, shape.text);
    compare(shape.doc, { anchor: shape.range.head, head: shape.range.anchor }, shape.text);
  });
}

test("seeded reference: 1800 replacements compare headings, text, beat identities, visuals, flags and comments", t => {
  const started = performance.now();
  for (let seed = 1; seed <= 300; seed++) {
    let state = seed;
    const pick = (limit: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor(state / 65536) % limit; };
    const rows = Array.from({ length: 1 + pick(6) }, (_, i) => ({ ...row("r" + i, ["", "Alpha", "<strong>Body</strong>", marked("Quote")][pick(4)] as string, ["", "Visual", marked("Visual")][pick(3)] as string),
      ...(pick(3) === 0 ? { paragraphStart: true } : {}), ...(pick(5) === 0 ? { imageRef: { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" }, imageName: "Picture" } : {}) }));
    const sections: DocumentScene[] = rows.filter((_, i) => i === 0 ? !!pick(2) : pick(3) === 0).map((beat, i) => scene("s" + i, beat.id));
    const doc: FlowDoc = { rows, sections, comments: [{ id: "thread", anchorId: "quote", rowId: rows[pick(rows.length)]?.id }] };
    const positions: FlowPos[] = rows.flatMap(beat => {
      const length = cells(beat.audioText).reduce((n, run) => n + run.text.length, 0);
      return [beatPos(beat.id, 0), beatPos(beat.id, Math.floor(length / 2)), beatPos(beat.id, length)];
    });
    for (const section of sections) positions.push(headingPos(section.id, 0), headingPos(section.id, 2), headingPos(section.id, 5));
    for (let operation = 0; operation < 6; operation++) {
      const range = { anchor: positions[pick(positions.length)] as FlowPos, head: positions[pick(positions.length)] as FlowPos };
      const text = operation % 2 ? "X" : "";
      try { compare(doc, range, text); }
      catch (error) { throw new Error("reference seed=" + seed + " operation=" + operation + " range=" + JSON.stringify(range), { cause: error }); }
    }
    const p = ports();
    const range = { anchor: positions[pick(positions.length)] as FlowPos, head: positions[pick(positions.length)] as FlowPos };
    const h = harness(undefined, { entry: () => {
      const live = migratedThenSet(JSON.parse(JSON.stringify(doc)) as FlowDoc);
      syncCommentAnchors(live, cells);
      return live;
    }, reconcile: live => syncCommentAnchors(live, cells), record: () => { undo.noteEdit(); undo.flush(); } });
    h.session.adopt({});
    const undo = createUndo({ held: h.session.held, runs: html => cells(String(html ?? "")), now: () => 1000, cleared: () => {} });
    undo.adopt(h.session.held());
    const unroute = undo.routeReplays(h.session.replay, null);
    const before = observedFlowContent(h.session.held() as FlowDoc, doc, p);
    const expected = referenceReplacement(h.session.held() as FlowDoc, range, "X", p);
    const out = runConfined(h.session, flowCommand("reference-replace", current => replaceRange(current, range, [{ text: "X", marks: {} }], p), stamps));
    assert.equal(out.kind, "applied", "session seed=" + seed);
    assert.deepEqual(observedFlowContent(h.session.held() as FlowDoc, doc, p), expected, "session seed=" + seed);
    assert.equal(undo.sizes().undo, 1, "session seed=" + seed);
    const undone = undo.undo();
    assert.equal(undone.ok, true, "undo seed=" + seed + " " + JSON.stringify(undone));
    assert.deepEqual(observedFlowContent(h.session.held() as FlowDoc, doc, p), before, "undo seed=" + seed);
    const redone = undo.redo();
    assert.equal(redone.ok, true, "redo seed=" + seed + " " + JSON.stringify(redone));
    assert.deepEqual(observedFlowContent(h.session.held() as FlowDoc, doc, p), expected, "redo seed=" + seed);
    unroute();
    h.session.dispose();
  }
  t.diagnostic("1800 pure comparisons + 300 session undo/redo comparisons in " + (performance.now() - started).toFixed(0) + " ms; seeds 1..300");
});

test("reference property R2-6: 100 duplicate-picture joins preserve ordered link details", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const imageRef = { sha256: seed.toString(16).padStart(64, "0"), width: 1, height: 1, mime: "image/png" };
    const first = { ...row("a", "A"), imageRef, imageName: seed % 2 ? "First" : "", imageLinks: [{ href: "https://example.com/first/" + seed }] };
    const second = { ...row("b", "B"), imageRef, imageName: "Second", imageLinks: [{ href: "https://example.com/second/" + seed }] };
    const out = joinWithPrevious({ rows: [first, second], comments: [] }, "b", ports());
    assert.ok(out && "rows" in out, "picture seed=" + seed);
    const slots = rowSlots(out.rows[0]);
    assert.equal(slots.length, 1, "picture seed=" + seed);
    assert.deepEqual(slots[0]?.links, first.imageLinks.concat(second.imageLinks), "picture seed=" + seed);
    assert.equal(slots[0]?.name, first.imageName || second.imageName, "picture seed=" + seed);
    assert.ok(out.notice?.includes("duplicate"), "picture seed=" + seed);
  }
});

test("reference property R2-7: 100 forward deletes stop at the next heading without changing content", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const text = seed % 2 ? "" : "Before";
    const doc: FlowDoc = { rows: [row("a", text), row("b", seed % 3 ? "Body" : "", "Visual")], sections: [scene("s", "b")], comments: [] };
    const before = JSON.stringify(doc);
    assert.deepEqual(deleteForwardAt(doc, beatPos("a", text.length), ports()), { move: headingPos("s", 0) }, "boundary seed=" + seed);
    assert.equal(JSON.stringify(doc), before, "boundary seed=" + seed);
  }
});

test("reference property R2-8: 100 heading-start Enters preserve a valid nonempty scene name", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const doc: FlowDoc = { rows: [row("a", "Body")], sections: [{ ...scene("s", "a"), name: "Title" + seed }], comments: [] };
    const before = JSON.stringify(doc);
    assert.deepEqual(enterInHeading(doc, headingPos("s", 0), ports()), { move: beatPos("a", 0) }, "heading seed=" + seed);
    assert.equal(JSON.stringify(doc), before, "heading seed=" + seed);
  }
});
