import { bootApp, closeApp } from "./_app-boot.mjs";
import { after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { currentDocument } from "../legacy/session-bridge.ts";
import { createHeldFetch, createHeldImageDecode, rightToday } from "./_m4-matrix.mjs";
import { unsavedChanges } from "../legacy/save-bridge.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { liveSession } = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { renderAbsorbed } = await import("../js/05-render.js");
const { confirmSavedNow } = await import("../legacy/save-bridge.ts");
const { flushEdits, lastUndoEntry, undoSizes } = await import("../js/12a-undo.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { handleImageFile } = await import("../js/06-rows.js");
const { openGalleryOverlay } = await import("../js/05e-gallery-overlay.js");
const { thumbnailsAfterPaste } = await import("../js/05v-video.js");
const annotate = await import("../js/05w-annotate.js");
const { addGalleryVideo, rowSlots } = await import("../core/document/gallery.ts");
const { loadTestDocument } = await import("./_document.mjs");
const { openDocument } = await import("../legacy/transition-bridge.ts");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
function pngDataUrl(red, green, blue) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, red, green, blue]))),
    chunk("IEND", Buffer.alloc(0))
  ]);
  return "data:image/png;base64," + png.toString("base64");
}

const session = liveSession();
const decode = createHeldImageDecode({ dataUrl: PNG, encodedDataUrl: pngDataUrl(229, 56, 59) });
const uninstallDecode = decode.install();

after(() => {
  uninstallDecode();
  closeApp();
});

const idOf = (letter) => "d" + letter.repeat(32);
const pause = () => new Promise((resolve) => setImmediate(resolve));
const cellOf = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');

async function settle(turns = 60) {
  for (let turn = 0; turn < turns; turn++) await pause();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function script(title, docId, ids, texts) {
  return migrateRows({
    schema: 5, title: title, docId: docId,
    rows: ids.map((id, i) => ({ id: id, visualText: "Wide " + i, audioText: texts ? texts[i] : "Hello world " + i + ".", status: "todo" }))
  });
}

function showDocument(doc) {
  decode.gates.releaseAll("image.decode");
  decode.gates.releaseAll("image.encode");
  loadTestDocument(doc);
  flushEdits();
  renderAbsorbed();
  confirmSavedNow();
  document.getElementById("toast-host").textContent = "";
  return doc;
}

function splitpageFile(doc) {
  return new File([buildSplitpageFile(exportDocumentOf(doc))], "m4.splitpage", { lastModified: 1 });
}

async function reopen(doc) {
  const epoch = session.epoch();
  await openDocument({ kind: "file", file: splitpageFile(doc), handle: null, options: { skipSnapshot: true, silent: true } });
  confirmSavedNow();
  document.getElementById("toast-host").textContent = "";
  assert.ok(session.epoch() > epoch, "setup: the document was replaced and has a new epoch");
}

function textNodes(el) {
  const walker = document.createTreeWalker(el, 4);
  const out = [];
  while (walker.nextNode()) out.push(walker.currentNode);
  return out;
}

function select(el, from, to) {
  const node = textNodes(el)[0];
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to === undefined ? from : to);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function pastePicture(cell, text) {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  const file = new window.File(["not really a picture"], "pasted.png", { type: "image/png" });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type) => (type === "text/plain" ? text : ""), files: [file], types: ["text/plain", "Files"] } });
  cell.dispatchEvent(event);
}

function toasts() {
  return Array.from(document.querySelectorAll("#toast-host .toast:not(.is-leaving)")).map((el) => (el.classList.contains("has-action") ? el.firstChild.nodeValue : el.textContent));
}

function edits() {
  return { doc: JSON.stringify(currentDocument()), dirty: unsavedChanges(), undo: undoSizes(), top: JSON.stringify(lastUndoEntry() || null) };
}

async function latePaste(replace) {
  showDocument(script("Paste target", idOf("a"), ["r1", "r2"]));
  const cell = cellOf("r1", "audioText");
  cell.focus();
  select(cell, 5);
  assert.equal(window.getSelection().anchorOffset, 5, "setup: the caret starts at offset 5");
  decode.holdDecode();
  pastePicture(cell, "Pasted ");
  await decode.arrivedAtDecode();
  assert.equal(decode.gates.parked("image.decode").length, 1, "setup: the picture is held in its decode");
  await replace();
  const before = edits();
  decode.releaseDecode();
  await settle();
  assert.equal(decode.gates.parked("image.decode").length, 0, "setup: the held decode was released");
  return before;
}

function assertDropped(before, what) {
  assert.deepEqual(edits(), before, what + ": the late picture and text changed nothing in the replacement");
  assert.ok(toasts().length > 0 && !toasts().some((text) => /added to scene/.test(text)), what + ": the user is told the picture was not added: " + JSON.stringify(toasts()));
}

const AUDIO = "Hello world 0.";
const afterCaret = (at, text) => AUDIO.slice(0, at) + text + AUDIO.slice(at);

rightToday("M0", "a delayed paste into an untouched document lands at the caret it started at, with its picture on the scene", async () => {
  await latePaste(async () => {});
  assert.equal(currentDocument().rows[0].audioText, afterCaret(5, "Pasted "), "the text went in at the caret");
  assert.equal(unsavedChanges(), true);
  assert.ok(currentDocument().rows[0].imageRef || currentDocument().rows[0].moreImages, "the picture is on the scene: " + JSON.stringify(Object.keys(currentDocument().rows[0])));
});

rightToday("M1", "a delayed paste that completes after another document was opened changes nothing and tells the user", async () => {
  const before = await latePaste(() => reopen(script("Another script", idOf("b"), ["x1", "x2"])));
  assertDropped(before, "after a switch");
});

rightToday("M1b", "a delayed paste that completes after another document with the same scene ids was opened changes nothing", async () => {
  const before = await latePaste(() => reopen(script("A copy", idOf("c"), ["r1", "r2"])));
  assertDropped(before, "after a switch to a copy");
});

rightToday("M2", "a delayed paste that completes after the same document was reopened changes nothing and tells the user", async () => {
  const before = await latePaste(() => reopen(script("Paste target", idOf("a"), ["r1", "r2"])));
  assertDropped(before, "after a same-id reopen");
});

rightToday("M3a", "a delayed paste puts its text at the place captured when it began if the cell is unchanged, however the caret moved (D11)", async () => {
  await latePaste(async () => { select(cellOf("r1", "audioText"), 0); });
  assert.equal(currentDocument().rows[0].audioText, afterCaret(5, "Pasted "), "the text went in at the captured place");
});

rightToday("M3b", "a delayed paste puts its text at the end of the cell if the cell was edited while the picture loaded (D11)", async () => {
  await latePaste(async () => {
    const cell = cellOf("r1", "audioText");
    const node = textNodes(cell)[textNodes(cell).length - 1];
    node.data += "!";
    cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "!" }));
    flushEdits();
    assert.equal(currentDocument().rows[0].audioText, AUDIO + "!", "setup: the edit made while the picture loaded reached the document");
    select(cell, 0);
  });
  assert.equal(currentDocument().rows[0].audioText, AUDIO + "!Pasted ", "the text went in at the end of the edited cell");
});

rightToday("M3c", "a delayed paste puts its text in the cell it began in when the caret moved to another cell (D11)", async () => {
  await latePaste(async () => {
    const other = cellOf("r2", "audioText");
    other.focus();
    select(other, 0);
  });
  assert.equal(currentDocument().rows[0].audioText, afterCaret(5, "Pasted "), "the text went in at the captured place");
  assert.equal(currentDocument().rows[1].audioText, "Hello world 1.", "the other cell is untouched");
});

function dropPicture(target) {
  const event = new window.Event("drop", { bubbles: true, cancelable: true });
  const file = new window.File(["not really a picture"], "dropped.png", { type: "image/png" });
  Object.defineProperty(event, "dataTransfer", { value: { files: [file], types: ["Files"], getData: () => "" } });
  target.dispatchEvent(event);
}

rightToday("M2d", "a delayed drop on a scene's image section that completes after the same document was reopened changes nothing and tells the user", async () => {
  showDocument(script("Drop target", idOf("a"), ["r1", "r2"]));
  const media = document.querySelector('#rows .row[data-id="r1"] .visual-cell');
  assert.ok(media, "setup: the scene has an image section to drop on");
  decode.holdDecode();
  dropPicture(media);
  await decode.arrivedAtDecode();
  assert.equal(decode.gates.parked("image.decode").length, 1, "setup: the dropped picture is held in its decode");
  await reopen(script("Drop target", idOf("a"), ["r1", "r2"]));
  const before = edits();
  decode.releaseDecode();
  await settle();
  assert.equal(decode.gates.parked("image.decode").length, 0, "setup: the held decode was released");
  assertDropped(before, "after a same-id reopen");
});

async function lateGalleryPicture(replace) {
  showDocument(script("Gallery target", idOf("a"), ["r1", "r2"]));
  decode.holdDecode();
  handleImageFile("r1", new window.File(["not really a picture"], "gallery.png", { type: "image/png" }));
  await decode.arrivedAtDecode();
  assert.equal(decode.gates.parked("image.decode").length, 1, "setup: the gallery picture is held in its decode");
  await replace();
  const before = edits();
  decode.releaseDecode();
  await settle();
  assert.equal(decode.gates.parked("image.decode").length, 0, "setup: the held decode was released");
  return before;
}

rightToday("M4", "a gallery picture that finishes loading after another document was opened changes nothing and tells the user", async () => {
  const before = await lateGalleryPicture(() => reopen(script("Another script", idOf("b"), ["x1", "x2"])));
  assertDropped(before, "after a switch");
});

rightToday("M4b", "a gallery picture that finishes loading after the same document was reopened changes nothing and tells the user", async () => {
  const before = await lateGalleryPicture(() => reopen(script("Gallery target", idOf("a"), ["r1", "r2"])));
  assertDropped(before, "after a same-id reopen");
});

const VIDEO = "https://youtu.be/dQw4w9WgXcQ";

function videoScript(title, docId, ids) {
  const doc = script(title, docId, ids);
  addGalleryVideo(doc.rows[0], { href: VIDEO });
  return doc;
}

function heldThumbnail() {
  const bytes = Uint8Array.from(Buffer.from(PNG.slice(PNG.indexOf(",") + 1), "base64"));
  const held = createHeldFetch({ answer: () => ({ bytes: bytes, headers: { "content-type": "image/png" } }) });
  held.holdWhen(() => true, Infinity);
  window.__videoTest.setFetch(held.fetch);
  return held;
}

function thumbnailOf(doc) {
  return rowSlots(doc.rows[0])[0].ref;
}

async function lateRetry(replace) {
  showDocument(videoScript("Video target", idOf("a"), ["r1", "r2"]));
  const held = heldThumbnail();
  openGalleryOverlay("r1", 0);
  document.querySelector('[data-gact="retry-thumb"]').click();
  await held.gates.arrived("fetch");
  await replace();
  document.getElementById("toast-host").textContent = "";
  const before = edits();
  held.gates.releaseAll("fetch");
  await settle();
  return before;
}

rightToday("M5", "a retried thumbnail that arrives after another document with the same scene and link was opened changes nothing in it", async () => {
  const before = await lateRetry(() => reopen(videoScript("A copy with the same video", idOf("c"), ["r1", "r2"])));
  assert.deepEqual(edits(), before, "the late thumbnail changed nothing in the replacement");
});

rightToday("M5b", "a retried thumbnail that arrives after an unrelated document was opened changes nothing in it", async () => {
  const before = await lateRetry(() => reopen(script("Another script", idOf("b"), ["x1", "x2"])));
  assert.deepEqual(edits(), before, "the late thumbnail changed nothing in the replacement");
});

async function lateThumbnailAfterPaste(replace) {
  showDocument(videoScript("Video target", idOf("a"), ["r1", "r2"]));
  const held = heldThumbnail();
  thumbnailsAfterPaste("r1", [VIDEO], null);
  await held.gates.arrived("fetch");
  await replace();
  const before = edits();
  held.gates.releaseAll("fetch");
  await settle();
  return before;
}

rightToday("M6", "a thumbnail fetched for a paste that arrives after the same document was reopened changes nothing in it", async () => {
  const before = await lateThumbnailAfterPaste(() => reopen(videoScript("Video target", idOf("a"), ["r1", "r2"])));
  assert.deepEqual(edits(), before, "the late thumbnail changed nothing in the reopened session");
});

rightToday("M6-switch", "a thumbnail fetched for a paste that arrives after a copy with another id and the same scenes was opened changes nothing in it", async () => {
  const before = await lateThumbnailAfterPaste(() => reopen(videoScript("A copy", idOf("c"), ["r1", "r2"])));
  assert.deepEqual(edits(), before, "the late thumbnail changed nothing in the copy");
});

rightToday("M0b", "in an untouched document the late gallery picture, retried thumbnail, pasted link's thumbnail and annotation each land on their scene", withObjectUrls(async () => {
  await lateGalleryPicture(async () => {});
  assert.ok(currentDocument().rows[0].imageRef, "the gallery picture is on the scene");

  await lateRetry(async () => {});
  assert.ok(thumbnailOf(currentDocument()), "the retried thumbnail is on the video");

  await lateThumbnailAfterPaste(async () => {});
  assert.ok(thumbnailOf(currentDocument()), "the pasted link's thumbnail is on the video");

  await lateAnnotation(async () => {});
  assert.ok(rowSlots(currentDocument().rows[0])[0].annotation, "the annotation is on the picture");
}));

function pointer(el, type) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 });
  Object.defineProperty(event, "pointerId", { value: 7 });
  Object.defineProperty(event, "pointerType", { value: "pen" });
  el.dispatchEvent(event);
}

async function lateAnnotation(replace) {
  const doc = script("Annotated", idOf("a"), ["r1", "r2"]);
  doc.rows[0].visualImage = PNG;
  showDocument(migrateRows(JSON.parse(JSON.stringify(doc))));
  assert.equal(annotate.openAnnotator("r1", 0), true);
  await settle(10);
  document.getElementById("annotate-img").onload();
  await settle(10);
  const frame = document.getElementById("annotate-frame");
  pointer(frame, "pointerdown");
  pointer(frame, "pointerup");
  assert.equal(window.__annotateTest.state().marks.length, 1, "setup: one stroke is drawn");
  decode.holdEncode();
  document.getElementById("annotate-done").click();
  await decode.arrivedAtEncode();
  await replace();
  const before = edits();
  decode.releaseEncode();
  await settle();
  return before;
}

function withObjectUrls(run) {
  return async () => {
    const make = URL.createObjectURL;
    URL.createObjectURL = () => "blob:m4-annotate";
    try {
      await run();
    } finally {
      URL.createObjectURL = make;
      annotate.closeAnnotator();
    }
  };
}

function annotatedSource(title, docId, ids) {
  const doc = script(title, docId, ids);
  doc.rows[0].visualImage = PNG;
  return migrateRows(JSON.parse(JSON.stringify(doc)));
}

rightToday("M7", "an annotation saved after the same document was reopened changes nothing in the reopened session", withObjectUrls(async () => {
  const before = await lateAnnotation(() => reopen(annotatedSource("Annotated", idOf("a"), ["r1", "r2"])));
  assert.deepEqual(edits(), before, "the late annotation changed nothing in the reopened session");
  assert.equal(annotate.annotatorOpen(), false, "the annotator closed");
  assert.ok(toasts().some((text) => /not saved/.test(text)), "the user is told the annotations were not saved: " + JSON.stringify(toasts()));
}));

rightToday("M7-switch", "an annotation saved after an unrelated document was opened changes nothing in it", withObjectUrls(async () => {
  const before = await lateAnnotation(() => reopen(script("Another script", idOf("b"), ["x1", "x2"])));
  assert.deepEqual(edits(), before, "the late annotation changed nothing in the replacement");
}));

