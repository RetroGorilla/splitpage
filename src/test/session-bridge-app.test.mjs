import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentDocument } from "../legacy/session-bridge.ts";
import { cloneState } from "../core/document/clone.ts";
import { saveChanges, unsavedChanges } from "../legacy/save-bridge.ts";
import { restoreDesktop, useDesktopForTest } from "../adapters/desktop/desktop-port.ts";

await bootApp();

const { liveSession, noteReload } = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { adoptRestoredState } = await import("../js/02b-doc-id.js");
const { applyMerge, restoreSnapshotFromCard } = await import("../js/03-sync.js");
const { scheduleIdleRefresh, productionIndexStats } = await import("../js/07-production-tags.js");
const { noteSessionEdit } = await import("../legacy/session-bridge.ts");
const { flushEdits, lastUndoEntry, undoSizes } = await import("../js/12a-undo.js");
const { reloadFileFromDisk } = await import("../js/18-local-files.js");
const { startNewScript } = await import("../js/18b-file-menu.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { applyTakenDraft } = await import("../js/20g-drafts.js");
const { loadTestDocument } = await import("./_document.mjs");
const { openDocument, keepSnapshot } = await import("../legacy/transition-bridge.ts");

after(closeApp);

const session = liveSession();
const heard = [];
let stopHearing = session.subscribe((c) => heard.push(c.kind));

function listen() {
  stopHearing();
  heard.length = 0;
  stopHearing = session.subscribe((c) => heard.push(c.kind));
}

const held = () => session.read((doc) => doc);

function script(title) {
  return migrateRows({
    schema: 5, title: title, docId: "d" + "3".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ]
  });
}

await openDocument({ kind: "file", file: new File([buildSplitpageFile(exportDocumentOf(script("Bridge")))], "bridge.splitpage", { lastModified: 1 }), handle: null, options: { skipSnapshot: true } });

test("the booted app's session holds the live document it adopted when the file opened", () => {
  assert.equal(currentDocument().title, "Bridge");
  assert.equal(held(), currentDocument());
  assert.ok(session.epoch() >= 2, "the seed and then the file were each adopted");
});

test("noteSessionEdit is one session edit: one generation, one saveChanges(), dirty, and one undo entry once the edit is flushed", () => {
  const gen = session.generation(), seq = saveChanges(), entries = undoSizes().undo;
  listen();
  currentDocument().rows[0].audioText = "One, edited.";
  noteSessionEdit();
  assert.equal(session.generation(), gen + 1);
  assert.equal(saveChanges(), seq + 1);
  assert.equal(unsavedChanges(), true);
  assert.deepEqual(heard, ["edit"]);
  flushEdits();
  assert.equal(undoSizes().undo, entries + 1);
  assert.equal(lastUndoEntry().steps[0].key, "audioText");
});

test("opening another document, or restoring one with the same id, opens a new epoch and is no edit", () => {
  const epoch = session.epoch(), gen = session.generation(), seq = saveChanges();
  listen();
  startNewScript();
  assert.equal(session.epoch(), epoch + 1, "a new script is adopted at the transition, with no flush or render first");
  assert.equal(held(), currentDocument());
  assert.deepEqual(heard, [], "and its session is a new one: a subscription made for the old document hears nothing of it");
  listen();
  const docId = currentDocument().docId;
  adoptRestoredState(cloneState(currentDocument()));
  assert.equal(currentDocument().docId, docId, "the same document id");
  flushEdits();
  assert.equal(session.epoch(), epoch + 2, "a new epoch all the same");
  assert.equal(held(), currentDocument());
  assert.equal(session.generation(), gen);
  assert.equal(saveChanges(), seq);
  assert.equal(undoSizes().undo, 0);
});

test("a merge right after a document was swapped in, with no flush between, leaves the session holding the merged document", () => {
  const base = script("Merge");
  const epoch = session.epoch(), gen = session.generation();
  listen();
  loadTestDocument(cloneState(base));
  const theirs = cloneState(base);
  theirs.rows[1].audioText = "Theirs.";
  applyMerge({ base: base, mine: cloneState(base), theirs: theirs, source: "server-conflict", report: false });
  assert.deepEqual(heard, ["adopt", "server"], "the session adopts the swapped-in document as it is handed over, then the merge lands");
  assert.equal(session.epoch(), epoch + 1);
  assert.equal(session.generation(), gen);
  assert.equal(held(), currentDocument());
  assert.equal(held().rows[1].audioText, "Theirs.");
  flushEdits();
  assert.equal(undoSizes().undo, 0);
});

test("a server update over undo entries forgets the ones on a field their side changed and keeps the rest", () => {
  loadTestDocument(cloneState(script("Forget")));
  flushEdits();
  currentDocument().rows[0].audioText = "Mine, one.";
  noteSessionEdit();
  flushEdits();
  currentDocument().rows[1].visualText = "Mine, close.";
  noteSessionEdit();
  flushEdits();
  assert.equal(undoSizes().undo, 2);
  const epoch = session.epoch();
  const theirs = cloneState(currentDocument());
  theirs.rows[1].visualText = "Their close.";
  listen();
  applyMerge({ theirs: theirs, source: "server-conflict", unchanged: true, report: false });
  assert.deepEqual(heard, ["server"]);
  assert.equal(session.epoch(), epoch);
  assert.equal(held(), currentDocument());
  assert.equal(undoSizes().undo, 1);
  assert.deepEqual([lastUndoEntry().steps[0].rowId, lastUndoEntry().steps[0].key], ["r1", "audioText"]);
});

test("a reported merge marks the document dirty and advances saveChanges() as before, but adds no edit generation", () => {
  const base = script("Reported");
  loadTestDocument(cloneState(base));
  flushEdits();
  const theirs = cloneState(base);
  theirs.rows[1].audioText = "Theirs.";
  const mine = cloneState(base);
  mine.rows[0].audioText = "Mine.";
  const gen = session.generation(), seq = saveChanges();
  listen();
  applyMerge({ base: base, mine: mine, theirs: theirs, source: "server-conflict" });
  assert.deepEqual(heard, ["server"]);
  assert.equal(session.generation(), gen);
  assert.equal(saveChanges(), seq + 1);
  assert.equal(unsavedChanges(), true);
});

test("a reload in place is its own kind: same epoch, no generation, saveChanges() and dirty as before, no undo entry", async () => {
  let disk = new File(["Wide\tOne.\nClose\tTwo."], "reload.txt", { lastModified: 1 });
  const handle = { kind: "file", name: "reload.txt", getFile: async () => disk };
  await openDocument({ kind: "file", file: disk, handle: handle, options: { skipSnapshot: true } });
  const doc = currentDocument();
  const epoch = session.epoch(), gen = session.generation(), seq = saveChanges();
  listen();
  disk = new File(["Wide\tOne, again.\nClose\tTwo."], "reload.txt", { lastModified: 2 });
  await reloadFileFromDisk();
  assert.equal(currentDocument(), doc, "reloaded in place");
  assert.match(currentDocument().rows[0].audioText, /again/);
  assert.deepEqual(heard, ["reload"]);
  assert.equal(session.epoch(), epoch);
  assert.equal(session.generation(), gen);
  assert.equal(saveChanges(), seq + 1, "loadFileIntoEditor's dirty marking still counts");
  assert.equal(unsavedChanges(), true);
  flushEdits();
  assert.equal(undoSizes().undo, 0, "the reloaded text is not an undo step");
});

test("a reload into a document swapped in with no flush lands in the document the app shows", () => {
  const before = held();
  const beforeText = JSON.stringify(before);
  listen();
  loadTestDocument(cloneState(script("Swapped")));
  const doc = currentDocument();
  const taken = noteReload({ title: "Reloaded", rows: [{ id: "r1", visualText: "Wide", audioText: "Reloaded." }] });
  assert.equal(currentDocument(), doc);
  assert.equal(taken, doc);
  assert.equal(held(), doc);
  assert.equal(doc.title, "Reloaded");
  assert.deepEqual(doc.rows.map((row) => [row.audioText, row.status]), [["Reloaded.", "todo"]]);
  assert.deepEqual(heard, ["adopt", "reload"], "the session adopts the swapped-in document as it is handed over, then the reload lands in it");
  assert.equal(JSON.stringify(before), beforeText, "the document held before is not written into");
});

test("E4: resumeServerDoc's merge is a recovery: a new epoch, the undo stack kept, no generation, no undo entry", () => {
  const source = readFileSync(new URL("../js/13-hosted.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function resumeServerDoc"), source.indexOf("\n}\n", source.indexOf("async function resumeServerDoc")));
  assert.equal(body.split('source: "server-resume"').length - 1, 2, "both of resumeServerDoc's merges name the server-resume source");
  const base = script("Resume");
  loadTestDocument(cloneState(base));
  flushEdits();
  currentDocument().rows[0].audioText = "Typed while reopening.";
  noteSessionEdit();
  flushEdits();
  const theirs = cloneState(base);
  theirs.rows[1].audioText = "Server.";
  const epoch = session.epoch(), gen = session.generation(), seq = saveChanges();
  listen();
  applyMerge({ base: base, mine: currentDocument(), theirs: theirs, source: "server-resume", newBase: cloneState(theirs), noAutoSave: true });
  assert.deepEqual(heard, ["recovery"]);
  assert.equal(session.epoch(), epoch + 1);
  assert.equal(session.generation(), gen);
  assert.equal(saveChanges(), seq + 1);
  assert.equal(held(), currentDocument());
  flushEdits();
  assert.equal(undoSizes().undo, 1, "12a's stack is kept through the merge, as before");
});

test("E4: a file draft restored onto a changed file is a recovery merge; an untitled draft is an adoption; neither adds a generation", async () => {
  const docId = "d" + "2".repeat(32);
  const original = migrateRows({ schema: 5, title: "On disk", docId: docId, rows: [{ id: "r1", visualText: "W", audioText: "One.", status: "todo" }, { id: "r2", visualText: "C", audioText: "Two.", status: "todo" }] });
  const changed = cloneState(original);
  changed.rows[1].audioText = "Changed on disk.";
  const mine = cloneState(original);
  mine.rows[0].audioText = "Unsaved here.";
  useDesktopForTest({
    readFile: async () => ({ name: "disk.splitpage", bytes: new TextEncoder().encode(buildSplitpageFile(exportDocumentOf(changed))), lastModified: 2 }),
    setDocumentState: () => {},
    draftRestoreDone: () => {}
  });
  try {
    const epoch = session.epoch(), gen = session.generation();
    listen();
    await applyTakenDraft({
      header: { origin: { kind: "file", fileName: "disk.splitpage" }, docIdWrittenOut: true },
      file: { id: "f1", name: "disk.splitpage" },
      stateJson: JSON.stringify(mine),
      baseJson: JSON.stringify(original)
    });
    assert.deepEqual(heard, [], "the file opens at the transition, so a subscription made for the old document hears nothing of the merge");
    assert.equal(session.epoch(), epoch + 2, "the file opens an epoch at the transition and the recovery merge opens another");
    assert.equal(session.generation(), gen);
    assert.equal(held(), currentDocument());
    assert.equal(currentDocument().rows[0].audioText, "Unsaved here.");
    assert.equal(currentDocument().rows[1].audioText, "Changed on disk.");
  } finally {
    restoreDesktop();
  }
  const epoch = session.epoch(), gen = session.generation(), seq = saveChanges();
  listen();
  await applyTakenDraft({ header: { origin: { kind: "untitled" } }, stateJson: JSON.stringify(script("Untitled draft")) });
  assert.deepEqual(heard, [], "the draft is recovered at the transition, a new session: a subscription made for the old document hears nothing of it");
  assert.equal(session.epoch(), epoch + 1);
  assert.equal(session.generation(), gen);
  assert.equal(saveChanges(), seq + 1);
  assert.equal(unsavedChanges(), true);
  assert.equal(held(), currentDocument());
});

test("importing a file is an adoption at the transition that marks the document dirty and advances saveChanges() as before, with no edit generation", async () => {
  const gen = session.generation(), epoch = session.epoch(), seq = saveChanges();
  listen();
  await openDocument({ kind: "file", file: new File(["Wide\tOne.\nClose\tTwo."], "import.txt", { lastModified: 1 }), handle: null, options: { skipSnapshot: true } });
  assert.deepEqual(heard, [], "the import is a new session: a subscription made for the old document hears nothing of it");
  assert.equal(session.epoch(), epoch + 1);
  assert.equal(session.generation(), gen);
  assert.equal(saveChanges(), seq + 1);
  assert.equal(unsavedChanges(), true);
  assert.equal(held(), currentDocument());
});

test("restoring a version from history is an adoption at the transition that marks the document dirty as before, with no edit generation", async () => {
  loadTestDocument(cloneState(script("History")));
  flushEdits();
  const point = cloneState(currentDocument());
  point.rows[0].audioText = "As it was.";
  const ticket = keepSnapshot("A point to go back to", point);
  await ticket.done;
  const button = document.createElement("button");
  button.setAttribute("data-id", ticket.id);
  const gen = session.generation(), epoch = session.epoch(), seq = saveChanges();
  listen();
  assert.equal(await restoreSnapshotFromCard(button), "restored");
  assert.equal(currentDocument().rows[0].audioText, "As it was.");
  assert.deepEqual(heard, [], "the version is restored at the transition, a new session: a subscription made for the old document hears nothing of it");
  assert.equal(session.epoch(), epoch + 1);
  assert.equal(session.generation(), gen);
  assert.equal(saveChanges(), seq + 1);
  assert.equal(unsavedChanges(), true);
  assert.equal(held(), currentDocument());
});

test("the idle refresh goes through the session's scheduler: requests in one window run the refresh once, 180 ms after the last", async (t) => {
  await new Promise((r) => setTimeout(r, 1500));
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const before = productionIndexStats().flushes;
  scheduleIdleRefresh("production");
  t.mock.timers.tick(100);
  scheduleIdleRefresh("writerStats");
  scheduleIdleRefresh("production");
  t.mock.timers.tick(179);
  assert.equal(productionIndexStats().flushes, before);
  t.mock.timers.tick(1);
  assert.equal(productionIndexStats().flushes, before + 1);
  t.mock.timers.tick(2000);
  assert.equal(productionIndexStats().flushes, before + 1);
});
