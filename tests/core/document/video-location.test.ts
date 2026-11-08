import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addGalleryVideo,
  bundleVideoLinks,
  bundledVideoNames,
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

test("a file dropped again from another path brings its own first frame and length with the path", () => {
  const frame = (c: string) => ({ sha256: c.repeat(64), width: 16, height: 9, mime: "image/jpeg" });
  const row: GalleryRow = { id: "r1", imageRef: null };
  assert.equal(addGalleryVideo(row, { name: "take one.mp4", size: 9, location: AT(WIN), duration: 10 }, frame("a")), 0);
  assert.equal(addGalleryVideo(row, { name: "take one.mp4", size: 9, location: AT(MOVED), duration: 20 }, frame("b")), 0);
  const slot = rowSlots(row)[0];
  assert.deepEqual(slot?.links, [{ name: "take one.mp4", size: 9, location: AT(MOVED), duration: 20, poster: true }]);
  assert.equal(slot?.ref?.sha256, "b".repeat(64));
  assert.equal(addGalleryVideo(row, { name: "take one.mp4", size: 9, location: AT(WIN) }, null), 0);
  assert.deepEqual(rowSlots(row)[0]?.links, [{ name: "take one.mp4", size: 9, location: AT(WIN), duration: 20, poster: true }],
    "a drop whose frame and length could not be read keeps the ones it has");
  assert.equal(rowSlots(row)[0]?.ref?.sha256, "b".repeat(64));
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
    ((mergeGalleryField("imageLinks", b ? { imageLinks: [b] } : null, { imageLinks: [m] }, { imageLinks: [t] }) as VideoLink[])[0]?.location as { path?: string } | undefined)?.path;
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

const IN = (name: string) => ({ kind: "bundled" as const, name });

test("a video file link may name a file in the script's bundle folder: one plain video file name, nothing else", () => {
  assert.deepEqual(normalizeVideoLink({ name: "take one.mp4", size: 9, location: IN("take one (2).mp4") }),
    { name: "take one.mp4", size: 9, location: IN("take one (2).mp4") });
  assert.deepEqual(normalizeVideoLink({ href: "https://x.test/v", location: IN("take.mp4") }), { href: "https://x.test/v" });
  for (const bad of [IN("..\\take.mp4"), IN("../take.mp4"), IN("sub/take.mp4"), IN("C:\\take.mp4"), IN("\\\\nas\\v\\take.mp4"), IN("/a/take.mp4"),
    IN("take.exe"), IN("take.mp4.lnk"), IN("take.mp4:x"), IN("CON.mp4"), IN("take.mp4."), IN("a\u0000.mp4"), IN(""),
    { kind: "bundled", path: "take.mp4" }, { kind: "bundled", name: 5 }]) {
    assert.deepEqual(normalizeVideoLink({ name: "take.mp4", location: bad }), { name: "take.mp4" }, JSON.stringify(bad));
    assert.equal(normalizeVideoLocation(bad), null, JSON.stringify(bad));
  }
});

test("a bundled link reads back unchanged, and is a different gallery value from the same file by path", () => {
  const row: GalleryRow = { id: "r1", imageRef: null, imageLinks: [{ name: "a.mp4", size: 3, location: IN("a.mp4"), poster: true }],
    moreImages: [{ links: [{ name: "b.mov", size: 2, location: IN("b (2).mov"), poster: true }] }] };
  const before = JSON.stringify(row);
  migrateGallery(row, NO_IMAGES);
  assert.equal(JSON.stringify(row), before);
  const byPath: VideoLink = { name: "a.mp4", size: 3, location: AT(WIN), poster: true };
  const bundled: VideoLink = { name: "a.mp4", size: 3, location: IN("a.mp4"), poster: true };
  assert.notEqual(galleryFieldKey({ imageLinks: [byPath] }, "imageLinks"), galleryFieldKey({ imageLinks: [bundled] }, "imageLinks"));
  assert.notEqual(galleryFieldKey({ imageLinks: [bundled] }, "imageLinks"), galleryFieldKey({ imageLinks: [{ ...bundled, location: IN("a (2).mp4") }] }, "imageLinks"));
  assert.equal(videoLinkKey(byPath), videoLinkKey(bundled), "still one video");
});

test("merging: bundling on one side wins over the untouched path on the other", () => {
  const byPath: VideoLink = { name: "a.mp4", size: 3, location: AT(WIN) };
  const bundled: VideoLink = { name: "a.mp4", size: 3, location: IN("a.mp4") };
  const merged = (b: VideoLink, m: VideoLink, t: VideoLink) =>
    (mergeGalleryField("imageLinks", { imageLinks: [b] }, { imageLinks: [m] }, { imageLinks: [t] }) as VideoLink[])[0]?.location;
  assert.deepEqual(merged(byPath, bundled, byPath), IN("a.mp4"), "mine bundled it");
  assert.deepEqual(merged(byPath, byPath, bundled), IN("a.mp4"), "theirs bundled it");
  assert.deepEqual(merged(bundled, bundled, { name: "a.mp4", size: 3 }), IN("a.mp4"), "an older build dropped it");
});

test("merging (#1252): a bundled copy beats a path on the other side, whichever side changed", () => {
  const byPath = (path: string): VideoLink => ({ name: "a.mp4", size: 3, location: AT(path) });
  const bundled: VideoLink = { name: "a.mp4", size: 3, location: IN("a.mp4") };
  const merged = (b: VideoLink | null, m: VideoLink, t: VideoLink) =>
    (mergeGalleryField("imageLinks", b ? { imageLinks: [b] } : null, { imageLinks: [m] }, { imageLinks: [t] }) as VideoLink[])[0]?.location;
  assert.deepEqual(merged(bundled, bundled, byPath(WIN)), IN("a.mp4"), "theirs moved it to a path");
  assert.deepEqual(merged(bundled, byPath(WIN), bundled), IN("a.mp4"), "mine moved it to a path");
  assert.deepEqual(merged(byPath(MOVED), bundled, byPath(WIN)), IN("a.mp4"), "both changed: mine bundled it");
  assert.deepEqual(merged(byPath(MOVED), byPath(WIN), bundled), IN("a.mp4"), "both changed: theirs bundled it");
  assert.deepEqual(merged(null, bundled, byPath(WIN)), IN("a.mp4"), "no base, mine bundled");
  assert.deepEqual(merged(null, byPath(WIN), bundled), IN("a.mp4"), "no base, theirs bundled");
  assert.deepEqual(merged(null, bundled, { ...bundled, location: IN("a (2).mp4") }), IN("a (2).mp4"), "two bundled names: theirs, as before");
  const more = mergeGalleryField("moreImages", null, { moreImages: [{ links: [{ ...bundled, poster: true }] }] },
    { moreImages: [{ links: [{ ...byPath(WIN), poster: true }] }] });
  assert.deepEqual(more, [{ links: [{ name: "a.mp4", size: 3, location: IN("a.mp4"), poster: true }] }], "a further picture's link too");
});

test("bundling relinks every link to that file at that path, wherever it is, and nothing else", () => {
  const from: VideoLink = { name: "a.mp4", size: 3, location: AT(WIN) };
  const rows: GalleryRow[] = [
    { id: "r1", imageLinks: [{ ...from, poster: true }, { href: "https://x.test/v" }],
      moreImages: [{ links: [{ ...from, poster: true }] }, { links: [{ name: "a.mp4", size: 3, location: AT(MOVED), poster: true }] }] },
    { id: "r2", imageLinks: [{ name: "a.mp4", size: 4, location: AT(WIN), poster: true }, { name: "a.mp4", size: 3, poster: true }] }
  ];
  assert.equal(bundleVideoLinks(rows, from, "a (2).mp4"), true);
  assert.deepEqual(rows[0]?.imageLinks, [{ name: "a.mp4", size: 3, location: IN("a (2).mp4"), poster: true }, { href: "https://x.test/v" }]);
  assert.deepEqual(rows[0]?.moreImages, [{ links: [{ name: "a.mp4", size: 3, location: IN("a (2).mp4"), poster: true }] },
    { links: [{ name: "a.mp4", size: 3, location: AT(MOVED), poster: true }] }], "the same file from another folder is not this copy");
  assert.deepEqual(rows[1]?.imageLinks, [{ name: "a.mp4", size: 4, location: AT(WIN), poster: true }, { name: "a.mp4", size: 3, poster: true }]);
  assert.equal(bundleVideoLinks(rows, from, "a (2).mp4"), false, "nothing left to relink");
  assert.equal(bundleVideoLinks(rows, { name: "a.mp4", size: 3, location: AT(MOVED) }, "..\\a.mp4"), false, "a bad name is never written");
});

test("the bundled names a script uses are listed once each, for Save As to carry", () => {
  const rows: GalleryRow[] = [
    { id: "r1", imageLinks: [{ name: "a.mp4", size: 3, location: IN("a.mp4"), poster: true }, { name: "p.mp4", location: AT(WIN) }],
      moreImages: [{ links: [{ name: "b.mov", location: IN("b.mov"), poster: true }] }, { links: [{ name: "a.mp4", size: 3, location: IN("a.mp4") }] }] },
    { id: "r2", imageLinks: [{ name: "x.mp4", location: IN("..\\x.mp4") } as VideoLink] }
  ];
  assert.deepEqual(bundledVideoNames([...rows, null, "x"]), ["a.mp4", "b.mov"]);
});

test("withoutVideoLocations removes a bundled location too", () => {
  const rows: GalleryRow[] = [{ id: "r1", imageLinks: [{ name: "c.mp4", size: 1, location: IN("c.mp4"), poster: true }],
    moreImages: [{ links: [{ name: "d.mp4", location: IN("d.mp4"), poster: true }] }] }];
  withoutVideoLocations(rows);
  assert.deepEqual(rows, [{ id: "r1", imageLinks: [{ name: "c.mp4", size: 1, poster: true }], moreImages: [{ links: [{ name: "d.mp4", poster: true }] }] }]);
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
