import { normalizeRowGallery, withoutVideoLocations } from "../../../core/document/gallery.ts";
import { NATIVE_GALLERY_FIELDS, decodeNativeValue, encodeNativeValue, nativeGalleryOf, recordBag, sameNativeValue } from "./values.ts";

const NO_IMAGES = { known: () => null, fromDataUrl: () => null };
const EMPTY_GALLERY = Object.freeze({ imageRef: null });

export function normalizeNativeGallery(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const gallery = { ...fields };
  normalizeRowGallery(gallery, NO_IMAGES);
  withoutVideoLocations([gallery]);
  return gallery;
}

export function encodeNativeGallery(gallery: Readonly<Record<string, unknown>>): string {
  return encodeNativeValue(nativeGalleryOf(gallery));
}

export function readNativeGallery(stored: unknown): Readonly<Record<string, unknown>> | null {
  if (stored === '{"imageRef":null}') return EMPTY_GALLERY;
  const value = decodeNativeValue(stored)?.value;
  if (!recordBag(value) || Object.keys(value).some(name => !NATIVE_GALLERY_FIELDS.has(name))) return null;
  return sameNativeValue(value, normalizeNativeGallery(value)) ? value : null;
}
