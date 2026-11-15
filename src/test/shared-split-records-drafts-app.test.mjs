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
import { openBrollPanel, runBrollRefresh } from "../features/broll/panel.ts";
import { closeCommentComposer, openCommentsPanel, postReply, toggleReplyComposer } from "../features/comments/comments.ts";
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
  productionTags: [],
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
    assert.deepEqual([shot("b1").notes, undoCount(f) - undo, warned()], ["Wide", 1, []], "saved once after release, with or without its box");
    runBrollRefresh();
    if (redraw.show) { redraw.show(f, order); runBrollRefresh(); }
    assert.equal(notesBox()?.value, "Wide");
    blurOut(notesBox());
    assert.deepEqual([undoCount(f) - undo, brollHook().drafts()], [1, []], "exactly one save");
    exchange(f, order);
    assert.equal(projectSharedDocument(f.peer).brollShots.find(s => s.id === "b1").notes, "Wide");
  } finally { stop(); tidy(f); }
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
    notesBox().focus();
    runBrollRefresh();
    assert.deepEqual([notesBox()?.value, document.activeElement === notesBox(), shot("b1").notes, warned()], ["Wide", true, "", []], "a focused redraw keeps the text and does not retry");
    refusing = false;
    runBrollRefresh();
    assert.equal(shot("b1").notes, "", "a waiting draft is not retried by a redraw");
    blurOut(notesBox());
    assert.deepEqual([shot("b1").notes, undoCount(f) - undo, warned(), brollHook().drafts()], ["Wide", 1, [], []], "the next blur saves it once");
    exchange(f, order);
  } finally { stop(); tidy(f); }
});

const GONE_NOTE ="The shot was removed, so its note was not saved. The text is kept at the top of the b-roll list.";

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
    const ownReason = rename.held ? [[REFUSED, "warn"]] : [];
    assert.deepEqual([warned(), kept()], [ownReason, ["Jetty", "Pier", cell, 0]], "after the release, a held rename tries once and is refused for its own reason");
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
