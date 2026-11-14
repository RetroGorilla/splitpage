import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { createSurface } from "../../../src/features/writer/flow-surface.ts";
import type { SurfacePorts } from "../../../src/features/writer/flow-surface.ts";
import { writerPage } from "./painted-base-support.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";
import { beatPos, caretAt } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import { fakeWriterBufferEffects } from "../fakes.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import type { BufferedTextCommit, BufferedTextEdit } from "../../../src/application/editing/ports.ts";
import type { SharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import type { SharedUndoActions } from "../../../src/application/editing/undo/shared-undo-actions.ts";

export function keyOf(type: string, insert: string): string | null {
  if (type === "insertText" && Array.from(insert).length === 1) return insert;
  return type === "deleteContentBackward" ? "Backspace" : type === "deleteContentForward" ? "Delete" : null;
}

export function pressKey(root: HTMLElement, key: string | null): boolean {
  return key === null || root.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
}

export function releaseKey(root: HTMLElement, key: string | null): void {
  if (key !== null) root.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true, key }));
}

export function bufferedWriter(text = "ab", sourceReady = true,
  command?: SurfacePorts["commit"], clipboard?: SurfacePorts["clipboard"], options: {
    h?: Stage1ExecutorHarness;
    open?: (open: BufferedTextCommit["open"]) => BufferedTextCommit["open"];
    key?: (event: KeyboardEvent, beat: HTMLElement) => boolean;
    author?: (serial: number) => string;
    fields?: Record<string, unknown>;
    undo?: (h: Stage1ExecutorHarness) => Pick<SharedUndo, "perform">;
    history?: SharedUndoActions;
  } = {}) {
  const h = options.h ?? new Stage1ExecutorHarness([{ id: "R1", text }, { id: "R2", text: "next" }], options.fields), a = sharedHarness(adapterReplica(h.a, options.undo?.(h)));
  const root = options.h ? document.body.appendChild(document.createElement("div")) : writerPage(), { effects, reports, missing, recovered } = fakeWriterBufferEffects();
  const notices: string[] = [];
  let serial = 0, reads = 0, ready = sourceReady;
  const shared = sharedBufferPorts(h.a, a.session, { ...effects, readers: bufferReaders, stamps: bufferStamps("Alice"), author: () => {
    const next = ++serial;
    return { id: options.author?.(next) ?? (options.h ? "other_native:" : "native:") + next, by: "Alice" };
  } });
  const edits: BufferedTextEdit[] = [];
  const outcomes: ReturnType<BufferedTextEdit["commit"]>[] = [];
  const open = options.open?.(shared.bufferedText.open) ?? shared.bufferedText.open;
  const surface = createSurface({
    ...shared,
    bufferedText: { ...shared.bufferedText, open: (rowId, base) => {
      const edit = open(rowId, base); if (!edit) return null;
      edits.push(edit);
      return { ...edit, commit: (runs, selection) => { const outcome = edit.commit(runs, selection); outcomes.push(outcome); return outcome; } };
    } },
    ...(clipboard ? { clipboard } : {}),
    paintedText: { documentRevision: shared.paintedText.documentRevision, read: (rowId, field) => { reads++; return ready ? shared.paintedText.read(rowId, field) : null; } },
    root, doc: () => a.session.read(doc => { assert.ok(doc); return doc as FlowDoc; }),
    lifetime: a.session,
    heldSelection: createEditorSelection({ epoch: a.session.epoch, order: () => [], keys: () => null }),
    flow: { cells: html => fromHtml(html ?? ""), newId: () => "new", hasVisual: () => false, operations: { id: "native_command", by: "Alice" } },
    decode: fromHtml, storedHtml: html => html, moveBeat: () => {}, editingBlocked: () => false,
    syncBeat: () => { throw new Error("Shared native input reached whole-field synchronization"); },
    commit: (name, operation, before) => { if (command) return command(name, operation, before); throw new Error("Shared native input reached the standalone model command"); },
    undo: direction => { if (options.history) options.history[direction](); else notices.push("undo"); }, ...(options.key ? { beatKeydown: options.key } : {}),
    notice: text => { notices.push(text); }, changed: () => {}, selectionMoved: () => {},
    settings: () => ({ enter: "double", tick: "delete", gapTyping: "here", markdown: true }), openFind: () => {}, plainVisual: () => ""
  });
  surface.paint(); surface.place(caretAt(beatPos("R1", text.length)));
  const beat = (rowId = "R1") => { const element = root.querySelector<HTMLElement>('.wr-beat[data-id="' + rowId + '"]'); assert.ok(element); return element; };
  function native(from: number, to: number, insert: string, during?: () => void, type = "insertText", rowId = "R1", reportInput = true): boolean {
    const target = { anchor: beatPos(rowId, from), head: beatPos(rowId, to) }, key = keyOf(type, insert);
    surface.place(target);
    if (!pressKey(root, key)) return false;
    const range = surface.domRange(target); assert.ok(range);
    const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type, data: insert });
    const nativeTarget = range.cloneRange();
    Object.defineProperty(event, "getTargetRanges", { value: () => [nativeTarget] });
    if (!root.dispatchEvent(event)) { releaseKey(root, key); return false; }
    during?.();
    range.deleteContents();
    const node = document.createTextNode(insert); range.insertNode(node);
    window.getSelection()?.setBaseAndExtent(node, insert.length, node, insert.length);
    if (reportInput) root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: type, data: insert }));
    releaseKey(root, key);
    return true;
  }
  return { h, a, root, surface, native, beat, reports, missing, recovered, notices, edits, outcomes, reads: () => reads, ready: () => { ready = true; },
    start: (from: number, to = from) => { surface.place({ anchor: beatPos("R1", from), head: beatPos("R1", to) }); root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true })); },
    end: (data: string) => { root.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data })); },
    text: () => a.session.read(doc => doc?.rows.find(row => row.id === "R1")?.audioText),
    close: () => { root.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" })); surface.dispose(); a.session.dispose(); if (!options.h) h.destroy(); root.remove(); }
  };
}
