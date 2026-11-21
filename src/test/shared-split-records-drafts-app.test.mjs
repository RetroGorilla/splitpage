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
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { fromHtml } from "../bootstrap/richtext.ts";
import { createSharedDocument, destroySharedDocument, applySharedUpdate, encodeSharedState } from "../adapters/collab/document.ts";
import { registerSharedOperationFamilies } from "../adapters/collab/operation-families.ts";
import { armDeleteComment, closeCommentComposer, openCommentComposer, openCommentsPanel, postComment, postReply, renderComments, toggleReplyComposer } from "../features/comments/comments.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const errors = [];
const allowed = { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) };
let serial = 0;
const ports = {
  opening: openingStatus,
  refusal: () => null, commandRefused: sharedCommandRefusalNotice(notices), settle: () => { undoOwner().flush(); }, detach: () => {},
  bindings: sharedSplitBindings({ report: () => {}, missingBase: () => {}, recovered: () => {} }),
  common: allowed, standalone: createSessionCapabilities("standalone", allowed), migrate: migrateRows,
  docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Alice", structure: { cells: html => fromHtml(html) },
  report: error => { errors.push(error); }, timers: { now: Date.now, start: (run, ms) => setTimeout(run, ms), stop: clearTimeout }, now: Date.now
};
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
  errors.length = 0;
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(SOURCE)));
  assert.deepEqual(await enterSharedSession(ports), { ok: true }, errors.map(error => error.stack).join("\n"));
  const parts = sharedSessionParts(); assert.ok(parts);
  const peer = createSharedDocument(); registerSharedOperationFamilies(peer, { cells: html => fromHtml(html) });
  assert.equal(applySharedUpdate(peer, encodeSharedState(parts.handle)).ok, true);
  return { parts, peer, close: () => { destroySharedDocument(peer); assert.deepEqual(leaveSharedSession(ports), { ok: true }); } };
}

const $ = selector => { const el = document.querySelector(selector); assert.ok(el, selector); return el; };
const undoCount = f => f.parts.undo.sizes().undo;
const bodyText = (box, value) => { box.innerHTML = value; box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" })); };

function tidy(f) {
  closeCommentComposer();
  f.close();
  document.activeElement?.blur?.();
}

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
