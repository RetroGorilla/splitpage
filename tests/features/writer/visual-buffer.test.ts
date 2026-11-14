import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlowWriter } from "../../../src/features/writer/flow-writer.ts";
import { writerVisualBuffer } from "../../../src/bootstrap/wiring/ports/writer-visual-buffer.ts";
import { writerFlowCommands } from "../../../src/bootstrap/wiring/ports/writer-flow.ts";
import { sharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { createPaintGuard } from "../../../src/application/editing/paint-guard.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { createMonitoredSharedDocument } from "../../adapters/collab/helpers.ts";
import { replicas } from "../../adapters/collab/executor-support.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { fakeFlowCommandEffects, fakeWriterBufferEffects } from "../fakes.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { cellSelection, setCellSelection } from "../../../src/features/common/cell-selection.ts";
import { posToDom } from "../../../src/features/common/cell-dom.ts";
import { createBufferedField } from "../../../src/application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../../src/application/editing/painted-beats.ts";
import { mountCellBuffer } from "../../../src/features/editing/cell-buffer.ts";
import { createCellPage } from "../../../src/features/editing/cell-page.ts";
import { bufferedFieldKey } from "../../../src/core/collab/buffer.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { operation, ref } from "../../adapters/collab/executor-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { replaceRange, beatPos } from "../../../src/core/flow/flow.ts";

const changed = { updatedAt: "2026-11-12T10:00:00.000Z", updatedBy: "Alice" };

function row(id: string, audioText: string, visualText: string, extra: Record<string, unknown> = {}) {
  return { id, status: "todo", visualText, audioText, imageRef: null, updatedAt: "", updatedBy: null, ...extra };
}

function expected(visualText: string, by = "Alice", rows?: readonly Record<string, unknown>[]) {
  return { schema: 2, title: "", docId: "d00000000000000000000000000000000", rows: rows ?? [row("R1", "abc", visualText, { ...changed, updatedBy: by }), row("R2", "def", "")],
    comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 };
}

function visualWriter() {
  Object.assign(globalThis, { MutationObserver: window.MutationObserver, CSS: { escape: (value: string) => value } });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  document.body.innerHTML = '<div class="writer-bar"></div><section><div id="writer-doc" contenteditable="true"></div></section>';
  const root = document.getElementById("writer-doc"); assert.ok(root);
  const h = replicas(2, { rows: [{ id: "R1", audioText: "abc", visualText: "ab" }, { id: "R2", audioText: "def" }] });
  const runtime = createFlowLoadRuntime();
  for (const handle of [h.a, h.b]) registerSharedOperationFamilies(handle, { cells: runtime.cells });
  const a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  const { effects: bufferEffects, reports, missing, recovered } = fakeWriterBufferEffects();
  const { effects, notices } = fakeFlowCommandEffects(), guard = createPaintGuard();
  const documentView = () => a.session.read(doc => doc);
  const author = sharedAuthorPort({ handle: () => h.a, name: () => "Alice" });
  const shared = sharedBufferPorts(h.a, a.session, { ...bufferEffects, readers: bufferReaders, stamps: bufferStamps("Alice"), author: () => { const request = author.next(); assert.ok(request); return request; } });
  const commands = writerFlowCommands(runtime.ports, { author, writer: () => "1" });
  const writer = createFlowWriter({ ...effects, ...shared, ...commands, root,
    visualBuffer: writerVisualBuffer(shared, { document: documentView, lifetime: a.session, decode: fromHtml, storedHtml: html => html, shown: guard.whileShown }),
    doc: () => { const doc = documentView(); assert.ok(doc); return doc; }, lifetime: a.session,
    heldSelection: createEditorSelection({ epoch: a.session.epoch, order: () => [], keys: () => null }),
    decode: fromHtml, storedHtml: html => html, run: a.session.run, shown: guard.whileShown, editingBlocked: () => guard.painting(),
    text: { cells: fromHtml, ...bufferStamps("Alice") },
    wholeFieldText: { commit: () => { throw new Error("Shared visual reached standalone whole-field synchronization"); } },
    visualInput: () => { throw new Error("Shared visual reached standalone record creators"); },
    visualLeave: () => { throw new Error("Shared visual reached standalone leave creators"); },
    visualKeydown: () => { throw new Error("Shared visual reached standalone key handlers"); }
  });
  writer.repaint();
  const stop = a.session.subscribe(() => { if (!guard.shown()) writer.repaint(); });
  writer.openVisual("R1");
  const cell = document.querySelector<HTMLElement>(".wr-flow-visual-text"); assert.ok(cell);
  function input(target: HTMLElement, from: number, to: number, data: string, type = "insertText", during?: () => void): boolean {
    target.focus(); setCellSelection(target, from, to);
    const start = posToDom(target, from), end = posToDom(target, to), range = document.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type, data });
    Object.defineProperty(event, "getTargetRanges", { value: () => [range.cloneRange()] });
    if (!target.dispatchEvent(event)) return false;
    during?.(); range.deleteContents(); if (data) range.insertNode(document.createTextNode(data));
    setCellSelection(target, from + data.length);
    target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: type, data }));
    return true;
  }
  function agrees(value: unknown) {
    h.queue.flush("dup");
    const late = createMonitoredSharedDocument(); assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
    const c = sharedHarness(adapterReplica(late));
    try {
      for (const harness of [a, b, c]) assert.deepEqual(harness.session.read(doc => doc), value);
      assertReplicasAgree("Writer visual", [{ order: "D1", replica: "A", output: documentView() }, { order: "D2", replica: "B", output: b.session.read(doc => doc) }, { order: "late-C", replica: "C", output: c.session.read(doc => doc) }]);
    } finally { c.session.dispose(); destroySharedDocument(late); }
  }
  let splitClose: (() => void) | null = null;
  function split() {
    const other = document.body.appendChild(document.createElement("section"));
    other.innerHTML = '<div class="cell-editable" data-id="R1" data-field="visualText" contenteditable="true">ab</div>';
    const target = other.firstElementChild as HTMLElement, listener = new Set<() => void>(), otherGuard = createPaintGuard();
    const otherAuthor = sharedAuthorPort({ handle: () => h.b, name: () => "Bob" });
    const otherShared = sharedBufferPorts(h.b, b.session, { ...bufferEffects, readers: bufferReaders, stamps: bufferStamps("Bob"), author: () => { const next = otherAuthor.next(); assert.ok(next); return next; } });
    const doc = () => b.session.read(doc => doc);
    const paint = () => { target.innerHTML = doc()?.rows.find(row => row.id === "R1")?.visualText ?? ""; for (const record of listener) record(); };
    const stopOther = b.session.subscribe(() => { if (!otherGuard.shown()) paint(); });
    const buffer = mountCellBuffer({ root: other, ports: {
      field: surface => createBufferedField(otherShared.bufferedText, surface), painted: createPaintedBeats(otherShared.paintedText),
      report: bufferEffects.report, page: createCellPage({ storedHtml: html => html, caretSpot: () => {} }), decode: fromHtml, document: doc,
      paintedFrom: () => true, notePainted: () => {}, shown: otherGuard.whileShown, repaintRows: paint,
      onPainted: record => { listener.add(record); return () => { listener.delete(record); }; }, beforePaint: () => () => {},
      readable: key => otherShared.paintedText.read(key, "visualText") !== null
    } });
    splitClose = () => { buffer.dispose(); stopOther(); other.remove(); };
    return { target, key: (from: number, to: number, data: string, type = "insertText") => input(target, from, to, data, type) };
  }
  return { h, a, b, writer, cell, key: (from: number, to: number, data: string, type = "insertText", during?: () => void) => input(cell, from, to, data, type, during), agrees, split, reports, missing, recovered, notices, guard,
    close: () => { splitClose?.(); stop(); writer.dispose(); a.session.dispose(); b.session.dispose(); h.close(); root.parentElement?.remove(); document.querySelector(".writer-bar")?.remove(); } };
}

for (const literal of [
  { name: "typing", from: 1, to: 1, insert: "X", type: "insertText", text: "aXb", kinds: ["text-insert", "scalar"] },
  { name: "deleting", from: 1, to: 2, insert: "", type: "deleteContentBackward", text: "a", kinds: ["text-delete", "scalar"] },
  { name: "whole visual replacement", from: 0, to: 2, insert: "New", type: "insertReplacementText", text: "New", kinds: ["text-insert", "text-delete", "scalar"] },
  { name: "plain records-looking text", from: 0, to: 2, insert: "B-roll: gulls\n@Sam\nSFX: bang", type: "insertText", text: "B-roll: gulls<br>@Sam<br>SFX: bang", kinds: ["text-insert", "text-delete", "scalar"] }
]) test("Writer shared visual literal: " + literal.name, () => {
  const page = visualWriter();
  try {
    assert.equal(page.key(literal.from, literal.to, literal.insert, literal.type), true);
    assert.deepEqual(page.a.executed.map(command => command.operations.map(op => op.kind)), [literal.kinds]);
    page.agrees(expected(literal.text));
    assert.deepEqual([page.reports, page.missing, page.recovered, page.notices], [[], [], [], []]);
    assert.deepEqual(cellSelection(page.cell), { from: literal.from + literal.insert.length, to: literal.from + literal.insert.length });
  } finally { page.close(); }
});

test("Writer visual holds same-visual remote typing until its native input commits, then restores the caret by identity", () => {
  const page = visualWriter();
  try {
    assert.equal(page.key(1, 1, "X", "insertText", () => {
      const target = { owner: ref("R1"), segment: ref("R1"), field: "visualText" as const };
      const anchor = createSharedAnchor(page.h.b, target, 0, "after"); assert.ok(anchor);
      assert.deepEqual(executeSharedOperations(page.h.b, [operation({ kind: "text-insert", id: "remote", by: "Bob", target, at: { left: anchor, right: null, affinity: "after" }, content: [{ value: "Q", marks: [] }] })]), { ok: true });
      page.h.queue.deliverFrom("B", "dup");
      assert.deepEqual(page.a.session.read(doc => doc?.rows[0]?.visualText), "ab");
      assert.deepEqual([...collabState(page.h.a).ingress.holds], ["buffer"]);
    }), true);
    page.agrees(expected("QaXb"));
    assert.deepEqual(cellSelection(page.cell), { from: 3, to: 3 });
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
  } finally { page.close(); }
});

test("Writer visual and Split visual race through the same buffered binding", () => {
  const page = visualWriter();
  try {
    const split = page.split();
    assert.equal(page.key(1, 1, "X", "insertText", () => {
      assert.equal(split.key(1, 1, "Y"), true);
      page.h.queue.deliverFrom("B", "D2");
      assert.equal(page.a.session.read(doc => doc?.rows[0]?.visualText), "ab");
    }), true);
    page.agrees(expected("aXYb", "Bob"));
    assert.deepEqual([page.reports, page.missing], [[], []]);
  } finally { page.close(); }
});

test("Writer visual typing racing beat removal stays in the removed beat and releases its hold", () => {
  const page = visualWriter();
  try {
    const runtime = createFlowLoadRuntime(), author = sharedAuthorPort({ handle: () => page.h.b, name: () => "Bob" });
    const commands = writerFlowCommands(runtime.ports, { author, writer: () => "2" });
    assert.equal(page.key(1, 1, "X", "insertText", () => {
      const prepared = commands.commands.prepare("remove", doc => replaceRange(doc, { anchor: beatPos("R1", 0), head: beatPos("R2", 0) }, [], commands.flow, true), bufferStamps("Bob"));
      assert.equal(page.b.session.run(prepared.command).kind, "applied");
      page.h.queue.deliverFrom("B", "dup");
      assert.equal(page.a.session.read(doc => doc?.rows.length), 2);
    }), true);
    page.agrees(expected("", "Alice", [row("R2", "def", "")]));
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
  } finally { page.close(); }
});
