import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();
after(closeApp);

const { currentDocument } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { restoreDesktop, useDesktopForTest } = await import("../adapters/desktop/desktop-port.ts");
const { videoFiles } = await import("../bootstrap/wiring/video-files.ts");
const { localFileMenuControls } = await import("../bootstrap/wiring/local-files.ts");
const { zipRead } = await import("../adapters/formats/zip.ts");
const { rowSlots, videoLinkKey } = await import("../core/document/gallery.ts");

const MARKER = "AttachMarker256";
const PDF = "C:\\" + MARKER + "\\Docs\\brief.pdf";
const at = (path) => ({ kind: "path", path });
const row = (id) => currentDocument().rows.find((r) => r.id === id);
const links = (id) => rowSlots(row(id)).flatMap((s) => s.links);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const toasts = () => Array.from(document.querySelectorAll("#toast-stack .toast, .toast")).map((t) => t.textContent);

async function until(check, what) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await settle();
  }
  assert.fail("timed out waiting for " + what);
}

let opened = 0;
async function open(rows) {
  const doc = { schema: 5, title: "Attachments", rows: rows || [
    { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
    { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
  ] };
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(doc)))], "attach-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file, handle: null, options: { skipSnapshot: true } });
  undoOwner().flush();
}

async function reopenSaved() {
  const text = buildSplitpageFile(exportDocumentOf(currentDocument()));
  const file = new File([text], "attach-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file, handle: null, options: { skipSnapshot: true } });
  undoOwner().flush();
  return text;
}

function drop(rowId, file, paths) {
  const target = document.querySelector('#rows .row[data-id="' + rowId + '"] .visual-cell');
  assert.ok(target, "setup: the beat has an image section to drop on");
  const event = new window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [file], types: ["Files"], getData: () => "" } });
  useDesktopForTest(paths ? { videoFilePath: (f) => paths[f.name] || null, grantVideoFile: () => Promise.resolve(null) } : null);
  try { target.dispatchEvent(event); } finally { restoreDesktop(); }
}

function pdf() { return new window.File([new Uint8Array(12)], "brief.pdf", { type: "application/pdf" }); }

async function openAs(rowId, link, desktop) {
  const asked = [];
  useDesktopForTest(desktop ? {
    openVideoFile: (token) => { asked.push("token:" + token); return Promise.resolve({ ok: true }); },
    openVideoPath: (path) => { asked.push(path); return Promise.resolve({ ok: true }); },
    openBundledFile: (name) => { asked.push("bundled:" + name); return Promise.resolve({ ok: true }); }
  } : null);
  try {
    const slot = rowSlots(row(rowId)).findIndex((s) => s.links.some((l) => videoLinkKey(l) === videoLinkKey(link)));
    videoFiles.openGallery(rowId, slot, videoLinkKey(link));
    await settle();
  } finally { restoreDesktop(); }
  return asked;
}

test("a PDF dropped in the desktop app becomes a file link with its type, keeps its path through a save and opens from it", async () => {
  await open();
  drop("r1", pdf(), { "brief.pdf": PDF });
  await until(() => links("r1").length === 1, "the attached file's link");
  assert.deepEqual(links("r1"), [{ name: "brief.pdf", size: 12, location: at(PDF) }]);
  const media = document.querySelector('#rows .row[data-id="r1"] .visual-media');
  assert.ok(media.querySelector('[data-action="image-add"]'), "a beat with only a file keeps its Attach button");
  assert.equal(media.querySelector(".scene-gallery-tile"), null, "a file is not shown as a picture tile");
  const line = media.querySelector(".scene-gallery-line");
  assert.equal(line.querySelector(".scene-gallery-host").textContent, "PDF");
  assert.ok(line.querySelector(".scene-gallery-file-icon"), "the line has a file icon");
  assert.equal(line.querySelector('[data-action="gallery-link"]').textContent, "brief.pdf");
  await reopenSaved();
  assert.deepEqual(links("r1"), [{ name: "brief.pdf", size: 12, location: at(PDF) }], "the reopened script still links it");
  assert.deepEqual(await openAs("r1", links("r1")[0], true), [PDF], "a click sends the stored path for main to check and open");
});

test("the empty beat's button says Attach", async () => {
  await open();
  const button = document.querySelector('#rows .row[data-id="r2"] [data-action="image-add"]');
  assert.equal(button.textContent, "Attach");
  assert.equal(button.getAttribute("title"), "Attach a picture or file — or drag one anywhere onto this beat’s visual column");
});

test("in the browser an attached file keeps only its name and a click says so", async () => {
  await open();
  drop("r1", pdf(), null);
  await until(() => links("r1").length === 1, "the attached file's link");
  assert.deepEqual(links("r1"), [{ name: "brief.pdf", size: 12 }]);
  assert.deepEqual(await openAs("r1", links("r1")[0], false), []);
  await until(() => toasts().some((t) => t.includes("brief.pdf")), "the browser notice");
  assert.ok(toasts().includes("“brief.pdf” is a file on the computer it was added from — only its name is kept here. Open it from there, or in the Splitpage desktop app."));
});

const PIC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("taking a video's link off keeps the file attached beside it, through a save and reopen", async () => {
  await open([
    { id: "r1", visualText: "Wide", audioText: "One.", status: "todo", visualImage: PIC,
      moreImages: [{ links: [{ name: "take.mov", size: 3, poster: true }, { name: "brief.pdf", size: 12, location: at(PDF) }] }] }
  ]);
  assert.equal(rowSlots(row("r1")).length, 2, "setup: a picture cover and a video item holding a file");
  const remove = document.querySelector('#rows .row[data-id="r1"] [data-action="gallery-link-remove"][data-key="f:take.mov:3"]');
  assert.ok(remove, "setup: the video link's remove button");
  remove.click();
  await until(() => !links("r1").some((l) => l.poster), "the video link to go");
  assert.deepEqual(links("r1"), [{ name: "brief.pdf", size: 12, location: at(PDF) }], "the file is still on the beat");
  await reopenSaved();
  assert.deepEqual(links("r1"), [{ name: "brief.pdf", size: 12, location: at(PDF) }], "and in the reopened script");
});

test("past three links the caption counts the rest as links when a file is among them", async () => {
  const vids = [1, 2, 3].map((n) => ({ href: "https://youtu.be/v" + n }));
  await open([
    { id: "r1", visualText: "Wide", audioText: "One.", status: "todo", imageLinks: vids.concat([{ name: "brief.pdf", size: 12 }]) },
    { id: "r2", visualText: "Close", audioText: "Two.", status: "todo", imageLinks: vids.concat([{ href: "https://youtu.be/v4" }]) }
  ]);
  const more = (id) => document.querySelector('#rows .row[data-id="' + id + '"] .scene-gallery-more-videos')?.textContent;
  assert.equal(more("r1"), "+1 more link");
  assert.equal(more("r2"), "+1 more video");
});

test("a paste whose files are all refused says so and still pastes its text", async () => {
  await open();
  const cell = document.querySelector('#rows .cell-editable[data-id="r1"][data-field="audioText"]');
  cell.focus();
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  const exe = new window.File([new Uint8Array(2)], "setup.exe", { type: "application/x-msdownload" });
  Object.defineProperty(event, "clipboardData", { value: { files: [exe], types: ["Files", "text/plain"], getData: (t) => (t === "text/plain" ? " pasted" : "") } });
  cell.dispatchEvent(event);
  await until(() => toasts().some((t) => t.startsWith("“setup.exe” wasn't attached.")), "the refusal notice");
  await until(() => String(row("r1").audioText).includes("pasted"), "the text to be pasted");
});

test("a file copied beside the script opens by its name, and no export names where a file is", async () => {
  await open([
    { id: "r1", visualText: "Wide", audioText: "One.", status: "todo",
      imageLinks: [{ name: "brief.pdf", size: 12, location: at(PDF) }, { name: "notes.docx", size: 3, location: { kind: "bundled", name: MARKER + ".docx" } }] }
  ]);
  assert.deepEqual(await openAs("r1", links("r1")[1], true), ["bundled:" + MARKER + ".docx"]);
  const leaked = [];
  for (const kind of ["docx", "txt", "html", "md", "csv", "xlsx"]) {
    const built = await localFileMenuControls().buildFileData(kind, "export", { allowImageBundle: true });
    const bytes = typeof built.data === "string" ? new TextEncoder().encode(built.data) : built.data;
    let text = new TextDecoder().decode(bytes);
    if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
      const zip = await zipRead(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      text = "";
      for (const name of zip.names) text += new TextDecoder().decode(await zip.get(name));
    }
    if (text.includes(MARKER)) leaked.push(kind);
    if (kind === "md") assert.ok(text.includes("▶ brief.pdf _(file)_"), "Markdown calls it a file, not a video file");
    if (kind === "txt") assert.ok(text.includes("brief.pdf (file)"), "plain text calls it a file");
  }
  assert.deepEqual(leaked, []);
});
