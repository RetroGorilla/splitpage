import { swapBeatsCommand } from "../../../src/application/commands/rows.ts";
import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlowWriter } from "../../../src/features/writer/flow-writer.ts";
import type { FlowWriterPorts } from "../../../src/features/writer/flow-writer.ts";
import { beatPos } from "../../../src/core/flow/flow.ts";
import { scenesInOrder } from "../../../src/core/document/scenes.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";

function harness(initial?: Parameters<typeof migrateRows>[0]) {
  Object.assign(globalThis, { MutationObserver: window.MutationObserver, CSS: { escape: (s: string) => s } });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  document.body.innerHTML = '<div id="writer-doc" contenteditable="true"></div>';
  const root = document.getElementById("writer-doc") as HTMLElement;
  const doc = migrateRows(initial ?? { paragraphsDecided: true, rows: [
    { id: "a", audioText: "Alpha", visualText: "A <strong>red</strong> sky" },
    { id: "b", audioText: "Bravo", visualText: "Red view" }
  ] }, fakeMigration().ports);
  let epoch = 1;
  const notices: string[] = [];
  let opens = 0;
  let closes = 0;
  let commands = 0;
  const ports: FlowWriterPorts = {
    root, doc: () => doc,
    openFind: () => { opens++; }, closeFind: () => { closes++; },
    lifetime: { epoch: () => epoch },
    heldSelection: createEditorSelection({ epoch: () => epoch, order: () => [], keys: () => null }),
    flow: { cells: html => fromHtml(html ?? ""), newId: () => "new", hasVisual: row => !!row.visualText },
    decode: fromHtml, storedHtml: html => html,
    moveBeat: swapBeatsCommand,
    run: command => {
      const plan = command.plan(doc, { edit: () => ({ allowed: true }) });
      if (!plan) return { kind: "noop" };
      if ("refused" in plan) return { kind: "rejected", reason: plan.refused };
      commands++;
      plan.apply(doc);
      return { kind: "applied", generation: 1, changes: plan.changes };
    },
    shown: edit => edit(),
    editingBlocked: () => false,
    text: { cells: fromHtml, clock: { nowIso: () => "2026-11-05T12:00:00.000Z" }, editor: { name: () => "Editor" } },
    undo: { step: () => {}, flush: () => {}, breakCoalescing: () => {}, last: () => null, nextRedo: () => null },
    caretAfterStep: () => 0, notice: message => { notices.push(message); }, changed: () => {}, selectionMoved: () => {},
    plainVisual: () => "", beatInput: () => {}, typeAtBeatEdge: () => false,
    beatKeydown: () => false, beatSelection: () => {}, leaveBeat: () => {}, newCommentId: () => "c", openComment: () => {}
  };
  const writer = createFlowWriter(ports);
  writer.repaint();
  return { writer, root, doc, notices, commands: () => commands, opens: () => opens, closes: () => closes, retire: () => { epoch++; } };
}

test("writer Find routes a visual match through openVisual with plain-text offsets", t => {
  const h = harness();
  try {
    assert.equal(h.writer.find.visuals(), false);
    assert.equal(h.writer.find.search("red", false).matches.length, 0);
    h.writer.find.setVisuals(true);
    const match = h.writer.find.search("red", false).matches[0];
    assert.ok(match);
    const spy = t.mock.method(h.writer, "openVisual", () => {});
    assert.equal(h.writer.find.reveal(match), null);
    assert.equal(spy.mock.callCount(), 1);
    assert.deepEqual(spy.mock.calls[0]?.arguments, ["a", { from: 2, to: 5 }]);
    h.writer.find.leave(match);
    assert.equal(spy.mock.callCount(), 2);
    assert.deepEqual(spy.mock.calls[1]?.arguments, ["a", { from: 2, to: 5 }]);
    assert.equal(h.commands(), 0);
  } finally { h.writer.dispose(); }
});

test("the phase 6 visual stub puts the caret in its beat without editing text", () => {
  const h = harness();
  try {
    h.writer.openVisual("b", { from: 0, to: 3 });
    assert.deepEqual(h.writer.selection(), { anchor: beatPos("b", 0), head: beatPos("b", 0) });
    assert.equal(h.doc.rows[1]?.audioText, "Bravo");
    assert.equal(h.commands(), 0);
  } finally { h.writer.dispose(); }
});

test("narration reveals a DOM range without taking Find's keyboard focus", t => {
  const h = harness();
  const input = document.createElement("input");
  document.body.append(input);
  try {
    input.focus();
    const spy = t.mock.method(h.writer, "openVisual", () => {});
    const match = h.writer.find.search("pha Bra", false).matches[0];
    assert.ok(match);
    const range = h.writer.find.reveal(match);
    assert.ok(range);
    assert.equal(range.toString().replace(/\u200b/g, ""), "phaBra");
    assert.equal(document.activeElement, input);
    assert.equal(spy.mock.callCount(), 0);
  } finally { h.writer.dispose(); }
});

test("one replace command covers all opted-in matches and retired writers cannot replace or reveal", t => {
  const h = harness();
  try {
    h.writer.find.setVisuals(true);
    const matches = h.writer.find.search("red", false).matches;
    assert.equal(h.writer.find.replace(matches, "blue"), true);
    assert.equal(h.commands(), 1);
    assert.equal(h.doc.rows[0]?.visualText, "A <strong>blue</strong> sky");
    assert.equal(h.doc.rows[1]?.visualText, "blue view");
    const spy = t.mock.method(h.writer, "openVisual", () => {});
    h.retire();
    assert.deepEqual(h.writer.find.search("blue", false), { matches: [], inTags: 0 });
    assert.equal(h.writer.find.replace(matches, "lost"), false);
    const first = matches[0];
    assert.ok(first);
    assert.equal(h.writer.find.reveal(first), null);
    assert.equal(h.commands(), 1);
    assert.equal(spy.mock.callCount(), 0);
  } finally { h.writer.dispose(); }
});

test("Ctrl+F uses the shared Find action and disposal closes its session", () => {
  const h = harness();
  h.writer.caret("a", 2);
  const event = new window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
  h.root.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.opens(), 1);
  h.writer.dispose();
  assert.equal(h.closes(), 1);
});

test("Visual input updates only its beat's decorations", t => {
  const h = harness();
  try {
    h.writer.openVisual("a");
    const other = h.root.querySelector<HTMLElement>('[data-id="b"]');
    assert.ok(other);
    const spy = t.mock.method(other.classList, "toggle");
    const cell = document.querySelector<HTMLElement>(".wr-flow-visual-text");
    assert.ok(cell);
    cell.innerHTML = "New visual";
    cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "l" }));
    assert.equal(h.doc.rows[0]?.visualText, "New visual");
    assert.equal(spy.mock.callCount(), 0);
  } finally { h.writer.dispose(); }
});

test("Find resolves a pending heading before capturing its starting position", () => {
  const h = harness({ paragraphsDecided: true, rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "Bravo", paragraphStart: true }] });
  try {
    h.writer.caret("b", 5);
    const beat = h.root.querySelector<HTMLElement>('[data-id="b"]');
    assert.ok(beat);
    beat.textContent = "# Bravo";
    assert.ok(beat.firstChild);
    window.getSelection()?.setBaseAndExtent(beat.firstChild, 4, beat.firstChild, 4);
    h.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "# Bravo" }));
    const at = h.writer.find.selection();
    assert.equal(h.doc.rows.some(row => row.id === "b"), false);
    assert.equal(scenesInOrder(h.doc)?.[0]?.name, "Bravo");
    assert.equal(at?.head.kind, "heading");
    assert.equal(h.writer.find.firstFrom(h.writer.find.search("Bravo", false).matches, at), 0);
  } finally { h.writer.dispose(); }
});

test("Find resolves an emptied heading before capturing its starting position", () => {
  const h = harness({ paragraphsDecided: true, rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "Bravo" }],
    sections: [{ id: "scene", name: "Heading", firstSceneId: "b" }] });
  try {
    h.writer.place({ anchor: { kind: "heading", sceneId: "scene", offset: 0 }, head: { kind: "heading", sceneId: "scene", offset: 0 } });
    const heading = h.root.querySelector<HTMLElement>(".wr-heading");
    assert.ok(heading);
    heading.textContent = "";
    window.getSelection()?.setBaseAndExtent(heading, 0, heading, 0);
    h.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    const at = h.writer.find.selection();
    assert.equal(scenesInOrder(h.doc), undefined);
    assert.equal(at?.head.kind, "beat");
    assert.equal(h.doc.rows[1]?.audioText, "Bravo");
  } finally { h.writer.dispose(); }
});
