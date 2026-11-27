import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { adoptReplacement, currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, forceLeaveSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { posToDom, readSelection } from "../features/common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { applyGearQuickAdd, openGearPanel } from "../features/tags/panels.ts";
import { nativeEntrySwitchFixture } from "../../tests/bootstrap/native-entry-switch-support.ts";

window.Element.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const visual = () => document.querySelector('#rows .cell-editable[data-id="r1"][data-field="visualText"]');
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const target = { beat: "r1", cell: "visual" };

async function start(t, visualText) {
  const fixture = nativeEntrySwitchFixture();
  const { errors } = fixture;
  const ports = { ...fixture.ports, commandRefused: sharedCommandRefusalNotice(notices) };
  adoptReplacement(migrateRows({ schema: 2, title: "Shared tags", paragraphsDecided: true,
    rows: [{ id: "r1", audioText: "Narration", visualText }] }));
  undoOwner().flush();
  writerControls().openWriter();
  let native;
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    native = opened.native;
    return opened.backend;
  }), { ok: true });
  writerControls().closeWriter();
  const peer = openNativeSession({ kind: "state", state: native.encodeState() }, { actor: "Peer" });
  t.after(() => { peer.close(); forceLeaveSharedSession(); assert.deepEqual(errors, []); });
  return { native, peer };
}

function select(from, to = from) {
  const node = visual();
  node.focus();
  setCellSelection(node, from, to);
}

function toolbar(from, to, cat) {
  select(from, to);
  const wrap = visual().closest(".field-wrap");
  wrap.querySelector('[data-cmd="tag"]').click();
  const picker = wrap.querySelector('.tag-toolbar-picker[aria-hidden="false"]');
  assert.ok(picker, "selection opens the category picker");
  picker.querySelector(`[data-tag-cat="${cat}"]`).click();
}

function type(text) {
  for (const char of text) {
    const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: char });
    Object.defineProperty(event, "getTargetRanges", { value: () => [document.getSelection().getRangeAt(0).cloneRange()] });
    assert.equal(visual().dispatchEvent(event), false);
  }
}

function tab() {
  return keydown("Tab");
}

function keydown(key) {
  return visual().dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
}

function quickAddLamp() {
  openGearPanel();
  document.getElementById("gear-quickadd-input").value = "Lamp";
  applyGearQuickAdd();
  document.getElementById("gear-close").click();
}

test("shared Gear Quick Add undo keeps a peer's label and edited entry through reload", async t => {
  const { native, peer } = await start(t, "Lamp");
  quickAddLamp();
  await exchange(native, peer);
  const [{ id }] = peer.document().productionTags;
  const third = openNativeSession({ kind: "state", state: native.encodeState() }, { actor: "Third" });
  t.after(() => third.close());
  const label = peer.commands.anchorText(target, 0, 4);
  assert.equal(label.kind, "anchored");
  assert.equal(peer.commands.labelVisual(label.range, { cat: "gear", name: "Lamp", words: "Lamp" }).kind, "written");
  assert.equal(third.commands.changeRegistry({ kind: "set", collection: "tags", ids: [id],
    fields: { notes: "Bring a spare bulb", status: "have" } }).kind, "written");
  assert.equal(applyNativePeerUpdate(native, third.encodeState()), true);
  await exchange(native, peer);
  const undo = native.commands.undo();
  await exchange(native, peer);
  assert.equal(applyNativePeerUpdate(third, native.encodeState()), true);
  assert.deepEqual(third.document(), native.document());
  assert.deepEqual(tags(), [["gear", "Lamp", "Lamp"]]);
  assert.deepEqual(currentDocument().productionTags.map(tag => [tag.id, tag.notes, tag.status]), [[id, "Bring a spare bulb", "have"]]);
  assert.equal(undo.kind, "unchanged");
  const reopened = openNativeSession({ kind: "state", state: native.encodeState() }, { actor: "Reopened" });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.document(), native.document());
});

test("standalone Gear Quick Add undo removes the added record", () => {
  adoptReplacement(migrateRows({ schema: 2, title: "Standalone gear", paragraphsDecided: true,
    rows: [{ id: "r1", audioText: "Narration", visualText: "Lamp" }] }));
  undoOwner().flush();
  quickAddLamp();
  assert.deepEqual(currentDocument().productionTags.map(tag => tag.name), ["Lamp"]);
  select(0);
  visual().dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual(currentDocument().productionTags, []);
});

test("redo restores the original label name when a peer renamed its orphaned entry", async t => {
  const { native, peer } = await start(t, "Lamp");
  toolbar(0, 4, "prop");
  await exchange(native, peer);
  const [{ id }] = peer.document().productionTags;
  assert.equal(native.commands.undo().kind, "written");
  await exchange(native, peer);
  assert.equal(peer.commands.changeRegistry({ kind: "set", collection: "tags", ids: [id], fields: { name: "New lamp" } }).kind, "written");
  await exchange(native, peer);
  assert.equal(native.commands.redo().kind, "written");
  await exchange(native, peer);
  assert.deepEqual(tags(), [["prop", "Lamp", "Lamp"]]);
  assert.deepEqual(currentDocument().productionTags.map(tag => [tag.id, tag.name]), [[id, "New lamp"]]);
});

async function exchange(native, peer) {
  assert.equal(applyNativePeerUpdate(native, peer.encodeState()), true);
  assert.equal(applyNativePeerUpdate(peer, native.encodeState()), true);
  await tick();
  assert.deepEqual(currentDocument(), native.document());
  assert.deepEqual(native.document(), peer.document());
}

function tags() {
  return [...visual().querySelectorAll(".tag-anchor")].map(tag => [tag.dataset.tagCat, tag.dataset.tagName, tag.textContent]);
}

for (const [keyword, cat] of [["prop", "prop"], ["location", "location"], ["cast", "cast"], ["vfx", "vfx"], ["sfx", "sound"], ["gear", "gear"], ["loc", "location"], ["music", "sound"]]) {
  for (const route of keyword === cat || keyword === "sfx" ? ["toolbar", "typed"] : ["typed"]) {
    test(`${route} creates an undoable shared Visual ${keyword} tag`, async t => {
      const { native, peer } = await start(t, route === "typed" ? "" : "  Lamp");
      if (route === "typed") { select(0); type(`${keyword}: Lamp`); await exchange(native, peer); }
      const before = currentDocument().rows[0].visualText;
      const updates = [];
      const stop = native.subscribeLocalUpdates(bytes => updates.push(bytes));
      if (route === "typed") assert.equal(tab(), false, "Tab completes the keyword");
      else toolbar(0, 6, cat);
      stop();
      assert.equal(updates.length, 2);
      for (const update of updates) assert.equal(applyNativePeerUpdate(peer, update), true);
      await tick();
      assert.deepEqual(tags(), [[cat, "Lamp", "Lamp"]]);
      assert.deepEqual(currentDocument().productionTags.map(({ cat, name }) => [cat, name]), [[cat, "Lamp"]]);
      assert.deepEqual(currentDocument(), peer.document());
      const after = currentDocument().rows[0].visualText;
      assert.equal(peer.commands.undo().kind, "unchanged");
      assert.equal(native.commands.undo().kind, "written");
      await exchange(native, peer);
      assert.equal(currentDocument().rows[0].visualText, before);
      assert.deepEqual(currentDocument().productionTags.map(({ cat, name }) => [cat, name]), [[cat, "Lamp"]]);
      assert.equal(native.commands.redo().kind, "written");
      await exchange(native, peer);
      assert.equal(currentDocument().rows[0].visualText, after);
      assert.deepEqual(tags(), [[cat, "Lamp", "Lamp"]]);
    });
  }
}

test("shared toolbar tags can be nested and adjacent", async t => {
  const { native, peer } = await start(t, "red lampcamera");
  toolbar(4, 8, "prop");
  toolbar(0, 8, "vfx");
  toolbar(8, 14, "gear");
  await exchange(native, peer);
  assert.deepEqual(tags(), [["vfx", "red lamp", "red lamp"], ["prop", "lamp", "lamp"], ["gear", "camera", "camera"]]);
  assert.equal(visual().querySelector('[data-tag-cat="prop"]').parentElement.dataset.tagCat, "vfx");
  assert.equal(native.commands.undo().kind, "written");
  await exchange(native, peer);
  assert.equal(native.commands.undo().kind, "written");
  await exchange(native, peer);
  assert.deepEqual(tags(), [["prop", "lamp", "lamp"]]);
  assert.equal(native.commands.redo().kind, "written");
  await exchange(native, peer);
  assert.equal(native.commands.redo().kind, "written");
  await exchange(native, peer);
  assert.equal(tags().length, 3);
});

test("typed shared tags offer the existing name and can keep the typed spelling instead", async t => {
  const { native, peer } = await start(t, "Camera ");
  toolbar(0, 6, "gear");
  select(7);
  type("GEAR: ca");
  const hint = document.getElementById("tag-open-hint");
  assert.equal(hint.dataset.name, "Camera");
  assert.equal(tab(), false);
  await exchange(native, peer);
  assert.deepEqual(tags(), [["gear", "Camera", "Camera"], ["gear", "Camera", "Camera"]]);
  assert.equal(currentDocument().productionTags.length, 1);
  assert.equal(native.commands.undo().kind, "written");
  await exchange(native, peer);
  assert.match(currentDocument().rows[0].visualText, /GEAR: ca$/);
  select(7, 15);
  type("GEAR: ca");
  assert.equal(hint.dataset.name, "Camera");
  assert.equal(keydown("Escape"), false);
  assert.equal(hint.dataset.name, "");
  assert.equal(tab(), false);
  await exchange(native, peer);
  assert.deepEqual(tags(), [["gear", "Camera", "Camera"], ["gear", "ca", "ca"]]);
});

test("a typed keyword can label existing text, and Escape keeps a later draft literal", async t => {
  const { native, peer } = await start(t, "lamp<br>next");
  select(0);
  type("prop:");
  assert.equal(tab(), false);
  await exchange(native, peer);
  assert.deepEqual(tags(), [["prop", "lamp", "lamp"]]);
  select(9);
  type(" prop: work");
  assert.equal(keydown("Escape"), false);
  assert.equal(tab(), true);
  await exchange(native, peer);
  assert.deepEqual(tags(), [["prop", "lamp", "lamp"]]);
  assert.match(currentDocument().rows[0].visualText, /next prop: work$/);
});

test("the toolbar still refuses collapsed and linked selections without a write", async t => {
  const { native, peer } = await start(t, 'red <a href="https://example.com">lamp</a>');
  t.mock.method(notices, "show", () => {});
  const before = native.encodeState();
  for (const [from, to] of [[2, 2], [0, 8]]) {
    select(from, to);
    const wrap = visual().closest(".field-wrap");
    wrap.querySelector('[data-cmd="tag"]').click();
    assert.equal(wrap.querySelector('.tag-toolbar-picker[aria-hidden="false"]'), null);
  }
  assert.deepEqual(notices.show.mock.calls.map(call => call.arguments), [
    ["This is not available in a shared session yet.", "warn"], ["This is not available in a shared session yet.", "warn"]
  ]);
  assert.deepEqual(native.encodeState(), before);
  await exchange(native, peer);
  assert.equal(native.commands.undo().kind, "unchanged");
});

test("another author's tag keeps the Production record after the first author undoes", async t => {
  const { native, peer } = await start(t, "Lamp Lamp");
  toolbar(0, 4, "prop");
  await exchange(native, peer);
  const second = peer.commands.anchorText(target, 5, 9);
  assert.equal(second.kind, "anchored");
  assert.equal(peer.commands.labelVisual(second.range, { cat: "prop", name: "Lamp", words: "Lamp" }).kind, "written");
  await exchange(native, peer);
  assert.equal(tags().length, 2);
  assert.equal(native.commands.undo().kind, "written");
  await exchange(native, peer);
  assert.deepEqual(tags(), [["prop", "Lamp", "Lamp"]]);
  assert.deepEqual(currentDocument().productionTags.map(tag => tag.name), ["Lamp"]);
  assert.equal(peer.commands.undo().kind, "written");
  await exchange(native, peer);
  assert.deepEqual(tags(), []);
  assert.deepEqual(currentDocument().productionTags.map(tag => tag.name), ["Lamp"]);
});

test("reusing a production tag preserves its field history across chip undo and redo", async t => {
  const { native, peer } = await start(t, "Lamp Lamp");
  toolbar(0, 4, "prop");
  await exchange(native, peer);
  const [first] = peer.document().productionTags;
  assert.equal(peer.commands.changeRegistry({ kind: "set", collection: "tags", ids: [first.id],
    fields: { notes: "Bring a spare bulb", status: "have" } }).kind, "written");
  const second = peer.commands.anchorText(target, 5, 9);
  assert.equal(second.kind, "anchored");
  assert.equal(peer.commands.labelVisual(second.range, { cat: "prop", name: "Lamp", words: "Lamp" }).kind, "written");
  await exchange(native, peer);
  assert.equal(native.commands.undo().kind, "written");
  await exchange(native, peer);
  assert.deepEqual(tags(), [["prop", "Lamp", "Lamp"]]);
  assert.deepEqual(currentDocument().productionTags.map(({ name, notes, status }) => [name, notes, status]),
    [["Lamp", "Bring a spare bulb", "have"]]);
  const [survivor] = peer.document().productionTags;
  assert.equal(peer.commands.changeRegistry({ kind: "set", collection: "tags", ids: [survivor.id],
    fields: { notes: "Packed the bulb", status: "returned" } }).kind, "written");
  await exchange(native, peer);
  assert.equal(native.commands.redo().kind, "written");
  await exchange(native, peer);
  assert.deepEqual(currentDocument().productionTags.map(({ name, notes, status }) => [name, notes, status]),
    [["Lamp", "Packed the bulb", "returned"]]);
});

test("undoing chips keeps Production fields, and undoing the field edit restores the prior values", async t => {
  const { native, peer } = await start(t, "Lamp Lamp");
  toolbar(0, 4, "prop");
  await exchange(native, peer);
  const [{ id }] = peer.document().productionTags;
  const set = fields => peer.commands.changeRegistry({ kind: "set", collection: "tags", ids: [id], fields });
  assert.equal(set({ notes: "Bring a bulb", status: "have" }).kind, "written");
  const second = peer.commands.anchorText(target, 5, 9);
  assert.equal(second.kind, "anchored");
  assert.equal(peer.commands.labelVisual(second.range, { cat: "prop", name: "Lamp", words: "Lamp" }).kind, "written");
  await exchange(native, peer);
  assert.equal(native.commands.undo().kind, "written");
  await exchange(native, peer);
  assert.equal(peer.commands.undo().kind, "written");
  await exchange(native, peer);
  assert.deepEqual(tags(), []);
  const fields = () => currentDocument().productionTags.map(tag => [tag.id, tag.notes, tag.status]);
  assert.deepEqual(fields(), [[id, "Bring a bulb", "have"]]);
  assert.equal(peer.commands.undo().kind, "written");
  await exchange(native, peer);
  assert.deepEqual(fields(), [[id, "", "needed"]]);
});

test("a peer field edit stays undoable after another author reuses the tag", async t => {
  const { native, peer } = await start(t, "Lamp Lamp");
  toolbar(0, 4, "prop");
  await exchange(native, peer);
  const [{ id }] = peer.document().productionTags;
  assert.equal(peer.commands.changeRegistry({ kind: "set", collection: "tags", ids: [id],
    fields: { notes: "Bring a bulb", status: "have" } }).kind, "written");
  await exchange(native, peer);
  toolbar(5, 9, "prop");
  await exchange(native, peer);
  assert.equal(peer.commands.undo().kind, "written");
  await exchange(native, peer);
  assert.equal(tags().length, 2);
  assert.deepEqual(currentDocument().productionTags.map(tag => [tag.id, tag.notes, tag.status]), [[id, "", "needed"]]);
});

for (const [notes, reverse] of [["Bulb packed", false], ["Bulb packed", true], ["", false], ["", true]]) {
  test(`a ${notes ? "notes edit survives chip undo and a concurrent label" : "notes clear survives a concurrent label"} (${reverse ? "reverse" : "forward"})`, async t => {
    const { native, peer } = await start(t, "Lamp Lamp");
    toolbar(0, 4, "prop");
    await exchange(native, peer);
    const [{ id }] = native.document().productionTags;
    const set = (session, value) => session.commands.changeRegistry({ kind: "set", collection: "tags", ids: [id], fields: { notes: value } });
    assert.equal(set(peer, "Bring a bulb").kind, "written");
    await exchange(native, peer);
    const third = openNativeSession({ kind: "state", state: native.encodeState() }, { actor: "Third" });
    t.after(() => third.close());
    const second = peer.commands.anchorText(target, 5, 9);
    assert.equal(second.kind, "anchored");
    assert.equal(peer.commands.labelVisual(second.range, { cat: "prop", name: "Lamp", words: "Lamp" }).kind, "written");
    assert.equal(set(third, notes).kind, "written");
    if (notes) assert.equal(native.commands.undo().kind, "written");
    for (const source of reverse ? [third, peer] : [peer, third]) assert.equal(applyNativePeerUpdate(native, source.encodeState()), true);
    await exchange(native, peer);
    assert.equal(applyNativePeerUpdate(third, native.encodeState()), true);
    assert.deepEqual(third.document(), native.document());
    assert.equal(tags().length, notes ? 1 : 2);
    assert.deepEqual(currentDocument().productionTags.map(tag => [tag.id, tag.notes, tag.unmergedEdits]), [[id, notes, undefined]]);
  });
}

test("the tag picker follows its untouched selection when peer typing repaints the cell", async t => {
  const { native, peer } = await start(t, "Lamp on desk");
  select(0, 4);
  visual().closest(".field-wrap").querySelector('[data-cmd="tag"]').click();
  assert.ok(document.querySelector('.tag-toolbar-picker[aria-hidden="false"]'));
  const at = peer.commands.anchorText(target, 12);
  assert.equal(at.kind, "anchored");
  assert.equal(peer.commands.typeText(at.range, "!", {}).kind, "written");
  await exchange(native, peer);
  const picker = visual().closest(".field-wrap").querySelector('.tag-toolbar-picker[aria-hidden="false"]');
  assert.ok(picker, "peer repaint keeps the live picker open");
  picker.querySelector('[data-tag-cat="prop"]').click();
  await exchange(native, peer);
  assert.deepEqual(tags(), [["prop", "Lamp", "Lamp"]]);
  assert.match(currentDocument().rows[0].visualText, /on desk!$/);
  toolbar(8, 12, "gear");
  await exchange(native, peer);
  assert.deepEqual(tags(), [["prop", "Lamp", "Lamp"], ["gear", "desk", "desk"]]);
});

test("the category focused with arrow keys stays focused after peer repaint", async t => {
  const { native, peer } = await start(t, "Lamp on desk");
  select(0, 4);
  visual().closest(".field-wrap").querySelector('[data-cmd="tag"]').click();
  const choices = [...document.activeElement.closest(".tag-toolbar-picker").querySelectorAll(".tag-toolbar-choice")];
  const gearIndex = choices.findIndex(button => button.dataset.tagCat === "gear");
  assert.ok(gearIndex > 0);
  for (let step = 0; step < gearIndex; step++) {
    const moved = document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    assert.equal(moved, false);
  }
  const gear = document.activeElement;
  const at = peer.commands.anchorText(target, 12);
  assert.equal(at.kind, "anchored");
  assert.equal(peer.commands.typeText(at.range, "!", {}).kind, "written");
  await exchange(native, peer);
  assert.notEqual(document.activeElement, gear);
  assert.equal(document.activeElement.dataset.tagCat, "gear");
  document.activeElement.click();
  await exchange(native, peer);
  assert.deepEqual(tags(), [["gear", "Lamp", "Lamp"]]);
});

test("a typed tag and its caret follow peer typing before the keyword", async t => {
  const { native, peer } = await start(t, "Near ");
  select(5);
  type("prop: L");
  await exchange(native, peer);
  const previous = visual();
  const at = peer.commands.anchorText(target, 0);
  assert.equal(at.kind, "anchored");
  assert.equal(peer.commands.typeText(at.range, "Look: ", {}).kind, "written");
  await exchange(native, peer);
  assert.notEqual(visual(), previous);
  assert.equal(document.activeElement, visual());
  assert.deepEqual(cellSelection(visual()), { from: 18, to: 18 });
  type("amp");
  assert.equal(tab(), false);
  await exchange(native, peer);
  assert.deepEqual(tags(), [["prop", "Lamp", "Lamp"]]);
  assert.match(currentDocument().rows[0].visualText, /^Look: Near /);
});

test("an open typed tag offers a production name a peer just added", async t => {
  const { native, peer } = await start(t, "");
  select(0);
  type("gear:");
  await exchange(native, peer);
  assert.equal(peer.commands.changeRegistry({ kind: "create", collection: "tags", fields: { cat: "gear", name: "Camera" } }).kind,
    "written");
  await exchange(native, peer);
  type(" ca");
  assert.equal(document.getElementById("tag-open-hint").dataset.name, "Camera");
  assert.equal(tab(), false);
  await exchange(native, peer);
  assert.deepEqual(tags(), [["gear", "Camera", "Camera"]]);
});

for (const backward of [false, true]) {
  test(`a peer repaint preserves a ${backward ? "backward" : "forward"} draft selection and Tab leaves it literal`, async t => {
    const { native, peer } = await start(t, "Near ");
    select(5);
    type("prop: Lamp");
    await exchange(native, peer);
    const anchor = posToDom(visual(), backward ? 15 : 0), head = posToDom(visual(), backward ? 0 : 15);
    document.getSelection().setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    const at = peer.commands.anchorText(target, 0);
    assert.equal(at.kind, "anchored");
    assert.equal(peer.commands.typeText(at.range, "Look: ", {}).kind, "written");
    await exchange(native, peer);
    assert.equal(document.activeElement, visual());
    const restored = readSelection(visual(), document.getSelection());
    assert.deepEqual([restored?.anchor, restored?.head], backward ? [21, 6] : [6, 21]);
    assert.equal(tab(), true);
    await exchange(native, peer);
    assert.equal(currentDocument().rows[0].visualText, "Look: Near prop: Lamp");
    assert.deepEqual(tags(), []);
  });
}

test("removing the keyword boundary from a peer closes the draft and Tab leaves it literal", async t => {
  const { native, peer } = await start(t, "Near ");
  select(5);
  type("prop: Lamp");
  await exchange(native, peer);
  const space = peer.commands.anchorText(target, 4, 5);
  assert.equal(space.kind, "anchored");
  assert.equal(peer.commands.deleteText(space.range).kind, "written");
  await exchange(native, peer);
  assert.equal(document.getElementById("tag-open-hint").classList.contains("is-visible"), false);
  assert.equal(tab(), true);
  await exchange(native, peer);
  assert.equal(currentDocument().rows[0].visualText, "Nearprop: Lamp");
  assert.deepEqual(tags(), []);
});

test("Tab labels an existing suffix as written even when it matches a longer name", async t => {
  const { native, peer } = await start(t, "Camera ca");
  toolbar(0, 6, "gear");
  select(7);
  type("gear:");
  assert.equal(tab(), false);
  await exchange(native, peer);
  assert.deepEqual(tags(), [["gear", "Camera", "Camera"], ["gear", "ca", "ca"]]);
});

test("a keyword across a formatting boundary stays literal", async t => {
  const { native, peer } = await start(t, "<strong>pr</strong>op");
  select(4);
  type(": lamp");
  assert.equal(tab(), true);
  await exchange(native, peer);
  assert.equal(currentDocument().rows[0].visualText, "<strong>pr</strong>op: lamp");
  assert.deepEqual(tags(), []);
});

for (const change of ["type", "delete"]) {
  test(`shared tag converges with simultaneous peer ${change} and both histories`, async t => {
    const { native, peer } = await start(t, "red lamp");
    const at = change === "type" ? peer.commands.anchorText(target, 5) : peer.commands.anchorText(target, 4, 8);
    assert.equal(at.kind, "anchored");
    const edit = change === "type" ? peer.commands.typeText(at.range, "X", {}) : peer.commands.deleteText(at.range);
    assert.equal(edit.kind, "written");
    toolbar(4, 8, "prop");
    await exchange(native, peer);
    const finalText = change === "type" ? "red lXamp" : "red ";
    const text = () => visual().textContent.replace(/\u200b/g, "").replace(/\u00a0/g, " ");
    assert.equal(text(), finalText);
    assert.deepEqual(currentDocument().productionTags.map(tag => tag.name), ["lamp"]);
    if (change === "delete") assert.deepEqual(tags(), []);
    else assert.equal(visual().querySelector(".tag-anchor").dataset.tagName, "lamp");
    assert.equal(native.commands.undo().kind, "written");
    await exchange(native, peer);
    assert.deepEqual(tags(), []);
    assert.equal(text(), finalText);
    assert.equal(native.commands.redo().kind, "written");
    await exchange(native, peer);
    assert.equal(text(), finalText);
    assert.equal(peer.commands.undo().kind, "written");
    await exchange(native, peer);
    assert.equal(text(), "red lamp");
    if (change === "delete") {
      assert.deepEqual(tags(), []);
      assert.deepEqual(currentDocument().productionTags.map(tag => tag.name), ["lamp"]);
    }
    assert.equal(peer.commands.redo().kind, "written");
    await exchange(native, peer);
    assert.equal(text(), finalText);
  });
}
