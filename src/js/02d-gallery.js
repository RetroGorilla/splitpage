import { bytesForSync, registryImages } from "./02c-blobs.js";
import {
  ANNOTATION_COLORS,
  addGalleryPicture,
  addGalleryVideo,
  annotateGallerySlot,
  galleryFieldKey,
  gallerySize,
  mergeGalleryField,
  migrateGallery as migrateGalleryWith,
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
} from "../core/document/gallery.ts";
export {
  ANNOTATION_COLORS,
  addGalleryPicture,
  addGalleryVideo,
  annotateGallerySlot,
  galleryFieldKey,
  gallerySize,
  mergeGalleryField,
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
};

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

export function videoLinkLabel(l) {
  if (!l) return "";
  if (!l.href) return l.name;
  var s = String(l.href).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return s.length > 48 ? s.slice(0, 45) + "…" : s;
}

export function __init() {}
