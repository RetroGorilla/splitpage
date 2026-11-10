import { compareCodeUnits } from "./order.ts";

const fileOrders = new WeakMap<object, readonly string[]>();

export function rememberFileOrder(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  fileOrders.set(value, keys); return value;
}

export function rememberTreeOrder(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) fileOrders.set(value, Object.keys(value));
  for (const child of Object.values(value as Record<string, unknown>)) rememberTreeOrder(child);
}

export function copyFileOrders(source: unknown, target: unknown): void {
  if (!source || !target || typeof source !== "object" || typeof target !== "object") return;
  const order = fileOrders.get(source); if (order) fileOrders.set(target, order);
  for (const key of Object.keys(source)) copyFileOrders((source as Record<string, unknown>)[key], (target as Record<string, unknown>)[key]);
}

export function fileOrderedCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fileOrderedCopy);
  if (!value || typeof value !== "object") return value;
  const keys = [...new Set([...fileOrders.get(value) ?? [], ...Object.keys(value)])];
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, fileOrderedCopy((value as Record<string, unknown>)[key])]));
}

export function canonicalUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return Array.from(value, canonicalUnknown);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.keys(value).sort(compareCodeUnits).map(key => [key, canonicalUnknown((value as Record<string, unknown>)[key])]));
  const order = fileOrders.get(value); if (order) fileOrders.set(result, order);
  return result;
}

export function literalRecord(values: Record<string, unknown>, fields: readonly string[], serializedKeys?: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of fields) if (Object.hasOwn(values, key)) Object.defineProperty(result, key, { value: values[key], enumerable: true, configurable: true, writable: true });
  for (const key of Object.keys(values).filter(key => !fields.includes(key)).sort(compareCodeUnits)) {
    Object.defineProperty(result, key, { value: canonicalUnknown(values[key]), enumerable: true, configurable: true, writable: true });
  }
  const order = serializedKeys ?? fileOrders.get(values); if (order) fileOrders.set(result, order);
  return result;
}

export function mergeLiteralFields(target: Record<string, unknown>, source: Record<string, unknown>, fields: readonly string[]): void {
  for (const key of fields) if (Object.hasOwn(source, key)) Object.defineProperty(target, key, { value: source[key], enumerable: true, configurable: true, writable: true });
  for (const key of Object.keys(source).filter(key => !fields.includes(key)).sort(compareCodeUnits)) {
    Object.defineProperty(target, key, { value: canonicalUnknown(source[key]), enumerable: true, configurable: true, writable: true });
  }
}

export const commentOutputFields = ["id", "author", "createdAt", "updatedAt", "text", "body", "rowId", "field", "anchorId", "assignee", "resolution", "recovery", "replies"] as const;
export const replyOutputFields = ["id", "commentId", "author", "createdAt", "updatedAt", "text", "body"] as const;
