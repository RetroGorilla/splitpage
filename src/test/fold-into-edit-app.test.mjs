import { bootApp, closeApp, rewireRunningApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { createHeldFetch, createHeldImageDecode } from "./_m4-matrix.mjs";
import { unsavedChanges } from "../legacy/save-bridge.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { getEditorName } = await import("../js/03-sync.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { foldIntoEdit, undo, redo, undoSizes, lastUndoEntry, flushEdits } = await import("../js/12a-undo.js");
const { thumbnailsAfterPaste } = await import("../js/05v-video.js");
const { liveSession } = await import("../legacy/session-bridge.ts");
const { addGalleryVideo, setVideoThumbnail, videoLinkKey } = await import("../core/document/gallery.ts");
const writer = await import("../js/19-writer.js");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");

const naming = { name: getEditorName };
await rewireRunningApp({ editorName: () => naming.name() });

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const decode = createHeldImageDecode({ dataUrl: PNG, encodedDataUrl: PNG });
const uninstallDecode = decode.install();

after(() => {
  uninstallDecode();
  closeApp();
});

const realNow = Date.now;
let clock = 7_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const VIDEO = "https://youtu.be/dQw4w9WgXcQ";
const VIDEO_KEY = videoLinkKey({ href: VIDEO });
const THUMB = { sha256: "a".repeat(64), mime: "image/jpeg" };
const GALLERY = /^(imageRef|imageLinks|moreImages|imageName)$/;
const touchesR1 = (s) => s.op === "rowField" && s.rowId === "r1" && GALLERY.test(s.key);
const giveThumb = (ref) => (state) => setVideoThumbnail(state.rows.find((r) => r.id === "r1"), VIDEO_KEY, ref);

function fixture() {
  return {
    schema: 2,
    title: "Fold",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Alpha", status: "todo", updatedAt: "2020-01-01T00:00:00.000Z", updatedBy: "Old" },
      { id: "r2", visualText: "Close", audioText: "Bravo", status: "ready", updatedAt: "2020-01-01T00:00:00.000Z", updatedBy: "Old" }
    ],
    comments: []
  };
}

let opened = 0;
async function open() {
  if (viewFlags().writerOpen()) writer.closeWriter();
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(fixture())))], "fold-" + (++opened) + ".splitpage", { lastModified: opened });
  await openProjectFile(file, null, { skipSnapshot: true });
  flushEdits();
}

const settle = () => new Promise((r) => setImmediate(r));
const row = (id) => S.state.rows.find((r) => r.id === id);
const docText = () => JSON.stringify(S.state);

function edit(fn) {
  clock += 5_000;
  const before = lastUndoEntry();
  fn(S.state);
  liveSession().noteEdit();
  flushEdits();
  const entry = lastUndoEntry();
  assert.notEqual(entry, before, "the edit made an undo entry");
  return entry;
}

const pasteVideo = () => edit((s) => { s.rows[0].audioText = "Alpha pasted"; addGalleryVideo(s.rows[0], { href: VIDEO }); });

function watch() {
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push({ kind: c.kind, generation: c.generation, changes: c.changes, stamp: row("r1") && row("r1").updatedAt, thumb: !!(row("r1") && row("r1").imageRef) }));
  return { seen, stop };
}

beforeEach(() => { clock += 10_000; });

test("6.3: the thumbnail amendment is one transaction: one generation, one publication as an amendment, no undo step of its own", async () => {
  await open();
  const entry = pasteVideo();
  edit((s) => { s.rows[1].audioText = "Bravo typed"; });
  const sizes = undoSizes();
  const generation = liveSession().generation();
  clock += 60_000;
  const stampBefore = row("r1").updatedAt;
  const w = watch();
  let done;
  try {
    done = foldIntoEdit(entry, touchesR1, giveThumb(THUMB));
    await settle();
  } finally {
    w.stop();
  }
  assert.equal(done, true);
  assert.equal(row("r1").imageRef.sha256, THUMB.sha256);
  assert.equal(liveSession().generation(), generation + 1, "one generation");
  assert.deepEqual(w.seen.map((c) => c.kind), ["amend"], "one publication, as an amendment");
  assert.deepEqual(undoSizes(), sizes, "the history count is unchanged by the amendment");
  assert.ok(w.seen[0].thumb, "the thumbnail was written before the amendment was published");
  assert.notEqual(w.seen[0].stamp, stampBefore, "the scene was stamped before the amendment was published");
  assert.equal(row("r1").updatedBy, getEditorName());
  const cells = w.seen[0].changes.cells.map((c) => c.rowId + "." + c.field);
  assert.ok(cells.includes("r1.imageRef"), "the change set names the written field: " + cells.join(", "));
  assert.ok(cells.includes("r1.updatedAt") && cells.includes("r1.updatedBy"), "the change set names the stamps: " + cells.join(", "));
  assert.ok(cells.every((c) => c.startsWith("r1.")), "only the amended scene: " + cells.join(", "));
  assert.equal(unsavedChanges(), true, "the effect pass marked the document dirty");
});

test("6.3: an amended thumbnail undoes together with the edit it belongs to, and redoes with it", async () => {
  await open();
  const entry = pasteVideo();
  edit((s) => { s.rows[1].audioText = "Bravo typed"; });
  assert.equal(foldIntoEdit(entry, touchesR1, giveThumb(THUMB)), true);
  await settle();
  undo();
  assert.equal(row("r2").audioText, "Bravo");
  assert.equal(row("r1").imageRef.sha256, THUMB.sha256, "the later edit's undo leaves the thumbnail alone");
  undo();
  assert.equal(row("r1").audioText, "Alpha");
  assert.equal(row("r1").imageRef, null, "one undo takes the paste and its thumbnail back");
  assert.equal(row("r1").imageLinks, undefined);
  redo();
  assert.equal(row("r1").audioText, "Alpha pasted");
  assert.equal(row("r1").imageRef.sha256, THUMB.sha256, "one redo brings both");
  assert.equal(row("r1").imageLinks[0].href, VIDEO);
});

test("6.3: a stale owner is refused by the guard: nothing written, nothing published, history untouched", async () => {
  await open();
  const entry = pasteVideo();
  edit((s) => { addGalleryVideo(s.rows[0], { href: "https://vimeo.com/76979871" }); });
  let text = docText();
  let sizes = undoSizes();
  let generation = liveSession().generation();
  let w = watch();
  try {
    assert.equal(foldIntoEdit(entry, touchesR1, giveThumb(THUMB)), false, "a later gallery edit owns the gallery now");
  } finally {
    w.stop();
  }
  assert.equal(docText(), text);
  assert.deepEqual(undoSizes(), sizes);
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(w.seen, []);

  await open();
  const undone = pasteVideo();
  undo();
  await settle();
  text = docText();
  sizes = undoSizes();
  generation = liveSession().generation();
  w = watch();
  try {
    assert.equal(foldIntoEdit(undone, touchesR1, giveThumb(THUMB)), false, "the paste it belongs to was undone");
  } finally {
    w.stop();
  }
  assert.equal(docText(), text);
  assert.deepEqual(undoSizes(), sizes);
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(w.seen, []);
});

test("6.3: a throw before the commit leaves the document, the entry and the history as they were", async () => {
  await open();
  const entry = pasteVideo();
  const text = docText();
  const steps = JSON.stringify(entry.steps);
  const sizes = undoSizes();
  const generation = liveSession().generation();
  naming.name = () => { throw new Error("no editor name"); };
  try {
    assert.throws(() => foldIntoEdit(entry, touchesR1, giveThumb(THUMB)), /no editor name/);
  } finally {
    naming.name = getEditorName;
  }
  assert.equal(docText(), text, "the thumbnail and the stamp are rolled back");
  assert.equal(JSON.stringify(entry.steps), steps, "the entry was not amended");
  assert.deepEqual(undoSizes(), sizes);
  assert.equal(liveSession().generation(), generation);
  flushEdits();
  assert.deepEqual(undoSizes(), sizes, "the rolled-back write left nothing for the next flush to record");
  assert.equal(foldIntoEdit(entry, touchesR1, giveThumb(THUMB)), true, "the same amendment lands afterwards");
  undo();
  assert.equal(row("r1").imageRef, null);
  assert.equal(row("r1").audioText, "Alpha");
});

test("6.3: the pasted link's thumbnail reaches the document through the amendment", async () => {
  await open();
  const entry = pasteVideo();
  const sizes = undoSizes();
  const held = createHeldFetch({ answer: () => ({ bytes: Uint8Array.from(Buffer.from(PNG.slice(PNG.indexOf(",") + 1), "base64")), headers: { "content-type": "image/png" } }) });
  window.__videoTest.setFetch(held.fetch);
  const w = watch();
  try {
    thumbnailsAfterPaste("r1", [VIDEO], entry);
    for (let i = 0; i < 60 && !row("r1").imageRef; i++) await new Promise((r) => setTimeout(r, 5));
  } finally {
    w.stop();
    window.__videoTest.setFetch(null);
  }
  assert.ok(row("r1").imageRef, "the thumbnail landed");
  assert.deepEqual(w.seen.map((c) => c.kind), ["amend"], "it landed as one amendment");
  assert.deepEqual(undoSizes(), sizes);
  undo();
  assert.equal(row("r1").imageRef, null);
  assert.equal(row("r1").imageLinks, undefined);
});

test("6.2 follow-up: a throw while the replay settles leaves the history unmoved as well as the document", async () => {
  await open();
  edit((s) => { s.rows[0].audioText = "Alpha again"; });
  const text = docText();
  const sizes = undoSizes();
  const top = lastUndoEntry();
  const generation = liveSession().generation();
  row("r2").updatedAt = 1n;
  try {
    assert.throws(() => undo(), /BigInt/);
  } finally {
    row("r2").updatedAt = "2020-01-01T00:00:00.000Z";
  }
  assert.equal(docText(), text, "the document is rolled back");
  assert.deepEqual(undoSizes(), sizes, "the history did not move");
  assert.equal(lastUndoEntry(), top);
  assert.equal(liveSession().generation(), generation);
  assert.equal(undo().ok, true, "the same entry still undoes afterwards");
  assert.equal(row("r1").audioText, "Alpha");
});
