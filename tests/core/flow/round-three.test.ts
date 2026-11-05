import { test } from "node:test";
import assert from "node:assert/strict";
import { flowCommand } from "../../../src/application/commands/flow.ts";
import { beatPos, caretAt, headingPos, insertBeats, joinWithPrevious, replaceRange } from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowEdit, FlowOutcome } from "../../../src/core/flow/flow.ts";
import { rowSlots } from "../../../src/core/document/gallery.ts";
import { harness, runConfined } from "../../application/session-fakes.ts";
import { createFlowLoadRuntime } from "./load.ts";

const stamps = { clock: { nowIso: () => "2026-11-04T12:00:00Z" }, editor: { name: () => "Editor" } };
const image = { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" };
const link = (n: number) => ({ href: "https://example.com/" + n });
function edited(out: FlowOutcome): FlowEdit {
  assert.ok(out && "rows" in out, JSON.stringify(out));
  return out;
}
function nextDocument(doc: FlowDoc, out: FlowEdit): FlowDoc {
  return { ...doc, rows: out.rows, sections: out.sections, comments: doc.comments.filter(comment => !out.removedComments.includes(comment.id)) };
}

test("R3-A: successive heading inserts retain the space, following letter and valid caret", () => {
  const rt = createFlowLoadRuntime();
  const doc = rt.load({ rows: [{ id: "a", audioText: "Body" }], sections: [{ id: "s", name: "Title", firstSceneId: "a" }] });
  const first = edited(replaceRange(doc, caretAt(headingPos("s", 5)), [{ text: " ", marks: {} }], rt.ports));
  const second = edited(replaceRange(nextDocument(doc, first), first.selection, [{ text: "X", marks: {} }], rt.ports));
  assert.equal(second.sections?.[0]?.name, "Title X");
  assert.equal(second.selection.head.offset, 7);
});

test("R3-A session: two real transactions preserve live heading whitespace and following text", () => {
  const rt = createFlowLoadRuntime();
  const h = harness(undefined, { entry: rt.load });
  h.session.adopt({ rows: [{ id: "a", audioText: "Body" }], sections: [{ id: "s", name: "Title", firstSceneId: "a" }] });
  let selection = caretAt(headingPos("s", 5));
  for (const text of [" ", "X"]) {
    const out = runConfined(h.session, flowCommand("heading-sequence", doc => {
      const result = edited(replaceRange(doc, selection, [{ text, marks: {} }], rt.ports));
      selection = result.selection;
      return result;
    }, stamps));
    assert.equal(out.kind, "applied");
  }
  assert.equal((h.session.held()?.["sections"] as { name: string }[])[0]?.name, "Title X");
  assert.equal(selection.head.offset, 7);
  assert.equal(h.session.generation(), 2);
  h.session.dispose();
});

test("R3-B: a joined 21st picture link is capped before reload and disclosed", () => {
  const rt = createFlowLoadRuntime();
  const doc = rt.load({ rows: [{ id: "a", imageRef: image, imageLinks: Array.from({ length: 20 }, (_, i) => link(i)) },
    { id: "b", imageRef: image, imageLinks: [link(20)] }] });
  const out = edited(joinWithPrevious(doc, "b", rt.ports));
  const next = nextDocument(doc, out);
  assert.deepEqual(rowSlots(next.rows[0]), rowSlots(rt.load(next).rows[0]));
  assert.equal(rowSlots(next.rows[0])[0]?.links.length, 20);
  assert.match(out.notice ?? "", /link/i);
  assert.match(out.notice ?? "", /left out|dropped|removed/i);
});

test("R3-B: joining two poster links applies the single-poster policy and discloses changed details", () => {
  const rt = createFlowLoadRuntime();
  const doc = rt.load({ rows: [{ id: "a", imageRef: image, imageLinks: [{ ...link(1), poster: true }] },
    { id: "b", imageRef: image, imageLinks: [{ ...link(2), poster: true }] }] });
  const out = edited(joinWithPrevious(doc, "b", rt.ports));
  assert.deepEqual(rowSlots(out.rows[0]), rowSlots(rt.load(nextDocument(doc, out)).rows[0]));
  assert.match(out.notice ?? "", /poster/i);
});

test("reload seed 1: inserted partial rows get stored defaults before entering a session", () => {
  const rt = createFlowLoadRuntime();
  const h = harness(undefined, { entry: rt.load });
  h.session.adopt({ rows: [{ id: "a", audioText: "Body" }] });
  const out = runConfined(h.session, flowCommand("insert", doc => insertBeats(doc, beatPos("a", 2), [{ id: "inserted", audioText: "New", visualText: "" }], rt.ports), stamps));
  assert.equal(out.kind, "applied");
  assert.deepEqual(h.session.held(), rt.load(h.session.held()));
  h.session.dispose();
});

test("gallery cap audit: names, pictures, annotation marks, points and text survive a maximum-size join", () => {
  const rt = createFlowLoadRuntime();
  const textMark = { kind: "text", color: "#111111", size: 0.1, x: 0.2, y: 0.3, text: "T".repeat(500) };
  const pen = { kind: "pen", color: "#111111", width: 0.05, points: Array.from({ length: 4000 }, (_, i) => i % 2 ? 0.2 : 0.1) };
  const annotation = { imageRef: { ...image, sha256: "b".repeat(64) }, marks: [pen, ...Array.from({ length: 499 }, () => textMark)] };
  const doc = rt.load({ rows: [{ id: "a", imageRef: image, imageName: "N".repeat(200), imageAnnotation: annotation,
    moreImages: Array.from({ length: 60 }, (_, i) => ({ imageRef: { ...image, sha256: (i + 1).toString(16).padStart(64, "0") }, name: "N".repeat(200), links: Array.from({ length: 20 }, (_, n) => link(n)) })) },
  { id: "b", imageRef: image, imageName: "Other" }] });
  const out = edited(joinWithPrevious(doc, "b", rt.ports));
  const slots = rowSlots(out.rows[0]);
  assert.equal(slots.length, 61);
  assert.equal(slots[0]?.name.length, 200);
  assert.equal(slots[0]?.annotation?.marks.length, 500);
  assert.equal((slots[0]?.annotation?.marks[0] as { points: number[] }).points.length, 4000);
  assert.equal((slots[0]?.annotation?.marks[1] as { text: string }).text.length, 500);
  assert.deepEqual(slots, rowSlots(rt.load(nextDocument(doc, out)).rows[0]));
});
