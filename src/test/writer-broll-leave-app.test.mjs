import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";
import { beatPos, caretAt } from "../core/flow/flow.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

function load(visual) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ schema: 2, title: "Writer leave", paragraphsDecided: true, rows: [
    { id: "r1", audioText: "Pour the coffee", visualText: visual, status: "todo" }, { id: "r2", audioText: "Other", visualText: "Wide", status: "todo" }
  ] }));
  undoOwner().flush();
}
function openVisual(rowId = "r1") {
  if (document.getElementById("writer").hidden) writerControls().openWriter();
  writerControls().writerFlowControl().openVisual(rowId);
  const cell = document.querySelector(".wr-flow-visual-text");
  assert.ok(cell);
  return cell;
}
function typeInBox(cell, at, value) {
  cell.focus(); setCellSelection(cell, at, at);
  const range = document.getSelection().getRangeAt(0).cloneRange();
  const before = new window.InputEvent("beforeinput", { inputType: "insertText", data: value, bubbles: true, cancelable: true });
  Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
  if (!cell.dispatchEvent(before)) return;
  range.deleteContents();
  const text = document.createTextNode(value); range.insertNode(text);
  document.getSelection().setBaseAndExtent(text, value.length, text, value.length);
  cell.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: value, bubbles: true }));
}
function key(target, init) { target.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); }
const state = () => {
  const doc = currentDocument();
  return { visual: doc.rows[0].visualText, shots: doc.brollShots.map(shot => [shot.id, shot.name]) };
};

const LEAVES = {
  escape: cell => { key(cell, { key: "Escape" }); },
  close: () => { document.querySelector(".wr-flow-visual-close").click(); },
  outside: () => { document.getElementById("writer-doc").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true })); },
  "view switch": () => { writerControls().closeWriter(); },
  "undo in the box": cell => { key(cell, { key: "z", ctrlKey: true }); }
};

const KEY = id => '<span class="broll-key" data-broll-id="' + id + '" contenteditable="false">B-roll:</span>';
const START = { typed: "Close up", loaded: "B-roll: Close up", nameless: "B-roll: " };

function expected(leave, start, shots) {
  if (leave === "undo in the box") return start === "typed" ? { visual: "Close up", shots: [] } : { visual: START[start], shots };
  const id = shots[0]?.[0];
  return { visual: KEY(id) + " Close up", shots: [[id, "Close up"]] };
}

for (const [leave, run] of Object.entries(LEAVES)) for (const start of Object.keys(START)) {
  test(`standalone Writer: ${leave} keys the visual as on main: ${start} marker`, () => {
    load(start === "typed" ? "Close up" : START[start]);
    const loaded = state().shots;
    const cell = openVisual();
    if (start === "typed") typeInBox(cell, 0, "B-roll: ");
    run(cell);
    const now = state(), want = expected(leave, start, start === "typed" ? now.shots : loaded);
    if (start === "nameless" && leave !== "undo in the box") {
      const [id] = /data-broll-id="([^"]+)"/.exec(now.visual)?.slice(1) ?? [];
      assert.ok(id);
      assert.deepEqual(now, { visual: KEY(id) + " ", shots: [] });
    } else assert.deepEqual(now, want);
    if (start === "typed" && leave !== "undo in the box") assert.match(now.shots[0]?.[0] ?? "", /^bs[a-z0-9]+$/);
  });
}

test("standalone Writer: leaving a narration beat holding a marker keys nothing", () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ schema: 2, title: "Writer leave", paragraphsDecided: true, rows: [
    { id: "r1", audioText: "B-roll: Close up", visualText: "Wide", status: "todo" }, { id: "r2", audioText: "Other", visualText: "Wide", status: "todo" }
  ] }));
  writerControls().openWriter();
  writerControls().writerFlowControl().place(caretAt(beatPos("r1", 3)));
  writerControls().writerFlowControl().place(caretAt(beatPos("r2", 2)));
  assert.deepEqual([currentDocument().rows[0].audioText, currentDocument().brollShots], ["B-roll: Close up", []]);
});
