import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { splitSpaceSwitch } from "./_shared-split-space.mjs";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { enterSharedSession, leaveSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { render, renderRow } from "../features/rows/render.ts";
import { posToDom } from "../features/common/cell-dom.ts";
import { sharedCellSpaceForm } from "../bootstrap/wiring/ports/shared-cell-space.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const cellOf = (field = "audioText") => document.querySelector(`#rows .cell-editable[data-id="r0"][data-field="${field}"]`);
function selectAll(cell) {
  cell.focus();
  const range = document.createRange(); range.selectNodeContents(cell);
  document.getSelection().removeAllRanges(); document.getSelection().addRange(range);
}
function payload(cell, type) {
  selectAll(cell);
  const writes = [], data = {}, event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === "dragstart" ? "dataTransfer" : "clipboardData", {
    value: { setData: (kind, value) => { writes.push(kind); data[kind] = value; } }
  });
  cell.dispatchEvent(event);
  return { data, writes, prevented: event.defaultPrevented };
}

for (const field of ["audioText", "visualText"]) test(`shared ${field} leave drops stored space form and paint on a reused cell, then copy and drag equal standalone`, async () => {
  const { ports } = splitSpaceSwitch();
  adoptReplacement(migrateRows({ title: "Spaces", rows: [{ id: "r0", audioText: "Word\u00a0", visualText: "Word\u00a0" }] }));
  const cell = cellOf(field), standaloneCopy = payload(cell, "copy"), standaloneDrag = payload(cell, "dragstart");
  assert.deepEqual(standaloneCopy, { data: { "text/html": "Word&nbsp;", "text/plain": "Word " }, writes: ["text/html", "text/plain"], prevented: true });
  assert.deepEqual(standaloneDrag, { data: {}, writes: [], prevented: false });
  assert.deepEqual(await enterSharedSession(ports), { ok: true });
  try {
    assert.equal(cellOf(field), cell);
    assert.equal(payload(cell, "copy").data["text/plain"], "Word\u00a0");
    assert.equal(payload(cell, "dragstart").data["text/plain"], "Word\u00a0");
  } finally { assert.deepEqual(leaveSharedSession(ports), { ok: true }); }
  assert.equal(sharedSession(), false);
  render(); renderRow("r0");
  assert.equal(cellOf(field), cell);
  assert.equal(sharedCellSpaceForm(cell), null);
  assert.equal(document.querySelector("[data-shared-cell-space-form], [data-shared-cell-space]"), null);
  assert.deepEqual(payload(cell, "copy"), standaloneCopy);
  assert.deepEqual(payload(cell, "dragstart"), standaloneDrag);
});

for (const size of [2, 50]) test(`shared space form writes only the typed cell with ${size} rows, and successful leave removes every painted span`, async () => {
  const { ports, reports } = splitSpaceSwitch();
  adoptReplacement(migrateRows({ title: "Space cost", rows: Array.from({ length: size }, (_, index) => ({ id: "r" + index, audioText: "Word ", visualText: "Wide " })) }));
  assert.deepEqual(await enterSharedSession(ports), { ok: true });
  const originalSet = WeakMap.prototype.set, writes = [];
  const watched = new Set(document.querySelectorAll("#rows .cell-editable"));
  try {
    assert.ok(document.querySelector("[data-shared-cell-space]"));
    WeakMap.prototype.set = function (key, value) {
      if (watched.has(key) && Object.hasOwn(value, "text") && Object.hasOwn(value, "html"))
        writes.push([key.getAttribute("data-id"), key.getAttribute("data-field"), value.text]);
      return originalSet.call(this, key, value);
    };
    const cell = cellOf(), point = posToDom(cell, 4);
    cell.focus(); document.getSelection().setBaseAndExtent(point.node, point.offset, point.node, point.offset);
    cell.dispatchEvent(new window.KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
    cell.dispatchEvent(new window.KeyboardEvent("keypress", { key: "x", bubbles: true, cancelable: true }));
    const range = document.getSelection().getRangeAt(0).cloneRange();
    const before = new window.InputEvent("beforeinput", { inputType: "insertText", data: "x", bubbles: true, cancelable: true });
    Object.defineProperty(before, "getTargetRanges", { value: () => [range] });
    assert.equal(cell.dispatchEvent(before), true);
    point.node.insertData(point.offset, "x");
    document.getSelection().setBaseAndExtent(point.node, point.offset + 1, point.node, point.offset + 1);
    cell.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: "x", bubbles: true }));
    cell.dispatchEvent(new window.KeyboardEvent("keyup", { key: "x", bubbles: true, cancelable: true }));
    assert.equal(currentDocument().rows[0].audioText, "Wordx ");
    assert.deepEqual(writes, [["r0", "audioText", "Wordx "]]);
    assert.equal(document.querySelector("[data-shared-cell-space-form]"), null);
  } finally {
    WeakMap.prototype.set = originalSet;
    assert.deepEqual(leaveSharedSession(ports), { ok: true }, JSON.stringify(reports, (_key, value) => value instanceof Error ? value.stack : value));
  }
  assert.equal(document.querySelector("[data-shared-cell-space-form], [data-shared-cell-space]"), null);
});
