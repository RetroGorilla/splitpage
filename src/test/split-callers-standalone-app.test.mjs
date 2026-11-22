import { after, test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { addRow } from "../bootstrap/wiring/rows.ts";
import { cycleRowStatus, setBeatFilmed } from "../bootstrap/wiring/beat-status.ts";
import { sharedStructureCommands, sharedValueCommands } from "../bootstrap/wiring/ports/shared-commands.ts";
import { setBeatLength } from "../features/rows/read-time.ts";
import { setTargetLength } from "../features/rundown/target.ts";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { posToDom, domToPos } from "../features/common/cell-dom.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const toastHost = () => { const host = document.getElementById("toast-host"); assert.ok(host); return host; };
const warnings = () => [...toastHost().querySelectorAll(".toast.warn")].map(el => el.firstChild.textContent);
const clearWarnings = () => { toastHost().replaceChildren(); };
const SOURCE = { schema: 2, title: "Shared callers", paragraphsDecided: true, wordsPerMinute: 150, rows: [
  { id: "r1", audioText: "abcdef", visualText: "Wide", status: "todo" }, { id: "r2", audioText: "Other", visualText: "", status: "todo" },
  { id: "r3", audioText: "Third", visualText: "", status: "todo" }
], sections: [{ id: "s1", name: "Scene", firstSceneId: "r3" }] };

const cellOf = (field, rowId = "r1") => {
  const cell = document.querySelector(`#rows .cell-editable[data-id="${rowId}"][data-field="${field}"]`);
  assert.ok(cell, rowId + " " + field); return cell;
};
function select(cell, from, to = from) {
  cell.focus();
  const anchor = posToDom(cell, from), head = posToDom(cell, to);
  document.getSelection().setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
}
function caret() {
  const selection = document.getSelection(), cell = selection.anchorNode?.parentElement?.closest(".cell-editable") ?? selection.anchorNode?.closest?.(".cell-editable");
  return cell ? [cell.getAttribute("data-id"), cell.getAttribute("data-field"), domToPos(cell, selection.anchorNode, selection.anchorOffset)] : null;
}
function press(target, key, modifiers = {}) {
  const handled = !target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
  target.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true, ...modifiers }));
  return handled;
}

test("C7 standalone: the callers read no shared ports and keep the list-local ids", () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(SOURCE)));
  assert.equal(sharedSession(), false);
  assert.equal(sharedStructureCommands.ports(), null);
  assert.equal(sharedValueCommands.ports(), null);
  clearWarnings();
  select(cellOf("audioText"), 3);
  assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
  const split = currentDocument().rows[1];
  assert.match(split.id, /^r/); assert.doesNotMatch(split.id, /^structure_/);
  assert.deepEqual(currentDocument().rows.map(r => [r.id, r.audioText]), [["r1", "abc"], [split.id, "def"], ["r2", "Other"], ["r3", "Third"]]);
  assert.deepEqual(caret(), [split.id, "audioText", 0]);
  const added = addRow(null);
  assert.equal(currentDocument().rows.at(-1).id, added);
  assert.doesNotMatch(added, /^structure_/);
  select(cellOf("visualText"), 2);
  assert.equal(press(cellOf("visualText"), "Enter", { altKey: true }), true);
  assert.deepEqual(currentDocument().rows.slice(0, 2).map(r => r.visualText), ["Wi", "de"]);
  assert.equal(currentDocument().rows[1].id === split.id, false);
  cycleRowStatus("r1"); setBeatFilmed("r2", true);
  assert.deepEqual(currentDocument().rows.filter(r => r.id === "r1" || r.id === "r2").map(r => r.status), ["ready", "shot"]);
  assert.equal(setBeatLength("r1", 42), true); assert.equal(setTargetLength(90), true);
  assert.deepEqual([currentDocument().rows[0].lengthSeconds, currentDocument().targetSeconds], [42, 90]);
  assert.deepEqual(warnings(), []);
});
