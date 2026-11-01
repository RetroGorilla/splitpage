import { bootApp, closeApp } from "./_app-boot.mjs";
import { text as portText } from "../bootstrap/wiring/ports/text.ts";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { confirmSavedNow, unsavedChanges } from "../bootstrap/wiring/save-owners.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const undo = () => undoOwner().undo();
const redo = () => undoOwner().redo();
const undoSizes = () => undoOwner().sizes();
const flushEdits = () => undoOwner().flush();
const breakUndoCoalescing = () => undoOwner().breakCoalescing();
const { liveSession, runDocumentEdit, stampDocument } = await import("../bootstrap/wiring/session-owner.ts");
const { setTargetLength } = await import("../features/rundown/target.ts");
const { registerProductionTag, findOrAddPerson } = await import("../features/tags/production-tags.js");
const { renameTag, removeTag, newBrollRecord, removeBrollProp } = await import("../application/commands/production-actions.ts");
const { retagRewrites: planRetagRewrites, retagMentions: countRetagMentions } = await import("../application/commands/tag-rewrites.ts");

const retagText = portText;
const retagRewrites = (tags, toName) => planRetagRewrites(retagText, tags, toName);
const retagMentions = (doc, tags) => countRetagMentions(retagText, doc, tags);
const { sessionStamps, readSession } = await import("../bootstrap/wiring/session-owner.ts");
const { randomIds } = await import("../adapters/identity/ids.ts");
const { currentBrollRecords } = await import("../bootstrap/wiring/broll.ts");
const addBrollProp = (...args) => currentBrollRecords().addBrollProp(...args);
const { setCommentAssignee, toggleResolve } = await import("../features/comments/comments.js");
const { wordsPerMinuteCommand } = await import("../application/commands/document-settings.ts");
const { deletePersonCommand } = await import("../application/commands/production-records.ts");
const { editStamp, documentIdStamp } = await import("../application/commands/save-stamps.ts");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");

after(closeApp);

const realNow = Date.now;
let clock = 11_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const OLD = "2020-01-01T00:00:00.000Z";

function fixture() {
  return {
    schema: 2,
    title: "Document edits",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "The <span class=\"tag-anchor\" data-tag-cat=\"prop\" data-tag-name=\"Net\">net</span> dries.", status: "todo", updatedAt: OLD, updatedBy: "Old" },
      { id: "r2", visualText: "Close", audioText: "Second line", status: "ready", updatedAt: OLD, updatedBy: "Old" }
    ],
    comments: [{ id: "c1", rowId: "r2", field: "audioText", body: "Tighter", replies: [] }],
    people: [{ id: "p1", name: "Mara" }],
    brollShots: [{ id: "b1", name: "Pier", status: "unshot", owner: "p1", props: [] }]
  };
}

let opened = 0;
async function open() {
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(fixture())))], "document-edits-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file: file, handle: null, options: { skipSnapshot: true } });
  flushEdits();
  breakUndoCoalescing();
}

const settle = () => new Promise((r) => setImmediate(r));
const held = () => liveSession().read((doc) => doc);
const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const tagNamed = (cat, name) => held().productionTags.find((t) => t && t.cat === cat && t.name === name);

async function roundTrip(gesture, look) {
  const before = copy(look());
  const generation = liveSession().generation();
  const sizes = undoSizes();
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c));
  try {
    assert.ok(gesture(), "the edit reports it was made");
    await settle();
  } finally {
    stop();
  }
  assert.equal(seen.filter((c) => c.kind === "edit").length, 1, "one edit is published");
  assert.equal(seen[0].changes.whole, false, "the session is told exactly what changed");
  assert.equal(liveSession().generation(), generation + 1, "one generation");
  assert.equal(undoSizes().undo, sizes.undo + 1, "one undo entry");
  const done = copy(look());
  assert.notDeepEqual(done, before, "the edit changed the document");
  undo();
  await settle();
  assert.deepEqual(copy(look()), before, "one undo puts it back");
  redo();
  await settle();
  assert.deepEqual(copy(look()), done, "one redo makes it again");
}

beforeEach(() => { clock += 10_000; });

test("document edits: target length undoes and redoes in one step", async () => {
  await open();
  await roundTrip(() => setTargetLength(150), () => held().targetSeconds);
});

test("document edits: words per minute undoes and redoes in one step", async () => {
  await open();
  await roundTrip(() => runDocumentEdit(wordsPerMinuteCommand(190)), () => held().wordsPerMinute);
});

test("document edits: registering a tag and adding a person undo and redo in one step", async () => {
  await open();
  await roundTrip(() => registerProductionTag("gear", "Drone"), () => held().productionTags);
  assert.ok(tagNamed("gear", "Drone"));
  await roundTrip(() => !!findOrAddPerson("Sam"), () => held().people);
});

test("document edits: renaming and removing a tag rewrite its mentions and undo in one step", async () => {
  await open();
  const look = () => ({ text: held().rows[0].audioText, tags: held().productionTags });
  await roundTrip(() => renameTag("prop", "Net", "Trawl", { run: runDocumentEdit, rewrites: retagRewrites, stamps: sessionStamps }), look);
  assert.match(held().rows[0].audioText, /data-tag-name="Trawl"/);
  await roundTrip(() => removeTag("prop", "Trawl", { run: runDocumentEdit, read: readSession, mentions: retagMentions, rewrites: retagRewrites, stamps: sessionStamps }) > 0, look);
  assert.doesNotMatch(held().rows[0].audioText, /tag-anchor/);
});

test("document edits: b-roll shots and their props undo and redo in one step", async () => {
  await open();
  await roundTrip(() => !!newBrollRecord({ name: "Gulls" }, { run: runDocumentEdit, ids: randomIds }), () => held().brollShots);
  await roundTrip(() => addBrollProp("b1", "Rope"), () => ({ shots: held().brollShots, tags: held().productionTags }));
  const prop = held().brollShots.find((b) => b.id === "b1").props[0];
  await roundTrip(() => removeBrollProp("b1", prop.id, { run: runDocumentEdit }), () => held().brollShots);
});

test("document edits: deleting a person undoes in one step with their ownership", async () => {
  await open();
  await roundTrip(() => runDocumentEdit(deletePersonCommand("p1")), () => ({ people: held().people, shots: held().brollShots }));
});

test("document edits: assigning and resolving a comment undo and redo in one step", async () => {
  await open();
  await roundTrip(() => { setCommentAssignee("c1", "Mara"); return held().comments[0].assignee === "Mara"; }, () => held().comments);
  await roundTrip(() => { toggleResolve("c1"); return held().comments[0].resolved === true; }, () => held().comments);
});

test("document edits: a save stamp changes the document without an undo entry or an unsaved change", async () => {
  await open();
  confirmSavedNow();
  const sizes = undoSizes();
  const generation = liveSession().generation();
  const out = stampDocument(editStamp({ rev: 7, lastEditedBy: "Adam", lastEditedAt: "2026-10-22T00:00:00.000Z" }));
  assert.equal(out.kind, "applied");
  assert.equal(held().rev, 7);
  assert.equal(held().lastEditedBy, "Adam");
  assert.equal(liveSession().generation(), generation, "a save is not an edit");
  assert.deepEqual(undoSizes(), sizes, "a stamp is not an edit to undo");
  assert.equal(unsavedChanges(), false, "a stamp does not make the document unsaved");
  const was = held().docId;
  assert.equal(stampDocument(documentIdStamp(was, "d" + "4".repeat(32))).kind, "applied");
  assert.equal(held().docId, "d" + "4".repeat(32));
  assert.deepEqual(undoSizes(), sizes);
});
