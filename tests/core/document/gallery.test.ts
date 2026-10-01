import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANNOTATION_COLORS,
  addGalleryPicture,
  addGalleryVideo,
  annotateGallerySlot,
  galleryFieldKey,
  gallerySize,
  mergeGalleryField,
  migrateGallery,
  morePictureRefs,
  moveGallerySlot,
  normalizeMarks,
  normalizePictureName,
  normalizeVideoLink,
  normalizeVideoLinks,
  removeGalleryLink,
  removeGallerySlot,
  replaceGalleryPicture,
  rowSlots,
  rowVideoLinks,
  setRowSlots,
  setVideoThumbnail,
  slotOriginal,
  videoLinkKey
} from "../../../src/core/document/gallery.ts";
import type { GalleryRow, Slot } from "../../../src/core/document/gallery.ts";
import type { ImageRef, ImageSource } from "../../../src/core/document/ports.ts";

const ref = (c: string, width = 4, height = 3): ImageRef => ({ sha256: c.repeat(64), width, height, mime: "image/png" });
const A = ref("a"), B = ref("b"), C = ref("c"), D = ref("d");
const RED = ANNOTATION_COLORS[0] as string;
const PEN = { kind: "pen", color: RED, width: 0.01, points: [0.1, 0.2, 0.3, 0.4] };

function recordingImages(map: Record<string, ImageRef>): ImageSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    known: () => { throw new Error("migrating a gallery looks nothing up"); },
    fromDataUrl(url) { calls.push(url); return map[url] || null; }
  };
}

test("marks keep the palette colours, clamp to the picture and round to four places", () => {
  assert.deepEqual(normalizeMarks([
    { kind: "pen", color: RED.toUpperCase(), width: 0.5, points: [-1, 0.123456, 2, 0.5, 0.7] },
    { kind: "highlight", color: "#ffffff", width: 0.0001, points: [0, 0, 1, 1] },
    { kind: "text", color: "#111111", size: 0.5, x: 0.25, y: 1.5, text: "a\r\nb\u0000\u0001c\u007f" },
    { kind: "pen", color: "#123456", width: 0.01, points: [0, 0, 1, 1] },
    { kind: "pen", color: RED, width: 0.01, points: [0.5] },
    { kind: "pen", color: RED, width: 0.01, points: [0.5, "x"] },
    { kind: "text", color: RED, size: 0.1, x: 0, y: 0, text: " \u0002 " },
    { kind: "shape", color: RED },
    null, [PEN]
  ]), [
    { kind: "pen", color: RED, width: 0.2, points: [0, 0.1235, 1, 0.5] },
    { kind: "highlight", color: "#ffffff", width: 0.001, points: [0, 0, 1, 1] },
    { kind: "text", color: "#111111", size: 0.3, x: 0.25, y: 1, text: "a\nb c " }
  ]);
  assert.deepEqual(normalizeMarks("marks"), []);
  assert.equal(normalizeMarks(Array.from({ length: 510 }, () => PEN)).length, 500);
  const long = normalizeMarks([{ ...PEN, points: Array.from({ length: 4010 }, () => 0.5) }])[0];
  assert.equal(long && "points" in long ? long.points.length : 0, 4000);
});

test("a video link is a web address or a named file, with a duration and a poster flag", () => {
  assert.deepEqual(normalizeVideoLink({ href: " https://example.com/v ", duration: 12.345, poster: true, size: 9 }),
    { href: "https://example.com/v", duration: 12.3, poster: true });
  assert.deepEqual(normalizeVideoLink({ name: "<b>clip</b>\n\t.mp4 ", size: 1024.9, duration: 0, poster: "yes" }),
    { name: "clip .mp4", size: 1024 });
  assert.deepEqual(normalizeVideoLink({ name: "a\u0000\u0001b" }), { name: "ab" }, "plainText drops most controls first");
  assert.deepEqual(normalizeVideoLink({ name: "clip.mp4", size: -1, duration: 1e7 }), { name: "clip.mp4" });
  for (const bad of [{ href: "javascript:alert(1)" }, { href: "mailto:a@b.c" }, { href: "https://x.test/" + "a".repeat(2048) },
    { name: "  " }, { name: 7 }, {}, null, "https://x.test", [{ href: "https://x.test" }]]) {
    assert.equal(normalizeVideoLink(bad), null, JSON.stringify(bad));
  }
});

test("video links are deduplicated by key, keep one poster and stop at twenty", () => {
  const out = normalizeVideoLinks([
    { href: "https://x.test/1", poster: true },
    { href: "https://x.test/2", poster: true },
    { href: "https://x.test/1" },
    { name: "a.mp4", size: 1 },
    { name: "a.mp4", size: 2 },
    { name: "a.mp4", size: 1 },
    { href: "javascript:x" }
  ]);
  assert.deepEqual(out, [
    { href: "https://x.test/1", poster: true },
    { href: "https://x.test/2" },
    { name: "a.mp4", size: 1 },
    { name: "a.mp4", size: 2 }
  ]);
  assert.equal(normalizeVideoLinks(Array.from({ length: 25 }, (_, i) => ({ href: "https://x.test/" + i }))).length, 20);
  assert.deepEqual(normalizeVideoLinks(null), []);
  assert.equal(videoLinkKey({ href: "https://x.test/1" }), "u:https://x.test/1");
  assert.equal(videoLinkKey({ name: "a.mp4" }), "f:a.mp4:0");
  assert.equal(videoLinkKey(null), "");
});

test("a picture name is one line of plain text", () => {
  assert.equal(normalizePictureName("  <i>Wide</i>\nshot\t2 "), "Wide shot 2");
  assert.equal(normalizePictureName("x".repeat(210)), "x".repeat(200));
  assert.equal(normalizePictureName(42), "");
});

test("migrating a gallery interns legacy pictures through the port, in document order", () => {
  const urls = { "data:image/png;base64,QQ==": A, "data:image/png;base64,Qg==": B, "data:image/png;base64,Qw==": C };
  const images = recordingImages(urls);
  const row: GalleryRow = {
    imageRef: D,
    imageName: " Main ",
    imageLinks: [{ href: "https://x.test/v" }, "junk"],
    imageAnnotation: { visualImage: "data:image/png;base64,QQ==", marks: [PEN] },
    moreImages: [
      { visualImage: "data:image/png;base64,Qg==", name: "Second", annotation: { visualImage: "data:image/png;base64,Qw==", marks: [PEN] } },
      { imageRef: D },
      { imageRef: B },
      { links: [{ href: "https://x.test/w", poster: true }] },
      { links: [{ href: "https://x.test/z" }] },
      { visualImage: "data:image/svg+xml;base64,PHN2Zz4=" },
      null
    ]
  };
  migrateGallery(row, images);
  assert.deepEqual(images.calls, ["data:image/png;base64,QQ==", "data:image/png;base64,Qg==", "data:image/png;base64,Qw=="]);
  assert.deepEqual(row, {
    imageRef: D,
    imageName: "Main",
    imageLinks: [{ href: "https://x.test/v" }],
    imageAnnotation: { imageRef: A, marks: [PEN] },
    moreImages: [
      { imageRef: B, name: "Second", annotation: { imageRef: C, marks: [PEN] } },
      { links: [{ href: "https://x.test/w", poster: true }] }
    ]
  });
});

test("migrating promotes the first extra picture when the row has none, and drops empty fields", () => {
  const row: GalleryRow = { imageRef: null, imageName: "orphan", imageAnnotation: { imageRef: A, marks: [PEN] }, moreImages: [{ imageRef: B, name: "B", annotation: { imageRef: C, marks: [PEN] } }] };
  migrateGallery(row, recordingImages({}));
  assert.deepEqual(row, { imageRef: B, imageName: "B", imageAnnotation: { imageRef: C, marks: [PEN] } });
  const flat: GalleryRow = { imageRef: A, imageAnnotation: { imageRef: A, marks: [PEN] }, moreImages: [] };
  migrateGallery(flat, recordingImages({}));
  assert.deepEqual(flat, { imageRef: A });
});

test("a row's slots read its first picture and its extras, and write back the same shape", () => {
  const row: GalleryRow = {
    imageRef: A, imageName: "First", imageLinks: [{ href: "https://x.test/v" }],
    imageAnnotation: { imageRef: B, marks: [PEN] },
    moreImages: [{ imageRef: C, name: "Third" }, { links: [{ href: "https://x.test/w", poster: true }] }, { name: "no picture" }]
  };
  const slots = rowSlots(row);
  assert.deepEqual(slots, [
    { ref: A, dataUrl: null, links: [{ href: "https://x.test/v" }], name: "First", annotation: { imageRef: B, marks: [PEN] } },
    { ref: C, dataUrl: null, links: [], name: "Third", annotation: null },
    { ref: null, dataUrl: null, links: [{ href: "https://x.test/w", poster: true }], name: "", annotation: null }
  ]);
  assert.equal(gallerySize(row), 3);
  assert.deepEqual(morePictureRefs(row), [C]);
  assert.deepEqual(rowVideoLinks(row), [{ href: "https://x.test/v" }, { href: "https://x.test/w", poster: true }]);
  assert.deepEqual(slotOriginal(slots[0]), B);
  assert.deepEqual(slotOriginal(slots[1]), C);
  assert.equal(slotOriginal(null), null);
  const copy: GalleryRow = { visualImage: "data:image/png;base64,QQ==" };
  setRowSlots(copy, slots);
  assert.deepEqual(copy, {
    imageRef: A, imageName: "First", imageLinks: [{ href: "https://x.test/v" }], imageAnnotation: { imageRef: B, marks: [PEN] },
    moreImages: [{ imageRef: C, name: "Third" }, { links: [{ href: "https://x.test/w", poster: true }] }]
  });
  assert.notEqual(copy.imageRef, A, "slots are copied, not shared");
  assert.deepEqual(rowSlots(null), []);
  assert.deepEqual(rowSlots({ visualImage: "data:image/png;base64,QQ==" }),
    [{ ref: null, dataUrl: "data:image/png;base64,QQ==", links: [], name: "", annotation: null }]);
});

test("adding a picture fills an empty first slot, appends otherwise, and finds a repeat", () => {
  const row: GalleryRow = { imageRef: null, imageLinks: [{ href: "https://x.test/v" }] };
  assert.equal(addGalleryPicture(row, A, " <b>One</b> "), 0);
  assert.deepEqual(row, { imageRef: A, imageName: "One", imageLinks: [{ href: "https://x.test/v" }] });
  assert.equal(addGalleryPicture(row, B, ""), 1);
  assert.equal(addGalleryPicture(row, A, "again"), 0);
  assert.deepEqual(row, { imageRef: A, imageName: "One", imageLinks: [{ href: "https://x.test/v" }], moreImages: [{ imageRef: B }] });
  const empty: GalleryRow = {};
  assert.equal(addGalleryPicture(empty, C, null), 0);
  assert.deepEqual(empty, { imageRef: C });
});

test("adding a video makes a poster slot, joins a lone link-only slot, and finds a repeat", () => {
  const row: GalleryRow = { imageRef: null, imageLinks: [{ href: "https://x.test/a" }] };
  assert.equal(addGalleryVideo(row, { href: "https://x.test/v" }), 0);
  assert.deepEqual(row, { imageRef: null, imageLinks: [{ href: "https://x.test/a" }, { href: "https://x.test/v", poster: true }] });
  assert.equal(addGalleryVideo(row, { href: "https://x.test/v" }), 0);
  assert.equal(addGalleryVideo(row, { href: "https://x.test/w" }, A), 1);
  assert.deepEqual(row, {
    imageRef: null,
    imageLinks: [{ href: "https://x.test/a" }, { href: "https://x.test/v", poster: true }],
    moreImages: [{ imageRef: A, links: [{ href: "https://x.test/w", poster: true }] }]
  });
  assert.equal(addGalleryVideo(row, { href: "javascript:x" }), -1);
});

test("a video's thumbnail fills its poster slot once", () => {
  const row: GalleryRow = { imageRef: A, moreImages: [{ links: [{ href: "https://x.test/w", poster: true }] }] };
  assert.equal(setVideoThumbnail(row, "u:https://x.test/w", A), false, "a picture already in the gallery");
  assert.equal(setVideoThumbnail(row, "u:https://x.test/nope", B), false);
  assert.equal(setVideoThumbnail(row, "u:https://x.test/w", null), false);
  assert.equal(setVideoThumbnail(row, "u:https://x.test/w", B), true);
  assert.deepEqual(row.moreImages, [{ imageRef: B, links: [{ href: "https://x.test/w", poster: true }] }]);
  assert.equal(setVideoThumbnail(row, "u:https://x.test/w", C), false);
});

test("replacing a picture clears its annotation, or drops the slot when the picture is already elsewhere", () => {
  const row: GalleryRow = { imageRef: A, imageAnnotation: { imageRef: B, marks: [PEN] }, moreImages: [{ imageRef: C }] };
  assert.equal(replaceGalleryPicture(row, 0, D, "New"), true);
  assert.deepEqual(row, { imageRef: D, imageName: "New", moreImages: [{ imageRef: C }] });
  assert.equal(replaceGalleryPicture(row, 0, C, "dup"), true);
  assert.deepEqual(row, { imageRef: C });
  assert.equal(replaceGalleryPicture(row, 5, A, ""), false);
});

test("annotating a slot keeps the original and refuses what would collide", () => {
  const row: GalleryRow = { imageRef: A, moreImages: [{ imageRef: C }] };
  assert.equal(annotateGallerySlot(row, 0, B, A, [PEN]), true);
  assert.deepEqual(row, { imageRef: B, imageAnnotation: { imageRef: A, marks: [PEN] }, moreImages: [{ imageRef: C }] });
  assert.equal(annotateGallerySlot(row, 0, C, A, [PEN]), false, "the flattened picture is another slot's");
  assert.equal(annotateGallerySlot(row, 0, A, A, [PEN]), false, "flattened to the original");
  assert.equal(annotateGallerySlot(row, 0, D, null, [PEN]), false);
  assert.equal(annotateGallerySlot(row, 9, D, A, [PEN]), false);
  assert.equal(annotateGallerySlot(row, 0, null, A, []), true, "no marks restores the original");
  assert.deepEqual(row, { imageRef: A, moreImages: [{ imageRef: C }] });
});

test("slots move, go, and lose links", () => {
  const row: GalleryRow = { imageRef: A, moreImages: [{ imageRef: B, links: [{ href: "https://x.test/1" }] }, { links: [{ href: "https://x.test/w", poster: true }] }] };
  assert.equal(moveGallerySlot(row, 2, 0), true);
  assert.deepEqual(rowSlots(row).map((s: Slot) => s.ref && s.ref.sha256[0]), [null, "a", "b"]);
  assert.equal(moveGallerySlot(row, 0, 0), false);
  assert.equal(moveGallerySlot(row, 0, 3), false);
  assert.equal(removeGalleryLink(row, 2, "u:https://x.test/1"), true);
  assert.equal(removeGalleryLink(row, 2, "u:https://x.test/1"), false);
  assert.equal(removeGalleryLink(row, 0, "u:https://x.test/w"), true, "a link-only slot with no links left goes");
  assert.equal(gallerySize(row), 2);
  assert.equal(removeGallerySlot(row, 0), true);
  assert.deepEqual(row, { imageRef: B });
  assert.equal(removeGallerySlot(row, 3), false);
});

test("gallery fields merge as sets: their order, my additions, and deletions on either side", () => {
  const base = { imageLinks: [{ href: "https://x.test/1" }, { href: "https://x.test/2" }] };
  const mine = { imageLinks: [{ href: "https://x.test/1" }, { href: "https://x.test/3" }] };
  const theirs = { imageLinks: [{ href: "https://x.test/2" }, { href: "https://x.test/1" }, { href: "https://x.test/4" }] };
  assert.deepEqual(mergeGalleryField("imageLinks", base, mine, theirs),
    [{ href: "https://x.test/1" }, { href: "https://x.test/4" }, { href: "https://x.test/3" }]);
  assert.equal(mergeGalleryField("imageLinks", null, {}, {}), undefined);
  const more = mergeGalleryField("moreImages",
    { moreImages: [{ imageRef: A, links: [{ href: "https://x.test/1" }] }] },
    { moreImages: [{ imageRef: A, links: [{ href: "https://x.test/1" }, { href: "https://x.test/m" }] }] },
    { moreImages: [{ imageRef: A, name: "theirs" }, { imageRef: B }] });
  assert.deepEqual(more, [{ imageRef: A, name: "theirs", links: [{ href: "https://x.test/m" }] }, { imageRef: B }]);
});

test("a gallery field's key names its pictures and links, poster flags included", () => {
  assert.equal(galleryFieldKey({ imageLinks: [{ href: "https://x.test/1", poster: true }, { name: "a.mp4", size: 3 }] }, "imageLinks"),
    "u:https://x.test/1*\nf:a.mp4:3");
  assert.equal(galleryFieldKey({ moreImages: [{ imageRef: A, links: [{ href: "https://x.test/1" }] }, { links: [{ href: "https://x.test/w", poster: true }] }] }, "moreImages"),
    A.sha256 + "[u:https://x.test/1]\nv:u:https://x.test/w[u:https://x.test/w]");
  assert.equal(galleryFieldKey({ imageLinks: [] }, "imageLinks"), null);
  assert.equal(galleryFieldKey(null, "moreImages"), null);
});
