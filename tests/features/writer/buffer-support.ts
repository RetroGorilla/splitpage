import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { sharedWriterBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { createSurface } from "../../../src/features/writer/flow-surface.ts";
import type { SurfacePorts } from "../../../src/features/writer/flow-surface.ts";
import { writerPage } from "./painted-base-support.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";
import { beatPos, caretAt } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import { fakeWriterBufferEffects } from "../fakes.ts";

export function bufferedWriter(text = "ab", sourceReady = true,
  command?: SurfacePorts["commit"], clipboard?: SurfacePorts["clipboard"]) {
  const h = new Stage1ExecutorHarness([{ id: "R1", text }, { id: "R2", text: "next" }]), a = sharedHarness(adapterReplica(h.a));
  const root = writerPage(), { effects, reports, missing } = fakeWriterBufferEffects();
  const notices: string[] = [];
  let serial = 0, reads = 0, ready = sourceReady;
  const shared = sharedWriterBufferPorts(h.a, a.session, { ...effects, author: () => ({ id: "native:" + ++serial, by: "Alice" }) });
  const surface = createSurface({
    ...shared,
    ...(clipboard ? { clipboard } : {}),
    paintedText: { documentRevision: shared.paintedText.documentRevision, read: (rowId, field) => { reads++; return ready ? shared.paintedText.read(rowId, field) : null; } },
    root, doc: () => a.session.read(doc => { assert.ok(doc); return doc as FlowDoc; }),
    lifetime: a.session,
    heldSelection: createEditorSelection({ epoch: a.session.epoch, order: () => [], keys: () => null }),
    flow: { cells: html => fromHtml(html ?? ""), newId: () => "new", hasVisual: () => false, operations: { id: "native_command", by: "Alice" } },
    decode: fromHtml, storedHtml: html => html, moveBeat: () => {}, editingBlocked: () => false,
    syncBeat: () => { throw new Error("Shared native input reached whole-field synchronization"); },
    commit: (name, operation, before) => { if (command) return command(name, operation, before); throw new Error("Shared native input reached the standalone model command"); },
    undo: () => {}, notice: text => { notices.push(text); }, changed: () => {}, selectionMoved: () => {},
    settings: () => ({ enter: "double", tick: "delete", gapTyping: "here", markdown: true }), openFind: () => {}, plainVisual: () => ""
  });
  surface.paint(); surface.place(caretAt(beatPos("R1", text.length)));
  const beat = () => { const element = root.querySelector<HTMLElement>('.wr-beat[data-id="R1"]'); assert.ok(element); return element; };
  function native(from: number, to: number, insert: string, during?: () => void, type = "insertText"): boolean {
    const target = { anchor: beatPos("R1", from), head: beatPos("R1", to) };
    surface.place(target);
    const range = surface.domRange(target); assert.ok(range);
    const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type, data: insert });
    const nativeTarget = range.cloneRange();
    Object.defineProperty(event, "getTargetRanges", { value: () => [nativeTarget] });
    if (!root.dispatchEvent(event)) return false;
    during?.();
    range.deleteContents();
    const node = document.createTextNode(insert); range.insertNode(node);
    window.getSelection()?.setBaseAndExtent(node, insert.length, node, insert.length);
    root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: type, data: insert }));
    return true;
  }
  return { h, a, root, surface, native, beat, reports, missing, notices, reads: () => reads, ready: () => { ready = true; },
    start: (from: number, to = from) => { surface.place({ anchor: beatPos("R1", from), head: beatPos("R1", to) }); root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true })); },
    end: (data: string) => { root.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data })); },
    text: () => a.session.read(doc => doc?.rows.find(row => row.id === "R1")?.audioText),
    close: () => { root.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" })); surface.dispose(); a.session.dispose(); h.destroy(); }
  };
}
