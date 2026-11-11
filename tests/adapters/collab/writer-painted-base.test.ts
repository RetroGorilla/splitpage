import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createSurface } from "../../../src/features/writer/flow-surface.ts";
import type { Surface } from "../../../src/features/writer/flow-surface.ts";
import type { FlowRow } from "../../../src/core/flow/flow.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";
import type { PaintedText } from "../../../src/application/editing/ports.ts";
import type { SharedContentRef, SharedOperation } from "../../../src/core/collab/operations.ts";
import { encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { sharedAnchorCharacterEnd } from "../../../src/adapters/collab/anchors.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { Stage1ExecutorHarness } from "./stage1-executor-support.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { ReplicaReading } from "../../collab/agreement.ts";

function paintOnA(h: Stage1ExecutorHarness): Surface {
  Object.assign(globalThis, { MutationObserver: window.MutationObserver, CSS: { escape: (s: string) => s } });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  document.body.innerHTML = '<div id="writer-doc" contenteditable="true"></div>';
  const root = document.getElementById("writer-doc") as HTMLElement;
  const surface = createSurface({
    paintedText: { read: (rowId, field) => field === "audioText" ? readSharedPaintedText(h.a, h.target(rowId)) : null },
    lifetime: { epoch: () => 1 },
    heldSelection: createEditorSelection({ epoch: () => 1, order: () => [], keys: () => null }),
    root, doc: () => ({ rows: projectSharedDocument(h.a).rows as readonly FlowRow[], comments: [] }),
    flow: { cells: html => fromHtml(html ?? ""), newId: () => "new", hasVisual: () => false },
    decode: fromHtml, storedHtml: html => html,
    moveBeat: () => {}, editingBlocked: () => false, syncBeat: () => {}, commit: () => null,
    undo: () => {}, notice: () => {}, changed: () => {}, selectionMoved: () => {},
    settings: () => ({ enter: "double", tick: "delete", gapTyping: "here", markdown: true }),
    openFind: () => {}, plainVisual: () => ""
  });
  surface.paint();
  return surface;
}

function painted(surface: Surface, row: string): PaintedText {
  const base = surface.paintedBase(row);
  assert.ok(base);
  return base;
}

function units(base: PaintedText): SharedContentRef[] {
  return [...Array(base.text.length).keys()].map(index => { const identity = base.identity(index); assert.ok(identity); return identity; });
}

function locate(handle: SharedDocumentHandle, anchors: readonly SharedContentRef[]): string[] {
  const preparation = createSharedPreparation(handle);
  try {
    const text = preparation.view.text(["segments", "b:R1", "text"]);
    assert.ok(text);
    return anchors.map(anchor => { const found = text.resolveAnchor(anchor); return found.kind === "gone" ? "gone" : found.kind + " " + found.index; });
  } finally { preparation.close(); }
}

function remoteEdits(h: Stage1ExecutorHarness): void {
  h.execute("B", [h.insertion("B", "R1", h.point("B", "R1", 0), "X")], ["X"]);
  h.execute("B", [h.insertion("B", "R1", h.point("B", "R1", 4), "Y")], ["Y"]);
  h.execute("B", [h.deletion("B", "R1", h.range("B", "R1", 5, 6))]);
  h.execute("B", [h.mark("B", "R1", h.range("B", "R1", 5, 7), { kind: "b", value: true })]);
  h.execute("B", [h.insertion("B", "R1", h.point("B", "R1", 7), "Z")], ["Z"]);
}

function fromPaintedBase(h: Stage1ExecutorHarness, painted: readonly SharedContentRef[]): SharedOperation[] {
  const b = painted[1], c = painted[2];
  assert.ok(b && c);
  const afterC = sharedAnchorCharacterEnd(c);
  assert.ok(afterC);
  return [h.deletion("A", "R1", b), h.insertion("A", "R1", afterC, "Q")];
}

test("positions painted on A name the same characters, or the gap one left, after B edits before, inside and after them", () => {
  const readings: ReplicaReading<readonly string[]>[] = [];
  const expected = ["index 1", "index 2", "index 3", "gap 5", "index 5", "index 6"];
  for (const order of deliveryOrders) {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcdef" }, { id: "R2", text: "gh" }]);
    let surface: Surface | null = null;
    try {
      surface = paintOnA(h);
      const base = painted(surface, "R1"), seen = units(base);
      assert.deepEqual([base.text, base.revision, painted(surface, "R2").text], ["abcdef", 1, "gh"]);
      assert.deepEqual(locate(h.a, seen), ["index 0", "index 1", "index 2", "index 3", "index 4", "index 5"]);
      remoteEdits(h);
      h.check(order, { rows: [
        { id: "R1", characters: [["X", "X", {}], ["s1", "a", {}], ["s2", "b", {}], ["s3", "c", {}], ["Y", "Y", {}], ["s5", "e", { b: true }], ["s6", "f", { b: true }], ["Z", "Z", {}]] },
        { id: "R2", characters: [["s7", "g", {}], ["s8", "h", {}]] }
      ], carets: {}, recovery: [] });
      assert.equal(surface.paintedBase("R1"), base);
      assert.deepEqual(units(base), seen);
      for (const [replica, handle] of [["A", h.a], ["B", h.b], ["C", h.c]] as const) {
        const output = locate(handle, seen);
        assert.deepEqual(output, expected);
        readings.push({ order: replica === "C" ? "late-C" : order === "late-C" ? "D1" : order, replica, output });
      }
      surface.repaint();
      const fresh = painted(surface, "R1");
      assert.deepEqual([fresh.text, fresh.revision], ["XabcYefZ", readSharedRevision(h.a)]);
      assert.deepEqual(locate(h.a, units(fresh)), ["index 0", "index 1", "index 2", "index 3", "index 4", "index 5", "index 6", "index 7"]);
      assert.deepEqual([1, 2, 3, 5, 6].map(index => fresh.identity(index)), [seen[0], seen[1], seen[2], seen[4], seen[5]]);
    } finally { surface?.dispose(); h.destroy(); }
  }
  assert.equal(readings.length, 18);
  assertReplicasAgree("painted positions", [{ order: "D2", replica: "A", output: expected }, ...readings]);
});

test("an operation list built from A's painted base is refused whole as stale once the revision moved", () => {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcdef" }, { id: "R2", text: "gh" }]);
  let surface: Surface | null = null;
  try {
    surface = paintOnA(h);
    const base = painted(surface, "R1"), operations = fromPaintedBase(h, units(base));
    remoteEdits(h);
    h.queue.flush("D1");
    assert.equal(readSharedRevision(h.a), base.revision + 5);
    const before = encodeSharedState(h.a), revision = readSharedRevision(h.a);
    assert.deepEqual(executeSharedOperations(h.a, operations, { base: base.revision }), { ok: false, reason: "stale-base" });
    assert.deepEqual(encodeSharedState(h.a), before);
    assert.equal(readSharedRevision(h.a), revision);
    assert.equal(h.queue.pending.length, 0);
    assert.deepEqual(h.characters(h.a, "R1").map(char => char.value).join(""), "XabcYefZ");
    surface.repaint();
    const fresh = painted(surface, "R1");
    assert.deepEqual(executeSharedOperations(h.a, fromPaintedBase(h, units(fresh).slice(1)), { base: fresh.revision }), { ok: true });
    assert.deepEqual(h.characters(h.a, "R1").map(char => char.value).join(""), "XacQYefZ");
  } finally { surface?.dispose(); h.destroy(); }
});

test("the same list is accepted whole while the revision is the painted one", () => {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcdef" }, { id: "R2", text: "gh" }]);
  let surface: Surface | null = null;
  try {
    surface = paintOnA(h);
    const base = painted(surface, "R1");
    assert.deepEqual(executeSharedOperations(h.a, fromPaintedBase(h, units(base)), { base: base.revision }), { ok: true });
    assert.deepEqual(h.characters(h.a, "R1").map(char => char.value).join(""), "acQdef");
    assert.equal(readSharedRevision(h.a), base.revision + 1);
  } finally { surface?.dispose(); h.destroy(); }
});
