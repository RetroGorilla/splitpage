import { test } from "node:test";
import assert from "node:assert/strict";
import { createRichText } from "../../../src/adapters/richtext/richtext.ts";
import { createImageIngestion } from "../../../src/core/document/media.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { rowSlots } from "../../../src/core/document/gallery.ts";
import { normalizeScenes } from "../../../src/core/document/scenes.ts";
import { beatPos, caretAt, deleteForwardAt, enterInHeading, headingPos, joinWithPrevious, replaceRange } from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowEdit, FlowOutcome, FlowPorts } from "../../../src/core/flow/flow.ts";
import { flowCommand } from "../../../src/application/commands/flow.ts";
import { jsdomParser } from "../../adapters/richtext/jsdom.mjs";
import { countingIds, migratedThenSet } from "../migrate-ports.ts";
import { harness, runConfined } from "../../application/session-fakes.ts";

const rich = createRichText({ DOMParser: jsdomParser(), images: createImageIngestion(() => null), ids: countingIds() });
const cells = rich.createCellReader(deepFreeze, { media: true });
const scene = (id: string, firstSceneId: string, name = "Title") => ({ id, firstSceneId, name });
const row = (id: string, audioText: string, visualText = "") => ({ id, audioText, visualText });
function ports(): FlowPorts {
  let made = 0;
  return { cells, newId: () => "new" + ++made, hasVisual: beat => !!beat.visualText || !!beat.imageRef };
}
function edit(out: FlowOutcome): FlowEdit {
  assert.ok(out && "rows" in out);
  return out;
}
const stamps = { clock: { nowIso: () => "2026-11-04T12:00:00Z" }, editor: { name: () => "Editor" } };

function sessionResult(doc: FlowDoc, operation: (current: FlowDoc) => FlowOutcome): FlowDoc {
  const h = harness(undefined, { entry: () => migratedThenSet(doc) });
  h.session.adopt({});
  const out = runConfined(h.session, flowCommand("round-two", operation, stamps));
  assert.ok(out.kind === "applied" || out.kind === "noop", JSON.stringify(out));
  const result = JSON.parse(JSON.stringify(h.session.held())) as FlowDoc;
  h.session.dispose();
  return result;
}

test("R2-1: a thread survives by anchorId when its marked words survive in another beat", () => {
  const marked = (text: string) => '<span class="cmt-anchor" data-cmt="quote">' + text + "</span>";
  const doc: FlowDoc = { rows: [row("a", "Before"), row("b", marked("Alpha")), row("c", marked("Bravo"))],
    comments: [{ id: "thread", anchorId: "quote", rowId: "b" }] };
  const out = sessionResult(doc, current => replaceRange(current, { anchor: beatPos("a", 6), head: beatPos("c", 0) }, [], ports()));
  assert.deepEqual(out.comments.map(comment => comment.id), ["thread"]);
});

test("R2-2: deleting a scene's only beat preserves its unselected heading and an empty beat", () => {
  const doc: FlowDoc = { rows: [row("a", "Body"), row("b", "Next")], sections: [scene("s", "a"), scene("t", "b", "Next")], comments: [] };
  const out = edit(replaceRange(doc, { anchor: beatPos("a", 0), head: headingPos("t", 0) }, [], ports()));
  assert.deepEqual(out.sections?.map(item => item.id), ["s", "t"]);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0]?.audioText, "");
  assert.equal(out.sections?.[0]?.firstSceneId, out.rows[0]?.id);
});

test("R2-3: deleting only a heading preserves the scene's implicit paragraph break", () => {
  const doc: FlowDoc = { rows: [row("a", "Before"), row("b", "Body")], sections: [scene("s", "b")], comments: [] };
  const out = sessionResult(doc, current => replaceRange(current, { anchor: beatPos("a", 6), head: beatPos("b", 0) }, [], ports()));
  assert.equal(out.rows[1]?.paragraphStart, true);
  assert.deepEqual(out.rows.map(beat => beat.audioText), ["Before", "Body"]);
});

test("R2-4: replacement starting in a heading inserts into the heading and advances its caret", () => {
  const doc: FlowDoc = { rows: [row("a", "Body")], sections: [scene("s", "a")], comments: [] };
  const out = edit(replaceRange(doc, { anchor: headingPos("s", 2), head: beatPos("a", 2) }, [{ text: "X", marks: {} }], ports()));
  assert.equal(out.sections?.[0]?.name, "TiX");
  assert.equal(out.rows[0]?.audioText, "dy");
  assert.deepEqual(out.selection, caretAt(headingPos("s", 3)));
});

test("R2-5: full deletion removes visual-only beats in both selection directions", () => {
  const doc: FlowDoc = { rows: [row("a", "", "Visual"), row("b", "Body")], sections: [scene("s", "a")], comments: [] };
  for (const range of [{ anchor: headingPos("s", 0), head: beatPos("b", 4) }, { anchor: beatPos("b", 4), head: headingPos("s", 0) }]) {
    const out = sessionResult(doc, current => replaceRange(current, range, [], ports()));
    assert.equal(out.rows.length, 1);
    assert.ok(out.rows.every(beat => beat.id !== "a" && beat.id !== "b"));
    assert.equal(out.rows[0]?.visualText, "");
    assert.equal(out.rows[0]?.audioText, "");
  }
});

test("R2-6: joining duplicate picture SHAs retains names and links and explains consolidation", () => {
  const imageRef = { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" };
  const doc: FlowDoc = { rows: [{ ...row("a", "A"), imageRef, imageName: "First", imageLinks: [{ href: "https://example.com/first" }] },
    { ...row("b", "B"), imageRef, imageName: "Second", imageLinks: [{ href: "https://example.com/second" }] }], comments: [] };
  const out = edit(joinWithPrevious(doc, "b", ports()));
  assert.equal(rowSlots(out.rows[0]).length, 1);
  assert.deepEqual(rowSlots(out.rows[0])[0]?.links.map(link => link.href), ["https://example.com/first", "https://example.com/second"]);
  assert.ok(out.notice?.includes("First") && out.notice.includes("Second"));
});

test("R2-7: Delete above a heading moves the caret without removing an empty beat", () => {
  const doc: FlowDoc = { rows: [row("a", ""), row("b", "Body")], sections: [scene("s", "b")], comments: [] };
  assert.deepEqual(deleteForwardAt(doc, beatPos("a", 0), ports()), { move: headingPos("s", 0) });
  const out = sessionResult(doc, current => deleteForwardAt(current, beatPos("a", 0), ports()));
  assert.deepEqual(out.rows.map(beat => beat.id), ["a", "b"]);
});

test("R2-8: empty scene names are invalid, so Enter at heading start retains caret-only behavior", () => {
  assert.equal(normalizeScenes([scene("s", "a", "")]), undefined);
  const doc: FlowDoc = { rows: [row("a", "Body")], sections: [scene("s", "a")], comments: [] };
  const before = JSON.stringify(doc);
  assert.deepEqual(enterInHeading(doc, headingPos("s", 0), ports()), { move: beatPos("a", 0) });
  assert.equal(JSON.stringify(doc), before);
});
