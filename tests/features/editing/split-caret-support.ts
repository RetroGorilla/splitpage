import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { operation, ref } from "../../adapters/collab/executor-support.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { editorKeys } from "../../../src/core/text/selection.ts";
import { bufferedFieldKey, readBufferedFieldKey } from "../../../src/core/collab/buffer.ts";
import { deriveDocumentNumbering } from "../../../src/core/document/numbering.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";
import { createPaintGuard, createUndoGuard } from "../../../src/application/editing/paint-guard.ts";
import { createBufferedField } from "../../../src/application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../../src/application/editing/painted-beats.ts";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { startRowsRender, paintedFromRow, onBeforePaint } from "../../../src/features/rows/render.ts";
import { mountCellBuffer } from "../../../src/features/editing/cell-buffer.ts";
import { createCellPage } from "../../../src/features/editing/cell-page.ts";
import { readSelection, placeSelection, posToDom } from "../../../src/features/common/cell-dom.ts";
import { ensureTrailingCaretSpot } from "../../../src/features/common/dom.ts";
import { fakeTextServices, fakeNotices, fakePictures, fakeWriterBufferEffects } from "../fakes.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { DeliveryOrder } from "../../collab/delivery.ts";

type Field = "audioText" | "visualText";

export function splitCaretPage(text = "abcdef", second = "uvwx") {
  const h = new Stage1ExecutorHarness([{ id: "R1", text }, { id: "R2", text: second }]);
  let serial = 0;
  const target = (row: string, field: Field) => ({ owner: ref(row), segment: ref(row), field });
  function execute(handle: SharedDocumentHandle, ops: unknown[]): void {
    assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true });
  }
  execute(h.a, ["R1", "R2"].map(row => ({ kind: "text-insert", id: "seed_" + row, by: "Alice", target: target(row, "visualText"),
    at: { left: null, right: flowBaseReference(row, "visualText", 0), affinity: "before" }, content: [{ value: row === "R1" ? text : second, marks: [] }] })));
  h.queue.flush("D1");
  for (const handle of [h.a, h.b]) registerSharedJoinHandlers(handle);
  const a = sharedHarness(adapterReplica(h.a)), guard = createPaintGuard(), { effects, reports, missing, recovered } = fakeWriterBufferEffects();
  const current = () => a.session.read(doc => doc);
  const selection = createEditorSelection<Element, Range, Element>({ epoch: a.session.epoch, order: () => current()?.rows.map(row => row.id) ?? [],
    keys: (id, field) => { const row = current()?.rows.find(row => row.id === id); return row ? editorKeys(fromHtml(row[field] ?? "", { media: true })) : null; } });
  document.body.innerHTML = '<div id="rows"></div><input id="doc-title"><div id="toast-host"></div>';
  const root = document.getElementById("rows"); assert.ok(root);
  const render = startRowsRender({
    document: { current, read: fn => a.session.read(fn), numbering: () => deriveDocumentNumbering(current() ?? { rows: [] }) }, edits: { allowed: () => true },
    text: { ...fakeTextServices(document).text, productionReaders: bufferReaders }, video: { card: () => document.createElement("a"), hostLabel: () => "File" },
    editing: { cells: () => ({ edit: () => null, sync: () => {} }), selection: () => selection, paint: () => guard, undo: () => createUndoGuard() },
    draft: { appendMedia: () => null, model: () => ({ cell: [], media: { markThroughout: () => false, toggleMark: () => [] } }), edit: () => null, isDraft: () => false, isScript: () => false },
    undo: { track: () => {} }, hiding: () => ({ groups: rows => rows.map((row, index) => ({ row, index })) }), scenes: () => ({ folded: () => false }),
    pictures: fakePictures().pictures, personColors: { personColor: () => "#000000" }, preferences: () => ({ clock: () => "24h" }), view: () => ({ writerOpen: () => false }),
    notices: fakeNotices().notices, actions: { invoke: id => ({ kind: "unknown", id }) }, deletes: () => ({ disarm: () => {} }),
    tagPanel: { setTagAddingPerson: () => {} }, ids: { id: () => "id" }, production: { stats: () => ({ derived: 0, flushes: 0 }), resetStats: () => {}, scan: () => {}, occurrences: () => ({ html: "", hits: 0 }) }
  });
  assert.equal(render.renderFirstDraw(), true);
  const shared = sharedBufferPorts(h.a, a.session, { ...effects, readers: bufferReaders, stamps: bufferStamps("Alice"), author: () => ({ id: "native_" + ++serial, by: "Alice" }) });
  const painted = createPaintedBeats(shared.paintedText);
  let deferred = false;
  const pending: (() => void)[] = [];
  const buffer = mountCellBuffer({ root, ports: {
    field: surface => createBufferedField(shared.bufferedText, surface), painted, report: effects.report,
    page: createCellPage({ storedHtml: html => html, caretSpot: ensureTrailingCaretSpot }), decode: html => fromHtml(html, { media: true }), document: current,
    paintedFrom: paintedFromRow, notePainted: render.noteFieldPainted, shown: edit => guard.whileShown(edit), repaintRows: render.render,
    onPainted: render.onPainted, beforePaint: onBeforePaint, readable: key => shared.paintedText.read(key, readBufferedFieldKey(key).field) !== null,
    caret: { selection, afterPaint: task => { if (deferred) pending.push(task); else guard.afterThisPaint(task); }, text: key => shared.selectionText.read(key, readBufferedFieldKey(key).field), identity: shared.selectionIdentity }
  } });
  const stop = a.session.subscribe(change => { render.screenListeners().session(change); });
  const cell = (field: Field, row = "R1") => { const el = root.querySelector<HTMLElement>('.cell-editable[data-id="' + row + '"][data-field="' + field + '"]'); assert.ok(el); return el; };
  const select = (field: Field, anchor: number, head = anchor, row = "R1") => { const el = cell(field, row); el.focus(); assert.equal(placeSelection(el, window.getSelection(), { anchor, head, affinity: "backward" }), true); };
  const points = (field: Field, row = "R1") => { const value = readSelection(cell(field, row), window.getSelection()); return value ? [value.anchor, value.head] : null; };
  function write(writer: "B" | "C", field: Field, kind: "insert" | "delete" | "mark", from: number, to = from, value = "X", row = "R1"): void {
    const handle = writer === "B" ? h.b : h.c, address = target(row, field), base = readSharedPaintedText(handle, address); assert.ok(base);
    const range = captureSharedTextRange(handle, address, from, to);
    const right = base.identity(from) ?? base.endGap; assert.ok(right);
    execute(handle, [{ id: "remote_" + ++serial, by: writer === "B" ? "Bob" : "Carol", ...kind === "insert"
      ? { kind: "text-insert", target: address, at: { left: null, right, affinity: "before" }, content: [{ value, marks: [] }] }
      : kind === "delete" ? { kind: "text-delete", target: address, observed: [range] }
      : { kind: "mark", target: address, observed: [range], mark: { kind: "b", value: true } } }]);
  }
  function deliver(order: DeliveryOrder): void {
    h.queue.flush(order);
    assert.equal(render.renderAbsorbed(), true);
  }
  function remote(field: Field, kind: "insert" | "delete" | "mark", from: number, to = from, value = "X", row = "R1"): void {
    write("B", field, kind, from, to, value, row); deliver("dup");
  }
  const join = () => { execute(h.b, [{ kind: "join", id: "join", by: "Bob", from: "R2", into: "R1", glue: " " }]); h.queue.flush("dup"); assert.equal(render.renderAbsorbed(), true); };
  const split = () => {
    registerSharedSplitHandlers(h.b, createFlowLoadRuntime());
    const address = target("R1", "audioText"), before = readSharedPaintedText(h.b, address), right = before?.identity(3); assert.ok(right);
    execute(h.b, [{ kind: "split", id: "split", by: "Bob", target: address, at: { left: null, right, affinity: "before" }, observed: [], beat: "fresh", boundary: "fresh", fields: {} }]);
    deliver("dup");
  };
  function type(field: Field, from: number, to: number, text: string): boolean {
    select(field, from, to);
    const el = cell(field), start = posToDom(el, from), end = posToDom(el, to), range = document.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    const key = (kind: string) => el.dispatchEvent(new window.KeyboardEvent(kind, { key: text, bubbles: true, cancelable: true }));
    if (!key("keydown") || !key("keypress")) { key("keyup"); return false; }
    const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text });
    Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
    if (!el.dispatchEvent(before)) { key("keyup"); return false; }
    range.deleteContents();
    const native = document.createTextNode(text === " " ? "\u00a0" : text); range.insertNode(native);
    document.getSelection()?.setBaseAndExtent(native, native.length, native, native.length);
    el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    key("keyup"); return true;
  }
  return { h, a, root, render, buffer, painted, cell, select, points, remote, write, deliver, join, split, type, reports, missing, recovered,
    defer: () => { deferred = true; }, flush: () => { const tasks = pending.splice(0); for (const task of tasks) task(); },
    key: (field: Field, row = "R1") => bufferedFieldKey(row, field),
    close: () => { stop(); buffer.dispose(); render.dispose(); a.session.dispose(); h.destroy(); document.body.innerHTML = ""; } };
}
