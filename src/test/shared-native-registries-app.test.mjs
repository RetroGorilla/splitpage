import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement } from "../bootstrap/wiring/session-owner.ts";
import { addPersonForTag, applyGearQuickAdd, armDeleteTag, armPersonDelete, openGearPanel, openProductionPanel, saveTagRename, setTagNotes, setTagStatus } from "../features/tags/panels.ts";
import { findOrAddPerson, registerProductionTag } from "../features/tags/production-tags.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;

async function enter(t, fields = {}) {
  adoptReplacement(migrateRows({ schema: 2, paragraphsDecided: true, title: "Registries",
    rows: [{ id: "r1", audioText: "Hello", visualText: "Look" }], ...fields }));
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

const $ = selector => document.querySelector(selector);
const tags = doc => doc.productionTags;
const tag = (doc, name) => tags(doc).find(entry => entry.name === name);

function production(group = "cat") {
  openProductionPanel();
  $(`#production-modes [data-group="${group}"]`).click();
}

function tagCard(key) {
  return $(`#production-list .tag-entity[data-key="${key}"]`);
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

test("native production actions create, cycle, assign, write notes, rename and delete", async t => {
  await enter(t);
  production();
  assert.equal(registerProductionTag("prop", "  Lens  "), true);
  await Promise.resolve();
  const id = tag(hook.read().app, "Lens").id;
  assert.ok(tagCard("prop lens"));
  setTagStatus("prop lens", null);
  await Promise.resolve();
  const status = tag(hook.read().app, "Lens").status;
  assert.notEqual(status, "needed");
  copies(doc => tag(doc, "Lens").status, status);
  assert.deepEqual(addPersonForTag("prop lens", "  Cam  "), { changed: true, held: false });
  await Promise.resolve();
  const owner = hook.read().app.people[0].id;
  copies(doc => tag(doc, "Lens").owner, owner);
  assert.match(tagCard("prop lens").textContent, /Cam/);
  setTagNotes("prop lens", "Bring a spare");
  await Promise.resolve();
  copies(doc => tag(doc, "Lens").notes, "Bring a spare");
  assert.equal(saveTagRename("prop lens", "Wide Lens"), "prop wide lens");
  await Promise.resolve();
  assert.ok(tagCard("prop wide lens"));
  copies(doc => tag(doc, "Wide Lens").id, id);
  const button = document.createElement("button");
  armDeleteTag(button, "prop wide lens");
  armDeleteTag(button, "prop wide lens");
  await Promise.resolve();
  copies(tags, []);
  key($('#rows .cell-editable[data-field="audioText"]'), "z", true);
  await Promise.resolve();
  copies(doc => tag(doc, "Wide Lens").id, id);
  assert.ok(tagCard("prop wide lens"));
});

test("a tag derived from cell markup reaches the panel and takes registry edits", async t => {
  await enter(t, { rows: [{ id: "r1", audioText: "Hello",
    visualText: 'A <span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug" contenteditable="false">Mug</span>' }] });
  production();
  assert.ok(tagCard("prop mug"));
  const id = tag(hook.read().app, "Mug").id;
  assert.equal(hook.nativePeer.registry({ kind: "remove", collection: "tags", ids: [id] }).kind, "written");
  await Promise.resolve();
  assert.ok(tagCard("prop mug"));
  copies(doc => tag(doc, "Mug").status, "needed");
  setTagNotes("prop mug", "Handle with care");
  await Promise.resolve();
  copies(doc => tag(doc, "Mug").notes, "Handle with care");
});

test("gear quick add replaces omitted orphaned gear in one step", async t => {
  await enter(t);
  assert.equal(registerProductionTag("gear", "Tripod"), true);
  await Promise.resolve();
  openGearPanel();
  $("#gear-quickadd-input").value = "Lens\nlens\nBoom";
  applyGearQuickAdd();
  await Promise.resolve();
  copies(doc => tags(doc).map(entry => entry.name), ["Lens", "Boom"]);
  assert.match($("#gear-list").textContent, /Lens/);
  assert.doesNotMatch($("#gear-list").textContent, /Tripod/);
  key($('#rows .cell-editable[data-field="audioText"]'), "z", true);
  await Promise.resolve();
  copies(doc => tags(doc).map(entry => entry.name), ["Tripod"]);
});

test("racing renames agree and the focused notes draft follows the tag ID", async t => {
  await enter(t);
  production();
  registerProductionTag("prop", "Lens");
  await Promise.resolve();
  const id = tag(hook.read().app, "Lens").id;
  tagCard("prop lens").querySelector("[data-action=tag-expand]").click();
  const notes = $(".tag-notes-input");
  notes.focus();
  notes.value = "A local draft";
  notes.setSelectionRange(2, 5);
  hook.nativePeer.hold();
  assert.equal(saveTagRename("prop lens", "Wide Lens"), "prop wide lens");
  assert.equal(hook.nativePeer.registry({ kind: "set", collection: "tags", ids: [id], fields: { name: "Long Lens" } }).kind, "written");
  hook.nativePeer.deliver();
  await Promise.resolve();
  const chosen = tags(hook.read().app)[0].name;
  assert.ok(["Wide Lens", "Long Lens"].includes(chosen));
  copies(doc => tags(doc).map(entry => [entry.id, entry.name, entry.notes]), [[id, chosen, ""]]);
  const card = tagCard("prop " + chosen.toLowerCase());
  assert.ok(card);
  const next = card.querySelector(".tag-notes-input");
  assert.equal(next, document.activeElement);
  assert.equal(next.value, "A local draft");
  assert.deepEqual([next.selectionStart, next.selectionEnd], [2, 5]);
});

test("racing person removal and assignment agree on empty owners and restore the kept assignment", async t => {
  await enter(t);
  const person = findOrAddPerson("Cam");
  registerProductionTag("prop", "Lens");
  registerProductionTag("prop", "Tripod");
  await Promise.resolve();
  addPersonForTag("prop lens", "Cam");
  await Promise.resolve();
  production("person");
  const tripod = tag(hook.read().app, "Tripod").id;
  hook.nativePeer.hold();
  const remove = () => $(`#production-list [data-action="person-delete"][data-person="${person}"]`);
  remove().click();
  remove().click();
  assert.equal(hook.nativePeer.registry({ kind: "set", collection: "tags", ids: [tripod], fields: { owner: person } }).kind, "written");
  hook.nativePeer.deliver();
  await Promise.resolve();
  copies(doc => doc.people, []);
  copies(doc => tags(doc).map(entry => entry.owner), ["", ""]);
  assert.equal(remove(), null);
  assert.match($("#production-list").textContent, /Unassigned/);
  key($('#rows .cell-editable[data-field="audioText"]'), "z", true);
  await Promise.resolve();
  copies(doc => tags(doc).map(entry => entry.owner), [person, person]);
  assert.ok(remove());
});
