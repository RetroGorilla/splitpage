export const PROTOTYPE_IDS: readonly string[] = Object.freeze([
  "__proto__", "constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty",
  "isPrototypeOf", "propertyIsEnumerable", "__defineGetter__", "__defineSetter__",
  "__lookupGetter__", "__lookupSetter__"
]);

export function idMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
