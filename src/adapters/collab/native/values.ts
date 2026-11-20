import * as Y from "yjs";

// why: the client id and clock distinguish records minted by copies that have not received each other's updates
export function mintNativeId(doc: Y.Doc, prefix: string): string {
  const clock = Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) ?? 0;
  return prefix + doc.clientID.toString(36) + "-" + clock.toString(36);
}

export const NATIVE_FIELD_PREFIX = "f:";
export const NATIVE_BEAT_FIELDS = ["status", "lengthSeconds", "paragraphStart"] as const;
export const NATIVE_GALLERY_KEY = "gallery";
export const NATIVE_GALLERY_FIELDS = new Set(["imageRef", "imageName", "imageAnnotation", "imageLinks", "moreImages"]);
const NAMED_BEAT_FIELDS = new Set<string>(NATIVE_BEAT_FIELDS);
const RESERVED_BEAT_FIELDS = new Set(["id", "audioText", "visualText", "rank", "joined", "updatedBy", "updatedAt"]);

export function isNativeBeatField(name: string): boolean {
  return NAMED_BEAT_FIELDS.has(name);
}

export function isReservedBeatField(name: string): boolean {
  return RESERVED_BEAT_FIELDS.has(name);
}

export function isNativeBeatExtra(name: string): boolean {
  return !isNativeBeatField(name) && !isReservedBeatField(name) && !NATIVE_GALLERY_FIELDS.has(name) && name !== "visualImage";
}

export function nativeGalleryOf(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const gallery: Record<string, unknown> = {};
  for (const name of NATIVE_GALLERY_FIELDS) if (Object.hasOwn(fields, name) && fields[name] !== undefined) gallery[name] = fields[name];
  return gallery;
}

export function encodeNativeValue(value: unknown): string {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) throw new TypeError("A file value has no JSON form");
  return text;
}

export function decodeNativeValue(stored: unknown): { readonly value: unknown } | null {
  if (typeof stored !== "string") return null;
  try { return { value: JSON.parse(stored) as unknown }; } catch { return null; }
}

export function nativeWellFormed(value: unknown): value is string {
  return typeof value === "string" && !/\p{Cs}/u.test(value);
}

// why: the Yjs string codec turns a lone surrogate into U+FFFD, so a field name travels as its escaped JSON form
export function nativeFieldKey(name: string): string {
  return NATIVE_FIELD_PREFIX + JSON.stringify(name);
}

export function nativeFieldName(key: string): string | null {
  if (!key.startsWith(NATIVE_FIELD_PREFIX)) return null;
  const name = decodeNativeValue(key.slice(NATIVE_FIELD_PREFIX.length))?.value;
  return typeof name === "string" ? name : null;
}

export function deepFrozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFrozen((value as Record<string | symbol, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
