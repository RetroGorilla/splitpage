import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import type { SharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { createPaintGuard } from "../../../src/application/editing/paint-guard.ts";
import { createFlowVisualBox } from "../../../src/features/writer/flow-visual-box.ts";
import { writerVisualBuffer } from "../../../src/bootstrap/wiring/ports/writer-visual-buffer.ts";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { caretAt, beatPos } from "../../../src/core/flow/flow.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { fakeWriterBufferEffects } from "../fakes.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { setCellSelection } from "../../../src/features/common/cell-selection.ts";

export function sharedWriterVisualBox(undo: (h: Stage1ExecutorHarness) => Pick<SharedUndo, "perform">) {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }]);
  const a = sharedHarness(adapterReplica(h.a, undo(h))), guard = createPaintGuard();
  const { effects, reports } = fakeWriterBufferEffects();
  let serial = 0;
  const shared = sharedBufferPorts(h.a, a.session, { ...effects, readers: bufferReaders, stamps: bufferStamps("Alice"), author: () => ({ id: "visual_" + ++serial, by: "Alice" }) });
  const holder = document.body.appendChild(document.createElement("section")), root = holder.appendChild(document.createElement("div"));
  const doc = () => { const view = a.session.read(doc => doc); assert.ok(view); return view; };
  const at = caretAt(beatPos("R1", 0));
  const forbidden = () => { assert.fail("Shared visual reached a standalone callback"); };
  const box = createFlowVisualBox({ root, buffer: writerVisualBuffer(shared, { document: doc, lifetime: a.session, decode: fromHtml, storedHtml: html => html, shown: guard.whileShown }),
    doc, selection: () => at, prepare: range => range, place: () => {}, current: () => true, blocked: () => guard.painting(), plainVisual: () => "", thumbnails: () => "",
    save: forbidden, input: forbidden, leave: forbidden, keydown: forbidden, notice: forbidden, undo: forbidden, paste: forbidden });
  const stop = a.session.subscribe(() => { if (!guard.shown()) box.refresh(); });
  box.open(at);
  const cell = box.element.querySelector<HTMLElement>(".wr-flow-visual-text"); assert.ok(cell);
  return { h, session: a.session, typeA: () => {
    cell.focus(); setCellSelection(cell, 0);
    const range = document.createRange(); range.selectNodeContents(cell); range.collapse(true);
    const before = new window.InputEvent("beforeinput", { inputType: "insertText", data: "x", bubbles: true, cancelable: true });
    Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
    assert.equal(cell.dispatchEvent(before), true);
    range.insertNode(document.createTextNode("x")); setCellSelection(cell, 1);
    cell.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: "x", bubbles: true }));
    assert.deepEqual(reports, []);
  }, close: () => { box.dispose(); stop(); a.session.dispose(); h.destroy(); holder.remove(); } };
}
