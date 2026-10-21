import { rowContentEqual } from "../core/merge/rows.ts";
import "./_dom.mjs";
import { liveDoc, liveWithAssets } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { __init as initStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { intern } from "../adapters/storage/02c-blobs.js";
import {
  addGalleryPicture, addGalleryVideo, moveGallerySlot, removeGalleryLink, removeGallerySlot, replaceGalleryPicture, rowSlots, videoLinkKey
} from "../adapters/storage/02d-gallery.js";
import { mergeStates } from "../js/03-sync.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { toMarkdownDoc } from "../js/14d-export-text.js";
import { __init as initDocx, buildDocx, docxToRows } from "../js/15-docx.js";
import { buildPdf } from "../js/17-pdf.js";
import { buildSplitpageFile, parseSplitpageFile } from "../js/20d-formats.js";
import { refsIn } from "../../shared/blob-policy.js";
import { exportDocumentOf } from "../js/14b-export-kit.js";

initTags();
initStatus();
initDocx();

const jpegBytes = (w, h, salt) => new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt || 0, 0xFF, 0xD9]);
const P1 = intern(jpegBytes(300, 200, 1));
const P2 = intern(jpegBytes(200, 300, 2));
const P3 = intern(jpegBytes(100, 100, 3));

function doc(rows) {
  return migrateRows({ schema: 2, title: "Gallery", comments: [], rows: rows.map((r, i) => Object.assign({ id: "r" + i, visualText: "", audioText: "", status: "todo" }, r)) });
}

test("migrateRows keeps a gallery, and makes it safe", () => {
  const s = doc([
    { imageRef: P1, imageLinks: [{ href: "https://youtu.be/abc", poster: true }, { href: "javascript:alert(1)" }, { href: "https://youtu.be/abc" }, { name: "<b>take</b>.mp4", size: 12, extra: 1 }, "junk"],
      moreImages: [{ imageRef: P2, links: [{ href: "https://vimeo.com/1" }] }, { imageRef: P1 }, { imageRef: { sha256: "x" } }, null, { imageRef: P3, bogus: true }] },
    { imageRef: null, moreImages: [{ imageRef: P3, links: [{ href: "https://loom.com/share/x" }] }] },
    { imageRef: P1 }
  ]);
  const r0 = s.rows[0];
  assert.deepEqual(r0.imageLinks, [{ href: "https://youtu.be/abc", poster: true }, { name: "take.mp4", size: 12 }]);
  assert.deepEqual(r0.moreImages, [
    { imageRef: P2, links: [{ href: "https://vimeo.com/1" }] },
    { imageRef: P3 }
  ], "a repeat of the first picture, a bad record and a non-object are dropped; nothing else rides along");
  assert.equal(s.rows[1].imageRef.sha256, P3.sha256);
  assert.deepEqual(s.rows[1].imageLinks, [{ href: "https://loom.com/share/x" }]);
  assert.equal(s.rows[1].moreImages, undefined);
  assert.ok(!("imageLinks" in s.rows[2]) && !("moreImages" in s.rows[2]));
  assert.deepEqual(migrateRows(JSON.parse(JSON.stringify(s))).rows, s.rows);
  assert.deepEqual(refsIn(s).sort(), [P1.sha256, P2.sha256, P3.sha256].sort());
});

test("the slot operations: every picture and video its own item; replace, move, remove, a link off", () => {
  const row = doc([{}]).rows[0];
  assert.equal(addGalleryVideo(row, { href: "https://youtu.be/v1" }, null), 0);
  assert.deepEqual(rowSlots(row).map((s) => [s.ref, s.links.length]), [[null, 1]], "a video with no thumbnail: a placeholder item");
  assert.equal(addGalleryPicture(row, P1), 1, "a picture goes after it, never over it");
  assert.equal(addGalleryPicture(row, P2), 2);
  assert.equal(addGalleryPicture(row, P1), 1, "never twice");
  assert.equal(addGalleryVideo(row, { href: "https://youtu.be/v2" }, P3), 3, "a video on a scene with pictures: a tile of its own, its thumbnail its picture");
  assert.equal(addGalleryVideo(row, { href: "https://youtu.be/v1" }, null), 0, "the same video twice is one item");
  assert.deepEqual(row.moreImages[2], { imageRef: P3, links: [{ href: "https://youtu.be/v2", poster: true }] });
  replaceGalleryPicture(row, 1, P3);
  assert.equal(rowSlots(row).length, 3, "a picture already there: the replaced slot goes");
  moveGallerySlot(row, 2, 0);
  assert.equal(row.imageRef.sha256, P3.sha256, "a video tile can be the cover");
  assert.deepEqual(row.imageLinks, [{ href: "https://youtu.be/v2", poster: true }]);
  assert.ok(removeGalleryLink(row, 1, videoLinkKey({ href: "https://youtu.be/v1", poster: true })));
  assert.equal(rowSlots(row).length, 2, "a placeholder with no link left is nothing");
  removeGallerySlot(row, 0);
  assert.equal(row.imageRef.sha256, P2.sha256, "the next moves up");
  assert.ok(!("imageLinks" in row) && !("moreImages" in row));
  removeGallerySlot(row, 0);
  assert.equal(row.imageRef, null);
  assert.deepEqual(rowSlots(row), []);
});

test("a video item survives migrateRows, refsIn and a .splitpage round trip", () => {
  const s = doc([{ imageRef: P1, moreImages: [{ links: [{ href: "https://vimeo.com/9", poster: true }] }, { links: [{ href: "https://vimeo.com/x" }] }, { imageRef: P2, links: [{ name: "a.mp4", size: 1, poster: true }] }] }]);
  assert.deepEqual(s.rows[0].moreImages, [
    { links: [{ href: "https://vimeo.com/9", poster: true }] },
    { imageRef: P2, links: [{ name: "a.mp4", size: 1, poster: true }] }
  ], "an item with neither a picture nor a video of its own is dropped");
  assert.deepEqual(refsIn(s).sort(), [P1.sha256, P2.sha256].sort());
  const back = migrateRows(parseSplitpageFile(buildSplitpageFile(exportDocumentOf(s))));
  assert.deepEqual(back.rows[0].moreImages, s.rows[0].moreImages);
});

test("the merge keeps both sides' pictures and links, and either side's removals", () => {
  const base = doc([{ visualText: "v", imageRef: P1, moreImages: [{ imageRef: P2 }] }]);
  const mine = JSON.parse(JSON.stringify(base));
  const theirs = JSON.parse(JSON.stringify(base));
  mine.rows[0].moreImages.push({ imageRef: P3 });
  mine.rows[0].imageLinks = [{ href: "https://youtu.be/mine" }];
  theirs.rows[0].moreImages[0].links = [{ href: "https://vimeo.com/theirs" }];
  let out = mergeStates(base, mine, theirs).merged;
  assert.deepEqual(out.rows[0].moreImages, [
    { imageRef: P2, links: [{ href: "https://vimeo.com/theirs" }] },
    { imageRef: P3 }
  ]);
  assert.deepEqual(out.rows[0].imageLinks, [{ href: "https://youtu.be/mine" }]);
  assert.equal(out.comments.length, 0, "never a conflict card");
  const theirs2 = JSON.parse(JSON.stringify(base));
  delete theirs2.rows[0].moreImages;
  out = mergeStates(base, mine, theirs2).merged;
  assert.deepEqual(out.rows[0].moreImages, [{ imageRef: P3 }]);
  assert.equal(rowContentEqual(base.rows[0], mine.rows[0]), false);
  assert.equal(rowContentEqual(base.rows[0], JSON.parse(JSON.stringify(base.rows[0]))), true);
});

test("a .splitpage file carries every picture inline and reads back the same gallery", () => {
  const s = doc([{ imageRef: P1, imageLinks: [{ href: "https://youtu.be/abc", poster: true }], moreImages: [{ imageRef: P2, links: [{ name: "b.mov", size: 3 }] }] }]);
  const text = buildSplitpageFile(exportDocumentOf(s));
  const raw = JSON.parse(text);
  assert.ok(raw.rows[0].visualImage.indexOf("data:image/jpeg;base64,") === 0);
  assert.ok(raw.rows[0].moreImages[0].visualImage.indexOf("data:image/jpeg;base64,") === 0, "a further picture inline too");
  assert.ok(!("imageRef" in raw.rows[0].moreImages[0]));
  const back = migrateRows(parseSplitpageFile(text));
  assert.deepEqual(back.rows[0].moreImages, s.rows[0].moreImages);
  assert.deepEqual(back.rows[0].imageLinks, s.rows[0].imageLinks);
  assert.equal(back.rows[0].imageRef.sha256, P1.sha256);
});

test("Word: every picture in the Visual cell, the video links under them, and back again as items", async () => {
  S.state = doc([
    { visualText: "Wide", audioText: "Hello.", imageRef: P1, imageLinks: [{ href: "https://youtu.be/abc", poster: true }],
      moreImages: [{ imageRef: P2 }, { links: [{ name: "take one.mp4", size: 3, poster: true }] }, { imageRef: P3 }] },
    { visualText: "▶ not a caption, just words", audioText: "Two." }
  ]);
  const parsed = await docxToRows(new File([buildDocx(...liveWithAssets())], "g.docx"));
  const r0 = parsed.rows[0];
  assert.equal(r0.imageRef.sha256, P1.sha256);
  assert.deepEqual((r0.moreImages || []).map((m) => m.imageRef ? m.imageRef.sha256 : m.links[0].href || m.links[0].name),
    [P2.sha256, P3.sha256, "https://youtu.be/abc", "take one.mp4"]);
  assert.ok(r0.moreImages.slice(2).every((m) => m.links.length === 1 && m.links[0].poster === true));
  assert.equal(r0.visualText.indexOf("youtu.be"), -1, "the links are not the scene's words");
  assert.ok(parsed.rows[1].visualText.indexOf("not a caption, just words") !== -1);
});

test("Markdown and PDF name every picture and every link", () => {
  S.state = doc([{ visualText: "Wide", audioText: "Hello.", imageRef: P1, imageLinks: [{ href: "https://youtu.be/abc" }],
    moreImages: [{ imageRef: P2, links: [{ name: "b.mov", size: 3 }] }] }]);
  const md = toMarkdownDoc(exportDocumentOf(S.state));
  assert.ok(md.indexOf("](images/scene-01.jpg)") !== -1);
  assert.ok(md.indexOf("](images/scene-01-2.jpg)") !== -1);
  assert.ok(md.indexOf("▶ [youtu.be/abc](https://youtu.be/abc)") !== -1);
  assert.ok(md.indexOf("▶ b.mov _(video file)_") !== -1);
  const jpeg = (w, h) => ({ bytes: jpegBytes(w, h, 9), size: { w, h } });
  const jpegs = [jpeg(300, 200)];
  jpegs.more = [[jpeg(200, 300)]];
  const t = new TextDecoder("latin1").decode(buildPdf(liveDoc(), jpegs));
  assert.ok(t.indexOf("(YouTube) Tj") !== -1 && t.indexOf("(youtu.be/abc) Tj") !== -1);
  assert.ok(t.indexOf("/Subtype /Link") !== -1 && t.indexOf("/URI (https://youtu.be/abc)") !== -1);
  assert.ok(t.indexOf("(b.mov) Tj") !== -1);
  assert.ok(/ cm \/Im1 Do Q/.test(t) && / cm \/Im2 Do Q/.test(t), "both pictures drawn");
});
