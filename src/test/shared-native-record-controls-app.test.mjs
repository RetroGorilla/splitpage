import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedRecoverySession } from "../bootstrap/wiring/session-owner.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { selectedKeys } from "../bootstrap/wiring/production-editing-owners.ts";
import { openProductionPanel, renderProduction } from "../features/tags/panels.ts";
import { openBrollPanel } from "../features/broll/panel.ts";
import { $, ADMISSION_HELD, B1, DRONE, FIRE, M, MUG, REFUSED, SOURCE, adopt, brollBulkNew, brollButton,
  brollOpen, brollSelect, choose, expandedCard, gearOpen, noticeCalls, productionCards, productionPick, tidyStandalone, typeIn } from "./_standalone-records.mjs";

function focused() {
  const active = document.activeElement;
  return { active, value: active && "value" in active ? active.value : null,
    range: active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null };
}

const textBoxes = root => [...document.querySelectorAll(`${root} input[type="text"], ${root} input:not([type]), ${root} textarea`)]
  .map(el => [el.id || el.classList[0], el.getAttribute("data-id") ?? el.getAttribute("data-key") ?? "", el.value]);

const brollState = () => ({
  open: [...document.querySelectorAll('#broll-panel [data-action="broll-person-new"]')].map(el => el.getAttribute("data-id")),
  selected: [...document.querySelectorAll("#broll-panel .broll-row.is-selected")].map(el => el.getAttribute("data-id")),
  menu: [...document.querySelectorAll('#broll-panel [data-action="broll-delete"]')].map(el => el.getAttribute("data-id")),
  boxes: textBoxes("#broll-panel")
});

const tagState = () => ({
  expanded: [...document.querySelectorAll(".tag-entity.is-expanded")].map(el => el.getAttribute("data-key")),
  selected: [...selectedKeys()], boxes: [...textBoxes("#production-panel"), ...textBoxes("#gear-panel")]
});

function brollMenu() { brollOpen("b1"); if (!document.querySelector(`#broll-panel [data-action="broll-delete"]${B1}`)) brollButton("broll-menu", "b1").click(); }

function tagPersonBox(panel, key) { expandedCard(panel, key); $(`${panel} [data-action="tag-person-new"][data-key="${key}"]`).click(); typeIn(`${panel} .tag-person-input[data-key="${key}"]`, "Cy", [1, 2]); }

function brollEditing(action, box, text, range) {
  brollOpen("b1");
  if (!document.querySelector(box)) brollButton(action, "b1").click();
  typeIn(box, text, range);
}

const broll = (name, how, target, setup, kept = how !== "click", refusedValue) => ({ name, how, target, setup, state: brollState, render: openBrollPanel, kept, refusedValue });

const tags = (name, how, target, setup, kept = false, refusedValue) => ({ name, how, target, setup, state: tagState, render: renderProduction, kept, refusedValue });

const LOC = `#broll-panel .broll-loc-input${B1}`, REF = `#broll-panel .broll-ref-input${B1}`;

const HELD_PATHS = [
  broll("the b-roll status button", "click", `#broll-panel .broll-status-btn${B1}`, () => { brollOpen("b1"); }),
  broll("the b-roll reshoot flag", "click", `#broll-panel [data-action="broll-reshoot-toggle"]${B1}`, () => { brollOpen("b1"); }),
  broll("the b-roll bulk Mark filmed", "click", '#broll-panel [data-action="broll-bulk-shot"]', () => { brollSelect("b1"); }),
  broll("the b-roll bulk owner control", "change", "#broll-bulk-owner", () => { brollSelect("b1"); choose("#broll-bulk-owner", "p2"); }),
  broll("the b-roll bulk new person box", "enter", "#broll-bulk-input", () => { brollBulkNew("owner"); typeIn("#broll-bulk-input", "Cy", [1, 2]); }),
  broll("the b-roll bulk new location box", "enter", "#broll-bulk-input", () => { brollBulkNew("location"); typeIn("#broll-bulk-input", "Quay", [1, 3]); }),
  broll("the b-roll delete", "click", `#broll-panel [data-action="broll-delete"]${B1}`, brollMenu),
  broll("the b-roll shot owner control", "change", `#broll-panel .broll-owner-select${B1}`, () => { brollOpen("b1"); choose(`#broll-panel .broll-owner-select${B1}`, "p2"); }, false, "p1"),
  broll("the b-roll shot person box, Enter", "enter", `#broll-panel .broll-person-input${B1}`, () => {
    brollOpen("b1"); brollButton("broll-person-new", "b1").click(); typeIn(`#broll-panel .broll-person-input${B1}`, "Cy", [1, 2]);
  }),
  broll("the b-roll shot person box, Add", "click", `#broll-panel [data-action="broll-person-save"]${B1}`, () => {
    brollOpen("b1"); brollButton("broll-person-new", "b1").click(); typeIn(`#broll-panel .broll-person-input${B1}`, "Cy", [1, 2]);
  }),
  broll("the b-roll add box", "enter", "#broll-add-input", () => { openBrollPanel(); typeIn("#broll-add-input", "Park", [1, 3]); }),
  broll("the b-roll prop remove", "click", `#broll-panel [data-action="broll-prop-remove"]${B1}[data-ref="${M}"]`, () => { brollOpen("b1"); }),
  broll("the b-roll prop box, Enter", "enter", `#broll-panel .broll-prop-input${B1}`, () => { brollOpen("b1"); typeIn(`#broll-panel .broll-prop-input${B1}`, "Lamp", [1, 3]); }),
  broll("the b-roll prop box, a suggestion pick", "pick", `#broll-panel .broll-prop-input${B1}`, () => { brollOpen("b1"); typeIn(`#broll-panel .broll-prop-input${B1}`, "Lamp", [1, 3]); }),
  broll("the b-roll location box, Enter", "enter", LOC, () => { brollEditing("broll-loc-edit", LOC, "Quay", [1, 3]); }),
  broll("the b-roll location box, blur", "blur", LOC, () => { brollEditing("broll-loc-edit", LOC, "Quay", [1, 3]); }),
  broll("the b-roll audio box, blur", "blur", REF, () => { brollEditing("broll-ref-edit", REF, "0:12", [1, 2]); }),
  broll("the b-roll notes box, blur", "blur", `#broll-panel .broll-notes-input${B1}`, () => { brollOpen("b1"); typeIn(`#broll-panel .broll-notes-input${B1}`, "Wide", [1, 2]); }),
  tags("the gear status pill", "click", `#gear-panel [data-action="tag-status-cycle"]${DRONE}`, gearOpen),
  tags("the gear status menu", "click", `#gear-panel [data-action="tag-status-set"]${DRONE}:not(.is-active)`, () => { gearOpen(); expandedCard("#gear-panel", "gear drone"); }),
  tags("the tag owner control", "change", `#production-panel .tag-owner-select${MUG}`, () => {
    productionCards(); expandedCard("#production-panel", "prop mug"); choose(`#production-panel .tag-owner-select${MUG}`, "p2");
  }, false, ""),
  tags("the tag person box, Enter", "enter", `#production-panel .tag-person-input${MUG}`, () => { productionCards(); tagPersonBox("#production-panel", "prop mug"); }),
  tags("the tag person box, Add", "click", `#production-panel [data-action="tag-person-save"]${MUG}`, () => { productionCards(); tagPersonBox("#production-panel", "prop mug"); }),
  tags("the gear tag person box, Enter", "enter", `#gear-panel .tag-person-input${DRONE}`, () => { gearOpen(); tagPersonBox("#gear-panel", "gear drone"); }),
  tags("the tag bulk owner control", "change", "#bulk-owner", () => { productionPick("prop mug"); choose("#bulk-owner", "p2"); }),
  tags("the tag bulk status control", "change", "#bulk-status", () => { productionPick("prop mug"); choose("#bulk-status", $("#bulk-status").options[2].value); }),
  tags("the tag bulk person box, Enter", "enter", "#bulk-person-input", () => {
    productionPick("prop mug"); $('[data-action="bulk-person-new"]').click(); typeIn("#bulk-person-input", "Cy", [1, 2]);
  }),
  tags("the tag bulk person box, Add", "click", '[data-action="bulk-person-save"]', () => {
    productionPick("prop mug"); $('[data-action="bulk-person-new"]').click(); typeIn("#bulk-person-input", "Cy", [1, 2]);
  }),
  tags("the tag bulk delete", "click", '#production-panel [data-action="bulk-delete"]', () => { productionPick("gear drone"); $('#production-panel [data-action="bulk-delete"]').click(); }),
  tags("the gear delete from list", "click", `#gear-panel [data-action="tag-delete"]${DRONE}`, () => {
    gearOpen(); expandedCard("#gear-panel", "gear drone"); $(`#gear-panel [data-action="tag-delete"]${DRONE}`).click();
  }),
  tags("the person remove", "click", '#production-panel [data-action="person-delete"][data-person="p2"]', () => {
    openProductionPanel(); $('#production-modes [data-group="person"]').click(); $('#production-panel [data-action="person-delete"][data-person="p2"]').click();
  }),
  tags("the gear quick add", "click", "#gear-quickadd-save", () => { gearOpen(); typeIn("#gear-quickadd-input", "Drone\nCrane", [0, 5]); }, true),

];

for (const path of HELD_PATHS) for (const order of ["forward", "reverse"]) {
  test(path.name + " keeps its editing context when held, " + order, async () => {
    adopt(SOURCE);
    const hook = window.__sharedTest;
    assert.deepEqual(await hook.enter(), { ok: true });
    const session = sharedRecoverySession();
    let release = () => {};
    try {
      path.setup();
      const target = $(path.target);
      if (path.how === "click") target.focus();
      const view = focused(), state = path.state();
      hook.nativePeer.hold("updates");
      assert.equal(hook.nativePeer.type("r2", 0, "Z").kind, "written");
      assert.equal(hook.nativePeer.type("r2", 6, "!").kind, "written");
      release = session.hold(ADMISSION_HELD);
      const before = [session.generation(), hook.read(), undoOwner().sizes(), hook.nativePeer.queuedUpdates()];
      noticeCalls.length = 0;
      FIRE[path.how](target);
      await Promise.resolve();
      assert.deepEqual(noticeCalls, [[REFUSED, "warn"]]);
      assert.deepEqual([session.generation(), hook.read(), undoOwner().sizes(), hook.nativePeer.queuedUpdates()], before);
      const now = focused();
      assert.equal(now.active, view.active);
      assert.deepEqual([now.value, now.range], [path.refusedValue ?? view.value, view.range]);
      assert.deepEqual(path.state(), state);
      path.render();
      const shown = s => path.kept || !s.boxes ? s : { ...s, boxes: s.boxes.map(box => box.slice(0, 2)) };
      assert.deepEqual(shown(path.state()), shown(state));
      release();
      assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
      assert.deepEqual(hook.nativePeer.release(order).map(packet => packet.to), ["app", "app"]);
      await Promise.resolve();
      const { app, peer } = hook.read();
      assert.equal(app.rows[1].audioText, "ZOther!");
      assert.deepEqual(app, peer);
      assert.deepEqual(hook.nativePeer.freshSnapshot("app"), app);
      assert.deepEqual(noticeCalls, [[REFUSED, "warn"]]);
    } finally {
      release();
      tidyStandalone();
      assert.deepEqual(hook.leave(), { ok: true });
    }
  });
}
