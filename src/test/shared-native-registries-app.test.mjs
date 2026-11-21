import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement } from "../bootstrap/wiring/session-owner.ts";
import { addPersonForTag, applyGearQuickAdd, armDeleteTag, armPersonDelete, bulkDeleteSelected, openGearPanel,
  openProductionPanel, saveTagRename, setTagNotes, setTagStatus, toggleCardSelection } from "../features/tags/panels.ts";
import { findOrAddPerson, registerProductionTag } from "../features/tags/production-tags.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { openBrollPanel } from "../features/broll/panel.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";

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

const shot = (doc, id) => doc.brollShots.find(entry => entry.id === id);
const shotRow = id => $(`#broll-list .broll-row[data-id="${id}"]`);
const shotCard = id => $(`#broll-list .broll-card[data-id="${id}"]`);
function shotButton(id, action) {
  const selector = `[data-action="broll-${action}"]`;
  return shotRow(id).querySelector(selector) ?? shotCard(id)?.querySelector(selector);
}
const shotBox = (id, box) => shotCard(id).querySelector(`.broll-${box}-input`);

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

test("the native rename notice uses the name stored after applying the length cap", async t => {
  await enter(t, { productionTags: [{ cat: "prop", name: "Lens" }] });
  production();
  const show = t.mock.method(notices, "show", () => {});
  const capped = "x".repeat(80);
  assert.equal(saveTagRename("prop lens", capped + "y"), "prop " + capped);
  await Promise.resolve();
  copies(doc => tags(doc).map(entry => entry.name), [capped]);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [["Renamed to " + capped, "ok"]]);
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
  const show = t.mock.method(notices, "show", () => {});
  const before = hook.read();
  assert.equal(saveTagRename("prop mug", "Cup"), "prop mug");
  toggleCardSelection("prop mug");
  bulkDeleteSelected();
  await Promise.resolve();
  assert.deepEqual(hook.read(), before);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), Array(2).fill(["This is not available in a shared session yet.", "warn"]));
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

test("untouched focused gear quick add refreshes across peer additions and saves nothing", async t => {
  await enter(t, { productionTags: [{ cat: "gear", name: "Tripod" }] });
  openGearPanel();
  const box = $("#gear-quickadd-input");
  box.focus();
  assert.equal(box.value, "Tripod");
  assert.equal(hook.nativePeer.registry({ kind: "create", collection: "tags", fields: { cat: "gear", name: "Boom" } }).kind, "written");
  applyGearQuickAdd();
  await Promise.resolve();
  const names = doc => tags(doc).map(entry => entry.name).sort();
  copies(names, ["Boom", "Tripod"]);
  assert.match($("#gear-list").textContent, /Boom/);
  assert.equal(document.activeElement, box);
  assert.equal(box.value, "Boom\nTripod");
  assert.equal(box.defaultValue, box.value);
  applyGearQuickAdd();
  await Promise.resolve();
  copies(names, ["Boom", "Tripod"]);
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
});

test("Scene prep keeps a removed tag's draft away from its same-name replacement", async t => {
  await enter(t, { rows: [{ id: "r1", audioText: "Hello",
    visualText: '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug" contenteditable="false">Mug</span>' }],
  productionTags: [{ id: "t_source", cat: "prop", name: "Mug" }] });
  production("prep");
  $('.prep-resource-name [data-prep="notes"]').click();
  const original = $(".prep-notes .tag-notes-input");
  const id = original.getAttribute("data-registry-id");
  assert.equal(id, tag(hook.read().app, "Mug").id);
  original.focus();
  original.value = "Notes for the removed record";
  assert.equal(hook.nativePeer.registry({ kind: "remove", collection: "tags", ids: [id] }).kind, "written");
  await Promise.resolve();
  const replacement = $(".prep-notes .tag-notes-input");
  assert.notEqual(replacement, original);
  assert.notEqual(replacement.getAttribute("data-registry-id"), id);
  assert.equal(replacement.value, "");
  assert.notEqual(document.activeElement, replacement);
  assert.equal($("#production-list .typed-unsaved-text").value, original.value);
  replacement.focus();
  replacement.blur();
  await Promise.resolve();
  copies(doc => tag(doc, "Mug").notes, "");
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

test("a native shot can be added, edited, assigned, unpropped, deleted and restored with undo", async t => {
  await enter(t);
  openBrollPanel();
  const add = $("#broll-add-input");
  add.value = "  Wide  ";
  key(add, "Enter");
  await Promise.resolve();
  const { id, name } = hook.read().app.brollShots[0];
  assert.equal(name, "Wide");
  assert.ok(shotRow(id).classList.contains("is-open"));
  assert.equal(add.value, "");
  shotButton(id, "status-toggle").click();
  await Promise.resolve();
  assert.equal(shotButton(id, "status-toggle").getAttribute("aria-checked"), "true");
  copies(doc => shot(doc, id).status, "shot");
  shotButton(id, "reshoot-toggle").click();
  await Promise.resolve();
  copies(doc => shot(doc, id).reshoot, true);
  const notes = shotBox(id, "notes");
  notes.focus();
  notes.value = "Second take";
  notes.blur();
  await Promise.resolve();
  copies(doc => shot(doc, id).notes, "Second take");
  shotButton(id, "person-new").click();
  shotBox(id, "person").value = "  Cam  ";
  shotButton(id, "person-save").click();
  await Promise.resolve();
  copies(doc => doc.people.find(p => p.id === shot(doc, id).owner)?.name, "Cam");
  shotBox(id, "prop").value = "  Lens  ";
  key(shotBox(id, "prop"), "Enter");
  await Promise.resolve();
  copies(doc => shot(doc, id).props.map(prop => prop.name), ["Lens"]);
  shotButton(id, "prop-remove").click();
  await Promise.resolve();
  copies(doc => shot(doc, id).props, []);
  shotButton(id, "menu").click();
  shotButton(id, "delete").click();
  await Promise.resolve();
  copies(doc => doc.brollShots, []);
  assert.equal(shotRow(id), null);
  key($('#rows .cell-editable[data-field="audioText"]'), "z", true);
  await Promise.resolve();
  copies(doc => shot(doc, id).name, name);
  assert.ok(shotRow(id));
});

test("a removed keyed shot is projected again, and renaming its visual line stays refused", async t => {
  await enter(t, { rows: [{ id: "r1", audioText: "Hello",
    visualText: '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> Wide' }] });
  const show = t.mock.method(notices, "show", () => {});
  openBrollPanel();
  assert.match(shotRow("bs1").textContent, /Wide/);
  if (!shotCard("bs1")) shotButton("bs1", "expand").click();
  shotButton("bs1", "menu").click();
  shotButton("bs1", "rename").click();
  const rename = shotBox("bs1", "rename");
  rename.value = "Close-up";
  key(rename, "Enter");
  await Promise.resolve();
  assert.equal(shotBox("bs1", "rename").value, "Close-up");
  copies(doc => shot(doc, "bs1").name, "Wide");
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [["This is not available in a shared session yet.", "warn"]]);
  shotButton("bs1", "rename-cancel").click();
  shotButton("bs1", "status-toggle").click();
  await Promise.resolve();
  copies(doc => shot(doc, "bs1").status, "shot");
  assert.equal(hook.nativePeer.registry({ kind: "remove", collection: "shots", ids: ["bs1"] }).kind, "written");
  await Promise.resolve();
  copies(doc => [shot(doc, "bs1").name, shot(doc, "bs1").status], ["Wide", "unshot"]);
  assert.equal(shotButton("bs1", "status-toggle").getAttribute("aria-checked"), "false");
});

test("racing prop additions keep one list and a peer redraw keeps the editor's shot notes draft", async t => {
  await enter(t, { brollShots: [{ id: "bs1", name: "Wide", origin: "list" }] });
  openBrollPanel();
  if (!shotCard("bs1")) shotButton("bs1", "expand").click();
  hook.nativePeer.hold();
  const prop = shotBox("bs1", "prop");
  prop.value = "Lens";
  key(prop, "Enter");
  const notes = shotBox("bs1", "notes");
  notes.focus();
  notes.value = "A shot draft";
  notes.setSelectionRange(1, 4);
  assert.equal(hook.nativePeer.registry({ kind: "addProp", id: "bs1", prop: "Tripod" }).kind, "written");
  hook.nativePeer.deliver();
  await Promise.resolve();
  const props = shot(hook.read().app, "bs1").props.map(prop => prop.name);
  assert.equal(props.length, 1);
  assert.ok(["Lens", "Tripod"].includes(props[0]));
  copies(doc => shot(doc, "bs1").props.map(prop => prop.name), props);
  copies(doc => tags(doc).map(entry => entry.name).sort(), ["Lens", "Tripod"]);
  assert.match(shotCard("bs1").textContent, new RegExp(props[0]));
  const retained = shotBox("bs1", "notes");
  assert.equal(retained.value, "A shot draft");
  assert.equal(retained, document.activeElement);
  assert.deepEqual([retained.selectionStart, retained.selectionEnd], [1, 4]);
  copies(doc => shot(doc, "bs1").notes, "");
});

test("a stale tag edit refuses instead of creating a duplicate of the old tag name", async t => {
  await enter(t);
  production();
  registerProductionTag("prop", "Lens");
  await Promise.resolve();
  const id = tag(hook.read().app, "Lens").id;
  const show = t.mock.method(notices, "show", () => {});
  assert.equal(hook.nativePeer.registry({ kind: "set", collection: "tags", ids: [id], fields: { name: "Wide" } }).kind, "written");
  assert.ok(tagCard("prop lens"));
  assert.deepEqual(addPersonForTag("prop lens", "Cam"), { changed: false, held: true });
  await Promise.resolve();
  copies(doc => tags(doc).map(entry => [entry.name, entry.owner]), [["Wide", ""]]);
  copies(doc => doc.people, []);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [["This is not available in a shared session yet.", "warn"]]);
});

test("refused native shot and tag owner changes restore the published selection and keep focus", async t => {
  await enter(t, { rows: [{ id: "r1", audioText: "Hello",
    visualText: '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> Wide' }],
  people: [{ id: "p1", name: "Cam" }], productionTags: [{ cat: "prop", name: "Lens" }] });
  const show = t.mock.method(notices, "show", () => {});
  function chooseOwner(select) {
    select.focus();
    select.value = "p1";
    assert.equal(select.value, "p1");
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(select.value, "");
    assert.equal(document.activeElement, select);
  }
  openBrollPanel();
  if (!shotCard("bs1")) shotButton("bs1", "expand").click();
  assert.equal(hook.nativePeer.registry({ kind: "remove", collection: "shots", ids: ["bs1"] }).kind, "written");
  await Promise.resolve();
  chooseOwner(shotCard("bs1").querySelector(".broll-owner-select"));
  copies(doc => shot(doc, "bs1").owner, "");

  production();
  tagCard("prop lens").querySelector("[data-action=tag-expand]").click();
  const select = tagCard("prop lens").querySelector(".tag-owner-select");
  select.focus();
  const narration = $('#rows .cell-editable[data-field="audioText"]');
  setCellSelection(narration, 2);
  narration.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, cancelable: true }));
  try {
    chooseOwner(select);
    copies(doc => tag(doc, "Lens").owner, "");
  } finally {
    narration.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }));
  }
  assert.deepEqual(show.mock.calls.map(call => call.arguments), Array(2).fill(["This is not available in a shared session yet.", "warn"]));
});
