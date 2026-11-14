import { test } from "node:test";
import * as Y from "yjs";
import assert from "node:assert/strict";
import { bufferedSplit } from "./cell-buffer-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { sharedCommand } from "../../application/session/shared-session-support.ts";
import { setCellSelection } from "../../../src/features/common/cell-selection.ts";
import type { SharedContentRef } from "../../../src/core/collab/operations.ts";
import { bufferedFieldKey } from "../../../src/core/collab/buffer.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { operation } from "../../adapters/collab/executor-support.ts";

type Page = ReturnType<typeof bufferedSplit>;

const NBSP = "\u00a0", VISUAL_KEY = bufferedFieldKey("R1", "visualText");

function visual(page: Page, rowId = "R1"): unknown {
  return page.a.session.read(doc => doc?.rows.find(row => row.id === rowId)?.visualText);
}

function type(page: Page, at: number, data: string, rowId = "R1"): boolean {
  return page.key(rowId, at, at, "insertText", data, { field: "visualText" });
}

function operations(page: Page): unknown[] {
  return page.a.executed.map(command => command.operations.map(operation => operation.kind));
}

test("9e: typing in a visual cell commits to the beat's visual through the buffered field, one commit per key", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    assert.equal(type(page, 0, "Z"), true);
    assert.equal(type(page, 1, "Y"), true);
    assert.deepEqual([visual(page), page.text(), page.reports, page.missing], ["ZY", "ab", [], []]);
    assert.deepEqual(operations(page), [["text-insert", "scalar"], ["text-insert", "scalar"]]);
    const insert = page.a.executed[0]?.operations[0];
    assert.deepEqual(page.a.described.map(described => [described?.label, described?.typing, described?.selection !== null]), [["typing", "Z", true], ["typing", "Y", true]]);
    assert.deepEqual(insert?.kind === "text-insert" ? insert.target : null, { owner: "R1", segment: "R1", field: "visualText" });
    assert.deepEqual([page.painted.base(VISUAL_KEY)?.text, page.caret("R1", "visualText")], ["ZY", { from: 2, to: 2 }]);
  } finally { page.close(); }
});

test("9e: a received update is held while a visual cell is composing and applied when the composition commits", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    const cell = page.cell("R1", "visualText"); cell.focus(); setCellSelection(cell, 0);
    cell.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    assert.equal(page.key("R1", 0, 0, "insertCompositionText", "x", { field: "visualText", during: () => {
      page.h.execute("B", [page.h.insertion("B", "R1", page.h.point("B", "R1", 0, "after"), "Q")], ["b1"]);
      page.h.queue.deliverFrom("B", "D3");
    } }), true);
    assert.deepEqual([page.text(), visual(page), [...collabState(page.h.a).ingress.holds]], ["ab", "", ["buffer"]]);
    cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "x" }));
    assert.deepEqual([page.text(), visual(page), page.caret("R1", "visualText"), page.reports], ["Qab", "x", { from: 1, to: 1 }, []]);
  } finally { page.close(); }
});

test("9e: one buffered edit across both columns: with a narration composition pending, typing in the visual column is refused and writes nothing", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    const narration = page.cell("R1"); narration.focus(); setCellSelection(narration, 2);
    narration.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    assert.equal(page.key("R1", 2, 2, "insertCompositionText", "x"), true);
    assert.equal(type(page, 0, "Z"), false);
    assert.deepEqual([page.reports, page.a.executed.length, visual(page)], [[{ kind: "rejected", reason: "buffer-composition" }], 0, ""]);
    narration.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "x" }));
    assert.deepEqual([page.text(), visual(page)], ["abx", ""]);
  } finally { page.close(); }
});

test("9e, rule 55: in the visual column a typed space the browser shows as U+00A0 is stored as typed and keeps its identity", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    assert.equal(type(page, 0, "a"), true);
    assert.equal(page.key("R1", 1, 1, "insertText", " ", { field: "visualText", shown: cell => {
      const node = [...cell.childNodes].find(child => child instanceof window.Text && child.data === " "); assert.ok(node instanceof window.Text); node.data = NBSP;
    } }), true);
    assert.equal(type(page, 2, "b"), true);
    assert.deepEqual([visual(page), page.reports], ["a b", []]);
    assert.deepEqual(page.a.executed.map(command => command.base), [1, 2, 3]);
  } finally { page.close(); }
});

test("9e, rule 29: a visual edit refused at its painted base is kept in recovery, the cell as shown in the draft's visual and its narration empty", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }, { id: "R2", text: "next" }], true, { author: serial => "r" + (15 + serial), structure: true });
  try {
    const other = collabState(page.h.a).roots.beats.get("R2"); assert.ok(other instanceof Y.Map);
    assert.equal(page.key("R1", 0, 0, "insertText", "XYZ", { field: "visualText", during: () => {
      transactSharedDocument(page.h.a, "local-command", () => { other.set("lengthSeconds", 7); });
    } }), true);
    assert.deepEqual([page.recovered, page.reports, visual(page), page.cell("R1", "visualText").textContent], [[VISUAL_KEY], [], "", ""]);
    assert.deepEqual(page.a.executed[1]?.operations, [
      { kind: "segment-create", id: "r17", by: "Alice", segment: "draft_segment_r17", beat: "draft_r17",
        at: { left: "b:R1", right: null, affinity: "after" }, fields: { visualText: "XYZ", bufferSourceOwner: "R1", bufferPaintedBase: 1 } },
      { kind: "remove", id: "r17_remove", by: "Alice", removalKind: "beat", targets: ["draft_r17"], observed: [],
        boundaries: ["draft_r17"], components: ["structure_1_007200310037_visual_0"], gallery: [], comments: [], at: 2 }
    ]);
    page.h.queue.flush("dup"); page.h.join();
    for (const handle of [page.h.a, page.h.b, page.h.c]) {
      assert.deepEqual(projectSharedDocumentWithRecovery(handle).recovery.map(entry => entry.kind === "removed-beat"
        ? [entry.row.id, entry.row.audioText, entry.row.visualText] : entry.kind), [["structure_1_007200310037_beat_0", "", "XYZ"]]);
    }
  } finally { page.close(); }
});

test("9e, assumed rule: typed @Name and B-roll lines in the visual column write only text in a shared session; people, shots and keys stay with package 14", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    assert.equal(type(page, 0, "@Sam"), true);
    assert.equal(page.key("R1", 4, 4, "insertLineBreak", "\n", { field: "visualText" }), false);
    assert.equal(type(page, 4, " B-roll: drone"), true);
    assert.deepEqual([visual(page), page.reports.map(report => report.kind === "rejected" ? report.reason : report.kind)],
      ["@Sam B-roll: drone", ["buffer-unsupported-input"]]);
    assert.deepEqual([page.a.session.read(doc => doc?.people.length), page.a.session.read(doc => doc?.brollShots.length)], [0, 0]);
    assert.deepEqual(operations(page), [["text-insert", "scalar"], ["text-insert", "scalar"]]);
  } finally { page.close(); }
});

test("9e, declared limit: the visual cell of a joined row shows both visuals and refuses typing until a later cut, as rule 27 does", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }]);
  try {
    registerSharedJoinHandlers(page.h.a);
    assert.equal(type(page, 0, "v1", "R1") && type(page, 0, "v2", "R2"), true);
    const joined = page.a.session.run(sharedCommand("join", [{ kind: "join", id: "glue" as SharedContentRef, by: "Alice", from: "R2" as SharedContentRef, into: "R1" as SharedContentRef, glue: " " }]));
    assert.equal(joined.kind, "applied");
    assert.deepEqual([visual(page), page.cell("R1", "visualText").textContent], ["v1<br>v2", "v1v2"]);
    assert.equal(type(page, 0, "Z"), false);
    assert.deepEqual([page.missing, visual(page), page.reports], [[VISUAL_KEY], "v1<br>v2", []]);
  } finally { page.close(); }
});

test("9e: a sound cue typed in the visual column stays plain text and registers no tag, since only the standalone cue shortcut marks it", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    assert.equal(type(page, 0, "SFX: bang"), true);
    assert.deepEqual([visual(page), page.a.session.read(doc => doc?.productionTags.length), operations(page), page.reports],
      ["SFX: bang", 0, [["text-insert", "scalar"]], []]);
  } finally { page.close(); }
});

function bobVisual(page: Page, op: Record<string, unknown>): void {
  assert.deepEqual(executeSharedOperations(page.h.b, [operation(op)], { base: readSharedRevision(page.h.b) }), { ok: true });
}

test("9e: the caret after a visual commit follows the visual's own characters through someone else's held insertion", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    assert.equal(type(page, 0, "hello"), true);
    page.h.queue.flush("D1");
    const target = { owner: "R1" as SharedContentRef, segment: "R1" as SharedContentRef, field: "visualText" as const };
    assert.equal(page.key("R1", 5, 5, "insertText", "X", { field: "visualText", during: () => {
      const first = createSharedAnchor(page.h.b, target, 0, "after"); assert.ok(first);
      bobVisual(page, { kind: "text-insert", id: "bob-qq", by: "Bob", target, at: { left: null, right: first, affinity: "before" }, content: [{ value: "QQ", marks: [] }] });
      page.h.queue.deliverFrom("B", "D3");
    } }), true);
    assert.deepEqual([visual(page), page.caret("R1", "visualText"), page.reports], ["QQhelloX", { from: 8, to: 8 }, []]);
  } finally { page.close(); }
});

test("9e: typing right after a word someone else made bold in the visual column commits, and every copy agrees on the result", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    assert.equal(type(page, 0, "ab"), true);
    page.h.queue.flush("D1");
    const target = { owner: "R1" as SharedContentRef, segment: "R1" as SharedContentRef, field: "visualText" as const };
    const units = [0, 1].map(offset => createSharedAnchor(page.h.b, target, offset, "after"));
    bobVisual(page, { kind: "mark", id: "bob-bold", by: "Bob", target, observed: units, mark: { kind: "b", value: true } });
    page.h.queue.deliverFrom("B", "D1");
    assert.equal(visual(page), "<strong>ab</strong>");
    assert.equal(type(page, 2, "c"), true);
    page.h.queue.flush("D1"); page.h.join();
    const shown = [page.h.a, page.h.b, page.h.c].map(handle => projectSharedDocumentWithRecovery(handle).document.rows.find(row => row.id === "R1")?.visualText);
    assert.deepEqual([shown, page.reports], [["<strong>abc</strong>", "<strong>abc</strong>", "<strong>abc</strong>"], []]);
  } finally { page.close(); }
});

function splitR1(page: Page): string {
  const split = page.a.session.run(sharedCommand("split", [operation({ kind: "split", id: "cut", by: "Alice", target: { owner: "R1", segment: "b:R1", field: "audioText" },
    at: { left: null, right: flowBaseReference("R1", "audioText", 2), affinity: "before" }, observed: [], boundary: "cut-boundary", beat: "Rn", fields: { status: "todo" } })]));
  assert.equal(split.kind, "applied");
  const fresh = page.a.session.read(doc => doc?.rows[1]?.id); assert.ok(fresh);
  return fresh;
}

function copies(page: Page): unknown[] {
  page.h.queue.flush("D1"); page.h.join();
  return [page.h.a, page.h.b, page.h.c].map(handle => projectSharedDocumentWithRecovery(handle).document.rows.map(row => [row.id, row.audioText, row.visualText]));
}

test("9e: a beat split off in a shared session has its own empty visual, so the first key in its visual cell commits on three copies", () => {
  const page = bufferedSplit([{ id: "R1", text: "abc" }], true, { structure: true });
  try {
    const fresh = splitR1(page);
    assert.equal(type(page, 0, "V", fresh), true);
    assert.deepEqual([page.reports, page.missing, page.caret(fresh, "visualText")], [[], [], { from: 1, to: 1 }]);
    assert.deepEqual(copies(page), Array.from({ length: 3 }, () => [["R1", "ab", ""], [fresh, "c", "V"]]));
  } finally { page.close(); }
});

test("9e, declared limit kept for older splits: a beat split before splits created a visual still loads, and its visual cell refuses with buffer-no-visual and writes nothing", () => {
  const page = bufferedSplit([{ id: "R1", text: "abc" }], true, { structure: true });
  try {
    const fresh = splitR1(page), roots = collabState(page.h.a).roots, beat = roots.beats.get(fresh);
    assert.ok(beat instanceof Y.Map);
    const made = beat.get("visual"); assert.equal(typeof made, "string");
    transactSharedDocument(page.h.a, "local-command", () => { beat.delete("visual"); roots.visuals.delete(String(made)); });
    page.paint();
    const executed = page.a.executed.length;
    assert.equal(type(page, 0, "V", fresh), false);
    assert.deepEqual([page.reports, page.missing, page.a.executed.length, visual(page, fresh)], [[{ kind: "rejected", reason: "buffer-no-visual" }], [], executed, ""]);
    assert.equal(page.key(fresh, 1, 1, "insertText", "N"), true);
    assert.deepEqual(copies(page), Array.from({ length: 3 }, () => [["R1", "ab", ""], [fresh, "cN", ""]]));
  } finally { page.close(); }
});
