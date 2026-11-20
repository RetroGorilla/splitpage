import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement } from "../bootstrap/wiring/session-owner.ts";
import { armPersonDelete } from "../features/tags/panels.ts";
import { findOrAddPerson } from "../features/tags/production-tags.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;

async function enter(t, fields = {}) {
  adoptReplacement(migrateRows({ title: "Registries", rows: [{ id: "r1", audioText: "Hello", visualText: "Look" }], ...fields }));
  assert.deepEqual(await hook.enter({ backend: "native" }), { ok: true });
  t.after(() => assert.deepEqual(hook.leave(), { ok: true }));
}

function copies(read, expected) {
  const { app, peer } = hook.read();
  assert.deepEqual(read(app), expected);
  assert.deepEqual(read(peer), expected);
}

function key(target, key, ctrlKey = false) {
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }));
}

test("creating a person flushes pending typing and each registry action has its own undo step", async t => {
  await enter(t);
  const narration = document.querySelector('#rows .cell-editable[data-field="audioText"]');
  narration.focus();
  setCellSelection(narration, 2);
  const input = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "x" });
  narration.dispatchEvent(input);
  assert.equal(input.defaultPrevented, true);
  assert.equal(hook.read().app.rows[0].audioText, "Hello");
  const at = cellSelection(narration);
  const id = findOrAddPerson("  Sam  ");
  assert.ok(id);
  assert.equal(findOrAddPerson("sam"), id);
  assert.equal(hook.read().app.rows[0].audioText, "Hexllo");
  await Promise.resolve();
  const people = doc => doc.people.map(({ id, name }) => ({ id, name }));
  copies(people, [{ id, name: "Sam" }]);
  const button = document.createElement("button");
  armPersonDelete(button, id);
  armPersonDelete(button, id);
  await Promise.resolve();
  copies(people, []);
  key(narration, "z", true);
  await Promise.resolve();
  copies(people, [{ id, name: "Sam" }]);
  key(narration, "z", true);
  await Promise.resolve();
  copies(people, []);
  copies(doc => doc.rows[0].audioText, "Hexllo");
  assert.deepEqual(cellSelection(narration), at);
  key(narration, "y", true);
  await Promise.resolve();
  copies(people, [{ id, name: "Sam" }]);
});
