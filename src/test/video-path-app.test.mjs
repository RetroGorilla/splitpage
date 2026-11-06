import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();
after(closeApp);

const { currentDocument } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { exportDocumentOf, captureExportDocument } = await import("../bootstrap/wiring/export-capture.ts");
const { buildMarkdownProject, buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { restoreDesktop, useDesktopForTest } = await import("../adapters/desktop/desktop-port.ts");
const { videoFiles } = await import("../bootstrap/wiring/video-files.ts");
const { mergeStates } = await import("../bootstrap/wiring/document-merge.ts");
const { localFileMenuControls } = await import("../bootstrap/wiring/local-files.ts");
const { zipRead } = await import("../adapters/formats/zip.ts");
const { exportAssetsNow } = await import("../adapters/formats/export-assets.ts");
const { exportServices } = await import("../application/export/services.ts");
const { buildPackingListPrintPage, buildScriptWithListsPrintPage, buildShotListPrintPage } = await import("../adapters/formats/list-print.ts");
const { rowSlots, videoLinkKey } = await import("../core/document/gallery.ts");
const { openGalleryOverlay, closeGalleryOverlay } = await import("../features/gallery/overlay.ts");

const MARKER = "PathMarker259";
const CLIP = "C:\\" + MARKER + "\\Clips\\take one.mp4";
const MOVED = "D:\\" + MARKER + "\\Archive\\take one.mp4";
const NEVER_DROPPED = "E:\\" + MARKER + "\\Old\\take one.mp4";
const at = (path) => ({ kind: "path", path });

const flush = () => undoOwner().flush();
const row = (id) => currentDocument().rows.find((r) => r.id === id);
const links = (id) => rowSlots(row(id)).flatMap((s) => s.links);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(check, what) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await settle();
  }
  assert.fail("timed out waiting for " + what);
}

function script(rows) {
  return {
    schema: 5, title: "Video paths",
    rows: rows || [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ]
  };
}

let opened = 0;
async function open(doc) {
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(doc)))], "video-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file, handle: null, options: { skipSnapshot: true } });
  flush();
}

async function reopenSaved() {
  const text = buildSplitpageFile(exportDocumentOf(currentDocument()));
  const file = new File([text], "video-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file, handle: null, options: { skipSnapshot: true } });
  flush();
  return text;
}

function dropVideo(rowId, file, paths, token) {
  const target = document.querySelector('#rows .row[data-id="' + rowId + '"] .visual-cell');
  assert.ok(target, "setup: the beat has an image section to drop on");
  const event = new window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [file], types: ["Files"], getData: () => "" } });
  useDesktopForTest(paths ? {
    videoFilePath: (f) => paths[f.name] || null,
    grantVideoFile: () => Promise.resolve(token || null)
  } : null);
  try { target.dispatchEvent(event); } finally { restoreDesktop(); }
}

function clip(name, size) {
  return new window.File([new Uint8Array(size)], name, { type: "video/mp4" });
}

async function openOnDesktop(rowId, link) {
  const asked = [];
  useDesktopForTest({
    openVideoFile: (token) => { asked.push("token:" + token); return Promise.resolve({ ok: true }); },
    openVideoPath: (path) => { asked.push(path); return Promise.resolve({ ok: true }); }
  });
  try {
    const slot = rowSlots(row(rowId)).findIndex((s) => s.links.some((l) => videoLinkKey(l) === videoLinkKey(link)));
    videoFiles.openGallery(rowId, slot, videoLinkKey(link));
    await settle();
  } finally { restoreDesktop(); }
  return asked;
}

test("a video dropped in the desktop app keeps its path through a save and a reopen, and opens from it", async () => {
  await open(script());
  dropVideo("r1", clip("take one.mp4", 9), { "take one.mp4": CLIP });
  await until(() => links("r1").length === 1, "the dropped video's link");
  assert.deepEqual(links("r1"), [{ name: "take one.mp4", size: 9, location: at(CLIP), poster: true }]);
  const saved = await reopenSaved();
  assert.ok(saved.includes(JSON.stringify(CLIP).slice(1, -1)), "the saved .splitpage names the path");
  assert.deepEqual(links("r1"), [{ name: "take one.mp4", size: 9, location: at(CLIP), poster: true }], "the reopened script still has it");
  assert.deepEqual(await openOnDesktop("r1", links("r1")[0]), [CLIP], "a click sends the stored path for the desktop app to check and open");
});

test("in the browser a dropped video records no path, as before", async () => {
  await open(script());
  dropVideo("r1", clip("take one.mp4", 9), null);
  await until(() => links("r1").length === 1, "the dropped video's link");
  assert.deepEqual(links("r1"), [{ name: "take one.mp4", size: 9, poster: true }]);
});

test("dropping a file again on a link from an older script records its path without a second tile; undo takes it back", async () => {
  await open(script([{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo", imageLinks: [{ name: "take one.mp4", size: 9, poster: true }] }]));
  dropVideo("r1", clip("take one.mp4", 9), { "take one.mp4": MOVED });
  await until(() => links("r1")[0] && links("r1")[0].location, "the recorded path");
  assert.deepEqual(links("r1"), [{ name: "take one.mp4", size: 9, location: at(MOVED), poster: true }]);
  assert.equal(rowSlots(row("r1")).length, 1);
  flush();
  undoOwner().undo();
  assert.deepEqual(links("r1"), [{ name: "take one.mp4", size: 9, poster: true }], "undo removes the path the drop added");
  undoOwner().redo();
  assert.deepEqual(links("r1"), [{ name: "take one.mp4", size: 9, location: at(MOVED), poster: true }], "redo brings it back");
});

test("a file dropped this session opens by its grant only for links to where it was dropped from", async () => {
  await open(script());
  dropVideo("r1", clip("take one.mp4", 9), { "take one.mp4": CLIP }, "tok-clip");
  await until(() => links("r1").length === 1, "the dropped video's link");
  await settle();
  assert.deepEqual(await openOnDesktop("r1", links("r1")[0]), ["token:tok-clip"], "the dropped file opens by its grant");
  await open(script([{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo",
    imageLinks: [{ name: "take one.mp4", size: 9, location: at(MOVED), poster: true }] }]));
  assert.deepEqual(await openOnDesktop("r1", links("r1")[0]), [MOVED],
    "another script's same-named file elsewhere opens from its own path, not the file dropped earlier");
});

test("undoing a drop that moved a link to a new path opens the old path, not the file just dropped", async () => {
  await open(script([{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo",
    imageLinks: [{ name: "take one.mp4", size: 9, location: at(NEVER_DROPPED), poster: true }] }]));
  dropVideo("r1", clip("take one.mp4", 9), { "take one.mp4": MOVED }, "tok-moved");
  await until(() => links("r1")[0].location.path === MOVED, "the new path");
  await settle();
  assert.deepEqual(await openOnDesktop("r1", links("r1")[0]), ["token:tok-moved"]);
  flush();
  undoOwner().undo();
  assert.deepEqual(links("r1")[0].location, at(NEVER_DROPPED), "setup: undo puts the old path back");
  assert.deepEqual(await openOnDesktop("r1", links("r1")[0]), [NEVER_DROPPED]);
});

test("a video playing in the gallery stops when undo puts its link back on another file's path", async () => {
  const fromClip = clip("take one.mp4", 9);
  const fromMoved = clip("take one.mp4", 9);
  const made = URL.createObjectURL, revoked = URL.revokeObjectURL;
  try {
    await open(script());
    dropVideo("r1", fromClip, { "take one.mp4": CLIP });
    await until(() => links("r1").length === 1, "the first drop");
    flush();
    dropVideo("r1", fromMoved, { "take one.mp4": MOVED });
    await until(() => links("r1")[0].location.path === MOVED, "the second drop's path");
    flush();
    URL.createObjectURL = (f) => f === fromClip ? "blob:clip" : f === fromMoved ? "blob:moved" : "blob:other";
    URL.revokeObjectURL = () => {};
    openGalleryOverlay("r1", 0);
    const play = document.querySelector('#gallery-body [data-gact="play"]');
    assert.ok(play, "setup: the dropped file can play here");
    play.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    assert.equal(document.querySelector("#gallery-body .scene-gallery-player")?.getAttribute("src"), "blob:moved");
    undoOwner().undo();
    await settle();
    assert.deepEqual(links("r1")[0].location, at(CLIP), "setup: undo puts the first path back");
    assert.equal(videoFiles.url(links("r1")[0]), "blob:clip", "setup: the link now names the first file");
    const player = document.querySelector("#gallery-body .scene-gallery-player");
    assert.notEqual(player && player.getAttribute("src"), "blob:moved", "the second file is no longer shown for the first file's link");
  } finally {
    closeGalleryOverlay();
    URL.createObjectURL = made;
    URL.revokeObjectURL = revoked;
  }
});

test("a merge with a copy saved by an older build, which drops the path, keeps the path", () => {
  const located = [{ name: "take one.mp4", size: 9, location: at(CLIP), poster: true }];
  const base = migrateRows(script([{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo", imageLinks: located }]));
  const mine = JSON.parse(JSON.stringify(base));
  const theirs = JSON.parse(JSON.stringify(base));
  delete theirs.rows[0].imageLinks[0].location;
  theirs.rows[0].audioText = "One, changed on disk.";
  const out = mergeStates(base, mine, theirs).merged;
  assert.deepEqual(out.rows[0].imageLinks, located);
  assert.equal(out.rows[0].audioText, "One, changed on disk.");
  assert.equal(out.comments.length, 0);
});

const KINDS = [
  "docx", "csv", "breakdown", "b-roll csv", "xlsx", "breakdown xlsx", "b-roll xlsx", "txt",
  "narration-docx", "narration-txt", "md-table", "html", "md"
];

async function textsOf(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) return [new TextDecoder().decode(bytes)];
  const zip = await zipRead(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const out = [];
  for (const name of zip.names) out.push(name, new TextDecoder().decode(await zip.get(name)));
  return out;
}

test("no export names where a video file is, and the saved formats keep it", async () => {
  await open(script([
    { id: "r1", visualText: "Wide B-roll: steam", audioText: "One.", status: "todo",
      imageLinks: [{ name: "take one.mp4", size: 9, location: at(CLIP), poster: true }],
      moreImages: [{ links: [{ name: "take two.mov", size: 4, location: at(MOVED), poster: true }] }] },
    { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
  ]));
  assert.equal(links("r1").filter((l) => l.location).length, 2, "setup: both links are located");
  const leaked = [], named = [];
  for (const kind of KINDS) {
    const built = await localFileMenuControls().buildFileData(kind, "export", { allowImageBundle: true });
    const texts = await textsOf(built.data);
    if (texts.join("\n").includes("take one")) named.push(kind);
    if (texts.some((t) => t.includes(MARKER))) leaked.push(kind);
  }
  assert.deepEqual(named.filter((k) => ["docx", "txt", "html", "md"].includes(k)), ["docx", "txt", "html", "md"],
    "setup: the exports that list videos name this one, so a path beside it would show");
  const doc = captureExportDocument();
  const pages = [
    buildScriptWithListsPrintPage({ doc, assets: exportAssetsNow(doc), services: exportServices() }),
    buildShotListPrintPage({ doc, services: exportServices() }, { filter: "all", group: "scene" }),
    buildPackingListPrintPage({ doc, services: exportServices() }, "gear")
  ];
  pages.forEach((page, i) => { if (JSON.stringify(page).includes(MARKER)) leaked.push("print page " + i); });
  assert.deepEqual(leaked, []);
  assert.ok(buildSplitpageFile(doc).includes(MARKER), "a .splitpage save keeps the path");
  assert.ok(buildMarkdownProject(doc).includes(MARKER), "a .md project's data block keeps the path");
  assert.equal(links("r1").filter((l) => l.location).length, 2, "exporting left the live document's paths alone");
});
