import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { createHeldFetch, createHeldImageDecode } from "./_m4-matrix.mjs";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { undoSizes, flushEdits } = await import("../js/12a-undo.js");
const { openGalleryOverlay, closeGalleryOverlay } = await import("../js/05e-gallery-overlay.js");
const { openCommentComposer, closeCommentComposer } = await import("../js/10-comments.js");
const { liveSession } = await import("../legacy/session-bridge.ts");
const { addGalleryVideo } = await import("../core/document/gallery.ts");
const writer = await import("../js/19-writer.js");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");

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

const OLD = "2020-01-01T00:00:00.000Z";
const VIDEO = "https://youtu.be/dQw4w9WgXcQ";

function fixture() {
  const rows = [
    { id: "r1", visualText: "Wide", audioText: "Alpha", status: "todo", updatedAt: OLD, updatedBy: "Old" },
    { id: "r2", visualText: "Close", audioText: "Bravo", status: "ready", updatedAt: OLD, updatedBy: "Old" }
  ];
  addGalleryVideo(rows[0], { href: VIDEO });
  return { schema: 2, title: "Video", rows: rows, comments: [] };
}

let opened = 0;
async function open() {
  if (viewFlags().writerOpen()) writer.closeWriter();
  closeGalleryOverlay();
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(fixture())))], "video-" + (++opened) + ".splitpage", { lastModified: opened });
  await openProjectFile(file, null, { skipSnapshot: true });
  flushEdits();
  document.getElementById("toast-host").textContent = "";
}

const settle = () => new Promise((r) => setImmediate(r));
const toasts = () => document.getElementById("toast-host").textContent;

function thumbnailFetch() {
  const bytes = Uint8Array.from(Buffer.from(PNG.slice(PNG.indexOf(",") + 1), "base64"));
  const held = createHeldFetch({ answer: () => ({ bytes: bytes, headers: { "content-type": "image/png" } }) });
  window.__videoTest.setFetch(held.fetch);
  return held;
}

function click(el) {
  assert.ok(el, "the control is on the page");
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
}

function key(target, k) {
  const e = new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

async function drained() {
  for (let i = 0; i < 10; i++) await settle();
}

function watch() {
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c));
  return { seen, stop };
}

beforeEach(() => { clock += 10_000; });
after(() => window.__videoTest.setFetch(null));

test("video: a retried thumbnail for a scene that was deleted while it loaded changes nothing and says it could not be added", async () => {
  await open();
  const held = thumbnailFetch();
  held.holdWhen(() => true, 1);
  openGalleryOverlay("r1", 0);
  click(document.querySelector('[data-gact="retry-thumb"]'));
  await held.gates.arrived("fetch");
  closeGalleryOverlay();
  S.state.rows.splice(0, 1);
  liveSession().noteEdit();
  flushEdits();
  const before = undoSizes();
  const generation = liveSession().generation();
  const text = JSON.stringify(S.state);
  document.getElementById("toast-host").textContent = "";
  const w = watch();
  try {
    held.gates.releaseAll("fetch");
    await drained();
  } finally {
    w.stop();
  }
  assert.equal(w.seen.length, 0, "nothing published");
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(undoSizes(), before);
  assert.equal(JSON.stringify(S.state), text);
  assert.match(toasts(), /Could not get this video’s thumbnail/);
});

function composer() {
  openCommentComposer({ id: "cv1", rowId: "r2", field: "audioText", quotedText: "Bravo" });
  const modal = document.getElementById("comment-modal");
  click(modal.querySelector('.mini-toolbar button[data-cmd="video"]'));
  const popover = modal.querySelector(".video-popover");
  assert.equal(popover.hidden, false, "the video button opens the popover");
  return { modal, popover, input: popover.querySelector("input"), body: document.getElementById("comment-body-editable") };
}

test("video: the comment popover's Add puts a video card in the draft only, and closes the popover", async () => {
  await open();
  const text = JSON.stringify(S.state);
  const w = watch();
  const c = composer();
  c.input.value = "youtu.be/dQw4w9WgXcQ";
  click(c.popover.querySelector('[data-action="video-confirm"]'));
  await settle();
  w.stop();
  assert.equal(c.popover.hidden, true);
  assert.ok(c.body.querySelector(".video-embed-card"), "the draft has the video card");
  assert.equal(JSON.stringify(S.state), text, "the document is untouched");
  assert.equal(w.seen.length, 0, "nothing published");
  closeCommentComposer(false);
});

test("video: Enter in the popover's input adds the card; Escape and Cancel close it and keep the comment open", async () => {
  await open();
  let c = composer();
  c.input.value = "https://youtu.be/dQw4w9WgXcQ";
  const enter = key(c.input, "Enter");
  assert.equal(enter.defaultPrevented, true);
  assert.equal(c.popover.hidden, true);
  assert.ok(c.body.querySelector(".video-embed-card"), "Enter adds the card");
  closeCommentComposer(false);

  c = composer();
  c.input.value = "https://youtu.be/dQw4w9WgXcQ";
  const esc = key(c.input, "Escape");
  assert.equal(esc.defaultPrevented, true);
  assert.equal(c.popover.hidden, true, "Escape closes the popover");
  assert.equal(c.modal.hidden, false, "and leaves the comment open");
  assert.equal(c.body.querySelector(".video-embed-card"), null, "with nothing added");

  click(c.modal.querySelector('.mini-toolbar button[data-cmd="video"]'));
  assert.equal(c.popover.hidden, false);
  click(c.popover.querySelector('[data-action="video-cancel"]'));
  assert.equal(c.popover.hidden, true, "Cancel closes it");
  assert.equal(c.body.querySelector(".video-embed-card"), null);
  closeCommentComposer(false);
});
