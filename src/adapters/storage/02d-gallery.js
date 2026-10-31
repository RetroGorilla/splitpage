import { bytesForSync, registryImages } from "./02c-blobs.js";
import { migrateGallery as migrateGalleryWith } from "../../core/document/gallery.ts";

export function migrateGallery(r) {
  migrateGalleryWith(r, registryImages);
}

export function pictureBytes(ref) {
  var held = ref ? bytesForSync(ref.sha256) : null;
  return held ? { bytes: held, mime: ref.mime, width: ref.width, height: ref.height } : null;
}

export function videoLinkText(l) {
  return l.href ? l.href : l.name + " (video file)";
}

export function startGalleryStore() {}
