export const NATIVE_FIELD_PREFIX = "f:";

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
