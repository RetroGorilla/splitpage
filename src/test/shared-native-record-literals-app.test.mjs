import { test } from "node:test";
import assert from "node:assert/strict";
import { currentBrollRecords } from "../bootstrap/wiring/broll.ts";
import { clearProductionSelection, selectedKeys } from "../bootstrap/wiring/production-editing-owners.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { openBrollPanel } from "../features/broll/panel.ts";
import { findOrAddPerson, registerProductionTag } from "../features/tags/production-tags.ts";
import { addPersonForTag, applyGearQuickAdd, armDeleteTag, armPersonDelete, bulkDeleteSelected, openGearPanel, openProductionPanel,
  setTagOwner, setTagStatus, toggleCardSelection } from "../features/tags/panels.ts";
import { tagKey } from "../core/document/tags.ts";
import { $, B1, FIRE, M, MUG, SOURCE, adopt, brollButton, brollOpen, brollSelect, clearWarnings, expandedCard, press,
  productionCards, shape, tidyStandalone, twice, typeIn, warnings } from "./_standalone-records.mjs";

function tagPersonBox(panel, key) {
  expandedCard(panel, key);
  $(panel + ' [data-action="tag-person-new"][data-key="' + key + '"]').click();
  typeIn(panel + ' .tag-person-input[data-key="' + key + '"]', "Cy", [1, 2]);
}

const withZ = s => ({ ...s, rows: s.rows.map(r => r[0] === "r2" ? [r[0], "Z" + r[1], ...r.slice(2)] : r) });

const edit = (s, change) => { const next = structuredClone(s); change(next); return next; };

const selectOnly = key => { openProductionPanel(); clearProductionSelection(); toggleCardSelection(key); assert.deepEqual(selectedKeys(), [key]); };

const served = [
  { name: "registering a production tag", tagOnly: true, retainedTag: ["location", "Park", "", "needed"],
    act: () => { assert.equal(registerProductionTag("location", "Park"), true); },
    after: s => edit(s, n => { n.tags.push(["location", "Park", "", "needed"]); }) },
  { name: "finding or adding a person", act: () => { assert.notEqual(findOrAddPerson("Cy"), ""); },
    after: s => edit(s, n => { n.people.push("Cy"); }) },
  { name: "adding a prop to a shot", retainedTag: ["prop", "Lamp", "", "needed"],
    act: () => { assert.deepEqual(currentBrollRecords()?.addBrollProp("b1", "Lamp"), { changed: true, held: false }); },
    after: s => edit(s, n => { n.tags.push(["prop", "Lamp", "", "needed"]); n.shots[0][4].push("Lamp"); }) },
  { name: "the b-roll status toggle", act: () => { openBrollPanel(); brollButton("broll-status-toggle", "b1").click(); },
    after: s => edit(s, n => { n.shots[0][1] = "shot"; }) },
  { name: "the b-roll bulk Mark filmed", act: () => {
    brollSelect("b1");
    const bulk = document.querySelector('#broll-panel [data-action="broll-bulk-shot"]'); assert.ok(bulk); bulk.click();
  }, after: s => edit(s, n => { n.shots[0][1] = "shot"; }) },
  { name: "the b-roll bulk assign to a new person", act: () => {
    brollSelect("b1");
    const owner = document.getElementById("broll-bulk-owner"); assert.ok(owner);
    owner.value = "__new__"; owner.dispatchEvent(new window.Event("change", { bubbles: true }));
    const box = document.getElementById("broll-bulk-input"); assert.ok(box); box.value = "Cy";
    const save = document.querySelector('#broll-panel [data-action="broll-bulk-input-save"]'); assert.ok(save); save.click();
    assert.equal(document.getElementById("broll-bulk-input"), null, "the bulk box closes");
  }, after: s => edit(s, n => { n.people.push("Cy"); n.shots[0][2] = "Cy"; }) },
  { name: "the b-roll prop box", retainedTag: ["prop", "Lamp", "", "needed"], act: () => {
    brollOpen("b1"); typeIn(`#broll-panel .broll-prop-input${B1}`, "Lamp", [4, 4]); FIRE.enter($(`#broll-panel .broll-prop-input${B1}`));
    const box = $(`#broll-panel .broll-prop-input${B1}`); assert.equal(box.value, "", "the prop box empties"); assert.equal(document.activeElement, box);
    box.blur();
  }, after: s => edit(s, n => { n.tags.push(["prop", "Lamp", "", "needed"]); n.shots[0][4].push("Lamp"); }) },
  { name: "the tag person box", act: () => {
    productionCards(); tagPersonBox("#production-panel", "prop mug"); FIRE.enter($(`#production-panel .tag-person-input${MUG}`));
    assert.equal(document.querySelector(`#production-panel .tag-person-input${MUG}`), null, "the person box closes");
    assert.equal(document.activeElement, $(`#production-panel [data-action="tag-person-new"]${MUG}`));
  }, after: s => edit(s, n => { n.people.push("Cy"); n.tags[1][2] = "Cy"; }) },
  { name: "the b-roll delete", act: () => {
    brollOpen("b1");
    if (!document.querySelector('#broll-panel [data-action="broll-delete"][data-id="b1"]')) brollButton("broll-menu", "b1").click();
    brollButton("broll-delete", "b1").click();
  }, after: s => edit(s, n => { n.shots = []; }) },
  { name: "the b-roll new person for a shot", act: () => {
    brollOpen("b1"); brollButton("broll-person-new", "b1").click();
    const box = document.querySelector('#broll-panel .broll-person-input[data-id="b1"]'); assert.ok(box); box.value = "Cy";
    brollButton("broll-person-save", "b1").click();
  }, after: s => edit(s, n => { n.people.push("Cy"); n.shots[0][2] = "Cy"; }) },
  { name: "adding a shot from the b-roll panel", act: () => {
    openBrollPanel();
    const box = document.getElementById("broll-add-input"); assert.ok(box); box.value = "Park";
    press(box, "Enter");
  }, after: s => edit(s, n => { n.shots.push(["Park", "unshot", "", false, []]); }) },
  { name: "removing a prop from a shot", act: () => { brollOpen("b1"); brollButton("broll-prop-remove", "b1", `[data-ref="${M}"]`).click(); },
    after: s => edit(s, n => { n.shots[0][4] = []; }) },
  { name: "the gear quick add", tagOnly: true, retainedTag: ["gear", "Crane", "", "needed"], act: () => {
    openGearPanel();
    const box = $("#gear-quickadd-input");
    box.value = "Drone\nCrane";
    applyGearQuickAdd();
  }, after: s => edit(s, n => { n.tags.push(["gear", "Crane", "", "needed"]); }) },
  { name: "advancing a tag's status", act: () => { openProductionPanel(); setTagStatus(tagKey("gear", "Drone"), null); },
    after: s => edit(s, n => { n.tags[0][3] = "sourcing"; }) },
  { name: "deleting a tag from its card", act: () => { openProductionPanel(); twice(armDeleteTag, tagKey("gear", "Drone")); },
    after: s => edit(s, n => { n.tags.shift(); }) },
  { name: "bulk deleting selected tags", act: () => {
    selectOnly(tagKey("gear", "Drone")); bulkDeleteSelected();
  }, after: s => edit(s, n => { n.tags.shift(); }) },
  { name: "assigning a tag's owner", act: () => { openProductionPanel(); setTagOwner(tagKey("prop", "Mug"), "p2"); },
    after: s => edit(s, n => { n.tags[1][2] = "Bob"; }) },
  { name: "creating a person while assigning a tag (one undo step removes both)", act: () => { openProductionPanel(); addPersonForTag(tagKey("prop", "Mug"), "Cy"); },
    after: s => edit(s, n => { n.people.push("Cy"); n.tags[1][2] = "Cy"; }) },
  { name: "adding a person from the production panel", act: () => { openProductionPanel(); addPersonForTag(null, "Cy"); },
    after: s => edit(s, n => { n.people.push("Cy"); }) },
  { name: "deleting a person", act: () => { openProductionPanel(); twice(armPersonDelete, "p2"); },
    after: s => edit(s, n => { n.people = ["Ann"]; }) },

];

for (const literal of served) for (const order of ["forward", "reverse"]) {
  test("Native record caller: " + literal.name + ", " + order, async () => {
    clearWarnings();
    adopt(SOURCE);
    const hook = window.__sharedTest;
    assert.deepEqual(await hook.enter(), { ok: true });
    try {
      const { app } = hook.read();
      const start = shape(app), standalone = undoOwner().sizes();
      hook.nativePeer.hold("updates");
      assert.equal(hook.nativePeer.type("r2", 0, "Z").kind, "written");
      literal.act();
      hook.nativePeer.release(order);
      await Promise.resolve();
      let copies = hook.read();
      assert.deepEqual(shape(copies.app), withZ(literal.after(start)));
      assert.deepEqual(copies.app, copies.peer);
      assert.deepEqual(hook.nativePeer.freshSnapshot("app"), copies.app);
      assert.deepEqual(warnings(), []);
      assert.deepEqual(undoOwner().sizes(), standalone);
      assert.equal(hook.nativePeer.step("undo").kind, literal.tagOnly ? "unchanged" : "written");
      await Promise.resolve();
      copies = hook.read();
      const undone = withZ(start);
      if (literal.retainedTag) undone.tags.push(literal.retainedTag);
      assert.deepEqual(shape(copies.app), undone);
      assert.deepEqual(copies.app, copies.peer);
      assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
      assert.deepEqual(warnings(), []);
    } finally {
      tidyStandalone();
      assert.deepEqual(hook.leave(), { ok: true });
    }
  });
}
