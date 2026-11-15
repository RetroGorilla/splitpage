import { test } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sidePanels } from "../bootstrap/wiring/ports/panels.ts";
import { clearProductionSelection } from "../bootstrap/wiring/production-editing-owners.ts";
import { closeBrollPage, openBrollPage, openBrollPanel, runBrollRefresh } from "../features/broll/panel.ts";
import { openGearPanel, renderProduction } from "../features/tags/panels.ts";
import { closeCommentComposer, openCommentComposer, openCommentsPanel, postReply, renderComments, toggleReplyComposer } from "../features/comments/comments.ts";
import { $, ADMISSION_HELD, REFUSED, SOURCE, adopt, brollBulkNew, brollButton, brollOpen, enter, expandedCard, noticeCalls, press,
  productionCards, productionPick, tidy } from "./_shared-split-records.mjs";

const ESCAPE_SOURCE = { ...SOURCE,
  rows: [...SOURCE.rows, { id: "r3", audioText: "Three", visualText: '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> Pier', status: "todo" }],
  brollShots: [...SOURCE.brollShots, { id: "bs1", name: "Pier", status: "unshot", origin: "script" }]
};
const shot = () => currentDocument().brollShots.find(s => s.id === "b1");
const tag = () => currentDocument().productionTags.find(t => t.name === "Mug");
const people = () => currentDocument().people.map(p => p.name);
const commentIds = () => currentDocument().comments.map(c => c.id);
const replies = () => currentDocument().comments[0].replies;
const gear = () => currentDocument().productionTags.filter(t => t.cat === "gear").map(t => t.name).sort();
const B1 = '[data-id="b1"]', MUG = '[data-key="prop mug"]';
const notes = '#broll-panel .broll-notes-input' + B1;
const input = (box, text) => {
  box.focus();
  if (box.matches("input, textarea")) box.value = text; else box.innerHTML = text;
  box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
};
const visible = box => !!box && !box.closest("[hidden]");
const value = box => box.matches("input, textarea") ? box.value : box.textContent;
const retained = text => [...document.querySelectorAll('#broll-panel input, #broll-panel textarea, #broll-page textarea, #production-panel input, #production-panel textarea, #gear-panel input, #gear-panel textarea, #comment-modal .cell-editable, #comments-panel .cell-editable, #comments-list .typed-unsaved-text')]
  .some(box => visible(box) && value(box) === text);
const stripValues = () => [...document.querySelectorAll(".typed-unsaved-text")].filter(visible).map(box => box.value);
function brollField(action, selector) { brollOpen("b1"); brollButton(action, "b1").click(); return $(selector); }
function tagEditor(action, selector) { productionCards(); expandedCard("#production-panel", "prop mug"); $('#production-panel [data-action="' + action + '"]' + MUG).click(); return $(selector); }
const ROWS = [
  { name: "b-roll notes", selector: notes, text: "Wide", saving: true, prepare: () => { brollOpen("b1"); }, stored: () => shot().notes, redraw: runBrollRefresh },
  { name: "b-roll page notes", selector: '#broll-page .broll-page-note' + B1, text: "Wide", saving: true,
    prepare: () => { brollOpen("b1"); openBrollPage(); }, stored: () => shot().notes, redraw: runBrollRefresh },
  { name: "b-roll location", selector: '.broll-loc-input' + B1, text: "Dock", saving: true,
    prepare: () => { brollField("broll-loc-edit", '.broll-loc-input' + B1); }, stored: () => shot().location, redraw: runBrollRefresh },
  { name: "b-roll audio reference", selector: '.broll-ref-input' + B1, text: "0:12", saving: true,
    prepare: () => { brollField("broll-ref-edit", '.broll-ref-input' + B1); }, stored: () => shot().audioRef, redraw: runBrollRefresh },
  { name: "b-roll rename", selector: '.broll-rename-input[data-id="bs1"]', text: "Jetty", cancel: true, prior: box => { press(box, "Enter"); },
    prepare: () => { brollOpen("bs1"); brollButton("broll-menu", "bs1").click(); brollButton("broll-rename", "bs1").click(); },
    stored: () => currentDocument().brollShots.find(s => s.id === "bs1").name, redraw: runBrollRefresh },
  { name: "b-roll person", selector: '.broll-person-input' + B1, text: "Cy", cancel: true, prior: box => { press(box, "Enter"); },
    prepare: () => { brollField("broll-person-new", '.broll-person-input' + B1); }, stored: people, redraw: runBrollRefresh },
  { name: "b-roll prop", selector: '.broll-prop-input' + B1, text: "Lamp", cancel: true, prior: box => { press(box, "Enter"); },
    prepare: () => { brollOpen("b1"); }, stored: () => shot().props, redraw: runBrollRefresh },
  { name: "b-roll bulk person", selector: "#broll-bulk-input", text: "Cy", cancel: true, prior: box => { press(box, "Enter"); },
    prepare: () => { brollBulkNew("owner"); }, stored: people, redraw: runBrollRefresh },
  { name: "b-roll bulk location", selector: "#broll-bulk-input", text: "Dock", cancel: true, prior: box => { press(box, "Enter"); },
    prepare: () => { brollBulkNew("location"); }, stored: () => shot().location, redraw: runBrollRefresh },
  { name: "b-roll add", selector: "#broll-add-input", text: "Park", keep: true, prior: box => { press(box, "Enter"); },
    prepare: openBrollPanel, stored: () => currentDocument().brollShots.map(s => s.name), redraw: runBrollRefresh },
  { name: "tag notes", selector: '.tag-notes-input' + MUG, text: "Red one", keep: true,
    prepare: () => { productionCards(); expandedCard("#production-panel", "prop mug"); }, stored: () => tag().notes, redraw: renderProduction },
  { name: "tag rename", selector: '.tag-rename-input' + MUG, text: "Cup", cancel: true, prior: box => { press(box, "Enter"); },
    prepare: () => { tagEditor("tag-rename", '.tag-rename-input' + MUG); }, stored: () => tag().name, redraw: renderProduction },
  { name: "tag person", selector: '.tag-person-input' + MUG, text: "Cy", cancel: true, prior: box => { press(box, "Enter"); },
    prepare: () => { tagEditor("tag-person-new", '.tag-person-input' + MUG); }, stored: people, redraw: renderProduction },
  { name: "tag bulk person", selector: "#bulk-person-input", text: "Cy", cancel: true, prior: box => { press(box, "Enter"); },
    prepare: () => { productionPick("prop mug"); $('[data-action="bulk-person-new"]').click(); }, stored: people, redraw: renderProduction },
  { name: "Gear quick add", selector: "#gear-quickadd-input", text: "Drone\nWireless lav", keep: true, prior: () => { $("#gear-quickadd-save").click(); },
    prepare: openGearPanel, stored: gear, redraw: renderProduction },
  { name: "comment composer", selector: "#comment-body-editable", text: "First", cancelCommand: true,
    prepare: () => { openCommentsPanel(); openCommentComposer({ id: "C9", rowId: "r1", field: "visualText", quotedText: "yz" }); $("#comment-name").value = "Alice"; },
    stored: commentIds, redraw: renderComments },
  { name: "reply composer", selector: '.reply-composer[data-for="C1"] .cell-editable', text: "First", keep: true, prior: () => { postReply("C1"); },
    prepare: () => { openCommentsPanel(); if (!document.querySelector('.reply-composer[data-for="C1"]')) toggleReplyComposer("C1"); $('.reply-composer[data-for="C1"] .reply-name-input').value = "Alice"; },
    stored: replies, redraw: renderComments, reopen: openCommentsPanel }
];

async function run(row, mode, standalone) {
  closeCommentComposer(); closeBrollPage(() => {}); sidePanels().closeAll(); clearProductionSelection();
  const shared = mode !== "standalone";
  const f = shared ? await enter(ESCAPE_SOURCE) : (adopt(ESCAPE_SOURCE), { close: () => {} });
  let release = () => {};
  try {
    row.prepare();
    if (mode === "held") release = f.parts.session.hold(ADMISSION_HELD);
    if (mode === "refused") release = f.parts.session.beforeCommand(() => { notices.show(REFUSED, "warn"); return "announced"; });
    input($(row.selector), row.text);
    const blocked = mode === "held" || mode === "refused";
    if (blocked && row.prior) row.prior($(row.selector));
    const before = structuredClone(row.stored()), warned = () => noticeCalls.filter(call => call[1] === "warn");
    const warningsBefore = warned().length;
    press($(row.selector), "Escape");
    const box = document.querySelector(row.selector);
    const result = { stored: structuredClone(row.stored()), showing: visible(box), text: visible(box) ? value(box) : null };
    if (!shared) return result;
    assert.equal(warned().length - warningsBefore, blocked && (row.saving || row.cancelCommand) ? 1 : 0, row.name + " " + mode + ": one notice for an Escape submit, none for a cancel");
    if (!blocked) assert.deepEqual(result, standalone, row.name + ": allowed Escape matches standalone");
    if (blocked) assert.deepEqual(row.stored(), before, row.name + ": held/refused Escape writes no field");
    if (row.cancel) {
      assert.equal(visible(box), false, row.name + ": cancel closes its editor");
      assert.equal(stripValues().includes(row.text), false, row.name + ": cancellation keeps no strip entry");
    }
    const afterEscape = structuredClone(row.stored()), noticesAfter = warned().length;
    release(); row.redraw(); row.reopen?.();
    assert.deepEqual(row.stored(), afterEscape, row.name + ": release and redraw never save");
    assert.equal(warned().length, noticesAfter, row.name + ": redraw adds no notice");
    if (row.keep || blocked && (row.saving || row.cancelCommand)) assert.equal(retained(row.text), true, row.name + ": uncancelled text survives Escape and redraw");
    if (row.cancel) assert.equal(stripValues().includes(row.text), false, row.name + ": a cancelled draft does not return");
    return result;
  } finally { release(); closeBrollPage(() => {}); tidy(f); sidePanels().closeAll(); }
}

for (const row of ROWS) test("Escape: " + row.name + " follows standalone when allowed, held and refused", async () => {
  const standalone = await run(row, "standalone");
  for (const mode of ["allowed", "held", "refused"]) await run(row, mode, standalone);
});
