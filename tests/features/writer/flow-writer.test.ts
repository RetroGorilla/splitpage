import { swapBeatsCommand } from "../../../src/application/commands/rows.ts";
import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlowWriter } from "../../../src/features/writer/flow-writer.ts";
import { beatPos } from "../../../src/core/flow/flow.ts";
import type { FlowSelectionPair } from "../../../src/core/flow/flow.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";

function harness(changeBeforePlan = false, refusePaste = false) {
  Object.assign(globalThis, { MutationObserver: window.MutationObserver, CSS: { escape: (s: string) => s } });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  document.body.innerHTML = '<div id="writer-doc" contenteditable="true"></div>';
  const root = document.getElementById("writer-doc") as HTMLElement;
  let doc = migrateRows({ rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "Bravo" }] }, fakeMigration().ports);
  let epoch = 1;
  let breaks = 0;
  let blocked = false;
  const left: string[] = [];
  const visualLeaves: string[] = [];
  let recorded: FlowSelectionPair | undefined;
  const writer = createFlowWriter({
    root, doc: () => doc,
    ...(refusePaste ? { clipboard: { mount: () => () => {}, copy: () => {}, paste: () => ({ refused: "Paste refused" }) } } : {}),
    lifetime: { epoch: () => epoch },
    heldSelection: createEditorSelection({ epoch: () => epoch, order: () => [], keys: () => null }),
    flow: { cells: html => fromHtml(html ?? ""), newId: () => "new", hasVisual: () => false },
    decode: fromHtml, storedHtml: html => html,
    moveBeat: swapBeatsCommand,
    run: command => {
      if (changeBeforePlan) {
        const [first, second] = doc.rows;
        assert.ok(first && second);
        second.audioText = "Live narration";
        first.audioText = "Live Alpha";
      }
      const plan = command.plan(doc, { edit: () => ({ allowed: true }) });
      if (!plan || "refused" in plan) return { kind: "noop" };
      recorded = plan.selection;
      plan.apply(doc);
      return { kind: "applied", generation: 1, changes: plan.changes };
    },
    shown: edit => edit(),
    editingBlocked: () => blocked,
    text: { cells: fromHtml, clock: { nowIso: () => "2026-11-04T12:00:00.000Z" }, editor: { name: () => "Editor" } },
    undo: { step: () => {}, flush: () => {}, breakCoalescing: () => { breaks++; }, last: () => null, nextRedo: () => null },
    caretAfterStep: () => 0, notice: () => {}, changed: () => {}, selectionMoved: () => {},
    plainVisual: () => "", beatInput: () => {}, typeAtBeatEdge: () => false,
    beatKeydown: () => false, beatSelection: () => {}, leaveBeat: beat => { left.push(beat.dataset.id ?? ""); },
    visualLeave: cell => { visualLeaves.push(cell.innerHTML); },
    newCommentId: () => "c", openComment: () => {}
  });
  return { writer, root, left, visualLeaves, block: (value: boolean) => { blocked = value; }, breaks: () => breaks, doc: () => doc, recorded: () => recorded, replace: () => {
    epoch++;
    doc = migrateRows({ rows: [{ id: "a", audioText: "Replacement" }] }, fakeMigration().ports);
  } };
}

test("Alt+Enter does not edit the writer", () => {
  const h = harness();
  try {
    h.writer.repaint();
    h.writer.caret("a", 2);
    const before = JSON.stringify(h.doc());
    const key = new window.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true });
    h.root.dispatchEvent(key);
    assert.equal(key.defaultPrevented, true);
    assert.equal(JSON.stringify(h.doc()), before);
    assert.deepEqual(h.writer.selection(), { anchor: beatPos("a", 2), head: beatPos("a", 2) });
  } finally { h.writer.dispose(); }
});

test("a retired writer never sends its beat departure to the current document's services", () => {
  const h = harness();
  try {
    h.writer.repaint();
    h.writer.place({ anchor: beatPos("a", 2), head: beatPos("a", 2) });
    h.replace();
    h.writer.place({ anchor: beatPos("b", 2), head: beatPos("b", 2) });
    assert.deepEqual(h.left, []);
    assert.equal(h.doc().rows[0]?.audioText, "Replacement");
  } finally { h.writer.dispose(); }
});

test("comment jumps follow the surviving narration mark instead of a stale comment row", () => {
  const h = harness();
  const row = h.doc().rows[1];
  assert.ok(row);
  row.audioText = 'Bravo <span class="cmt-anchor" data-cmt="c">marked</span> tail';
  try {
    h.writer.repaint();
    h.writer.jumpComment("c", "a", "audioText");
    assert.deepEqual(h.writer.selection(), { anchor: beatPos("b", 6), head: beatPos("b", 6) });
    assert.equal(h.root.querySelector('.cmt-anchor[data-cmt="c"]')?.classList.contains("flash"), true);
    assert.equal(h.recorded(), undefined);
  } finally { h.writer.dispose(); }
});

test("a visual comment jumps to its beat without changing the narration", () => {
  const h = harness();
  try {
    h.writer.repaint();
    h.writer.jumpComment("visual-comment", "b", "visualText");
    assert.deepEqual(h.writer.selection(), { anchor: beatPos("b", 0), head: beatPos("b", 0) });
    assert.equal(h.doc().rows[1]?.audioText, "Bravo");
    assert.equal(h.recorded(), undefined);
  } finally { h.writer.dispose(); }
});

function typeVisual(html: string): HTMLElement {
  const cell = document.querySelector<HTMLElement>(".wr-flow-visual-text");
  assert.ok(cell);
  cell.innerHTML = html;
  cell.dispatchEvent(new window.Event("input", { bubbles: true }));
  return cell;
}

test("the Visual box does not save while editing is blocked, and saves the typed text once it is not", () => {
  const h = harness();
  try {
    h.writer.repaint();
    h.writer.openVisual("a");
    h.block(true);
    typeVisual("Seen");
    assert.equal(h.doc().rows[0]?.visualText ?? "", "");
    h.block(false);
    typeVisual("Seen more");
    assert.equal(h.doc().rows[0]?.visualText, "Seen more");
  } finally { h.writer.dispose(); }
});

test("closing the Visual box after a blocked save keeps the text for the next save", () => {
  const h = harness();
  try {
    h.writer.repaint();
    h.writer.openVisual("a");
    h.block(true);
    typeVisual("Seen");
    h.block(false);
    const cell = document.querySelector<HTMLElement>(".wr-flow-visual-text");
    cell?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(h.doc().rows[0]?.visualText, "Seen");
  } finally { h.writer.dispose(); }
});

function escapeVisual(): void {
  const cell = document.querySelector<HTMLElement>(".wr-flow-visual-text");
  cell?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

test("text typed in the Visual box and closed while blocked is saved once editing is allowed again", () => {
  const h = harness();
  try {
    h.writer.repaint();
    h.writer.openVisual("a");
    h.block(true);
    typeVisual("Seen");
    escapeVisual();
    assert.equal(h.doc().rows[0]?.visualText ?? "", "");
    h.block(false);
    h.writer.repaint();
    assert.equal(h.doc().rows[0]?.visualText, "Seen");
  } finally { h.writer.dispose(); }
});

test("reopening the Visual box after a blocked close saves the pending text first", () => {
  const h = harness();
  try {
    h.writer.repaint();
    h.writer.openVisual("a");
    h.block(true);
    typeVisual("Seen");
    escapeVisual();
    h.block(false);
    h.writer.openVisual("a");
    assert.equal(h.doc().rows[0]?.visualText, "Seen");
    assert.equal(document.querySelector(".wr-flow-visual-text")?.innerHTML, "Seen");
  } finally { h.writer.dispose(); }
});

test("opening another beat's Visual box while the save is still blocked keeps the pending text", () => {
  const h = harness();
  try {
    h.writer.repaint();
    h.writer.openVisual("a");
    h.block(true);
    typeVisual("Seen");
    escapeVisual();
    h.writer.openVisual("b");
    h.block(false);
    h.writer.repaint();
    assert.equal(h.doc().rows[0]?.visualText, "Seen");
    assert.equal(h.doc().rows[1]?.visualText ?? "", "");
  } finally { h.writer.dispose(); }
});

test("closing the Visual box while editing is blocked does not run the leave callback", () => {
  const h = harness();
  try {
    h.writer.repaint();
    h.writer.openVisual("a");
    h.block(true);
    typeVisual("Seen");
    escapeVisual();
    assert.deepEqual(h.visualLeaves, []);
    h.block(false);
    h.writer.repaint();
    assert.deepEqual(h.visualLeaves, ["Seen"]);
  } finally { h.writer.dispose(); }
});

test("writer operations plan after entering the command and carry the directed selection", () => {
  const h = harness(true);
  const writer = h.writer;
  const before = { anchor: beatPos("a", 4), head: beatPos("a", 1) };
  try {
    writer.repaint();
    writer.place(before);
    writer.format("bold");
    assert.equal(h.doc().rows[1]?.audioText, "Live narration");
    assert.equal(h.doc().rows[0]?.audioText, "L<strong>ive</strong> Alpha");
    assert.deepEqual(h.recorded()?.before, before);
    assert.deepEqual(h.recorded()?.after, before);
  } finally { writer.dispose(); }
});

test("closing keeps composed text that landed outside its beat, with no beat marked as touched", () => {
  const h = harness();
  try {
    h.writer.repaint();
    const beat = h.root.querySelector('.wr-beat[data-id="a"]');
    assert.ok(beat);
    h.root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    const orphan = document.createTextNode("LOCAL");
    beat.after(orphan);
    window.getSelection()?.setBaseAndExtent(orphan, 5, orphan, 5);
    h.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true, data: "LOCAL" }));
    h.root.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "LOCAL" }));
    h.writer.finish();
    assert.equal(h.doc().rows[0]?.audioText, "AlphaLOCAL");
  } finally { h.writer.dispose(); }
});

test("closing a retired writer never repairs its old DOM into a replacement document", () => {
  const h = harness();
  try {
    h.writer.repaint();
    const beat = h.root.querySelector('.wr-beat[data-id="a"]');
    assert.ok(beat);
    beat.after(document.createTextNode("Stale"));
    h.replace();
    h.writer.finish();
    assert.equal(h.doc().rows[0]?.audioText, "Replacement");
  } finally { h.writer.dispose(); }
});

test("closing a retired writer never syncs its old DOM into a replacement document with reused beat ids", () => {
  const h = harness();
  try {
    h.writer.repaint();
    const beat = h.root.querySelector('.wr-beat[data-id="a"]');
    assert.ok(beat);
    beat.textContent = "Unsynced old document";
    h.replace();
    h.writer.finish();
    assert.equal(h.doc().rows[0]?.audioText, "Replacement");
  } finally { h.writer.dispose(); }
});

test("refused paste and join preserve the typing group", () => {
  const h = harness(false, true);
  try {
    h.doc().sections = [{ id: "s", name: "Scene", firstSceneId: "b" }];
    h.writer.repaint();
    h.writer.caret("b", 0);
    h.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Backspace", altKey: true, bubbles: true, cancelable: true }));
    assert.equal(h.breaks(), 0);
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"], getData: () => "X" } });
    h.root.dispatchEvent(event);
    assert.equal(h.breaks(), 0);
    assert.deepEqual(h.doc().rows.map(row => row.audioText), ["Alpha", "Bravo"]);
  } finally { h.writer.dispose(); }
});
test("Alt+Up and Alt+Down move the caret's beat through one command with its directed selection", () => {
  const h = harness();
  try {
    h.writer.repaint();
    const range = { anchor: beatPos("b", 4), head: beatPos("b", 1) };
    h.writer.place(range);
    h.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual(h.doc().rows.map(row => row.id), ["b", "a"]);
    assert.deepEqual(h.writer.selection(), range);
    assert.deepEqual(h.recorded(), { before: range, after: range });
    assert.equal(h.breaks(), 1);
    h.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual(h.doc().rows.map(row => row.id), ["b", "a"]);
    assert.equal(h.breaks(), 1);
    h.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual(h.doc().rows.map(row => row.id), ["a", "b"]);
    assert.deepEqual(h.writer.selection(), range);
    assert.equal(h.breaks(), 2);
  } finally { h.writer.dispose(); }
});
test("Ctrl+Shift+Enter retains the shipped beat split instead of inserting a line break", () => {
  const h = harness();
  try {
    h.writer.repaint();
    h.writer.caret("a", 2);
    h.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual(h.doc().rows.map(row => row.audioText), ["Al", "pha", "Bravo"]);
    assert.deepEqual(h.writer.selection(), { anchor: beatPos("new", 0), head: beatPos("new", 0) });
    assert.equal(h.breaks(), 1);
  } finally { h.writer.dispose(); }
});
