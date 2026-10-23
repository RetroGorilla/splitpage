import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { currentDocument } from "../legacy/session-bridge.ts";
import { createHeldImageDecode } from "./_m4-matrix.mjs";
import { saveChanges } from "../legacy/save-bridge.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { undo, undoSizes, flushEdits } = await import("../legacy/undo-bridge.ts");
const { liveSession } = await import("../legacy/session-bridge.ts");
const { rowSlots } = await import("../core/document/gallery.ts");
const { openGalleryOverlay, closeGalleryOverlay } = await import("../features/gallery/overlay.js");
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

const decode = createHeldImageDecode({ dataUrl: pngDataUrl(229, 56, 59) });
const uninstallDecode = decode.install();

after(() => {
  uninstallDecode();
  closeApp();
});

const realNow = Date.now;
let clock = 9_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const VIDEO = "https://youtu.be/abc";

function fixture() {
  return {
    schema: 2,
    title: "Media routes",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo", visualImage: PNG },
      { id: "r3", visualText: "Drone", audioText: "Three.", status: "todo", imageLinks: [{ href: VIDEO }] }
    ],
    comments: []
  };
}

let opened = 0;
async function open(role) {
  window.__hostedTest.setSession({ role: role || "edit", docId: null });
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(fixture())))], "media-routes-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file: file, handle: null, options: { skipSnapshot: true } });
  flushEdits();
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const row = (id) => currentDocument().rows.find((r) => r.id === id);
const button = (rowId, action) => document.querySelector('#rows [data-action="' + action + '"][data-id="' + rowId + '"]');
const GALLERY = ["imageAnnotation", "imageLinks", "imageName", "imageRef", "moreImages", "visualImage"];

function watch() {
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c));
  return { seen, stop };
}

function click(el) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

function pick(file) {
  const input = document.getElementById("file-input");
  Object.defineProperty(input, "files", { value: file ? [file] : [], configurable: true });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function fieldsOf(change) {
  return change.changes.cells.map((c) => c.rowId + "." + c.field);
}

function assertGalleryEdit(seen, rowId) {
  assert.equal(seen.length, 1, "one publication");
  const change = seen[0];
  assert.equal(change.kind, "edit");
  assert.equal(change.changes.whole, false, "the change names the scene's gallery fields, not the whole document");
  const fields = fieldsOf(change);
  assert.ok(fields.includes(rowId + ".updatedAt") && fields.includes(rowId + ".updatedBy"), "stamped inside the transaction");
  assert.ok(fields.every((f) => f.startsWith(rowId + ".") && (GALLERY.includes(f.slice(rowId.length + 1)) || /updated(At|By)$/.test(f))), fields.join(", "));
}

beforeEach(() => { clock += 10_000; });

test("a picture added through the picker is one gallery command: one declared edit, one undo entry, and undo takes it off", async () => {
  await open();
  const seq = saveChanges(), generation = liveSession().generation(), undos = undoSizes().undo;
  const w = watch();
  try {
    click(button("r1", "image-add"));
    pick(new window.File(["picture"], "shot.png", { type: "image/png" }));
    await settle();
  } finally {
    w.stop();
  }
  assertGalleryEdit(w.seen, "r1");
  assert.equal(rowSlots(row("r1")).length, 1);
  assert.equal(row("r1").imageName, "shot.png");
  assert.equal(saveChanges(), seq + 1);
  assert.equal(liveSession().generation(), generation + 1);
  assert.equal(undoSizes().undo, undos + 1);
  undo();
  assert.equal(rowSlots(row("r1")).length, 0);
});

test("the picker's pending scene and slot are used once: a second change with no click adds nothing", async () => {
  await open();
  click(button("r1", "image-add"));
  pick(new window.File(["picture"], "shot.png", { type: "image/png" }));
  await settle();
  const seq = saveChanges();
  pick(new window.File(["again"], "again.png", { type: "image/png" }));
  await settle();
  assert.equal(saveChanges(), seq);
  assert.equal(document.getElementById("file-input").value, "");
});

test("the gallery's Add opens the chooser for its scene, and the picked picture joins that scene once", async () => {
  await open();
  const input = document.getElementById("file-input");
  let chosen = 0;
  input.addEventListener("click", () => { chosen++; });
  openGalleryOverlay("r2", 0);
  try {
    click(document.querySelector('[data-gact="add"]'));
  } finally {
    closeGalleryOverlay();
  }
  assert.equal(chosen, 1, "the file chooser opened");
  const w = watch();
  try {
    pick(new window.File(["more"], "more.png", { type: "image/png" }));
    await settle();
  } finally {
    w.stop();
  }
  assertGalleryEdit(w.seen, "r2");
  assert.equal(rowSlots(row("r2")).length, 2, "added beside the scene's picture, not over it");
  const generation = liveSession().generation();
  pick(new window.File(["again"], "again.png", { type: "image/png" }));
  await settle();
  assert.equal(liveSession().generation(), generation, "a second change with no Add adds nothing");
});

test("Replace puts the picked picture in the slot it was clicked on", async () => {
  await open();
  const before = rowSlots(row("r2"))[0].ref.sha256;
  const w = watch();
  try {
    click(button("r2", "image-replace"));
    pick(new window.File(["other"], "other.png", { type: "image/png" }));
    await settle();
  } finally {
    w.stop();
  }
  assertGalleryEdit(w.seen, "r2");
  assert.equal(rowSlots(row("r2")).length, 1);
  assert.equal(row("r2").imageName, "other.png");
  assert.notEqual(rowSlots(row("r2"))[0].ref.sha256, before, "the slot holds the picked picture");
});

test("Remove on a scene's picture is one gallery command, and undo puts the picture back", async () => {
  await open();
  const ref = JSON.stringify(row("r2").imageRef);
  const w = watch();
  try {
    click(button("r2", "image-remove"));
  } finally {
    w.stop();
  }
  assertGalleryEdit(w.seen, "r2");
  assert.equal(row("r2").imageRef, null);
  undo();
  assert.equal(JSON.stringify(row("r2").imageRef), ref);
});

test("taking a video link off is one gallery command, and undo puts it back", async () => {
  await open();
  const w = watch();
  try {
    click(button("r3", "gallery-link-remove"));
  } finally {
    w.stop();
  }
  assertGalleryEdit(w.seen, "r3");
  assert.equal(rowSlots(row("r3")).length, 0);
  undo();
  assert.deepEqual(rowSlots(row("r3"))[0].links.map((l) => l.href), [VIDEO]);
});

test("a click on a video link opens it and edits nothing", async () => {
  await open();
  const opens = [];
  const realOpen = window.open;
  window.open = (href) => { opens.push(href); return {}; };
  const seq = saveChanges();
  try {
    const link = document.querySelector('#rows [data-action="gallery-link"][data-id="r3"]');
    const ev = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
  } finally {
    window.open = realOpen;
  }
  assert.deepEqual(opens, [VIDEO]);
  assert.equal(saveChanges(), seq);
});

test("when the session refuses edits, a gallery change writes nothing", async () => {
  await open();
  const { removeImage } = await import("../js/06-rows.js");
  const before = JSON.stringify(row("r2"));
  const seq = saveChanges();
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
  try {
    removeImage("r2", 0);
  } finally {
    window.__hostedTest.setSession({ role: "edit", docId: null });
  }
  assert.equal(JSON.stringify(row("r2")), before);
  assert.equal(saveChanges(), seq);
});
