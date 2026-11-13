import "../../../src/test/_dom.mjs";
import { fakeCapabilities } from "../fakes.ts";
import assert from "node:assert/strict";
import { createFlowWriter } from "../../../src/features/writer/flow-writer.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { swapBeatsCommand } from "../../../src/application/commands/rows.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";
import { createWholeFieldTextCommit } from "../../../src/application/editing/whole-field-text.ts";
import type { PaintedTextSource } from "../../../src/application/editing/ports.ts";
import type { Command, CommandOutcome } from "../../../src/application/session/document-session.ts";

export function writerPage(): HTMLElement {
  Object.assign(globalThis, { MutationObserver: window.MutationObserver, CSS: { escape: (s: string) => s } });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  document.body.innerHTML = '<div id="writer-doc" contenteditable="true"></div>';
  return document.getElementById("writer-doc") as HTMLElement;
}

export function typeInto(root: HTMLElement, beat: HTMLElement, text: string): void {
  const node = beat.firstChild;
  assert.ok(node && node.nodeType === 3);
  (node as Text).appendData(text);
  window.getSelection()?.setBaseAndExtent(node, (node as Text).length, node, (node as Text).length);
  root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

export function writerFor(source?: PaintedTextSource, rowCount = 2, sections?: readonly Record<string, unknown>[]) {
  const root = writerPage();
  const doc = migrateRows({ ...sections ? { sections } : {}, rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "Bravo" },
    ...Array.from({ length: rowCount - 2 }, (_, index) => ({ id: "r" + index, audioText: "Charlie" }))] }, fakeMigration().ports);
  const text = { cells: fromHtml, clock: { nowIso: () => "2026-11-11T12:00:00.000Z" }, editor: { name: () => "Editor" } };
  const run = (command: Command): CommandOutcome => {
    const plan = command.plan(doc, fakeCapabilities());
    if (!plan || "refused" in plan) return { kind: "noop" };
    plan.apply(doc);
    return { kind: "applied", generation: 1, changes: plan.changes };
  };
  const writer = createFlowWriter({
    ...(source ? { paintedText: source } : {}),
    root, doc: () => doc, lifetime: { epoch: () => 1 },
    heldSelection: createEditorSelection({ epoch: () => 1, order: () => [], keys: () => null }),
    flow: { cells: html => fromHtml(html ?? ""), newId: () => "new", hasVisual: () => false },
    decode: fromHtml, storedHtml: html => html, moveBeat: swapBeatsCommand, run,
    shown: edit => edit(), editingBlocked: () => false, text, wholeFieldText: createWholeFieldTextCommit({ run, text }),
    undo: { step: () => {}, flush: () => {}, breakCoalescing: () => {}, last: () => null, nextRedo: () => null },
    caretAfterStep: () => 0, notice: () => {}, changed: () => {}, selectionMoved: () => {},
    plainVisual: () => "", beatInput: () => {}, typeAtBeatEdge: () => false,
    beatKeydown: () => false, beatSelection: () => {}, leaveBeat: () => {},
    newCommentId: () => "c", openComment: () => {}
  });
  function session(): string[] {
    writer.repaint();
    writer.caret("a", 5);
    const beat = root.querySelector<HTMLElement>('.wr-beat[data-id="a"]');
    assert.ok(beat);
    typeInto(root, beat, "s");
    writer.caret("a", 2);
    root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    writer.repaint();
    return doc.rows.map(row => row.id + "=" + (row.audioText ?? ""));
  }
  return { writer, session, doc, root };
}
