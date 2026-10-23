import { bootApp, closeApp } from "./_app-boot.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHeldFetch, mockClock } from "./_m4-matrix.mjs";
import { cloneState } from "../core/document/clone.ts";
import { autoSavePolicy, unsavedChanges } from "../legacy/save-bridge.ts";
import { documentLocation } from "../legacy/location-bridge.ts";
import { mergeBase, currentDocument } from "../legacy/session-bridge.ts";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { noteSessionEdit } = await import("../legacy/session-bridge.ts");
const { confirmSavedNow } = await import("../legacy/save-bridge.ts");
const { flushEdits } = await import("../js/12a-undo.js");
const exportModule = await import("../js/14-export.js");
const { saveDoc } = exportModule;
const hosted = await import("../js/13-hosted.js");
const homeModule = await import("../legacy/location-bridge.ts");
const { pushSnapshot, restoreSnapshotFromCard } = await import("../js/03-sync.js");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

const DOC_ID = "d" + "a".repeat(32);

function script() {
  return migrateRows({
    schema: 5, title: "A", docId: DOC_ID,
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ]
  });
}

function textOf(row) {
  return String((row && row.audioText) || "").replace(/<[^>]*>/g, "");
}

function createServer() {
  const docs = new Map();
  const answered = [];
  let hold = null;
  return {
    docs: docs,
    answered: answered,
    holdPutReply: function () {
      let release;
      hold = new Promise(function (resolve) { release = resolve; });
      return function () { hold = null; release(); };
    },
    put: function (id, state, rev) {
      docs.set(id, { rev: rev, state: JSON.parse(JSON.stringify(state)) });
    },
    answer: async function (r) {
      const path = r.url.replace(/^https?:\/\/[^/]+\//, "").replace(/^\//, "");
      const doc = /^api\/docs\/([^/]+)$/.exec(path);
      if (doc && r.method === "GET") {
        const found = docs.get(doc[1]);
        return found ? { status: 200, body: { id: doc[1], rev: found.rev, state: found.state } } : { status: 404, body: { error: "not-found" } };
      }
      if (doc && r.method === "PUT") {
        const found = docs.get(doc[1]);
        if (!found) return { status: 404, body: { error: "not-found" } };
        if (r.body.baseRev !== found.rev) {
          answered.push({ baseRev: r.body.baseRev, status: 409 });
          return { status: 409, body: { error: "conflict", rev: found.rev, state: found.state } };
        }
        found.rev += 1;
        found.state = JSON.parse(JSON.stringify(r.body.state));
        answered.push({ baseRev: r.body.baseRev, status: 200 });
        const waiting = hold;
        if (waiting) await waiting;
        return { status: 200, body: { id: doc[1], rev: found.rev } };
      }
      return { status: 200, body: {} };
    }
  };
}

function withServer(t, server) {
  const held = createHeldFetch({ connection: () => homeModule.currentConn(), answer: server.answer });
  t.after(held.install());
  return held;
}

async function settle() {
  for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve));
}

function openHosted(id, rev) {
  loadTestDocument(script());
  flushEdits();
  confirmSavedNow();
  homeModule.setHome("none");
  window.__hostedTest.setSession({ docId: id, rev: rev });
  documentLocation().markWrittenOut(true);
  confirmSavedNow();
}

function leave() {
  homeModule.setHome("none");
  window.__hostedTest.setSession({ docId: null });
  confirmSavedNow();
}

function warnToasts() {
  return Array.from(document.querySelectorAll("#toast-host .toast.warn")).map((el) => el.textContent);
}

test("a hosted save that lands after a same-id reopen is not adopted, and the next save merges it in", async (t) => {
  mockClock(t);
  const server = createServer();
  server.put("srv-a", script(), 1);
  const held = withServer(t, server);
  openHosted("srv-a", 1);

  currentDocument().rows[0].audioText = "Typed before the save.";
  noteSessionEdit();
  held.holdWhen((r) => r.method === "PUT");
  const saving = saveDoc({ auto: true });
  await held.gates.arrived("fetch");

  assert.equal(await hosted.openServerDoc("srv-a"), true, "the document was reopened");
  assert.equal(textOf(currentDocument().rows[0]), "One.", "the reopened copy shows the server's revision 1");
  const warnedBefore = warnToasts().length;

  held.gates.releaseAll("fetch");
  await saving;
  await settle();
  const late = {
    rev: homeModule.currentHome().rev,
    baseText: textOf(mergeBase().rows[0]),
    shown: textOf(currentDocument().rows[0]),
    warned: warnToasts().slice(warnedBefore),
    halted: autoSavePolicy().halted()
  };
  assert.equal(server.docs.get("srv-a").rev, 2, "the late save reached the server");

  currentDocument().rows[1].audioText = "Typed after the reopen.";
  noteSessionEdit();
  await saveDoc();
  await settle();

  const stored = server.docs.get("srv-a");
  assert.equal(textOf(stored.state.rows[0]), "Typed before the save.", "the server still holds the text typed before the late save");
  assert.equal(textOf(stored.state.rows[1]), "Typed after the reopen.", "the server holds the edit made after the reopen");
  assert.deepEqual(server.answered.map((a) => a.baseRev + ":" + a.status), ["1:200", "1:409", "2:200"], "the next save was refused once and retried after a merge");
  assert.equal(late.rev, 1, "the reopened session keeps its own revision");
  assert.equal(late.baseText, "One.", "the reopened session keeps its own baseline");
  assert.equal(late.shown, "One.", "the late save did not change the reopened copy");
  assert.deepEqual(late.warned, ["An earlier save of this script arrived late. Your next save will merge both versions."], "the late save is reported with one warning");
  assert.equal(late.halted, "", "a late save that landed does not pause autosave");
  leave();
});

test("a hosted save that lands after another server document was opened is not reported or adopted", async (t) => {
  mockClock(t);
  const server = createServer();
  server.put("srv-e", script(), 1);
  server.put("srv-f", script(), 4);
  const held = withServer(t, server);
  openHosted("srv-e", 1);

  currentDocument().rows[0].audioText = "Typed in E.";
  noteSessionEdit();
  held.holdWhen((r) => r.method === "PUT");
  const saving = saveDoc();
  await held.gates.arrived("fetch");
  assert.equal(await hosted.openServerDoc("srv-f"), true, "the other document opened");
  const warnedBefore = warnToasts().length;

  held.gates.releaseAll("fetch");
  await saving;
  await settle();

  assert.equal(server.docs.get("srv-e").rev, 2, "the save of E reached the server");
  assert.equal(homeModule.currentHome().id, "srv-f", "F stays open");
  assert.equal(homeModule.currentHome().rev, 4, "F keeps its own revision");
  assert.equal(textOf(mergeBase().rows[0]), "One.", "F keeps its own baseline");
  assert.deepEqual(warnToasts().slice(warnedBefore), [], "a save that went to another document's place is not reported");
  leave();
});

test("a history restore made while a hosted save is in flight sticks, on screen and on the server", async (t) => {
  mockClock(t);
  const server = createServer();
  server.put("srv-r", script(), 1);
  const held = withServer(t, server);
  openHosted("srv-r", 1);
  const ticket = pushSnapshot("The version to go back to", cloneState(currentDocument()));
  await ticket.done;

  currentDocument().rows[0].audioText = "Typed then regretted.";
  noteSessionEdit();
  held.holdWhen((r) => r.method === "PUT");
  const saving = saveDoc({ auto: true });
  await held.gates.arrived("fetch");

  const button = document.createElement("button");
  button.setAttribute("data-id", ticket.id);
  assert.equal(await restoreSnapshotFromCard(button), "restored", "the earlier version was restored");
  assert.equal(textOf(currentDocument().rows[0]), "One.", "the restored version is on screen");
  const warnedBefore = warnToasts().length;

  held.gates.releaseAll("fetch");
  await saving;
  await settle();
  const late = { rev: homeModule.currentHome().rev, warned: warnToasts().slice(warnedBefore) };

  await saveDoc();
  await settle();

  assert.equal(textOf(currentDocument().rows[0]), "One.", "the restored version is still on screen");
  assert.equal(textOf(server.docs.get("srv-r").state.rows[0]), "One.", "the server holds the restored version");
  assert.deepEqual(server.answered.map((a) => a.baseRev + ":" + a.status), ["1:200", "2:200"], "the save after the restore went on top of the late save");
  assert.equal(late.rev, 2, "the late save moved the revision of the place it was sent to");
  assert.deepEqual(late.warned, [], "a save that landed where the restored copy saves is not reported");
  leave();
});

test("a hosted save whose revision the reopen already fetched is not reported", async (t) => {
  mockClock(t);
  const server = createServer();
  server.put("srv-h", script(), 1);
  withServer(t, server);
  openHosted("srv-h", 1);

  currentDocument().rows[0].audioText = "Saved before the reopen.";
  noteSessionEdit();
  const releaseReply = server.holdPutReply();
  const saving = saveDoc({ auto: true });
  for (let turn = 0; turn < 2000 && !server.answered.length; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.docs.get("srv-h").rev, 2, "the server accepted the save before replying");

  assert.equal(await hosted.openServerDoc("srv-h"), true, "the document was reopened");
  assert.equal(textOf(currentDocument().rows[0]), "Saved before the reopen.", "the reopened copy already shows the saved text");
  const warnedBefore = warnToasts().length;

  releaseReply();
  await saving;
  await settle();

  assert.equal(homeModule.currentHome().rev, 2, "the reopened session keeps the revision it fetched");
  assert.deepEqual(warnToasts().slice(warnedBefore), [], "a save the reopened copy already holds is not reported");
  leave();
});

test("a pull noticed while a hosted save waits for its reply does not run, and the save completes in the same session", async (t) => {
  mockClock(t);
  const server = createServer();
  server.put("srv-b", script(), 1);
  withServer(t, server);
  openHosted("srv-b", 1);

  currentDocument().rows[0].audioText = "Typed and saved.";
  noteSessionEdit();
  const releaseReply = server.holdPutReply();
  const saving = hosted.saveToServer();
  for (let turn = 0; turn < 2000 && !server.answered.length; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.docs.get("srv-b").rev, 2, "the server accepted the save before replying");

  const warnedBefore = warnToasts().length;
  hosted.notePresenceRev({ docId: "srv-b", rev: 2 });
  await settle();
  assert.equal(homeModule.currentHome().rev, 1, "the pull waits while the save runs");
  releaseReply();
  assert.equal(await saving, true, "the save reports success");
  await settle();

  assert.equal(homeModule.currentHome().rev, 2, "the session takes the revision its save produced");
  assert.equal(textOf(mergeBase().rows[0]), "Typed and saved.", "the baseline is what the server accepted");
  assert.deepEqual(warnToasts().slice(warnedBefore), [], "no late-save warning in the session that saved");
  leave();
});

test("a pull whose connection changes before the answer arrives merges nothing; the next pull does", async (t) => {
  mockClock(t);
  const server = createServer();
  server.put("srv-p", script(), 1);
  withServer(t, server);
  openHosted("srv-p", 1);
  const changed = script();
  changed.rows[0].audioText = "Saved by someone else.";
  server.put("srv-p", changed, 2);

  const before = textOf(currentDocument().rows[0]);
  hosted.notePresenceRev({ docId: "srv-p", rev: 2 });
  hosted.setServerToken("another-token");
  await settle();
  assert.equal(textOf(currentDocument().rows[0]), before, "nothing fetched under the old connection was merged into the document");
  assert.equal(homeModule.currentHome().rev, 1, "the tracked revision did not move");
  hosted.notePresenceRev({ docId: "srv-p", rev: 2 });
  await settle();
  assert.equal(textOf(currentDocument().rows[0]), "Saved by someone else.", "a pull under the current connection merges");
  assert.equal(homeModule.currentHome().rev, 2);
  hosted.clearServerToken();
  leave();
});

test("a plain hosted save adopts its revision and baseline and clears the unsaved flag", async (t) => {
  mockClock(t);
  const server = createServer();
  server.put("srv-c", script(), 1);
  withServer(t, server);
  openHosted("srv-c", 1);

  currentDocument().rows[0].audioText = "Saved plainly.";
  noteSessionEdit();
  const warnedBefore = warnToasts().length;
  await saveDoc();
  await settle();

  assert.equal(homeModule.currentHome().rev, 2, "the revision moved to the saved one");
  assert.equal(textOf(mergeBase().rows[0]), "Saved plainly.", "the baseline is the saved text");
  assert.equal(unsavedChanges(), false, "the document reads as saved");
  assert.deepEqual(warnToasts().slice(warnedBefore), [], "no late-save warning");
  leave();
});
