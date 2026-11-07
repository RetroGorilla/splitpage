import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addGalleryFile,
  addGalleryPicture,
  addGalleryVideo,
  bundleVideoLinks,
  bundledVideoNames,
  galleryFieldKey,
  isOtherFileLink,
  mergeGalleryField,
  migrateGallery,
  moveGallerySlot,
  normalizeVideoLink,
  removeGalleryLink,
  removeGallerySlot,
  replaceGalleryPicture,
  rowSlots,
  setRowSlots,
  videoLinkKey,
  withoutVideoLocations
} from "../../../src/core/document/gallery.ts";
import type { GalleryItem, GalleryRow, GallerySide, Slot, VideoLink } from "../../../src/core/document/gallery.ts";
import { ATTACHABLE_FILE, BLOCKED_FILE_TYPES, isStoredVideoPath } from "../../../shared/video-path.ts";
import { attachToGallery } from "../../../src/application/commands/clipboard.ts";
import { videoHostLabel } from "../../../src/adapters/formats/video-host.ts";

const PIC = { sha256: "a".repeat(64), width: 4, height: 3, mime: "image/png" };
const PDF = "C:\\Docs\\brief.pdf";

test("any file with an extension may be attached except programs, scripts, shortcuts and installers", () => {
  for (const ok of ["brief.pdf", "notes.DOCX", "vo.wav", "plan.xlsx", "take.mp4", "C:\\Docs\\brief.pdf", "Z:\\NAS\\a b.key", ".bashrc"]) {
    assert.equal(ATTACHABLE_FILE.test(ok), true, ok);
  }
  const named = ["exe", "com", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp", "scr", "hta", "cpl", "lnk",
    "url", "reg", "jar", "appref-ms", "application", "pif", "settingcontent-ms",
    "ahk", "au3", "a3x", "pyw", "pyz", "pyc", "pyo", "rb", "rbw", "pl", "php", "tcl", "lua", "bash", "zsh", "fish", "command",
    "applescript", "scpt", "ws", "wsc", "sct", "xll", "mht", "mhtml", "btm", "air"];
  for (const ext of named) {
    assert.ok(BLOCKED_FILE_TYPES.includes(ext), ext + " is on the list");
    assert.equal(ATTACHABLE_FILE.test("tool." + ext), false, ext);
    assert.equal(ATTACHABLE_FILE.test("TOOL." + ext.toUpperCase()), false, ext + " in capitals");
  }
  for (const bad of ["README", "brief.pdf.exe", "setup.exe.", "setup.exe ", "C:\\dir.pdf\\file", "a.", "brief.pdf:x", ""]) {
    assert.equal(ATTACHABLE_FILE.test(bad), false, JSON.stringify(bad));
  }
  assert.equal(isStoredVideoPath(PDF, ATTACHABLE_FILE), true);
  assert.equal(isStoredVideoPath(PDF), false, "the video rule stays the default");
  assert.equal(isStoredVideoPath("\\\\server\\share\\brief.pdf", ATTACHABLE_FILE), false, "a raw share path is still refused");
  assert.equal(isStoredVideoPath("Z:\\NAS\\brief.pdf", ATTACHABLE_FILE), true, "a mapped drive is a drive");
});

test("an attached file's link keeps its path or bundled name, and a crafted program location is dropped", () => {
  assert.deepEqual(normalizeVideoLink({ name: "brief.pdf", size: 9, location: { kind: "path", path: PDF } }),
    { name: "brief.pdf", size: 9, location: { kind: "path", path: PDF } });
  assert.deepEqual(normalizeVideoLink({ name: "brief.pdf", location: { kind: "bundled", name: "brief (2).pdf" } }),
    { name: "brief.pdf", location: { kind: "bundled", name: "brief (2).pdf" } });
  for (const location of [{ kind: "path", path: "C:\\Docs\\setup.exe" }, { kind: "bundled", name: "setup.exe" }, { kind: "bundled", name: "README" },
    { kind: "path", path: "C:\\Docs\\run.ps1" }, { kind: "bundled", name: "..\\brief.pdf" }]) {
    assert.deepEqual(normalizeVideoLink({ name: "brief.pdf", location }), { name: "brief.pdf" }, JSON.stringify(location));
  }
});

test("an attached file goes on the beat's first gallery item, or on its own when the beat has none", () => {
  const empty: GalleryRow = { id: "r1" };
  assert.equal(addGalleryFile(empty, { name: "brief.pdf", size: 9, location: { kind: "path", path: PDF } }), 0);
  assert.deepEqual(empty.imageLinks, [{ name: "brief.pdf", size: 9, location: { kind: "path", path: PDF } }]);
  assert.equal(empty.imageRef, null);
  assert.equal(addGalleryPicture(empty, PIC, "p.png"), 0, "a picture fills the item the file sits on");
  assert.equal(rowSlots(empty).length, 1);

  const withPicture: GalleryRow = { id: "r2", imageRef: PIC };
  assert.equal(addGalleryFile(withPicture, { name: "notes.docx", size: 4, poster: true }), 0);
  assert.deepEqual(rowSlots(withPicture)[0]?.links, [{ name: "notes.docx", size: 4 }], "an attached file is never a poster");
  assert.equal(addGalleryFile(withPicture, { href: "https://e.x/" }), -1, "a web link is not a file");
});

test("attaching the same file again records its new place on the link it has, in one change", () => {
  const row: GalleryRow = { id: "r1" };
  addGalleryFile(row, { name: "brief.pdf", size: 9 });
  assert.equal(addGalleryFile(row, { name: "brief.pdf", size: 9, location: { kind: "path", path: PDF } }), 0);
  assert.deepEqual(row.imageLinks, [{ name: "brief.pdf", size: 9, location: { kind: "path", path: PDF } }]);
  assert.equal(addGalleryFile(row, { name: "brief.pdf", size: 9 }), 0);
  assert.equal((row.imageLinks as VideoLink[]).length, 1);
});

test("attachments count separately from pictures and videos", () => {
  const row: GalleryRow = { id: "r1" };
  const got = attachToGallery(row, [{ kind: "file", name: "brief.pdf", size: 9, path: PDF }, { kind: "videoFile", name: "take.mp4", size: 3 }]);
  assert.deepEqual(got, { pictures: 0, videos: 1, files: 1, links: [] });
  assert.equal(rowSlots(row).length, 1, "the file joins the video's item");
});

test("bundling, carrying, merging and SplitShare treat a file link like a video file link", () => {
  const row: GalleryRow = { id: "r1" };
  addGalleryFile(row, { name: "brief.pdf", size: 9, location: { kind: "path", path: PDF } });
  const from = (row.imageLinks as VideoLink[])[0] as VideoLink;
  assert.equal(bundleVideoLinks([row], from, "brief.pdf"), true);
  assert.deepEqual((row.imageLinks as VideoLink[])[0]?.location, { kind: "bundled", name: "brief.pdf" });
  assert.deepEqual(bundledVideoNames([row]), ["brief.pdf"]);
  assert.equal(bundleVideoLinks([row], from, "setup.exe"), false, "a program name is never written as a bundled location");
  const base = { imageLinks: [{ name: "brief.pdf", size: 9 }] };
  const mine = { imageLinks: [{ name: "brief.pdf", size: 9, location: { kind: "bundled" as const, name: "brief.pdf" } }] };
  assert.deepEqual(mergeGalleryField("imageLinks", base, mine, base), mine.imageLinks);
  assert.notEqual(galleryFieldKey(base, "imageLinks"), galleryFieldKey(mine, "imageLinks"));
  const copy = JSON.parse(JSON.stringify(row)) as GalleryRow;
  withoutVideoLocations([copy]);
  assert.deepEqual(copy.imageLinks, [{ name: "brief.pdf", size: 9 }]);
});

test("a file link is told apart from a video by its extension, and older extensionless file links stay videos", () => {
  assert.equal(isOtherFileLink({ name: "brief.pdf" }), true);
  assert.equal(isOtherFileLink({ name: "take.mov" }), false);
  assert.equal(isOtherFileLink({ name: "Local clip" }), false);
  assert.equal(isOtherFileLink({ name: "odd.pdf", poster: true }), false, "a poster is a video");
  assert.equal(isOtherFileLink({ href: "https://e.x/a.pdf" }), false);
  const row: GalleryRow = { id: "r1" };
  addGalleryVideo(row, { name: "take.mov", size: 3 });
  addGalleryFile(row, { name: "brief.pdf", size: 9 });
  assert.deepEqual(rowSlots(row)[0]?.links.map(videoLinkKey), ["f:take.mov:3", "f:brief.pdf:9"]);
});

const PIC2 = { sha256: "b".repeat(64), width: 4, height: 3, mime: "image/png" };
const BRIEF = { name: "brief.pdf", size: 9, location: { kind: "path" as const, path: PDF } };
const fileLinks = (row: GalleryRow) => rowSlots(row).flatMap((s) => s.links).filter((l) => !l.href && !l.poster);
const reopened = (row: GalleryRow): GalleryRow => {
  const back = JSON.parse(JSON.stringify(row)) as GalleryRow;
  migrateGallery(back, { known: () => null, fromDataUrl: () => null });
  return back;
};

test("a file attached beside a video survives taking the video's link off after a picture became the cover, and a reopen", () => {
  const row: GalleryRow = { id: "r1" };
  addGalleryVideo(row, { name: "take.mov", size: 3 });
  addGalleryFile(row, BRIEF);
  assert.equal(addGalleryPicture(row, PIC, "p.png"), 1);
  assert.ok(moveGallerySlot(row, 1, 0), "the picture is the cover");
  assert.ok(removeGalleryLink(row, 1, videoLinkKey({ name: "take.mov", size: 3 })));
  assert.deepEqual(fileLinks(row), [BRIEF], "the attached file is still on the beat");
  assert.equal(rowSlots(row).length, 1, "it joins the cover's links rather than leaving an empty tile");
  assert.deepEqual(fileLinks(reopened(row)), [BRIEF], "and after a save and reopen");
});

test("removing a picture or a video keeps the files attached to it", () => {
  const row: GalleryRow = { id: "r1", imageRef: PIC, imageLinks: [BRIEF] };
  addGalleryPicture(row, PIC2, "q.png");
  assert.ok(removeGallerySlot(row, 0));
  assert.equal(rowSlots(row)[0]?.ref?.sha256, PIC2.sha256);
  assert.deepEqual(fileLinks(row), [BRIEF], "the file moves to the next item");
  assert.ok(removeGallerySlot(row, 0));
  assert.deepEqual(rowSlots(row).map((s) => [s.ref, s.links]), [[null, [BRIEF]]], "the last picture going leaves the file on its own");
  assert.deepEqual(fileLinks(reopened(row)), [BRIEF]);

  const video: GalleryRow = { id: "r2" };
  addGalleryVideo(video, { href: "https://youtu.be/v1" }, null);
  addGalleryFile(video, BRIEF);
  assert.ok(removeGallerySlot(video, 0));
  assert.deepEqual(rowSlots(video).map((s) => s.links), [[BRIEF]], "a video's web link goes with it, the file stays");

  const dup: GalleryRow = { id: "r3" };
  addGalleryPicture(dup, PIC, "p.png");
  addGalleryPicture(dup, PIC2, "q.png");
  setRowSlots(dup, [rowSlots(dup)[0] as Slot, { ...(rowSlots(dup)[1] as Slot), links: [BRIEF] }]);
  assert.ok(replaceGalleryPicture(dup, 1, PIC, "p.png"), "replacing with a picture already there removes the item");
  assert.deepEqual(fileLinks(dup), [BRIEF]);
});

const PIC3 = { sha256: "c".repeat(64), width: 4, height: 3, mime: "image/png" };
const file = (name: string): VideoLink => ({ name, size: 1 });
const names = (links: unknown): string[] => ((links || []) as VideoLink[]).map((l) => l.name ?? "").sort();
const side = (r: GalleryRow): GallerySide => ({ imageLinks: r.imageLinks as VideoLink[] | undefined, moreImages: r.moreImages as GalleryItem[] | undefined });

test("file links are stored only in the beat's own list, never in a gallery item, whatever moves", () => {
  const row: GalleryRow = { id: "r1" };
  addGalleryVideo(row, { href: "https://youtu.be/v1" }, PIC);
  addGalleryFile(row, BRIEF);
  addGalleryPicture(row, PIC2, "q.png");
  assert.ok(moveGallerySlot(row, 0, 1), "the video stops being the cover");
  assert.deepEqual(row.imageLinks, [BRIEF], "the file stays in the beat's list");
  assert.deepEqual(row.moreImages, [{ imageRef: PIC, links: [{ href: "https://youtu.be/v1", poster: true }] }], "the video's item has no file");
  assert.ok(removeGallerySlot(row, 1));
  assert.ok(removeGallerySlot(row, 0));
  assert.deepEqual(row, { id: "r1", imageRef: null, imageLinks: [BRIEF] }, "with every picture gone the file is still there");
});

test("files on overlapping items are all kept, past a full cover, through normalization and slot writing", () => {
  const full = Array.from({ length: 20 }, (_, i) => file("f" + i + ".pdf"));
  const stored: GalleryRow = { id: "r1", imageRef: PIC, imageLinks: full,
    moreImages: [{ imageRef: PIC2, links: [file("A.pdf"), file("B.pdf")] }, { imageRef: PIC3, links: [file("A.pdf"), file("C.pdf")] }, { links: [file("D.pdf")] }] };
  const back = reopened(stored);
  assert.deepEqual(names(back.imageLinks), names(full.concat([file("A.pdf"), file("B.pdf"), file("C.pdf"), file("D.pdf")])), "every file, once");
  assert.equal(rowSlots(back).length, 3, "the pictures stay items of their own");
  assert.ok(removeGallerySlot(back, 2));
  assert.ok(removeGallerySlot(back, 1));
  assert.equal(fileLinks(back).length, 24, "removing both pictures loses none");
  const written: GalleryRow = { id: "r2" };
  setRowSlots(written, rowSlots(stored));
  assert.equal(fileLinks(written).length, 24, "slot writing keeps them all too");
});

test("concurrent file changes merge per file: a removal on either side stays removed, an addition on either side stays added", () => {
  const base = { imageLinks: [file("A.pdf"), file("B.pdf"), file("C.pdf")] };
  const mine = { imageLinks: [file("B.pdf"), file("C.pdf")] };
  const theirs = { imageLinks: [file("A.pdf"), file("C.pdf"), file("N.pdf")] };
  assert.deepEqual(names(mergeGalleryField("imageLinks", base, mine, theirs) as VideoLink[]), ["C.pdf", "N.pdf"], "A and B stay removed, N is added");
});

function mergeRows(base: GalleryRow, mine: GalleryRow, theirs: GalleryRow): GalleryRow {
  const out: GalleryRow = { id: base.id, imageRef: theirs.imageRef ?? null };
  for (const f of ["imageLinks", "moreImages"] as const) {
    const v = mergeGalleryField(f, side(base), side(mine), side(theirs));
    if (v) (out as Record<string, unknown>)[f] = v;
  }
  return reopened(out);
}

test("files left behind by a removed video, then removed one each by two editors, stay removed", () => {
  const start: GalleryRow = { id: "r1" };
  addGalleryVideo(start, { href: "https://youtu.be/v1" }, PIC2);
  for (const n of ["A.pdf", "B.pdf", "C.pdf"]) addGalleryFile(start, file(n));
  addGalleryPicture(start, PIC, "p.png");
  moveGallerySlot(start, 1, 0);
  removeGalleryLink(start, 1, videoLinkKey({ href: "https://youtu.be/v1" }));
  const full = Array.from({ length: 20 }, (_, i) => file("f" + i + ".pdf"));
  const stored: GalleryRow = { id: "r1", imageRef: PIC, imageLinks: full, moreImages: [{ links: ["A.pdf", "B.pdf", "C.pdf"].map(file) }] };
  for (const [what, from] of [["after a removed video", start], ["stored on an item of their own beside a full cover", stored]] as const) {
    const base = reopened(from), mine = reopened(from), theirs = reopened(from);
    const own = (row: GalleryRow) => names(fileLinks(row)).filter((n) => !/^f\d/.test(n));
    assert.deepEqual(own(base), ["A.pdf", "B.pdf", "C.pdf"], what);
    assert.ok(takeOff(mine, "A.pdf"), what);
    assert.ok(takeOff(theirs, "B.pdf"), what);
    assert.deepEqual(own(mergeRows(base, mine, theirs)), ["C.pdf"], "neither removed file comes back, " + what);
  }
});

function takeOff(row: GalleryRow, n: string): boolean {
  const key = videoLinkKey(file(n));
  return removeGalleryLink(row, rowSlots(row).findIndex((s) => s.links.some((l) => videoLinkKey(l) === key)), key);
}

test("taking a video off while a file is attached elsewhere loses nothing, even past the attach limit", () => {
  const others = Array.from({ length: 17 }, (_, i) => file("f" + i + ".pdf"));
  const start: GalleryRow = { id: "r1", imageRef: PIC, imageLinks: others.concat([file("A.pdf"), file("B.pdf")]),
    moreImages: [{ links: [{ name: "take.mov", size: 3, poster: true }] }] };
  const one = reopened(start), two = reopened(start), three = reopened(start);
  assert.ok(removeGallerySlot(one, 1), "editor 1 removes the video");
  assert.equal(addGalleryFile(two, file("New.pdf")), 0, "editor 2 attaches a file");
  assert.equal(addGalleryFile(three, file("Other.pdf")), 0, "editor 3 attaches another");
  let merged = mergeGalleryField("imageLinks", side(start), side(one), side(two)) as VideoLink[];
  merged = mergeGalleryField("imageLinks", side(start), { imageLinks: merged }, side(three)) as VideoLink[];
  assert.equal(merged.length, 21);
  const row = reopened({ id: "r1", imageRef: PIC, imageLinks: merged });
  assert.deepEqual(names(row.imageLinks), names(others.concat([file("A.pdf"), file("B.pdf"), file("New.pdf"), file("Other.pdf")])), "normalization drops no file to keep a limit");
  assert.equal(addGalleryFile(row, file("More.pdf")), -1, "the limit still applies when attaching");
});

test("a stored item holding only an attached file keeps the file through normalization, slot writing and a join", () => {
  const stored: GalleryRow = { id: "r1", imageRef: PIC, moreImages: [{ links: [BRIEF] }, { imageRef: PIC2 }] };
  assert.deepEqual(fileLinks(reopened(stored)), [BRIEF], "normalization keeps it");
  const written: GalleryRow = { id: "r2" };
  setRowSlots(written, rowSlots(stored));
  assert.deepEqual(fileLinks(written), [BRIEF], "slot writing keeps it");
  const doc = { rows: [{ id: "a", imageRef: PIC }, { id: "b", imageLinks: [BRIEF] }] };
  const joined = setRowSlotsJoin(doc.rows[0] as GalleryRow, doc.rows[1] as GalleryRow);
  assert.deepEqual(fileLinks(joined), [BRIEF], "joining a beat with only a file onto one with a picture");
});

function setRowSlotsJoin(prev: GalleryRow, row: GalleryRow): GalleryRow {
  const out: GalleryRow = { ...prev };
  setRowSlots(out, rowSlots(prev).concat(rowSlots(row)));
  return reopened(out);
}

test("the beat shows a file's type beside its name", () => {
  const cases: [string, string][] = [["brief.pdf", "PDF"], ["vo.WAV", "Audio"], ["notes.docx", "Document"], ["plan.xlsx", "Sheet"],
    ["deck.pptx", "Slides"], ["draft.txt", "Text"], ["take.mp4", "File"], ["Local clip", "File"], ["data.bin2", "File"]];
  for (const [name, label] of cases) assert.equal(videoHostLabel({ name }), label, name);
  assert.equal(videoHostLabel({ href: "https://youtu.be/abc" }), "YouTube");
});
