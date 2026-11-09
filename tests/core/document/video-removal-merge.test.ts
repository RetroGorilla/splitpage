import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeGalleryField } from "../../../src/core/document/gallery.ts";
import type { GallerySide, VideoLink } from "../../../src/core/document/gallery.ts";
import type { ImageRef } from "../../../src/core/document/ports.ts";

const thumbnail: ImageRef = { sha256: "b".repeat(64), width: 1, height: 1, mime: "image/png" };

test("a removed video link stays removed when the other side only sets its thumbnail (#1278)", () => {
  for (const link of [{ href: "https://example.test/video", poster: true }, { name: "clip.mp4", size: 3, poster: true }] satisfies VideoLink[]) {
    const base: GallerySide = { moreImages: [{ links: [link] }] };
    const removed: GallerySide = {};
    const changed: GallerySide = { moreImages: [{ imageRef: thumbnail, links: [link] }] };
    for (const [mine, theirs] of [[removed, changed], [changed, removed]]) {
      assert.deepEqual(mergeGalleryField("moreImages", base, mine as GallerySide, theirs as GallerySide),
        [{ imageRef: thumbnail }]);
    }
  }
});
