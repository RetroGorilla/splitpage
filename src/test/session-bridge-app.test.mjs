import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

await bootApp();

const { liveSession } = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { adoptRestoredState } = await import("../js/02b-doc-id.js");
const { applyMerge, cloneState } = await import("../js/03-sync.js");
const { scheduleIdleRefresh, productionIndexStats } = await import("../js/07-production-tags.js");
const { markDirty } = await import("../js/12-dirty-toast.js");
const { flushEdits, lastUndoEntry, undoSizes } = await import("../js/12a-undo.js");
const { openProjectFile, reloadFileFromDisk } = await import("../js/18-local-files.js");
const { startNewScript } = await import("../js/18b-file-menu.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");

after(closeApp);

const session = liveSession();
const heard = [];
session.subscribe((c) => heard.push(c.kind));

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

await openProjectFile(new File([buildSplitpageFile(script("Bridge"))], "bridge.splitpage", { lastModified: 1 }), null, { skipSnapshot: true });

test("the booted app's session holds the live document it adopted when the file opened", () => {
  assert.equal(S.state.title, "Bridge");
  assert.equal(held(), S.state);
  assert.ok(session.epoch() >= 2, "the seed and then the file were each adopted");
});

test("markDirty is one session edit: one generation, one S.editSeq, dirty, and one undo entry once the edit is flushed", () => {
  const gen = session.generation(), seq = S.editSeq, entries = undoSizes().undo;
  heard.length = 0;
  S.state.rows[0].audioText = "One, edited.";
  markDirty();
  assert.equal(session.generation(), gen + 1);
  assert.equal(S.editSeq, seq + 1);
  assert.equal(S.dirty, true);
  assert.deepEqual(heard, ["edit"]);
  flushEdits();
  assert.equal(undoSizes().undo, entries + 1);
  assert.equal(lastUndoEntry().steps[0].key, "audioText");
});

test("opening another document, or restoring one with the same id, opens a new epoch and is no edit", () => {
  const epoch = session.epoch(), gen = session.generation(), seq = S.editSeq;
  startNewScript();
  assert.equal(session.epoch(), epoch + 1);
  assert.equal(held(), S.state);
  const docId = S.state.docId;
  adoptRestoredState(cloneState(S.state));
  assert.equal(S.state.docId, docId, "the same document id");
  flushEdits();
  assert.equal(session.epoch(), epoch + 2, "a new epoch all the same");
  assert.equal(held(), S.state);
  assert.equal(session.generation(), gen);
  assert.equal(S.editSeq, seq);
  assert.equal(undoSizes().undo, 0);
});

test("a server update keeps the epoch, hands the session the merged document and records no undo entry for the merge", () => {
  const base = script("Merge");
  S.state = cloneState(base);
  flushEdits();
  const epoch = session.epoch(), gen = session.generation();
  const theirs = cloneState(base);
  theirs.rows[1].audioText = "Theirs.";
  heard.length = 0;
  applyMerge({ base: base, mine: cloneState(base), theirs: theirs, source: "stash", report: false });
  assert.equal(session.epoch(), epoch);
  assert.equal(session.generation(), gen);
  assert.equal(held(), S.state);
  assert.equal(S.state.rows[1].audioText, "Theirs.");
  assert.deepEqual(heard, ["server"]);
  flushEdits();
  assert.equal(undoSizes().undo, 0);
});

test("a reload in place is its own kind: same epoch, no generation of its own, no undo entry", async () => {
  let disk = new File(["Wide\tOne.\nClose\tTwo."], "reload.txt", { lastModified: 1 });
  const handle = { kind: "file", name: "reload.txt", getFile: async () => disk };
  await openProjectFile(disk, handle, { skipSnapshot: true });
  const doc = S.state;
  const epoch = session.epoch(), gen = session.generation();
  heard.length = 0;
  disk = new File(["Wide\tOne, again.\nClose\tTwo."], "reload.txt", { lastModified: 2 });
  await reloadFileFromDisk();
  assert.equal(S.state, doc, "reloaded in place");
  assert.match(S.state.rows[0].audioText, /again/);
  assert.deepEqual(heard, ["reload", "edit"], "the reload, then the markDirty loadFileIntoEditor calls after it");
  assert.equal(session.epoch(), epoch);
  assert.equal(session.generation(), gen + 1, "the reload adds none; its markDirty adds one");
  flushEdits();
  assert.equal(undoSizes().undo, 0, "the reloaded text is not an undo step");
});

test("the idle refresh goes through the session's scheduler: requests in one window run the refresh once", async () => {
  await new Promise((r) => setTimeout(r, 1100));
  const before = productionIndexStats().flushes;
  scheduleIdleRefresh("production");
  scheduleIdleRefresh("writerStats");
  scheduleIdleRefresh("production");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(productionIndexStats().flushes, before + 1);
});
