import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { posToDom } from "../features/common/cell-dom.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const cellOf = (field, rowId = "r1") => {
  const cell = document.querySelector(`#rows .cell-editable[data-id="${rowId}"][data-field="${field}"]`);
  assert.ok(cell); return cell;
};
function type(cell, at, characters) {
  cell.focus();
  const point = posToDom(cell, at);
  document.getSelection().setBaseAndExtent(point.node, point.offset, point.node, point.offset);
  for (const character of characters) {
    const range = document.getSelection().getRangeAt(0).cloneRange();
    const before = new window.InputEvent("beforeinput", { inputType: "insertText", data: character, bubbles: true, cancelable: true });
    Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
    if (!cell.dispatchEvent(before)) continue;
    range.deleteContents();
    const text = document.createTextNode(character); range.insertNode(text);
    document.getSelection().setBaseAndExtent(text, character.length, text, character.length);
    cell.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: character, bubbles: true }));
  }
}
function read() {
  const doc = currentDocument(), ids = new Map();
  const named = id => { if (!ids.has(id)) ids.set(id, "ID" + ids.size); return ids.get(id); };
  const plain = html => html.replace(/data-broll-id="([^"]+)"/g, (_, id) => 'data-broll-id="' + named(id) + '"');
  return { rows: doc.rows.map(row => [plain(row.visualText), plain(row.audioText)]),
    shots: doc.brollShots.map(shot => [named(shot.id), shot.name, shot.origin ?? null, shot.audioRef ?? null]) };
}

const KEY = (text, id = "ID0") => '<span class="broll-key" data-broll-id="' + id + '" contenteditable="false">' + text + "</span>";
const OTHER = ["Wide", "Other"];
const ROWS = [
  { name: "a line typed at the start of a visual cell", visual: "Close up", field: "visualText", at: 0, typed: "B-roll: ",
    left: { rows: [[KEY("B-roll:") + " Close up", "Pour the coffee"], OTHER], shots: [["ID0", "Close up", "script", "Pour the coffee"]] },
    undone: { rows: [["Close up", "Pour the coffee"], OTHER], shots: [] } },
  { name: "a dashed marker typed at the start of a visual cell", visual: "Mug", field: "visualText", at: 0, typed: "b roll - ",
    left: { rows: [[KEY("b roll-") + " Mug", "Pour the coffee"], OTHER], shots: [["ID0", "Mug", "script", "Pour the coffee"]] },
    undone: { rows: [["Mug", "Pour the coffee"], OTHER], shots: [] } },
  { name: "a marker typed on the second line of a visual cell", visual: "Wide<br>Steam", field: "visualText", at: 5, typed: "B-roll: ",
    left: { rows: [["Wide<br>" + KEY("B-roll:") + " Steam", "Pour the coffee"], OTHER], shots: [["ID0", "Steam", "script", "Pour the coffee"]] },
    undone: { rows: [["Wide<br>Steam", "Pour the coffee"], OTHER], shots: [] } },
  { name: "a marker typed in a narration cell", visual: "Wide", field: "audioText", at: 0, typed: "B-roll: ",
    left: { rows: [["Wide", "B-roll: Pour the coffee"], OTHER], shots: [] }, undone: { rows: [["Wide", "Pour the coffee"], OTHER], shots: [] } },
  { name: "a visual cell with nothing to key", visual: "Wide", field: "visualText", at: 4, typed: " shot",
    left: { rows: [["Wide shot", "Pour the coffee"], OTHER], shots: [] }, undone: { rows: [["Wide", "Pour the coffee"], OTHER], shots: [] } },
  { name: "a nameless marker typed in a visual cell", visual: "", field: "visualText", at: 0, typed: "B-roll: ",
    left: { rows: [[KEY("B-roll:") + " ", "Pour the coffee"], OTHER], shots: [] }, undone: { rows: [["", "Pour the coffee"], OTHER], shots: [] } }
];

for (const row of ROWS) test(`standalone leave: ${row.name}`, () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ schema: 2, title: "Standalone leave", paragraphsDecided: true, rows: [
    { id: "r1", audioText: "Pour the coffee", visualText: row.visual, status: "todo" }, { id: "r2", audioText: "Other", visualText: "Wide", status: "todo" }
  ] }));
  undoOwner().flush();
  const before = undoOwner().sizes();
  type(cellOf(row.field), row.at, row.typed);
  cellOf("audioText", "r2").focus();
  undoOwner().flush();
  const left = read(), after = undoOwner().sizes();
  undoOwner().undo(); undoOwner().flush();
  assert.deepEqual({ left, entries: after.undo - before.undo, undone: read() }, { left: row.left, entries: 1, undone: row.undone });
});
