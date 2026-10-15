import "./_dom.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const frames = new Map();
let nextFrame = 1;
let scrolled = 0;
const requestFrame = (fn) => { const id = nextFrame++; frames.set(id, fn); return id; };
const cancelFrame = (id) => { frames.delete(id); };
for (const target of [globalThis, window]) {
  target.requestAnimationFrame = requestFrame;
  target.cancelAnimationFrame = cancelFrame;
}
window.scrollBy = () => { scrolled++; };
window.document.elementFromPoint = () => null;

function runFrames(n) {
  for (let i = 0; i < n; i++) {
    const due = [...frames.values()];
    frames.clear();
    for (const fn of due) fn();
  }
}

const { bootApp, closeApp } = await import("./_app-boot.mjs");
const { S } = await import("../js/_state.js");
await bootApp();
const app = await import("../bootstrap/app.ts");

after(() => {
  app.stopApp();
  closeApp();
});

function firstRow() {
  return document.querySelector("#rows .row[data-id]");
}

function startEdgeDrag() {
  const row = firstRow();
  row.setAttribute("draggable", "true");
  row.dispatchEvent(new window.MouseEvent("dragstart", { bubbles: true, cancelable: true }));
  document.body.dispatchEvent(new window.MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: 10, clientY: 2 }));
  return row;
}

test("stopping the app mid edge-drag ends the drag: the auto-scroll stops, the markers clear, and a remount starts with no dragged scene", async () => {
  const row = startEdgeDrag();
  const id = row.getAttribute("data-id");
  assert.equal(S.dragRowId, id, "the drag started");
  assert.equal(frames.size, 1, "the edge auto-scroll is running");
  runFrames(2);
  assert.equal(scrolled, 2, "the auto-scroll scrolls each frame");
  assert.equal(frames.size, 1, "and keeps going while the drag holds");

  app.stopApp();
  assert.equal(S.dragRowId, null, "dispose forgets the dragged scene");
  assert.equal(frames.size, 0, "dispose cancels the auto-scroll frame");
  assert.equal(document.querySelectorAll("#rows .row.is-dragging, #rows .row[draggable]").length, 0, "dispose clears the drag markers");
  runFrames(3);
  assert.equal(scrolled, 2, "nothing scrolls after dispose");

  app.startApp();
  await S.initialStateReady;
  assert.equal(S.dragRowId, null, "the remount inherits no dragged scene");
  document.body.dispatchEvent(new window.MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: 10, clientY: 2 }));
  assert.equal(frames.size, 0, "an edge dragover with no drag does not scroll");
  startEdgeDrag();
  assert.equal(S.dragRowId, firstRow().getAttribute("data-id"), "a new drag starts on the remount");
  assert.equal(frames.size, 1, "and auto-scrolls once");
  document.getElementById("rows").dispatchEvent(new window.MouseEvent("dragend", { bubbles: true }));
  assert.equal(frames.size, 0);
});
