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
import { createCellEditing } from "../../../src/application/editing/cell-editing.ts";
import { createWholeFieldTextCommit } from "../../../src/application/editing/whole-field-text.ts";
import { createPaintGuard } from "../../../src/application/editing/paint-guard.ts";
import type { Command, CommandOutcome } from "../../../src/application/session/document-session.ts";
import { createProductionIndex } from "../../../src/application/production/production-index.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { acceptTagGhost, maybeAutoTagShortcut, startProductionTags, tagGhost, updateTagGhost } from "../../../src/features/tags/production-tags.ts";
import { fakeDocument, fakeEdits, fakeNotices } from "../fakes.ts";

function harness(changeBeforePlan = false, refusePaste = false, tagged = false) {
  Object.assign(globalThis, { MutationObserver: window.MutationObserver, CSS: { escape: (s: string) => s } });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  document.body.innerHTML = '<div id="writer-doc" contenteditable="true"></div>' + (tagged ? '<div id="tag-ghost"></div>' : "");
  const root = document.getElementById("writer-doc") as HTMLElement;
  const migration = fakeMigration();
  let doc = migrateRows({
    rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "Bravo" }],
    ...(tagged ? { productionTags: [{ id: "t_kettle", cat: "prop", name: "Kettle" }] } : {})
  }, migration.ports);
  let epoch = 1;
  let breaks = 0;
  const left: string[] = [];
  const leaves: string[] = [];
  const inputs: string[] = [];
  let recorded: FlowSelectionPair | undefined;
  const guard = createPaintGuard();
  const text = { cells: fromHtml, clock: { nowIso: () => "2026-11-04T12:00:00.000Z" }, editor: { name: () => "Editor" } };
  const run = (command: Command): CommandOutcome => {
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
  };
  const cells = createCellEditing<Element>({
    page: {
      address: cell => ({ rowId: cell.getAttribute("data-id"), field: cell.getAttribute("data-field") }),
      attached: cell => cell.isConnected, html: cell => cell.innerHTML, selection: () => null,
      write: (cell, html) => { cell.innerHTML = html; }, focus: () => {}
    },
    document: () => doc, run, text, wholeFieldText: createWholeFieldTextCommit({ run, text }), decode: { text: fromHtml, withMedia: fromHtml },
    undo: { applying: () => false, breakCoalescing: () => {}, flush: () => {}, latest: () => null },
    stale: () => false, painted: () => {}, shown: edit => edit(), announce: () => {}
  });
  const tags = tagged ? startProductionTags({
    document: fakeDocument(doc).document, edits: fakeEdits().edits,
    refresh: { request: () => {}, cancel: () => {} }, stamping: { stamp: () => { throw new Error("No stamp expected"); } },
    text: { cellOf: () => [], productionReaders: migration.ports.readers, inertBody: () => document.body, sanitizeHtml: html => String(html ?? "") },
    production: () => createProductionIndex(migration.ports.readers, deepFreeze),
    editing: { cells: () => cells, focus: () => ({ promptMutedFor: () => null }) },
    undo: { breakCoalescing: () => {} }, view: () => ({ writerOpen: () => true }),
    notices: fakeNotices().notices, ids: migration.ids
  }) : null;
  const writer = createFlowWriter({
    root, doc: () => doc,
    ...(refusePaste ? { clipboard: { mount: () => () => {}, copy: () => {}, paste: () => ({ refused: "Paste refused" }) } } : {}),
    lifetime: { epoch: () => epoch },
    heldSelection: createEditorSelection({ epoch: () => epoch, order: () => [], keys: () => null }),
    flow: { cells: html => fromHtml(html ?? ""), newId: () => "new", hasVisual: () => false },
    decode: fromHtml, storedHtml: html => html,
    moveBeat: swapBeatsCommand,
    run,
    shown: edit => edit(),
    editingBlocked: () => guard.painting(),
    text,
    wholeFieldText: createWholeFieldTextCommit({ run, text }),
    visualInput: tagged
      ? (event, cell) => { maybeAutoTagShortcut(event, cell); updateTagGhost(cell); }
      : (_event, cell) => { inputs.push(cell.innerHTML); cells.sync(cell); },
    visualKeydown: (event, cell) => {
      if (event.key === "Tab" && tagGhost?.cellEl === cell && acceptTagGhost()) { event.preventDefault(); return true; }
      return false;
    },
    visualLeave: cell => { leaves.push(cell.innerHTML); cells.sync(cell); },
    undo: { step: () => {}, flush: () => {}, breakCoalescing: () => { breaks++; }, last: () => null, nextRedo: () => null },
    caretAfterStep: () => 0, notice: () => {}, changed: () => {}, selectionMoved: () => {},
    plainVisual: () => "", beatInput: () => {}, typeAtBeatEdge: () => false,
    beatKeydown: () => false, beatSelection: () => {}, leaveBeat: beat => { left.push(beat.dataset.id ?? ""); },
    newCommentId: () => "c", openComment: () => {}
  });
  return { writer, root, tags, left, leaves, inputs, painting: guard.whilePainting, breaks: () => breaks, doc: () => doc, recorded: () => recorded, replace: () => {
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

function visualCell(): HTMLElement {
  const cell = document.querySelector<HTMLElement>(".wr-flow-visual-text");
  assert.ok(cell);
  return cell;
}

function typeVisual(html: string): void {
  const cell = visualCell();
  cell.innerHTML = html;
  const last = cell.lastChild;
  if (last && last.nodeType === 3) window.getSelection()?.setBaseAndExtent(last, (last as Text).length, last, (last as Text).length);
  cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: html.slice(-1) }));
}

function withCaretRects<T>(run: () => T): T {
  const proto = window.Range.prototype as unknown as { getClientRects: () => unknown[] };
  const original = proto.getClientRects;
  proto.getClientRects = () => [{ right: 0, top: 0 }];
  try { return run(); } finally { proto.getClientRects = original; }
}

function pressVisual(key: string): void {
  visualCell().dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function openWithOld(h: ReturnType<typeof harness>): void {
  const row = h.doc().rows[0];
  assert.ok(row);
  row.visualText = "Old";
  h.writer.repaint();
  h.writer.openVisual("a");
}

test("typing in the Visual box while editing is blocked changes neither the document nor the box", () => {
  const h = harness();
  try {
    openWithOld(h);
    h.painting(() => { typeVisual("Seen"); });
    assert.equal(h.doc().rows[0]?.visualText, "Old");
    assert.equal(visualCell().innerHTML, "Old");
    h.painting(() => { pressVisual("Enter"); });
    assert.equal(h.doc().rows[0]?.visualText, "Old");
    assert.equal(visualCell().innerHTML, "Old");
  } finally { h.writer.dispose(); }
});

test("typing a tag shortcut in the Visual box while editing is blocked creates no tag", () => {
  const h = harness(false, false, true);
  try {
    h.writer.repaint();
    h.writer.openVisual("a");
    h.painting(() => { typeVisual("[kettle]"); });
    assert.equal(h.doc().rows[0]?.visualText ?? "", "");
    assert.equal(visualCell().innerHTML, "");
    typeVisual("[kettle]");
    assert.match(h.doc().rows[0]?.visualText ?? "", /tag-anchor/);
  } finally { h.tags?.dispose(); h.writer.dispose(); }
});

test("Tab in the Visual box while editing is blocked does not accept the tag completion", () => {
  const h = harness(false, false, true);
  try {
    withCaretRects(() => {
      h.writer.repaint();
      h.writer.openVisual("a");
      typeVisual("[ke");
      assert.equal(document.getElementById("tag-ghost")?.classList.contains("is-visible"), true);
      h.painting(() => { pressVisual("Tab"); });
      assert.equal(h.doc().rows[0]?.visualText, "[ke");
      assert.equal(visualCell().innerHTML, "[ke");
      assert.equal(document.querySelector<HTMLElement>(".wr-flow-visual-box")?.hidden, false);
      pressVisual("Tab");
      assert.match(h.doc().rows[0]?.visualText ?? "", /tag-anchor/);
    });
  } finally { h.tags?.dispose(); h.writer.dispose(); }
});

test("closing a clean Visual box while editing is blocked does not write its stale text over the document", () => {
  const h = harness();
  try {
    openWithOld(h);
    const row = h.doc().rows[0];
    assert.ok(row);
    row.visualText = "Restored";
    h.painting(() => { pressVisual("Escape"); });
    assert.equal(document.querySelector<HTMLElement>(".wr-flow-visual-box")?.hidden, true);
    assert.deepEqual(h.leaves, []);
    assert.equal(h.doc().rows[0]?.visualText, "Restored");
  } finally { h.writer.dispose(); }
});

test("the Visual box types, saves and closes as before once editing is allowed again", () => {
  const h = harness();
  try {
    openWithOld(h);
    h.painting(() => { typeVisual("Seen"); });
    typeVisual("New");
    assert.equal(h.doc().rows[0]?.visualText, "New");
    assert.deepEqual(h.inputs, ["New"]);
    pressVisual("Escape");
    assert.deepEqual(h.leaves, ["New"]);
    assert.equal(h.doc().rows[0]?.visualText, "New");
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
