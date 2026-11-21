import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_legacy-shared-app-boot.mjs";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const { adoptReplacement, currentDocument, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { stepSharedUndo, undoOwner } = await import("../bootstrap/wiring/undo.ts");
const hook = window.__legacySharedTest;

async function openWriter(t, rows) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Shared script", rows }));
  undoOwner().flush();
  writerControls().openWriter();
  t.after(() => {
    if (sharedSession()) hook.leave();
    writerControls().closeWriter();
  });
  assert.deepEqual(await hook.enter(), { ok: true });
}

test("the legacy buffer counts a Writer ownership scan", async t => {
  await openWriter(t, [{ id: "r1", audioText: "Hello" }]);
  const before = hook.counters().ownershipScans;
  const beat = document.querySelector('#writer-doc .wr-beat[data-id="r1"]');
  beat.dataset.id = "missing";
  beat.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  assert.ok(hook.counters().ownershipScans > before);
});

test("the legacy empty Writer places the caret after the first beat's text", async t => {
  await openWriter(t, []);
  const input = document.querySelector(".empty-script-input");
  input.focus();
  input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
  input.value = "Hi";
  input.dispatchEvent(new window.InputEvent("input", { bubbles: true, isComposing: true, data: "Hi" }));
  input.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "Hi" }));
  const row = currentDocument().rows[0];
  assert.equal(row.audioText, "Hi");
  assert.equal(document.activeElement, document.getElementById("writer-doc"));
  const point = { kind: "beat", rowId: row.id, offset: 2 };
  assert.deepEqual(writerControls().writerFlowControl().selection(), { anchor: point, head: point });
});

test("the legacy shared undo route warns for a used-up step in either direction", () => {
  const used = { ok: true, effective: false, reason: "used-up", label: "typing", selection: null };
  const route = { actions: { undo: () => used, redo: () => used }, breakGroup: () => {} };
  const messages = [];
  for (const direction of ["undo", "redo"]) assert.equal(stepSharedUndo(route, direction, text => messages.push(text)), used);
  assert.deepEqual(messages, [
    "That step could not be undone because someone else changed it.",
    "That step could not be redone because someone else changed it."
  ]);
});
