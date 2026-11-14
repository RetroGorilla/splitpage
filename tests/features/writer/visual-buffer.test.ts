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
import { replaceRange, beatPos, enterAt, joinWithPrevious } from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowOutcome, FlowPorts } from "../../../src/core/flow/flow.ts";
import type { DeliveryOrder } from "../../collab/delivery.ts";
import { deliveryReplica } from "../../adapters/collab/helpers.ts";
import { createFlowVisualBox } from "../../../src/features/writer/flow-visual-box.ts";
import { sharedUndoOwner } from "../../../src/bootstrap/wiring/ports/shared-undo.ts";
import { sharedUndoActions } from "../../../src/application/editing/undo/shared-undo-actions.ts";

const changed = { updatedAt: "2026-11-12T10:00:00.000Z", updatedBy: "Alice" };

function row(id: string, audioText: string, visualText: string, extra: Record<string, unknown> = {}) {
  return { id, status: "todo", visualText, audioText, imageRef: null, updatedAt: "", updatedBy: null, ...extra };
}

function expected(visualText: string, by = "Alice", rows?: readonly Record<string, unknown>[]) {
  return { schema: 2, title: "", docId: "d00000000000000000000000000000000", rows: rows ?? [row("R1", "abc", visualText, { ...changed, updatedBy: by }), row("R2", "def", "")],
    comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 };
}

function visualWriter(order: DeliveryOrder = "dup", secondVisual = "", recordUndo = false) {
  Object.assign(globalThis, { MutationObserver: window.MutationObserver, CSS: { escape: (value: string) => value } });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  document.body.innerHTML = '<div class="writer-bar"></div><section><div id="writer-doc" contenteditable="true"></div></section>';
  const root = document.getElementById("writer-doc"); assert.ok(root);
  const h = replicas(2, { rows: [{ id: "R1", audioText: "abc", visualText: "ab" }, { id: "R2", audioText: "def", visualText: secondVisual }] });
  const runtime = createFlowLoadRuntime();
  for (const handle of [h.a, h.b]) registerSharedOperationFamilies(handle, { cells: runtime.cells });
  let reversals = 0;
  const undoOwner = recordUndo ? sharedUndoOwner(h.a, () => ({ id: "visual_undo_" + ++reversals, by: "Alice" }), () => 0, error => { assert.fail(String(error)); }) : null;
  const a = sharedHarness(adapterReplica(h.a, undoOwner ?? undefined)), b = sharedHarness(adapterReplica(h.b));
  const undo = undoOwner ? sharedUndoActions(a.session, undoOwner) : null;
  const { effects: bufferEffects, reports, missing, recovered } = fakeWriterBufferEffects();
  const { effects, notices } = fakeFlowCommandEffects(), guard = createPaintGuard();
  const unexpected: string[] = [];
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
    wholeFieldText: { commit: () => { unexpected.push("whole-field"); return { kind: "rejected", reason: "unexpected-whole-field" }; } },
    visualInput: () => { unexpected.push("visual-input"); },
    visualLeave: () => { unexpected.push("visual-leave"); },
    visualKeydown: () => { unexpected.push("visual-keydown"); return false; }
  });
  writer.repaint();
  const stop = a.session.subscribe(() => { if (!guard.shown()) writer.repaint(); });
  writer.openVisual("R1");
  const foundCell = document.querySelector<HTMLElement>(".wr-flow-visual-text"); assert.ok(foundCell);
  const cell: HTMLElement = foundCell;
  function input(target: HTMLElement, from: number, to: number, data: string, type = "insertText", during?: () => void, focus = true): boolean {
    if (focus) { target.focus(); setCellSelection(target, from, to); }
    const start = posToDom(target, from), end = posToDom(target, to), range = document.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type, data });
    Object.defineProperty(event, "getTargetRanges", { value: () => [range.cloneRange()] });
    if (!target.dispatchEvent(event)) return false;
    during?.(); range.deleteContents();
    if (data) {
      const content = document.createDocumentFragment();
      for (const [index, line] of data.split("\n").entries()) { if (index) content.append(document.createElement("br")); content.append(document.createTextNode(line)); }
      range.insertNode(content);
    }
    if (focus) setCellSelection(target, from + data.length);
    target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: type, data }));
    return true;
  }
  function agrees(value: unknown, recoveredRows?: readonly Record<string, unknown>[]) {
    assert.deepEqual(unexpected, []);
    h.queue.flush(order);
    const late = createMonitoredSharedDocument(); assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
    const c = sharedHarness(adapterReplica(late));
    try {
      for (const harness of [a, b, c]) {
        assert.deepEqual(harness.session.read(doc => doc), value);
        if (recoveredRows) assert.deepEqual(harness.session.recovery().flatMap(entry => entry.kind === "removed-beat" ? [entry.row] : []), recoveredRows);
      }
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
    return { target, key: (from: number, to: number, data: string, type = "insertText") => input(target, from, to, data, type, undefined, false) };
  }
  function otherVisual() {
    const holder = document.body.appendChild(document.createElement("section")), otherRoot = holder.appendChild(document.createElement("div"));
    const otherGuard = createPaintGuard(), otherAuthor = sharedAuthorPort({ handle: () => h.b, name: () => "Bob" });
    const otherShared = sharedBufferPorts(h.b, b.session, { ...bufferEffects, readers: bufferReaders, stamps: bufferStamps("Bob"), author: () => { const next = otherAuthor.next(); assert.ok(next); return next; } });
    const doc = () => { const view = b.session.read(doc => doc); assert.ok(view); return view; };
    const at = { anchor: beatPos("R1", 0), head: beatPos("R1", 0) };
    const forbidden = () => { unexpected.push("other-standalone"); };
    const box = createFlowVisualBox({ root: otherRoot, buffer: writerVisualBuffer(otherShared, { document: doc, lifetime: b.session, decode: fromHtml, storedHtml: html => html, shown: otherGuard.whileShown }),
      doc, selection: () => at, prepare: range => range, place: () => {}, current: () => true, blocked: () => otherGuard.painting(),
      plainVisual: () => "", thumbnails: () => "", save: () => { forbidden(); return null; }, input: forbidden, leave: forbidden, keydown: () => { forbidden(); return false; },
      notice: forbidden, undo: forbidden, paste: forbidden });
    const stopOther = b.session.subscribe(() => { if (!otherGuard.shown()) box.refresh(); });
    box.open(at);
    const target = box.element.querySelector<HTMLElement>(".wr-flow-visual-text"); assert.ok(target);
    splitClose = () => { box.dispose(); stopOther(); holder.remove(); };
    cell.focus(); setCellSelection(cell, 1);
    return { key: (from: number, to: number, data: string) => input(target, from, to, data, "insertText", undefined, false) };
  }
  return { h, a, b, writer, root, cell, undo, undoOwner, key: (from: number, to: number, data: string, type = "insertText", during?: () => void) => input(cell, from, to, data, type, during), agrees, split, otherVisual, reports, missing, recovered, notices, guard,
    close: () => {
      try { splitClose?.(); stop(); writer.dispose(); assert.deepEqual(unexpected, []); }
      finally { a.session.dispose(); b.session.dispose(); h.close(); root.parentElement?.remove(); document.querySelector(".writer-bar")?.remove(); }
    } };
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

for (const order of ["dup", "rev"] as const) test("Writer visual holds same-visual remote typing until its native input commits, then restores the caret by identity: " + order, () => {
  const page = visualWriter(order);
  try {
    assert.equal(page.key(1, 1, "X", "insertText", () => {
      const target = { owner: ref("R1"), segment: ref("R1"), field: "visualText" as const };
      const anchor = createSharedAnchor(page.h.b, target, 0, "after"); assert.ok(anchor);
      assert.deepEqual(executeSharedOperations(page.h.b, [operation({ kind: "text-insert", id: "remote", by: "Bob", target, at: { left: anchor, right: null, affinity: "after" }, content: [{ value: "Q", marks: [] }] })]), { ok: true });
      page.h.queue.deliverFrom("B", order);
      assert.deepEqual(page.a.session.read(doc => doc?.rows[0]?.visualText), "ab");
      assert.deepEqual([...collabState(page.h.a).ingress.holds], ["buffer"]);
    }), true);
    page.agrees(expected("QaXb"));
    assert.deepEqual(cellSelection(page.cell), { from: 3, to: 3 });
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
  } finally { page.close(); }
});

for (const order of ["dup", "rev"] as const) test("Writer visual and Split visual race through the same buffered binding: " + order, () => {
  const page = visualWriter(order);
  try {
    const split = page.split();
    assert.equal(page.key(1, 1, "X", "insertText", () => {
      assert.equal(split.key(1, 1, "Y"), true);
      page.h.queue.deliverFrom("B", order);
      assert.equal(page.a.session.read(doc => doc?.rows[0]?.visualText), "ab");
    }), true);
    page.agrees(expected("aXYb", "Bob"));
    assert.deepEqual([page.reports, page.missing], [[], []]);
  } finally { page.close(); }
});

for (const order of ["dup", "rev"] as const) test("Writer visual typing racing beat removal stays in the removed beat and releases its hold: " + order, () => {
  const page = visualWriter(order);
  try {
    const runtime = createFlowLoadRuntime(), author = sharedAuthorPort({ handle: () => page.h.b, name: () => "Bob" });
    const commands = writerFlowCommands(runtime.ports, { author, writer: () => "2" });
    assert.equal(page.key(1, 1, "X", "insertText", () => {
      const prepared = commands.commands.prepare("remove", doc => replaceRange(doc, { anchor: beatPos("R1", 0), head: beatPos("R2", 0) }, [], commands.flow, true), bufferStamps("Bob"));
      assert.equal(page.b.session.run(prepared.command).kind, "applied");
      page.h.queue.deliverFrom("B", order);
      assert.equal(page.a.session.read(doc => doc?.rows.length), 2);
    }), true);
    page.agrees(expected("", "Alice", [row("R2", "def", "")]));
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
  } finally { page.close(); }
});

function remoteInsert(page: ReturnType<typeof visualWriter>, text: string, offset = 0) {
  const target = { owner: ref("R1"), segment: ref("R1"), field: "visualText" as const };
  const anchor = createSharedAnchor(page.h.b, target, offset, "after"); assert.ok(anchor);
  assert.deepEqual(executeSharedOperations(page.h.b, [operation({ kind: "text-insert", id: "remote_" + text, by: "Bob", target,
    at: { left: anchor, right: null, affinity: "after" }, content: [...text].map(value => ({ value, marks: [] })) })]), { ok: true });
}

test("Writer visual idle repaint keeps the caret with its character", () => {
  const page = visualWriter();
  try {
    page.cell.focus(); setCellSelection(page.cell, 1);
    remoteInsert(page, "Q"); page.h.queue.deliverFrom("B", "dup");
    assert.deepEqual(cellSelection(page.cell), { from: 2, to: 2 });
    page.agrees(expected("Qab", "Alice", [row("R1", "abc", "Qab"), row("R2", "def", "")]));
  } finally { page.close(); }
});

for (const order of ["dup", "rev"] as const) test("two Writer visual boxes race through their own bindings: " + order, () => {
  const page = visualWriter(order);
  try {
    const other = page.otherVisual();
    assert.equal(page.key(1, 1, "X", "insertText", () => {
      assert.equal(other.key(1, 1, "Y"), true);
      page.h.queue.deliverFrom("B", order);
      assert.equal(page.cell.textContent, "ab");
    }), true);
    page.agrees(expected("aXYb", "Bob"));
    assert.deepEqual([page.reports, page.missing], [[], []]);
  } finally { page.close(); }
});

test("Writer visual composition holds remote edits and refuses close until composition ends", () => {
  const page = visualWriter();
  try {
    page.cell.focus(); setCellSelection(page.cell, 1);
    page.cell.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    page.cell.innerHTML = "a漢b"; setCellSelection(page.cell, 2);
    page.cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "漢", isComposing: true }));
    remoteInsert(page, "Q"); page.h.queue.deliverFrom("B", "dup");
    const box = page.cell.closest<HTMLElement>(".wr-flow-visual-box"); assert.ok(box);
    box.querySelector<HTMLButtonElement>(".wr-flow-visual-close")?.click();
    assert.equal(box.hidden, false);
    assert.equal(page.writer.settle?.(), false);
    page.writer.openVisual("R2");
    assert.equal(page.cell.dataset.id, "R1");
    page.writer.dispose();
    assert.equal(document.querySelector(".wr-flow-visual-text"), page.cell);
    assert.equal(page.cell.textContent, "a漢b");
    assert.deepEqual([...collabState(page.h.a).ingress.holds], ["buffer"]);
    page.cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "漢" }));
    page.agrees(expected("Qa漢b"));
    assert.deepEqual(cellSelection(page.cell), { from: 3, to: 3 });
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
    box.querySelector<HTMLButtonElement>(".wr-flow-visual-close")?.click();
    assert.equal(box.hidden, true);
    assert.equal(page.cell.dataset.field, "inactive-visual");
    page.writer.openVisual("R1");
    assert.equal(page.key(4, 4, "!"), true);
    page.agrees(expected("Qa漢b!"));
    box.querySelector<HTMLButtonElement>(".wr-flow-visual-close")?.click();
    page.writer.place({ anchor: beatPos("R2", 0), head: beatPos("R2", 3) });
    page.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
    page.agrees(expected("", "Alice", [row("R1", "abc", "Qa漢b!", changed), row("R2", "<strong>def</strong>", "", changed)]));
  } finally { page.close(); }
});

test("Writer visual without a visual record refuses buffer-no-visual and writes nothing", () => {
  const page = visualWriter();
  try {
    assert.deepEqual(executeSharedOperations(page.h.b, [operation({ kind: "record-delete", id: "drop_visual", by: "Bob", target: { collection: "visuals", record: "R1" } })]), { ok: true });
    page.h.queue.deliverFrom("B", "dup");
    assert.equal(page.key(0, 0, "X"), false);
    assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-no-visual" }]);
    assert.deepEqual(page.a.executed, []);
    page.agrees(expected("", "Alice", [row("R1", "abc", ""), row("R2", "def", "")]));
  } finally { page.close(); }
});

test("Writer joined visual stays read-only under rule 93", () => {
  const page = visualWriter("dup", "cd");
  try {
    assert.deepEqual(executeSharedOperations(page.h.b, [operation({ kind: "join", id: "join", by: "Bob", from: "R2", into: "R1", glue: " " })]), { ok: true });
    page.h.queue.deliverFrom("B", "dup");
    assert.equal(page.key(1, 1, "X"), false);
    assert.deepEqual(page.missing, [bufferedFieldKey("R1", "visualText")]);
    assert.deepEqual(page.a.executed, []);
    page.agrees(expected("ab<br>cd", "Alice", [row("R1", "abc def", "ab<br>cd")]));
  } finally { page.close(); }
});

test("Writer narration selection uses visual-selection once, then the visual buffer while narration arrives during native input", () => {
  const page = visualWriter();
  try {
    page.cell.closest(".wr-flow-visual-box")?.querySelector<HTMLButtonElement>(".wr-flow-visual-close")?.click();
    page.writer.place({ anchor: beatPos("R1", 1), head: beatPos("R1", 2) });
    document.getElementById("wr-visual")?.click();
    assert.equal(page.cell.dataset.field, "selection-visual");
    assert.equal(page.key(0, 0, "X", "insertText", () => {
      bobNarration(page, 0, "Q"); page.h.queue.deliverFrom("B", "dup");
      assert.equal(page.a.session.read(doc => doc?.rows[0]?.audioText), "abc");
      assert.deepEqual([...collabState(page.h.a).ingress.holds], ["buffer"]);
    }), true);
    assert.deepEqual(page.notices, []);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
    assert.equal(page.key(1, 1, "Y"), true);
    page.agrees(expected("", "Alice", [row("R1", "Qa", "ab", changed), row("structure_1_00770031005f0031005f006f005f0030_beat_0", "b", "XY", changed), row("structure_1_00770031005f0031005f006f005f0031_beat_0", "c", "", changed), row("R2", "def", "")]));
    assert.deepEqual(page.a.executed.map(command => command.operations.map(op => op.kind)), [["split", "split", "text-insert", "scalar", "scalar", "scalar"], ["text-insert", "scalar"]]);
  } finally { page.close(); }
});

function openSelectedVisual(page: ReturnType<typeof visualWriter>, rowId: string, from: number, to: number) {
  page.cell.closest(".wr-flow-visual-box")?.querySelector<HTMLButtonElement>(".wr-flow-visual-close")?.click();
  page.writer.place({ anchor: beatPos(rowId, from), head: beatPos(rowId, to) });
  document.getElementById("wr-visual")?.click();
  assert.equal(page.cell.dataset.field, "selection-visual");
}

function bobNarration(page: ReturnType<typeof visualWriter>, offset: number, text: string) {
  const target = { owner: ref("R1"), segment: ref("R1"), field: "audioText" as const };
  const anchor = createSharedAnchor(page.h.b, target, offset, "after"); assert.ok(anchor);
  assert.deepEqual(executeSharedOperations(page.h.b, [operation({ kind: "text-insert", id: "narration", by: "Bob", target,
    at: { left: anchor, right: null, affinity: "after" }, content: [{ value: text, marks: [] }] })]), { ok: true });
}

function bobFlow(page: ReturnType<typeof visualWriter>, run: (doc: FlowDoc, ports: FlowPorts) => FlowOutcome) {
  const commands = writerFlowCommands(createFlowLoadRuntime().ports, { author: sharedAuthorPort({ handle: () => page.h.b, name: () => "Bob" }), writer: () => "2" });
  const prepared = commands.commands.prepare("other-edit", doc => run(doc, commands.flow), bufferStamps("Bob"));
  assert.equal(page.b.session.run(prepared.command).kind, "applied");
}

for (const order of ["D1", "rev", "dup"] as const) {
  test("Writer idle visual selection follows the selected narration characters through a remote prefix: " + order, () => {
    const page = visualWriter(order);
    try {
      openSelectedVisual(page, "R1", 1, 2); bobNarration(page, 0, "Q"); page.h.queue.deliverFrom("B", order);
      assert.equal(page.key(0, 0, "X"), true);
      page.agrees(expected("", "Alice", [row("R1", "Qa", "ab", changed), row("structure_1_00770031005f0031005f006f005f0030_beat_0", "b", "X", changed), row("structure_1_00770031005f0031005f006f005f0031_beat_0", "c", "", changed), row("R2", "def", "")]));
      assert.deepEqual(page.reports, []);
    } finally { page.close(); }
  });
  test("Writer idle visual selection whose narration was deleted refuses without a write: " + order, () => {
    const page = visualWriter(order);
    try {
      openSelectedVisual(page, "R1", 1, 2); bobFlow(page, (doc, ports) => replaceRange(doc, { anchor: beatPos("R1", 1), head: beatPos("R1", 2) }, [], ports));
      page.h.queue.deliverFrom("B", order);
      assert.equal(page.key(0, 0, "X"), false); assert.deepEqual(page.a.executed, []);
      assert.deepEqual(page.reports, [{ kind: "rejected", reason: "visual-selection-unavailable" }]);
      page.agrees(expected("", "Alice", [row("R1", "ac", "ab", { ...changed, updatedBy: "Bob" }), row("R2", "def", "")]));
    } finally { page.close(); }
  });
  test("Writer idle visual selection split over beats refuses without a write: " + order, () => {
    const page = visualWriter(order);
    try {
      openSelectedVisual(page, "R1", 1, 3); bobFlow(page, (doc, ports) => enterAt(doc, { anchor: beatPos("R1", 2), head: beatPos("R1", 2) }, ports)); page.h.queue.deliverFrom("B", order);
      assert.equal(page.key(0, 0, "X"), false); assert.deepEqual(page.a.executed, []);
      assert.deepEqual(page.reports, [{ kind: "rejected", reason: "visual-selection-unavailable" }]);
      page.agrees(expected("", "Alice", [row("R1", "ab", "ab", { ...changed, updatedBy: "Bob" }), row("structure_2_00770032005f0031005f006f005f0030_beat_0", "c", "", { ...changed, updatedBy: "Bob" }), row("R2", "def", "")]));
    } finally { page.close(); }
  });
  test("Writer idle visual selection follows its characters into a new split beat: " + order, () => {
    const page = visualWriter(order);
    try {
      openSelectedVisual(page, "R1", 1, 2); bobFlow(page, (doc, ports) => enterAt(doc, { anchor: beatPos("R1", 1), head: beatPos("R1", 1) }, ports)); page.h.queue.deliverFrom("B", order);
      assert.equal(page.key(0, 0, "X"), true);
      assert.deepEqual(page.notices, []);
      page.agrees(expected("", "Alice", [row("R1", "a", "ab", { ...changed, updatedBy: "Bob" }), row("structure_1_00770031005f0031005f006f005f0030_beat_0", "b", "X", changed), row("structure_2_00770032005f0031005f006f005f0030_beat_0", "c", "", changed), row("R2", "def", "")]));
    } finally { page.close(); }
  });
  test("Writer idle visual selection follows a join but retains the isolation handler's invalid-reference refusal: " + order, () => {
    const page = visualWriter(order);
    try {
      openSelectedVisual(page, "R2", 1, 2); bobFlow(page, (doc, ports) => joinWithPrevious(doc, "R2", ports)); page.h.queue.deliverFrom("B", order);
      assert.equal(page.cell.closest<HTMLElement>(".wr-flow-visual-box")?.hidden, false);
      assert.equal(page.cell.dataset.id, "R1");
      const before = encodeSharedState(page.h.a);
      assert.equal(page.key(0, 0, "X"), true);
      assert.deepEqual(page.notices, ["invalid-reference"]);
      assert.deepEqual(encodeSharedState(page.h.a), before);
      assert.deepEqual(page.a.executed[0]?.operations[0], { kind: "split", id: "w1_1_o_0", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" },
        at: { left: null, right: '["flow-base","R1","audioText",5,5]', affinity: "before" }, observed: ['["flow-base","R1","audioText",0,7]'], boundary: "new1", beat: "new1", fields: { visualText: "", imageRef: null, status: "todo" } });
      page.agrees(expected("", "Alice", [row("R1", "abc def", "ab", { ...changed, updatedBy: "Bob" })]));
    } finally { page.close(); }
  });
  for (const edit of [{ name: "insertion", from: 1, to: 1, text: "X", type: "insertText", recovered: "aXb" }, { name: "deletion", from: 1, to: 2, text: "", type: "deleteContentBackward", recovered: "a" }, { name: "replacement", from: 0, to: 2, text: "New", type: "insertReplacementText", recovered: "New" }]) {
    test("Writer visual removed during " + edit.name + " closes and immediately admits another beat's edits: " + order, () => {
      const page = visualWriter(order);
      try {
        assert.equal(page.key(edit.from, edit.to, edit.text, edit.type, () => {
          bobFlow(page, (doc, ports) => replaceRange(doc, { anchor: beatPos("R1", 0), head: beatPos("R2", 0) }, [], ports, true));
          page.h.queue.deliverFrom("B", order);
        }), true);
        assert.equal(page.cell.closest<HTMLElement>(".wr-flow-visual-box")?.hidden, true);
        assert.equal(page.writer.settle?.(), true);
        page.writer.openVisual("R2"); assert.equal(page.cell.dataset.id, "R2"); assert.equal(page.key(0, 0, "Y"), true);
        page.cell.closest(".wr-flow-visual-box")?.querySelector<HTMLButtonElement>(".wr-flow-visual-close")?.click();
        page.writer.place({ anchor: beatPos("R2", 0), head: beatPos("R2", 3) }); page.writer.format("bold");
        page.agrees(expected("", "Alice", [row("R2", "<strong>def</strong>", "Y", changed)]), [row("R1", "abc", edit.recovered, changed)]);
        assert.deepEqual([page.notices, page.reports, [...collabState(page.h.a).ingress.holds]], [[], [], []]);
      } finally { page.close(); }
    });
  }
}

test("a closed Writer visual never admits its stale hidden cell into a narration command", () => {
  const page = visualWriter();
  try {
    page.cell.closest(".wr-flow-visual-box")?.querySelector<HTMLButtonElement>(".wr-flow-visual-close")?.click();
    remoteInsert(page, "Q"); page.h.queue.deliverFrom("B", "dup");
    page.writer.place({ anchor: beatPos("R1", 1), head: beatPos("R1", 2) }); page.writer.format("bold");
    page.agrees(expected("", "Alice", [row("R1", "a<strong>b</strong>c", "Qab", changed), row("R2", "def", "")]));
    assert.deepEqual([page.reports, page.missing, page.notices], [[], [], []]);
  } finally { page.close(); }
});

test("Writer visual typing reaches the shared undo owner as one group and leaves a remote visual insertion", () => {
  const page = visualWriter("dup", "", true);
  try {
    assert.ok(page.undo); assert.ok(page.undoOwner);
    assert.equal(page.key(1, 1, "X"), true);
    assert.equal(page.key(2, 2, "Y"), true);
    assert.deepEqual(page.undoOwner.sizes(), { undo: 1, redo: 0, dropped: 0 });
    remoteInsert(page, "Q"); page.h.queue.deliverFrom("B", "dup");
    page.agrees(expected("QaXYb"));
    assert.equal(page.undo.undo().ok, true);
    page.agrees(expected("Qab"));
    assert.deepEqual(page.undoOwner.sizes(), { undo: 0, redo: 1, dropped: 0 });
    assert.equal(page.undo.redo().ok, true);
    page.agrees(expected("QaXYb"));
  } finally { page.close(); }
});

test("seeded Writer visual histories: three writers, native command kinds, reordered duplicates and an encoded late joiner", () => {
  const histories = [
    { from: 1, to: 1, data: "X", type: "insertText", b: "Q", bAt: 0, c: "Z", cAt: 2, text: "QaXbZ" },
    { from: 1, to: 2, data: "", type: "deleteContentBackward", b: "Q", bAt: 0, c: "Z", cAt: 0, text: "QZa" },
    { from: 0, to: 2, data: "New", type: "insertReplacementText", b: "Y", bAt: 2, c: "Z", cAt: 2, text: "NewYZ" }
  ];
  let seed = 0x86c6;
  for (let step = 0; step < 24; step++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const history = histories[step % histories.length]; assert.ok(history);
    const order = seed & 1 ? "dup" : "rev", page = visualWriter(order);
    try {
      registerSharedOperationFamilies(page.h.c, { cells: createFlowLoadRuntime().cells });
      page.h.queue.addReplica("C", deliveryReplica(page.h.c));
      assert.equal(page.key(history.from, history.to, history.data, history.type, () => {
        remoteInsert(page, history.b, history.bAt);
        const target = { owner: ref("R1"), segment: ref("R1"), field: "visualText" as const };
        const anchor = createSharedAnchor(page.h.c, target, history.cAt, "after"); assert.ok(anchor);
        assert.deepEqual(executeSharedOperations(page.h.c, [operation({ kind: "text-insert", id: "third", by: "Cara", target,
          at: { left: anchor, right: null, affinity: "after" }, content: [{ value: history.c, marks: [] }] })]), { ok: true });
        for (const from of seed & 2 ? ["B", "C"] as const : ["C", "B"] as const) page.h.queue.deliverFrom(from, order);
        assert.equal(page.a.session.read(doc => doc?.rows[0]?.visualText), "ab");
      }), true);
      const value = expected(history.text);
      page.agrees(value);
      const third = sharedHarness(adapterReplica(page.h.c));
      try { assert.deepEqual(third.session.read(doc => doc), value); } finally { third.session.dispose(); }
      assert.deepEqual([page.reports, page.missing, page.recovered, page.notices], [[], [], [], []]);
      assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
    } finally { page.close(); }
  }
});
