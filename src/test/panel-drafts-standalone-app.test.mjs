import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { clearProductionSelection } from "../bootstrap/wiring/production-editing-owners.ts";
import { openProductionPanel, renderProduction } from "../features/tags/panels.ts";
import { openBrollPanel, runBrollRefresh } from "../features/broll/panel.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const tag = name => '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="' + name + '" contenteditable="false">' + name + "</span>";
const script = (title, shot) => ({ schema: 2, title, paragraphsDecided: true,
  rows: [
    { id: "r1", audioText: "One", visualText: "A " + tag("Mug"), status: "todo" },
    { id: "r2", audioText: "Two", visualText: "B " + tag("Mug"), status: "todo" },
    { id: "r3", audioText: "Three", visualText: "C " + tag("Lamp"), status: "todo" }
  ],
  sections: [{ id: "H1", name: "Open", firstSceneId: "r1" }, { id: "H2", name: "Close", firstSceneId: "r2" }],
  people: [{ id: "p1", name: "Ann" }],
  productionTags: [{ id: "t_mug", cat: "prop", name: "Mug", owner: "", notes: "", status: "needed" },
    { id: "t_lamp", cat: "prop", name: "Lamp", owner: "", notes: "", status: "needed" }],
  brollShots: [{ id: "b1", name: shot, desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "", location: "", props: [], origin: "list" }]
});

const $ = selector => { const el = document.querySelector(selector); assert.ok(el, selector); return el; };
const typeIn = (el, text) => { el.focus(); el.value = text; el.setSelectionRange(text.length, text.length); };
const press = (el, key) => { el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); };
const MUG = '[data-key="prop mug"]', LAMP_STATUS = '#production-panel [data-action="tag-status-cycle"][data-key="prop lamp"]';
const scene = index => `#production-panel [data-scene-group=":scene:${index}"]`;
const place = el => [el.classList[0] ?? el.id, el.getAttribute("data-key") ?? el.getAttribute("data-id") ?? "",
  el.closest("[data-scene-group]")?.getAttribute("data-scene-group") ?? ""];
const drafts = () => [...document.querySelectorAll("#production-panel input[type=text], #production-panel textarea, #broll-panel input[type=text], #broll-panel textarea")]
  .filter(el => el.value !== "" && !el.closest("[hidden]")).map(el => [...place(el), el.value]);
const focusAt = () => { const active = document.activeElement; return !active || active === document.body ? "body" : place(active); };

function open(title = "Script A", shot = "City") {
  writerControls().closeWriter();
  clearProductionSelection();
  adoptReplacement(migrateRows(script(title, shot)));
}
function mode(group) { openProductionPanel(); $(`#production-modes [data-group="${group}"]`).click(); }
function expand(scope, key) {
  if (!document.querySelector(`${scope} .tag-entity.is-expanded[data-key="${key}"]`)) $(`${scope} [data-action="tag-expand"][data-key="${key}"]`).click();
}
function personBox(scope) { expand(scope, "prop mug"); $(`${scope} [data-action="tag-person-new"]${MUG}`).click(); return $(`${scope} .tag-person-input${MUG}`); }
function renameBox(scope) { $(`${scope} [data-action="tag-rename"]${MUG}`).click(); return $(`${scope} .tag-rename-input${MUG}`); }
function brollOpen() {
  openBrollPanel();
  if (!document.querySelector('#broll-panel [data-action="broll-person-new"][data-id="b1"]')) $('#broll-panel [data-action="broll-expand"][data-id="b1"]').click();
}
const otherStatus = () => { $(LAMP_STATUS).click(); };
function tidy() {
  for (const box of document.querySelectorAll(".tag-rename-input")) press(box, "Escape");
  document.activeElement?.blur?.();
  clearProductionSelection();
}

const ROWS = [
  { name: "a tag person box, then another tag's status", arrange: () => { mode("cat"); typeIn(personBox("#production-panel"), "Cy"); }, redraw: otherStatus,
    drafts: [], focus: ["tag-status-pill", "prop lamp", ""] },
  { name: "a tag rename box, then another tag's status", arrange: () => { mode("cat"); typeIn(renameBox("#production-panel"), "Cup"); }, redraw: otherStatus,
    drafts: [["tag-rename-input", "prop mug", "", "Mug"]], focus: ["tag-status-pill", "prop lamp", ""] },
  { name: "the bulk person box, then a redraw", arrange: () => {
    mode("cat");
    $(`#production-panel .tag-entity${MUG} .tag-entity-row`).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    $('[data-action="bulk-person-new"]').click(); typeIn($("#bulk-person-input"), "Cy");
  }, redraw: renderProduction, drafts: [], focus: "body" },
  { name: "a tag rename box in By scene, then another tag's status", arrange: () => { mode("by-scene"); typeIn(renameBox(scene(0)), "Cup"); }, redraw: otherStatus,
    drafts: [["tag-rename-input", "prop mug", ":scene:0", "Mug"], ["tag-rename-input", "prop mug", ":scene:1", "Mug"]], focus: ["tag-status-pill", "prop lamp", ":scene:1"] },
  { name: "two person boxes for one tag in By scene, then another tag's status", arrange: () => {
    mode("by-scene"); typeIn(personBox(scene(0)), "Alice"); typeIn(personBox(scene(1)), "Bob");
  }, redraw: otherStatus, drafts: [], focus: ["tag-status-pill", "prop lamp", ":scene:1"] },
  { name: "a b-roll prop box left without Enter, then a redraw", arrange: () => { brollOpen(); typeIn($('#broll-panel .broll-prop-input[data-id="b1"]'), "Lamp"); document.activeElement.blur(); },
    redraw: runBrollRefresh, drafts: [], focus: "body" },
  { name: "the focused b-roll notes box, then a redraw", arrange: () => { brollOpen(); typeIn($('#broll-panel .broll-notes-input[data-id="b1"]'), "Wide"); },
    redraw: runBrollRefresh, drafts: [["broll-notes-input", "b1", "", "Wide"]], focus: ["broll-notes-input", "b1", ""], notes: "Wide" }
];

for (const row of ROWS) test(`standalone panel drafts as on main: ${row.name}`, () => {
  open();
  try {
    row.arrange();
    row.redraw();
    assert.deepEqual([drafts(), focusAt()], [row.drafts, row.focus]);
    assert.equal(currentDocument().brollShots[0].notes, row.notes ?? "", "the shot's stored notes");
  } finally { tidy(); }
});

test("standalone panel drafts as on main: a b-roll prop draft in script A does not reach script B's shot with the same id", () => {
  open("Script A", "City");
  try {
    brollOpen();
    typeIn($('#broll-panel .broll-prop-input[data-id="b1"]'), "Old script prop");
    document.activeElement.blur();
    open("Script B", "Harbour");
    brollOpen();
    const box = $('#broll-panel .broll-prop-input[data-id="b1"]');
    assert.equal(box.value, "");
    box.focus(); press(box, "Enter");
    assert.deepEqual(currentDocument().brollShots[0].props, []);
  } finally { tidy(); }
});
