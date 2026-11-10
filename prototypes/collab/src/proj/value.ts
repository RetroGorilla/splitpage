import type * as Y from "yjs";
import { mapValue } from "../schema.ts";

export type ProjectionBag = Record<string, unknown>;

export function bag(value: unknown): ProjectionBag {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a document record");
  return value as ProjectionBag;
}

export function records(value: unknown): ProjectionBag[] {
  return Array.isArray(value) ? value.map(bag) : [];
}

export function copy<T>(value: T): T {
  return structuredClone(value);
}

export function rank(index: number): string {
  return String(index).padStart(10, "0");
}

export function ordered(values: ProjectionBag, keys: unknown): ProjectionBag {
  const result: ProjectionBag = {};
  for (const key of [...(Array.isArray(keys) ? keys as string[] : []), ...Object.keys(values)]) {
    if (Object.hasOwn(values, key)) Object.defineProperty(result, key, { value: values[key], enumerable: true, configurable: true, writable: true });
  }
  return result;
}

export function writeRecord(target: Y.Map<unknown>, source: ProjectionBag, fields: readonly string[]): void {
  target.set("keys", Object.keys(source));
  const extra: ProjectionBag = {};
  for (const [key, value] of Object.entries(source)) {
    if (fields.includes(key)) target.set(key, copy(value));
    else Object.defineProperty(extra, key, { value: copy(value), enumerable: true, configurable: true, writable: true });
  }
  target.set("extra", JSON.stringify(extra));
}

export function readRecord(source: Y.Map<unknown>, fields: readonly string[]): ProjectionBag {
  const result = JSON.parse(String(source.get("extra") ?? "{}")) as ProjectionBag;
  for (const key of fields) if (source.has(key)) result[key] = copy(source.get(key));
  return ordered(result, source.get("keys"));
}

export function ranked(source: Y.Map<unknown>): [string, Y.Map<unknown>][] {
  return [...source.entries()].map(([id, value]): [string, Y.Map<unknown>] => [id, mapValue(value)])
    .sort(([a, left], [b, right]) => String(left.get("rank")).localeCompare(String(right.get("rank"))) || a.localeCompare(b));
}
