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

type Page = ReturnType<typeof bufferedSplit>;

const NBSP = " ", VISUAL_KEY = "R1�visualText";

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
