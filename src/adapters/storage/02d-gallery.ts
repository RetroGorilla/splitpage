import { bytesForSync, registryImages } from "./02c-blobs.ts";
import { migrateGallery as migrateGalleryWith } from "../../core/document/gallery.ts";

import type { GalleryRow, VideoLink } from "../../core/document/gallery.ts";
import type { ImageRef } from "../../core/document/ports.ts";

export function migrateGallery(r: GalleryRow) {
  migrateGalleryWith(r, registryImages);
}

export function pictureBytes(ref: ImageRef | null | undefined) {
  const held = ref ? bytesForSync(ref.sha256) : null;
  return held ? { bytes: held, mime: (ref as ImageRef).mime, width: (ref as ImageRef).width, height: (ref as ImageRef).height } : null;
}

export function videoLinkText(l: VideoLink) {
  return l.href ? l.href : l.name + " (video file)";
}

export function startGalleryStore() {}
