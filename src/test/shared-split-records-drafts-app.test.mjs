import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sharedSplitBindings } from "../bootstrap/wiring/shared-split.ts";
import { adoptReplacement, currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveSharedSession, sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { openingStatus } from "../bootstrap/wiring/ports/transitions.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { sharedRecordCommands } from "../bootstrap/wiring/ports/shared-commands.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { fromHtml } from "../bootstrap/richtext.ts";
import { closeBrollPage, openBrollPage, openBrollPanel, runBrollRefresh } from "../features/broll/panel.ts";
import { armDeleteComment, closeCommentComposer, openCommentComposer, openCommentsPanel, postComment, postReply, renderComments, setCommentFilterMode, toggleReplyComposer } from "../features/comments/comments.ts";
import { applyGearQuickAdd, openGearPanel, openProductionPanel, renderProduction, toggleCardSelection } from "../features/tags/panels.ts";
import { sidePanels } from "../bootstrap/wiring/ports/panels.ts";
import { createSharedDocument, destroySharedDocument, applySharedUpdate, encodeSharedState } from "../adapters/collab/document.ts";
import { projectSharedDocument } from "../adapters/collab/project.ts";
import { registerSharedOperationFamilies } from "../adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../adapters/collab/execute.ts";
import { readOperation } from "../core/collab/read-operation.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const noticeCalls = [], actualShow = notices.show, errors = [];
notices.show = (...args) => { noticeCalls.push(args); return actualShow(...args); };
after(() => { notices.show = actualShow; });
const warned = () => noticeCalls.filter(call => call[1] === "warn");
const allowed = { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) };
let serial = 0, peerSerial = 0;
const ports = {
  opening: openingStatus,
  refusal: () => null, commandRefused: sharedCommandRefusalNotice(notices), settle: () => { undoOwner().flush(); }, detach: () => {},
  bindings: sharedSplitBindings({ report: () => {}, missingBase: () => {}, recovered: () => {} }),
  common: allowed, standalone: createSessionCapabilities("standalone", allowed), migrate: migrateRows,
  docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Alice", structure: { cells: html => fromHtml(html) },
  report: error => { errors.push(error); }, timers: { now: Date.now, start: (run, ms) => setTimeout(run, ms), stop: clearTimeout }, now: Date.now
};
const ORDERS = ["local-first", "remote-first"];
const REFUSED = "This is not available in a shared session yet.";
const ADMISSION_HELD = "held-for-test";
const SOURCE = { schema: 2, title: "Shared drafts", paragraphsDecided: true, wordsPerMinute: 150,
  rows: [
    { id: "r1", audioText: "One", visualText: '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> Pier', status: "todo" },
    { id: "r2", audioText: "Two", visualText: "Plain", status: "todo" }
  ],
  comments: [{ id: "C1", author: "Ann", createdAt: "2026-11-13T10:00:00.000Z", rowId: "r2", field: "audioText", anchorId: "C1", body: "note",
    quotedText: "Two", resolved: false, resolvedAt: null, resolvedBy: null, replies: [] }],
  people: [{ id: "p1", name: "Ann" }],
  productionTags: [
    { id: "T1", cat: "prop", name: "Mug", owner: "", notes: "", status: "needed" },
    { id: "T3", cat: "prop", name: "Lamp", owner: "", notes: "", status: "needed" }
  ],
  brollShots: [
    { id: "b1", name: "City", desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "", location: "", props: [], origin: "list" },
    { id: "b2", name: "Harbour", desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "", location: "", props: [], origin: "list" },
    { id: "bs1", name: "Pier", status: "unshot", origin: "script" }
  ]
};

async function enter() {
  errors.length = 0; noticeCalls.length = 0;
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(SOURCE)));
  assert.deepEqual(await enterSharedSession(ports), { ok: true }, errors.map(error => error.stack).join("\n"));
  const parts = sharedSessionParts(); assert.ok(parts);
  const peer = createSharedDocument(); registerSharedOperationFamilies(peer, { cells: html => fromHtml(html) });
  assert.equal(applySharedUpdate(peer, encodeSharedState(parts.handle)).ok, true);
  return { parts, peer, close: () => { destroySharedDocument(peer); assert.deepEqual(leaveSharedSession(ports), { ok: true }); } };
}
function exchange(f, order) {
  const toPeer = () => { assert.equal(applySharedUpdate(f.peer, encodeSharedState(f.parts.handle)).ok, true); };
  const toLocal = () => { assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true); };
  if (order === "local-first") { toPeer(); toLocal(); } else { toLocal(); toPeer(); }
}
function peerWrite(f, order, operation) {
  const op = readOperation({ id: "bob_draft_" + ++peerSerial, by: "Bob", ...operation });
  assert.ok(op, JSON.stringify(operation));
  assert.deepEqual(executeSharedOperations(f.peer, [op]), { ok: true });
  exchange(f, order);
}
const peerStatus = (status, record = "b1") => (f, order) => {
  const parents = [...sharedRecordCommands.ports().heads("shot", record)];
  peerWrite(f, order, { kind: "status", parents, target: { scope: "shot", record }, value: status });
};
const $ = selector => { const el = document.querySelector(selector); assert.ok(el, selector); return el; };
function press(target, key) {
  const handled = !target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  target.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true }));
  return handled;
}
const blurOut = el => { el.focus(); el.blur(); };
const filter = id => { const tab = document.querySelector(`#broll-panel [data-action="broll-filter"][data-filter="${id}"]`); if (tab) tab.click(); };
function brollOpen(id) {
  openBrollPanel();
  if (!document.querySelector(`#broll-panel .broll-notes-input[data-id="${id}"]`)) $(`#broll-panel [data-action="broll-expand"][data-id="${id}"]`).click();
}
const NOTES = '#broll-panel .broll-notes-input[data-id="b1"]';
const notesBox = () => document.querySelector(NOTES);
const shot = id => currentDocument().brollShots.find(s => s.id === id);
const undoCount = f => f.parts.undo.sizes().undo;
const brollHook = () => window.__brollTest;
function tidy(f) {
  closeCommentComposer();
  filter("all");
  f.close();
  document.activeElement?.blur?.();
}

const REDRAWS = [
  { name: "its own filter change hides the shot", hide: () => { filter("shot"); }, show: () => { filter("all"); } },
  { name: "a peer's status change hides the shot", setup: () => { filter("unshot"); }, hide: peerStatus("shot"), show: peerStatus("unshot") },
  { name: "a redraw for another shot keeps its box", hide: peerStatus("shot", "b2"), show: null }
];

for (const redraw of REDRAWS) for (const order of ORDERS) test(`C7 typed draft: a held b-roll note stays with its shot when ${redraw.name}, shows again with its box and saves exactly once after release, ${order}`, async () => {
  const f = await enter();
  let stop = () => {};
  try {
    openBrollPanel(); redraw.setup?.(); brollOpen("b1");
    const box = notesBox(); box.focus(); box.value = "Wide";
    const undo = undoCount(f);
    stop = f.parts.session.hold(ADMISSION_HELD);
    noticeCalls.length = 0;
    blurOut(box);
    assert.deepEqual([warned(), shot("b1").notes], [[[REFUSED, "warn"]], ""], "refused once");
    noticeCalls.length = 0;
    redraw.hide(f, order); runBrollRefresh();
    if (redraw.show) {
      assert.equal(notesBox(), null, "the box is no longer drawn");
      redraw.show(f, order); runBrollRefresh();
    }
    assert.deepEqual([notesBox()?.value, shot("b1").notes, warned()], ["Wide", "", []], "the box shows the held text after the redraw");
    if (redraw.show) { redraw.hide(f, order); runBrollRefresh(); assert.equal(notesBox(), null); }
    stop();
    runBrollRefresh();
    assert.deepEqual([shot("b1").notes, undoCount(f) - undo, warned()], ["", 0, []], "release and redraw save nothing, with or without its box");
    runBrollRefresh();
    if (redraw.show) { redraw.show(f, order); runBrollRefresh(); }
    assert.equal(notesBox()?.value, "Wide");
    blurOut(notesBox());
    assert.deepEqual([undoCount(f) - undo, brollHook().drafts()], [1, []], "exactly one save");
    exchange(f, order);
    assert.equal(projectSharedDocument(f.peer).brollShots.find(s => s.id === "b1").notes, "Wide");
  } finally { stop(); tidy(f); }
});

const inputText = (box, value) => {
  box.focus(); box.value = value;
  box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
};
const bodyText = (box, value) => { box.innerHTML = value; box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" })); };
const stripText = root => [...document.querySelectorAll(root + " .typed-unsaved-text")].map(box => box.value);
function tagsOpen() {
  openProductionPanel();
  $('#production-modes [data-group="cat"]').click();
}
function tagExpand(key) {
  if (!document.querySelector('#production-panel .tag-entity.is-expanded[data-key="' + key + '"]')) $('#production-panel [data-action="tag-expand"][data-key="' + key + '"]').click();
}

for (const finalText of ["", "Wide shot"]) test(`manual draft a: held notes revised to ${JSON.stringify(finalText)} wait for blur, never redraw`, async () => {
  const f = await enter(); let release = () => {};
  try {
    brollOpen("b1");
    inputText(notesBox(), "Wide");
    release = f.parts.session.hold(ADMISSION_HELD);
    blurOut(notesBox());
    inputText(notesBox(), finalText);
    const undo = undoCount(f);
    release(); runBrollRefresh();
    assert.deepEqual([shot("b1").notes, notesBox().value, undoCount(f) - undo], ["", finalText, 0]);
    assert.equal(brollHook().drafts().length, finalText ? 1 : 0);
    assert.equal(notesBox().hasAttribute("data-unsaved"), !!finalText);
    blurOut(notesBox());
    assert.deepEqual([shot("b1").notes, undoCount(f) - undo, brollHook().drafts()], [finalText, finalText ? 1 : 0, []]);
  } finally { release(); tidy(f); }
});

for (const reply of [false, true]) test(`manual draft b: ${reply ? "reply" : "comment"} remains open during an unrelated delete-confirm redraw`, async () => {
  const f = await enter(); let release = () => {};
  try {
    openCommentsPanel();
    if (reply) toggleReplyComposer("C1");
    else openCommentComposer({ id: "C2", rowId: "r2", field: "audioText", quotedText: "Two" });
    const selector = reply ? '.reply-composer[data-for="C1"] .cell-editable' : "#comment-body-editable";
    $(reply ? '.reply-composer[data-for="C1"] .reply-name-input' : "#comment-name").value = "Alice";
    bodyText($(selector), "First");
    release = f.parts.session.hold(ADMISSION_HELD);
    if (reply) postReply("C1"); else postComment();
    bodyText($(selector), "First sec");
    const undo = undoCount(f);
    release();
    armDeleteComment(document.createElement("button"), "C1");
    renderComments();
    assert.deepEqual([$(selector).textContent, currentDocument().comments.length, currentDocument().comments[0].replies.length, undoCount(f) - undo], ["First sec", 1, 0, 0]);
    if (reply) postReply("C1"); else postComment();
    assert.equal(reply ? currentDocument().comments[0].replies.length : currentDocument().comments.length, reply ? 1 : 2);
    const stored = reply ? currentDocument().comments[0].replies[0].body : currentDocument().comments.find(c => c.id === "C2").body;
    assert.equal(stored, "First sec");
    assert.equal(reply ? currentDocument().comments[0].replies.length : currentDocument().comments.length, reply ? 1 : 2);
    renderComments();
    assert.equal(reply ? currentDocument().comments[0].replies.length : currentDocument().comments.length, reply ? 1 : 2);
  } finally { release(); tidy(f); }
});

for (const rename of [false, true]) test(`manual draft c: a waiting tag ${rename ? "rename" : "person"} survives another expanded tag and returns from the strip`, async () => {
  const f = await enter(); let release = () => {};
  try {
    tagsOpen(); tagExpand("prop mug");
    $('#production-panel [data-action="' + (rename ? "tag-rename" : "tag-person-new") + '"][data-key="prop mug"]').click();
    const selector = '#production-panel .' + (rename ? "tag-rename-input" : "tag-person-input") + '[data-key="prop mug"]';
    inputText($(selector), rename ? "Cup" : "Cy");
    release = rename ? f.parts.session.beforeCommand(() => { renderProduction(); notices.show(REFUSED, "warn"); return "announced"; })
      : f.parts.session.hold(ADMISSION_HELD);
    press($(selector), "Enter");
    assert.equal(document.querySelector(selector)?.value, rename ? "Cup" : "Cy", "the submit's own redraw keeps its editor open");
    tagExpand("prop lamp");
    assert.deepEqual(stripText("#production-panel"), [rename ? "Cup" : "Cy"]);
    assert.match($('#production-panel .typed-unsaved-label').textContent, /Mug.*(?:new name|new person)/);
    release(); renderProduction();
    assert.deepEqual(stripText("#production-panel"), [rename ? "Cup" : "Cy"]);
    tagExpand("prop mug");
    assert.equal($(selector).value, rename ? "Cup" : "Cy");
    assert.equal($(selector).hasAttribute("data-unsaved"), true);
    assert.deepEqual(stripText("#production-panel"), []);
    assert.equal(currentDocument().people.some(p => p.name === "Cy"), false);
  } finally { release(); tidy(f); }
});

for (const tagPanel of [false, true]) test(`manual draft d: ${tagPanel ? "tag bulk person" : "shot bulk location"} uses the current selection only on resubmit`, async () => {
  const f = await enter(); let release = () => {};
  try {
    if (tagPanel) { tagsOpen(); toggleCardSelection("prop mug"); $('[data-action="bulk-person-new"]').click(); }
    else {
      brollOpen("b1");
      $('#broll-panel [data-action="broll-expand"][data-id="b1"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
      const select = $("#broll-bulk-location"); select.value = "__new__"; select.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    const box = tagPanel ? "#bulk-person-input" : "#broll-bulk-input", text = tagPanel ? "Cy" : "Dock";
    inputText($(box), text);
    release = f.parts.session.hold(ADMISSION_HELD); press($(box), "Enter");
    if (tagPanel) { toggleCardSelection("prop mug"); toggleCardSelection("prop lamp"); }
    else for (const id of ["b1", "b2"]) $('#broll-panel [data-action="broll-expand"][data-id="' + id + '"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
    const undo = undoCount(f);
    release(); if (tagPanel) renderProduction(); else runBrollRefresh();
    assert.deepEqual([shot("b1").location, shot("b2").location, currentDocument().people.some(p => p.name === "Cy"), undoCount(f) - undo], ["", "", false, 0]);
    if (!document.querySelector(box)) {
      assert.ok(stripText(tagPanel ? "#production-panel" : "#broll-panel").includes(text));
      if (tagPanel) $('[data-action="bulk-person-new"]').click();
      else { const select = $("#broll-bulk-location"); select.value = "__new__"; select.dispatchEvent(new window.Event("change", { bubbles: true })); }
    }
    assert.equal($(box).value, text);
    press($(box), "Enter");
    assert.equal(undoCount(f) - undo, 1);
    if (tagPanel) {
      const person = currentDocument().people.find(p => p.name === "Cy");
      assert.equal(currentDocument().productionTags.find(t => t.name === "Mug").owner, "");
      assert.equal(currentDocument().productionTags.find(t => t.name === "Lamp").owner, person.id);
    } else assert.deepEqual([shot("b1").location, shot("b2").location], ["", "Dock"]);
  } finally { release(); tidy(f); }
});

test("manual draft e: tag notes follow the registry id through rename and reuse of its old name", async () => {
  const f = await enter(); let release = () => {};
  try {
    tagsOpen(); tagExpand("prop mug");
    release = f.parts.session.hold(ADMISSION_HELD);
    inputText($('#production-panel .tag-notes-input[data-key="prop mug"]'), "Wide");
    const record = currentDocument().productionTags.find(t => t.name === "Mug").id;
    peerWrite(f, "remote-first", { kind: "record-set", target: { collection: "tags", record }, field: "name", value: "Cup" });
    peerWrite(f, "remote-first", { kind: "record-create", target: { collection: "tags", record: "t_replacement" }, fields: { cat: "prop", name: "Mug", owner: "", notes: "", status: "needed", rank: "9999999999" } });
    renderProduction();
    assert.deepEqual(stripText("#production-panel"), ["Wide"]);
    assert.match($('#production-panel .typed-unsaved-label').textContent, /Cup.*notes/);
    tagExpand("prop mug");
    assert.equal($('#production-panel .tag-notes-input[data-key="prop mug"]').value, "");
    tagExpand("prop cup");
    assert.equal($('#production-panel .tag-notes-input[data-key="prop cup"]').value, "Wide");
    release(); renderProduction();
    assert.deepEqual(currentDocument().productionTags.map(t => t.notes), ["", "", ""]);
    assert.equal($('#production-panel .tag-notes-input[data-key="prop cup"]').defaultValue, "");
    blurOut($('#production-panel .tag-notes-input[data-key="prop cup"]'));
    assert.equal(currentDocument().productionTags.find(t => t.id === record).notes, "Wide", JSON.stringify(noticeCalls));
    assert.equal(currentDocument().productionTags.find(t => t.id === "t_replacement").notes, "");
  } finally { release(); tidy(f); }
});

test("manual draft e: a removed tag's held person goes to the strip without creating an unassigned person", async () => {
  const f = await enter(); let release = () => {};
  try {
    tagsOpen(); tagExpand("prop mug");
    $('#production-panel [data-action="tag-person-new"][data-key="prop mug"]').click();
    inputText($('#production-panel .tag-person-input[data-key="prop mug"]'), "Cy");
    release = f.parts.session.hold(ADMISSION_HELD);
    press($('#production-panel .tag-person-input[data-key="prop mug"]'), "Enter");
    const record = currentDocument().productionTags.find(t => t.name === "Mug").id;
    peerWrite(f, "remote-first", { kind: "record-delete", target: { collection: "tags", record } });
    release(); renderProduction();
    assert.deepEqual(stripText("#production-panel"), ["Cy"]);
    assert.equal(currentDocument().people.some(p => p.name === "Cy"), false);
  } finally { release(); tidy(f); }
});

test("manual draft f: an announced refusal still gets one removal notice and the removed shot's text", async () => {
  const f = await enter();
  const stop = f.parts.session.beforeCommand(() => { notices.show(REFUSED, "warn"); return "announced"; });
  try {
    brollOpen("b1"); inputText(notesBox(), "Wide"); blurOut(notesBox()); noticeCalls.length = 0;
    peerWrite(f, "remote-first", { kind: "record-delete", target: { collection: "shots", record: "b1" } });
    runBrollRefresh(); runBrollRefresh();
    assert.deepEqual([warned(), stripText("#broll-panel")], [[[GONE_NOTE, "warn"]], ["Wide"]]);
  } finally { stop(); tidy(f); }
});

test("manual draft g: Gear filling keeps held quick-add text after closing and reopening", async () => {
  const f = await enter(); let release = () => {};
  try {
    openGearPanel(); inputText($("#gear-quickadd-input"), "Wireless lav");
    release = f.parts.session.hold(ADMISSION_HELD); applyGearQuickAdd();
    sidePanels().close("gear-panel"); openProductionPanel(); renderProduction();
    assert.ok(stripText("#production-panel").includes("Wireless lav"));
    release(); openGearPanel();
    assert.deepEqual([$("#gear-quickadd-input").value, currentDocument().productionTags.filter(t => t.cat === "gear")], ["Wireless lav", []]);
    applyGearQuickAdd();
    assert.deepEqual(currentDocument().productionTags.filter(t => t.cat === "gear").map(t => t.name), ["Wireless lav"]);
  } finally { release(); tidy(f); }
});

for (const order of ORDERS) test(`C7 typed draft: a b-roll note refused by a listener that announces it waits through a focused redraw, and the next blur once allowed saves it once, ${order}`, async () => {
  const f = await enter();
  let refusing = true;
  const stop = f.parts.session.beforeCommand(() => {
    if (!refusing) return true;
    notices.show(REFUSED, "warn");
    return "announced";
  });
  try {
    brollOpen("b1");
    const box = notesBox(); box.focus(); box.value = "Wide";
    const undo = undoCount(f);
    noticeCalls.length = 0;
    blurOut(box);
    assert.deepEqual([warned(), shot("b1").notes], [[[REFUSED, "warn"]], ""], "refused once by the listener");
    noticeCalls.length = 0;
    refusing = false;
    runBrollRefresh();
    assert.deepEqual([notesBox()?.value, shot("b1").notes, warned()], ["Wide", "", []], "a waiting draft is not retried by a redraw");
    notesBox().focus();
    runBrollRefresh();
    assert.deepEqual([notesBox()?.value, document.activeElement === notesBox(), shot("b1").notes, warned()], ["Wide", true, "", []], "a focused redraw keeps the text and does not retry");
    blurOut(notesBox());
    assert.deepEqual([shot("b1").notes, undoCount(f) - undo, warned(), brollHook().drafts()], ["Wide", 1, [], []], "the next blur saves it once");
    exchange(f, order);
  } finally { stop(); tidy(f); }
});

const GONE_NOTE ="The shot was removed, so its note was not saved. The text is kept at the top of the b-roll list.";

test("manual draft ninth: dismissing a hidden shot note clears stale boxes in both b-roll views", async () => {
  const f = await enter(); let release = () => {};
  try {
    brollOpen("b1"); inputText(notesBox(), "Wide");
    release = f.parts.session.hold(ADMISSION_HELD); blurOut(notesBox());
    openBrollPage(); filter("shot"); runBrollRefresh();
    assert.deepEqual(stripText("#broll-page"), ["Wide"]);
    $('#broll-page [data-action="typed-unsaved-dismiss"]').click();
    assert.deepEqual(stripText("#broll-page"), []);
    release(); closeBrollPage(() => {}); filter("all"); brollOpen("b1"); runBrollRefresh();
    assert.deepEqual([notesBox().value, shot("b1").notes, brollHook().drafts(), stripText("#broll-panel")], ["", "", [], []]);
  } finally { release(); closeBrollPage(() => {}); tidy(f); }
});

test("manual draft ninth: dismissing hidden Gear text ends the draft when the panel reopens", async () => {
  const f = await enter(); let release = () => {};
  try {
    openGearPanel(); inputText($("#gear-quickadd-input"), "Wireless lav");
    release = f.parts.session.hold(ADMISSION_HELD); applyGearQuickAdd();
    sidePanels().close("gear-panel"); openProductionPanel();
    assert.ok(stripText("#production-panel").includes("Wireless lav"));
    $('#production-panel [data-action="typed-unsaved-dismiss"][data-box="gear-quickadd-input"]').click();
    assert.deepEqual(stripText("#production-panel"), []);
    release(); renderProduction(); openGearPanel();
    assert.equal($("#gear-quickadd-input").value, "");
    assert.deepEqual(currentDocument().productionTags.filter(t => t.cat === "gear"), []);
  } finally { release(); tidy(f); }
});

test("manual draft ninth: dismissing a filtered reply clears its composer state and text", async () => {
  const f = await enter(); let release = () => {};
  try {
    openCommentsPanel(); toggleReplyComposer("C1");
    $('.reply-composer[data-for="C1"] .reply-name-input').value = "Alice";
    bodyText($('.reply-composer[data-for="C1"] .cell-editable'), "First");
    release = f.parts.session.hold(ADMISSION_HELD); postReply("C1");
    setCommentFilterMode("resolved");
    assert.deepEqual(stripText("#comments-list"), ["First"]);
    $('#comments-list [data-action="typed-unsaved-dismiss"]').click();
    assert.deepEqual(stripText("#comments-list"), []);
    release(); setCommentFilterMode("all");
    if (!document.querySelector('.reply-composer[data-for="C1"]')) toggleReplyComposer("C1");
    assert.equal($('.reply-composer[data-for="C1"] .cell-editable').textContent, "");
    assert.deepEqual(currentDocument().comments[0].replies, []);
  } finally { release(); setCommentFilterMode("all"); tidy(f); }
});

for (const order of ORDERS) test(`C7 typed draft: a held b-roll note whose shot a peer deletes gives one notice and stays readable in the panel, ${order}`, async () => {
  const f = await enter();
  let stop = () => {};
  try {
    brollOpen("b1");
    const box = notesBox(); box.focus(); box.value = "Wide";
    const undo = undoCount(f);
    stop = f.parts.session.hold(ADMISSION_HELD);
    blurOut(box);
    noticeCalls.length = 0;
    peerWrite(f, order, { kind: "record-delete", target: { collection: "shots", record: "b1" } });
    runBrollRefresh();
    const strip = () => [...document.querySelectorAll("#broll-panel .typed-unsaved-text")].map(el => el.value);
    assert.deepEqual([warned(), strip(), notesBox()], [[[GONE_NOTE, "warn"]], ["Wide"], null]);
    noticeCalls.length = 0;
    runBrollRefresh();
    stop();
    runBrollRefresh();
    assert.deepEqual([warned(), strip(), undoCount(f) - undo, brollHook().drafts()], [[], ["Wide"], 0, []], "one notice, nothing written");
    $('#broll-panel [data-action="typed-unsaved-dismiss"]').click();
    assert.deepEqual(strip(), []);
  } finally { stop(); tidy(f); }
});

const RENAME = '#broll-panel .broll-rename-input[data-id="bs1"]';
const RENAMES = [{ name: "refused because the shared rename has no shared form", held: false }, { name: "held at admission", held: true }];

for (const rename of RENAMES) test(`C7 typed draft: a script-shot rename ${rename.name} keeps the box open with the typed name after the refusal, a redraw and the release, and writes nothing`, async () => {
  const f = await enter();
  let stop = () => {};
  try {
    brollOpen("bs1");
    if (!document.querySelector('#broll-panel [data-action="broll-rename"][data-id="bs1"]')) $('#broll-panel [data-action="broll-menu"][data-id="bs1"]').click();
    $('#broll-panel [data-action="broll-rename"][data-id="bs1"]').click();
    const box = $(RENAME); box.focus(); box.value = "Jetty";
    const undo = undoCount(f), cell = currentDocument().rows[0].visualText;
    if (rename.held) stop = f.parts.session.hold(ADMISSION_HELD);
    noticeCalls.length = 0;
    $('#broll-panel [data-action="broll-rename-save"][data-id="bs1"]').click();
    const kept = () => [document.querySelector(RENAME)?.value, shot("bs1").name, currentDocument().rows[0].visualText, undoCount(f) - undo];
    assert.deepEqual([warned(), kept()], [[[REFUSED, "warn"]], ["Jetty", "Pier", cell, 0]], "refused once, the box stays open");
    noticeCalls.length = 0;
    runBrollRefresh();
    assert.deepEqual([warned(), kept()], [[], ["Jetty", "Pier", cell, 0]], "after a redraw");
    stop();
    runBrollRefresh();
    assert.deepEqual([warned(), kept()], [[], ["Jetty", "Pier", cell, 0]], "after release the draft waits for the person");
    noticeCalls.length = 0;
    runBrollRefresh();
    assert.deepEqual([warned(), kept()], [[], ["Jetty", "Pier", cell, 0]], "a rename refused when it is decided waits for the person");
    press($(RENAME), "Escape");
    runBrollRefresh();
    assert.deepEqual([document.querySelector(RENAME), brollHook().drafts()], [null, []], "Escape leaves rename mode and drops the draft");
  } finally { stop(); tidy(f); }
});

const GONE_REPLY = "The comment was removed, so your reply was not saved. The text is kept at the top of the comments list.";

for (const order of ORDERS) test(`C7 typed draft: a held reply whose comment a peer deletes gives one notice and stays readable in the comments panel, ${order}`, async () => {
  const f = await enter();
  let stop = () => {};
  try {
    openCommentsPanel();
    if (!document.querySelector('.reply-composer[data-for="C1"]')) toggleReplyComposer("C1");
    const card = $('.reply-composer[data-for="C1"]');
    card.querySelector(".reply-name-input").value = "Alice"; card.querySelector(".cell-editable").innerHTML = "ok";
    const undo = undoCount(f);
    stop = f.parts.session.hold(ADMISSION_HELD);
    noticeCalls.length = 0;
    postReply("C1");
    assert.deepEqual(warned(), [[REFUSED, "warn"]]);
    noticeCalls.length = 0;
    peerWrite(f, order, { kind: "record-delete", target: { collection: "comments", record: "C1" } });
    openCommentsPanel();
    const strip = () => [...document.querySelectorAll("#comments-list .typed-unsaved-text")].map(el => el.value);
    assert.deepEqual([warned(), strip()], [[[GONE_REPLY, "warn"]], ["ok"]]);
    noticeCalls.length = 0;
    stop();
    openCommentsPanel();
    assert.deepEqual([warned(), strip(), undoCount(f) - undo], [[], ["ok"], 0], "one notice, nothing written");
    $('#comments-list [data-action="typed-unsaved-dismiss"]').click();
    assert.deepEqual(strip(), []);
  } finally { stop(); tidy(f); }
});
