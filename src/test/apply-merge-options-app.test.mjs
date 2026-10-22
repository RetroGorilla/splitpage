import "./_dom.mjs";
import { bootApp, clearTimers, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { applyMerge, baseStateReason, reportMerge, setBaseState } from "../js/03-sync.js";
import { mergeUndo } from "../legacy/editor-bridge.ts";
import { listDocHistory } from "../js/03a-history-store.js";
import { clearDirty } from "../js/12-dirty-toast.js";
import * as exporting from "../js/14-export.js";
import { cloneState } from "../core/document/clone.ts";
import { loadTestDocument } from "./_document.mjs";

await bootApp();
await window.__historyTest.forceBackend("memory");
after(() => {
  closeApp();
});

let seq = 0;
function freshId() {
  seq++;
  return "d" + String(900 + seq).padStart(32, "0");
}
function mk(docId) {
  return migrateRows({
    docId: docId,
    title: "Options",
    rows: [
      { id: "r1", visualText: "v1", audioText: "a1" },
      { id: "r2", visualText: "v2", audioText: "a2" }
    ]
  });
}

const banner = () => document.getElementById("merge-banner");
const undoBtn = () => document.getElementById("merge-undo");
const reviewBtn = () => document.getElementById("merge-review");
const summary = () => document.getElementById("merge-summary").textContent;
const toasts = () => Array.from(document.querySelectorAll("#toast-host .toast")).map((t) => ({
  text: t.textContent, warn: t.classList.contains("warn"), ok: t.classList.contains("ok"), sticky: t.classList.contains("is-sticky")
}));

function start(id) {
  clearTimers();
  const doc = mk(id);
  loadTestDocument(cloneState(doc));
  setBaseState(cloneState(doc), "a test: the document as opened");
  mergeUndo().arm(null);
  clearDirty();
  exporting.resumeAutoSave();
  banner().hidden = true;
  undoBtn().hidden = true;
  reviewBtn().hidden = true;
  document.getElementById("toast-host").innerHTML = "";
  window.__renderTest.reset();
  return doc;
}

function sides(id) {
  const mine = mk(id);
  mine.rows[0].audioText = "mine";
  const theirs = mk(id);
  theirs.rows[1].audioText = "theirs";
  return { base: mk(id), mine, theirs };
}

test("characterization: an adopted merge redraws, shows the banner, marks the document unsaved and leaves autosave running", () => {
  const id = freshId();
  start(id);
  const s = sides(id);
  const baseBefore = S.baseState;

  const out = applyMerge({ base: s.base, mine: s.mine, theirs: s.theirs, source: "server-conflict" });
  assert.equal(out.state, S.state);
  assert.equal(S.state.rows[0].audioText, "mine");
  assert.equal(S.state.rows[1].audioText, "theirs");
  assert.equal(out.snapshot, null, "no undoPoint asked for");
  assert.equal(window.__renderTest.counts().render, 1, "one redraw");
  assert.equal(banner().hidden, false);
  assert.equal(summary(), " Kept 1 row you edited, 1 changed by someone else.");
  assert.equal(undoBtn().hidden, true, "nothing to undo");
  assert.equal(reviewBtn().hidden, true, "no conflicts");
  assert.ok(S.dirty, "unsaved");
  assert.equal(exporting.autoSaveHalt, "");
  assert.equal(S.baseState, baseBefore, "no newBase, no baseline move");
});

test("characterization: `report: false` merges silently: no banner, no unsaved mark, no autosave halt", () => {
  const id = freshId();
  start(id);
  const s = sides(id);

  const out = applyMerge({ base: s.base, mine: s.mine, theirs: s.theirs, source: "server-conflict", report: false, noAutoSave: true });
  assert.ok(out.result);
  assert.equal(S.state.rows[1].audioText, "theirs");
  assert.equal(window.__renderTest.counts().render, 1);
  assert.equal(banner().hidden, true);
  assert.ok(!S.dirty, "report: false leaves the unsaved mark to the caller");
  assert.equal(exporting.autoSaveHalt, "", "and the autosave decision too");
});

test("characterization: `report: false` with nothing merged adopts theirs without marking it unsaved", () => {
  const id = freshId();
  start(id);
  const theirs = mk(id);
  theirs.title = "As the server has it";

  const out = applyMerge({ theirs: theirs, unchanged: true, source: "stash", recovery: true, report: false });
  assert.equal(out.result, null);
  assert.equal(out.snapshot, null);
  assert.equal(S.state.title, "As the server has it");
  assert.equal(window.__renderTest.counts().render, 1, "adopting theirs redraws");
  assert.equal(banner().hidden, true);
  assert.ok(!S.dirty);
});

test("characterization: `unchanged` with reporting marks the adopted document unsaved, with no banner and no snapshot", async () => {
  const id = freshId();
  start(id);
  const theirs = mk(id);
  theirs.title = "Recovered as it was";

  const out = applyMerge({ theirs: theirs, unchanged: true, source: "stash", recovery: true, undoPoint: mk(id) });
  assert.equal(out.result, null);
  assert.equal(out.snapshot, null, "an unchanged apply takes no undo point even when given one");
  assert.equal(mergeUndo().last(), null, "and arms no Undo merge");
  assert.equal(banner().hidden, true);
  assert.ok(S.dirty);
  const listed = await listDocHistory(id);
  assert.equal(listed.entries.length, 0);
});

test("characterization: `noAutoSave` halts autosave with its reason and still marks the document unsaved", () => {
  const id = freshId();
  start(id);
  const s = sides(id);

  applyMerge({ base: s.base, mine: s.mine, theirs: s.theirs, source: "server-resume", noAutoSave: true });
  assert.equal(banner().hidden, false);
  assert.ok(S.dirty);
  assert.equal(exporting.autoSaveHalt,
    "Autosave is paused — changes recovered for you are on screen but not in your file yet. Press Save once you have looked them over.");
});

test("characterization: a merge where nothing differs row by row still marks unsaved but shows no banner", () => {
  const id = freshId();
  start(id);
  const mine = mk(id);
  mine.title = "Mine";
  const theirs = mk(id);

  const out = applyMerge({ base: mk(id), mine: mine, theirs: theirs, source: "stash", noAutoSave: true });
  assert.ok(out.result);
  assert.equal(S.state.title, "Mine");
  assert.equal(banner().hidden, true);
  assert.ok(S.dirty);
  assert.ok(exporting.autoSaveHalt, "the no-autosave rule applies here too");
});

test("characterization: a conflict warns on the banner, offers Review conflicts and marks the row", () => {
  const id = freshId();
  start(id);
  const mine = mk(id);
  mine.rows[0].audioText = "mine said this";
  const theirs = mk(id);
  theirs.rows[0].audioText = "they said that";

  const out = applyMerge({ base: mk(id), mine: mine, theirs: theirs, source: "server-conflict", undoPoint: cloneState(mine) });
  assert.equal(out.result.conflicts.length, 1);
  assert.equal(banner().hidden, false);
  assert.ok(banner().classList.contains("notice-warn"));
  assert.equal(reviewBtn().hidden, false);
  assert.equal(undoBtn().hidden, false, "an undo point armed is offered");
  assert.match(summary(), /1 edit was changed on both sides — your version is saved as a comment\.$/);
  assert.ok(document.querySelector('#rows .row[data-id="r1"]').classList.contains("just-merged"));
});

test("characterization: `newBase` sets the baseline through setBaseState with the source as its reason, a function read once", () => {
  const id = freshId();
  start(id);
  const s = sides(id);
  const given = cloneState(s.theirs);

  applyMerge({ base: s.base, mine: s.mine, theirs: s.theirs, source: "server-resume", newBase: given, report: false });
  assert.equal(S.baseState, given);
  assert.equal(baseStateReason(), "merge: server-resume");

  start(id);
  let asked = 0;
  const fromFn = cloneState(s.theirs);
  applyMerge({ base: s.base, mine: s.mine, theirs: s.theirs, newBase: function () { asked++; return fromFn; }, report: false });
  assert.equal(asked, 1);
  assert.equal(S.baseState, fromFn);
  assert.equal(baseStateReason(), "merge: ", "no source, an empty one");

  start(id);
  const before = S.baseState;
  applyMerge({ base: s.base, mine: s.mine, theirs: s.theirs, source: "stash", newBase: undefined, report: false });
  assert.equal(S.baseState, before, "no newBase, no move");
});

test("characterization: `toast` speaks after adoption, a function seeing the adopted document", () => {
  const id = freshId();
  start(id);
  const s = sides(id);
  s.theirs.title = "Their title";

  applyMerge({
    base: s.base, mine: s.mine, theirs: s.theirs, source: "server-resume", report: false,
    toast: { text: function () { return "Now " + S.state.title; }, tone: "warn", sticky: true }
  });
  assert.deepEqual(toasts(), [{ text: "Now Their title", warn: true, ok: false, sticky: true }]);

  start(id);
  applyMerge({ base: s.base, mine: s.mine, theirs: s.theirs, report: false, toast: { text: "Plain" } });
  assert.deepEqual(toasts(), [{ text: "Plain", warn: false, ok: true, sticky: false }]);

  start(id);
  applyMerge({ base: s.base, mine: s.mine, theirs: s.theirs, report: false, toast: { text: function () { return ""; } } });
  assert.deepEqual(toasts(), [], "an empty answer says nothing");
});

test("characterization: `alreadySaved` shows the banner without marking unsaved; `undo` decides the Undo merge button", () => {
  const id = freshId();
  start(id);
  const s = sides(id);
  const merged = applyMerge({ base: s.base, mine: s.mine, theirs: s.theirs, source: "server-conflict", undoPoint: cloneState(s.mine), report: false });
  assert.ok(mergeUndo().last());
  const defaultTitle = undoBtn().title;

  reportMerge(merged.result, { alreadySaved: true, undo: "saved" });
  assert.equal(banner().hidden, false);
  assert.ok(!S.dirty, "already on its destination");
  assert.equal(undoBtn().hidden, false);
  assert.match(summary(), /Undo merge puts your version back here; the next save replaces the merged copy on the server\.$/);
  assert.notEqual(undoBtn().title, defaultTitle);

  reportMerge(merged.result, { alreadySaved: true, undo: false });
  assert.equal(undoBtn().hidden, true, "a pull offers no Undo merge even with one armed");
  assert.equal(undoBtn().title, defaultTitle);
  assert.doesNotMatch(summary(), /Undo merge/);
});

test("characterization: the boot path reports a recovery as unsaved through reportMerge", () => {
  const id = freshId();
  start(id);
  const s = sides(id);
  const merged = applyMerge({ base: s.base, mine: s.mine, theirs: s.theirs, source: "stash", recovery: true, report: false });
  assert.ok(!S.dirty);
  reportMerge(merged.result, { kind: "recovery" });
  assert.equal(banner().hidden, false);
  assert.ok(S.dirty);
  assert.equal(exporting.autoSaveHalt, "");
});

test("characterization: the banner's ×, Review conflicts and Undo merge", async () => {
  const id = freshId();
  start(id);
  const mine = mk(id);
  mine.rows[0].audioText = "mine said this";
  const theirs = mk(id);
  theirs.rows[0].audioText = "they said that";
  const out = applyMerge({ base: mk(id), mine: mine, theirs: theirs, source: "server-conflict", undoPoint: cloneState(mine) });
  assert.equal(banner().hidden, false);
  await out.snapshot.done;

  document.getElementById("merge-dismiss").click();
  assert.equal(banner().hidden, true, "× hides it");

  banner().hidden = false;
  reviewBtn().click();
  assert.equal(banner().hidden, true, "Review conflicts hides it");
  assert.equal(document.getElementById("comments-panel").hidden, false, "and opens the comments panel");

  undoBtn().click();
  assert.equal(undoBtn().textContent, "Drop their changes?", "the first click arms");
  assert.ok(undoBtn().classList.contains("armed"));
  undoBtn().click();
  assert.equal(undoBtn().textContent, "Undo merge");
  assert.ok(!undoBtn().classList.contains("armed"));
  for (let i = 0; i < 50 && S.state.rows[0].audioText !== "mine said this"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(S.state.rows[0].audioText, "mine said this", "the second restores the undo point");
  assert.ok(S.dirty, "locally, unsaved");
});

test("characterization: Undo merge with nothing armed, or armed for another document, only says so", () => {
  const id = freshId();
  start(id);
  undoBtn().hidden = false;
  undoBtn().click();
  assert.deepEqual(toasts().map((t) => t.text), ["No merge snapshot to undo."]);
  assert.equal(undoBtn().textContent, "Undo merge");

  document.getElementById("toast-host").innerHTML = "";
  mergeUndo().arm({ id: "s-x", docId: freshId(), source: "stash" });
  undoBtn().click();
  assert.deepEqual(toasts().map((t) => t.text), ["That merge belongs to a different document, so there is nothing to undo here."]);
  assert.equal(undoBtn().textContent, "Undo merge");
});

test("characterization: Undo merge for a stash asks to discard, and a snapshot gone from the history says so", async () => {
  const id = freshId();
  start(id);
  mergeUndo().arm({ id: "s-y", docId: id, source: "stash" });
  undoBtn().click();
  assert.equal(undoBtn().textContent, "Discard my edits?");
  undoBtn().click();
  assert.equal(undoBtn().textContent, "Undo merge");
  for (let i = 0; i < 50 && !toasts().length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(toasts().map((t) => t.text), ["The snapshot from before the merge is no longer in the history."]);
});
