import * as Y from "yjs";

export function nativeClock(doc: Y.Doc): number {
  return Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) ?? 0;
}

// why: the client id and clock distinguish records minted by copies that have not received each other's updates
export function mintNativeId(doc: Y.Doc, prefix: string): string {
  return prefix + doc.clientID.toString(36) + "-" + nativeClock(doc).toString(36);
}

export function mintNativeTagId(doc: Y.Doc, offset = 0): string {
  const pair = ((BigInt(nativeClock(doc)) + BigInt(offset)) << 32n) + BigInt(doc.clientID);
  const digits = pair.toString(36);
  return digits.length <= 16 ? "t_" + digits : "t_" + (pair / 1_000_000n).toString(36) + "-" + pair % 1_000_000n;
}

export const NATIVE_FIELD_PREFIX = "f:";
export const NATIVE_BEAT_FIELDS = ["status", "lengthSeconds", "paragraphStart"] as const;
export const NATIVE_GALLERY_KEY = "gallery";
export const NATIVE_GALLERY_FIELDS = new Set(["imageRef", "imageName", "imageAnnotation", "imageLinks", "moreImages"]);
const NAMED_BEAT_FIELDS = new Set<string>(NATIVE_BEAT_FIELDS);
const RESERVED_BEAT_FIELDS = new Set(["id", "audioText", "visualText", "rank", "joined", "updatedBy", "updatedAt"]);
export const NATIVE_STORED_VALUE_DEPTH = 1024;

export function isNativeBeatField(name: string): boolean {
  return NAMED_BEAT_FIELDS.has(name);
}

export function isReservedBeatField(name: string): boolean {
  return RESERVED_BEAT_FIELDS.has(name);
}

export function isNativeBeatExtra(name: string): boolean {
  return !isNativeBeatField(name) && (!isReservedBeatField(name) || name === "rank" || name === "joined")
    && !NATIVE_GALLERY_FIELDS.has(name) && name !== "visualImage";
}

export function nativeGalleryOf(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const gallery: Record<string, unknown> = {};
  for (const name of NATIVE_GALLERY_FIELDS) if (Object.hasOwn(fields, name) && fields[name] !== undefined) gallery[name] = fields[name];
  return gallery;
}

export function encodeNativeValue(value: unknown): string {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) throw new TypeError("A file value has no JSON form");
  if (text.length > NATIVE_STORED_VALUE_DEPTH * 2 && !decodeNativeValue(text)) throw new RangeError("A file value is too deeply nested");
  return text;
}

export function decodeNativeValue(stored: unknown): { readonly value: unknown } | null {
  if (typeof stored !== "string") return null;
  try {
    const value: unknown = JSON.parse(stored);
    return readableDepth(value, 0) ? { value } : null;
  } catch { return null; }
}

function readableDepth(value: unknown, depth: number): boolean {
  if (value === null || typeof value !== "object") return true;
  if (depth >= NATIVE_STORED_VALUE_DEPTH) return false;
  for (const child of Object.values(value) as unknown[]) if (!readableDepth(child, depth + 1)) return false;
  return true;
}

export function recordBag(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function plainRecordArgument(value: unknown): value is Record<string, unknown> {
  if (!recordBag(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function sameNativeValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => sameNativeValue(item, right[index]));
  if (!recordBag(left) || !recordBag(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameNativeValue(left[key], right[key]));
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
