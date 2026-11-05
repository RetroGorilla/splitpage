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

function harness(changeBeforePlan = false) {
  Object.assign(globalThis, { MutationObserver: window.MutationObserver, CSS: { escape: (s: string) => s } });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  document.body.innerHTML = '<div id="writer-doc" contenteditable="true"></div>';
  const root = document.getElementById("writer-doc") as HTMLElement;
  let doc = migrateRows({ rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "Bravo" }] }, fakeMigration().ports);
  let epoch = 1;
  const left: string[] = [];
  let recorded: FlowSelectionPair | undefined;
  const writer = createFlowWriter({
    root, doc: () => doc,
    lifetime: { epoch: () => epoch },
    heldSelection: createEditorSelection({ epoch: () => epoch, order: () => [], keys: () => null }),
    flow: { cells: html => fromHtml(html ?? ""), newId: () => "new", hasVisual: () => false },
    decode: fromHtml, storedHtml: html => html,
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
    text: { cells: fromHtml, clock: { nowIso: () => "2026-11-04T12:00:00.000Z" }, editor: { name: () => "Editor" } },
    undo: { step: () => {}, flush: () => {}, breakCoalescing: () => {}, last: () => null, nextRedo: () => null },
    caretAfterStep: () => 0, notice: () => {}, changed: () => {}, selectionMoved: () => {},
    plainVisual: () => "", beatInput: () => {}, typeAtBeatEdge: () => false,
    beatKeydown: () => false, beatSelection: () => {}, leaveBeat: beat => { left.push(beat.dataset.id ?? ""); },
    newCommentId: () => "c", openComment: () => {}
  });
  return { writer, root, left, doc: () => doc, recorded: () => recorded, replace: () => {
    epoch++;
    doc = migrateRows({ rows: [{ id: "a", audioText: "Replacement" }] }, fakeMigration().ports);
  } };
}

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
