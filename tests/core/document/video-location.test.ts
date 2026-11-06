import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addGalleryVideo,
  galleryFieldKey,
  mergeGalleryField,
  migrateGallery,
  normalizeVideoLink,
  normalizeVideoLocation,
  rowSlots,
  videoLinkKey,
  withoutVideoLocations
} from "../../../src/core/document/gallery.ts";
import type { GalleryRow, VideoLink } from "../../../src/core/document/gallery.ts";
import type { ImageSource } from "../../../src/core/document/ports.ts";

const NO_IMAGES: ImageSource = { known: () => null, fromDataUrl: () => null };
const AT = (path: string) => ({ kind: "path" as const, path });
const WIN = "C:\\Videos\\take one.mp4";
const MOVED = "D:\\Archive\\take one.mp4";
const MAC = "/Users/adam/Movies/take one.mov";

test("a video file link keeps a local path; a web link and a bad or unknown location keep none", () => {
  assert.deepEqual(normalizeVideoLink({ name: "take one.mp4", size: 9, location: AT(WIN), duration: 2 }),
    { name: "take one.mp4", size: 9, location: AT(WIN), duration: 2 });
  assert.deepEqual(normalizeVideoLink({ name: "take one.mov", location: AT(MAC) }), { name: "take one.mov", location: AT(MAC) });
  assert.deepEqual(normalizeVideoLink({ href: "https://x.test/v", location: AT(WIN) }), { href: "https://x.test/v" });
  for (const bad of [null, "C:\\v.mp4", { path: WIN }, { kind: "bundle", path: "take.mp4" }, AT("take.mp4"), AT("\\\\nas\\v\\take.mp4"),
    AT("C:\\Videos\\..\\take.mp4"), AT("C:\\Videos\\take.exe"), AT("C:\\Videos\\take.mp4.lnk"), AT("/a/b\u0000.mp4")]) {
    assert.deepEqual(normalizeVideoLink({ name: "take.mp4", location: bad }), { name: "take.mp4" }, JSON.stringify(bad));
    assert.equal(normalizeVideoLocation(bad), null, JSON.stringify(bad));
  }
});

test("the location is not part of a link's identity: the same file from another folder is still one link", () => {
  assert.equal(videoLinkKey({ name: "a.mp4", size: 3, location: AT(WIN) }), videoLinkKey({ name: "a.mp4", size: 3 }));
});

test("a saved gallery with locations reads back unchanged, in the first item and in further items", () => {
  const row: GalleryRow = {
    id: "r1", imageRef: null,
    imageLinks: [{ name: "take one.mp4", size: 9, location: AT(WIN), poster: true }],
    moreImages: [{ links: [{ name: "b.mov", size: 3, location: AT(MAC), poster: true }] }]
  };
  const before = JSON.stringify(row);
  migrateGallery(row, NO_IMAGES);
  assert.equal(JSON.stringify(row), before);
  const again = JSON.parse(JSON.stringify(row)) as GalleryRow;
  migrateGallery(again, NO_IMAGES);
  assert.deepEqual(again, row);
});

test("dropping a file again records its path on the link it already has, and never adds a second tile", () => {
  const row: GalleryRow = { id: "r1", imageRef: null };
  assert.equal(addGalleryVideo(row, { name: "take one.mp4", size: 9 }), 0);
  const before = JSON.stringify(row);
  assert.equal(addGalleryVideo(row, { name: "take one.mp4", size: 9 }), 0);
  assert.equal(JSON.stringify(row), before, "no path: nothing changes");
  assert.equal(addGalleryVideo(row, { name: "take one.mp4", size: 9, location: AT(WIN) }), 0);
  assert.deepEqual(row.imageLinks, [{ name: "take one.mp4", size: 9, location: AT(WIN), poster: true }]);
  assert.equal(addGalleryVideo(row, { name: "take one.mp4", size: 9, location: AT(MOVED) }), 0);
  assert.deepEqual(row.imageLinks, [{ name: "take one.mp4", size: 9, location: AT(MOVED), poster: true }]);
  assert.equal(addGalleryVideo(row, { name: "take one.mp4", size: 9 }), 0);
  assert.deepEqual(row.imageLinks, [{ name: "take one.mp4", size: 9, location: AT(MOVED), poster: true }], "a drop without a path keeps the one it has");
  assert.equal(rowSlots(row).length, 1);
});

test("a change of location alone is a change of the gallery field, for merging and for equality", () => {
  const plain: VideoLink = { name: "a.mp4", size: 3, poster: true };
  const located: VideoLink = { ...plain, location: AT(WIN) };
  assert.notEqual(galleryFieldKey({ imageLinks: [plain] }, "imageLinks"), galleryFieldKey({ imageLinks: [located] }, "imageLinks"));
  assert.notEqual(galleryFieldKey({ imageLinks: [located] }, "imageLinks"), galleryFieldKey({ imageLinks: [{ ...plain, location: AT(MOVED) }] }, "imageLinks"));
  assert.notEqual(galleryFieldKey({ moreImages: [{ links: [plain] }] }, "moreImages"), galleryFieldKey({ moreImages: [{ links: [located] }] }, "moreImages"));
  assert.equal(galleryFieldKey({ imageLinks: [located] }, "imageLinks"), galleryFieldKey({ imageLinks: [{ ...located }] }, "imageLinks"));
});

test("merging a link: the side that changed its location wins, and a location is never lost to a side without one", () => {
  const link = (location?: string): VideoLink => location ? { name: "a.mp4", size: 3, location: AT(location) } : { name: "a.mp4", size: 3 };
  const merged = (b: VideoLink | null, m: VideoLink, t: VideoLink) =>
    (mergeGalleryField("imageLinks", b ? { imageLinks: [b] } : null, { imageLinks: [m] }, { imageLinks: [t] }) as VideoLink[])[0]?.location?.path;
  assert.equal(merged(link(), link(WIN), link()), WIN, "mine added a path");
  assert.equal(merged(link(), link(), link(WIN)), WIN, "theirs added a path");
  assert.equal(merged(link(WIN), link(WIN), link()), WIN, "theirs was saved by an older build, which drops it");
  assert.equal(merged(link(WIN), link(), link(WIN)), WIN, "mine was saved by an older build");
  assert.equal(merged(link(WIN), link(MOVED), link(WIN)), MOVED, "mine moved it");
  assert.equal(merged(link(WIN), link(WIN), link(MOVED)), MOVED, "theirs moved it");
  assert.equal(merged(link(WIN), link(MAC), link(MOVED)), MOVED, "both moved it: theirs, as for every other link field");
  assert.equal(merged(null, link(WIN), link(MOVED)), MOVED, "no base: theirs");
  const more = mergeGalleryField("moreImages", { moreImages: [{ links: [{ ...link(), poster: true }] }] },
    { moreImages: [{ links: [{ ...link(WIN), poster: true }] }] }, { moreImages: [{ links: [{ ...link(), poster: true }] }] });
  assert.deepEqual(more, [{ links: [{ name: "a.mp4", size: 3, poster: true, location: AT(WIN) }] }]);
});

test("withoutVideoLocations removes every location and nothing else", () => {
  const rows: GalleryRow[] = [
    { id: "r1", imageLinks: [{ name: "a.mp4", size: 3, location: AT(WIN), poster: true }, { href: "https://x.test/v" }],
      moreImages: [{ links: [{ name: "b.mov", size: 2, location: AT(MAC), poster: true }] }, { imageRef: null }] },
    { id: "r2" }
  ];
  withoutVideoLocations([...rows, null, "x"]);
  assert.deepEqual(rows, [
    { id: "r1", imageLinks: [{ name: "a.mp4", size: 3, poster: true }, { href: "https://x.test/v" }],
      moreImages: [{ links: [{ name: "b.mov", size: 2, poster: true }] }, { imageRef: null }] },
    { id: "r2" }
  ]);
});
