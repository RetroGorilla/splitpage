import { identityEntries } from "../readers/identity.ts";
import * as Y from "yjs";
import { compareCodeUnits } from "../readers/order.ts";
import { readRankedRecord, readWireValue, stringKeys } from "../readers/records.ts";

export type ProjectionBag = Record<string, unknown>;

export function bag(value: unknown): ProjectionBag {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ProjectionBag : {};
}

export function records(value: unknown): ProjectionBag[] {
  return Array.isArray(value) ? value.filter((value: unknown): value is ProjectionBag => Boolean(value) && typeof value === "object" && !Array.isArray(value)) : [];
}

export function copy<T>(value: T): T {
  return structuredClone(value);
}

export function rank(index: number): string {
  return String(index).padStart(10, "0");
}

export function ordered(values: ProjectionBag, keys: unknown): ProjectionBag {
  const result: ProjectionBag = {};
  for (const key of [...stringKeys(keys), ...Object.keys(values)]) {
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

export function readRecord(source: unknown, fields: readonly string[]): ProjectionBag {
  if (!(source instanceof Y.Map)) return {};
  let result: ProjectionBag = {};
  const extra = readWireValue(source.get("extra"));
  if (typeof extra === "string") try { result = bag(JSON.parse(extra) as unknown); } catch { result = {}; }
  for (const key of fields) if (source.has(key)) Object.defineProperty(result, key, { value: readWireValue(source.get(key)), enumerable: true, configurable: true, writable: true });
  return ordered(result, source.get("keys"));
}

export function ranked(source: unknown): [string, Y.Map<unknown>][] {
  if (!(source instanceof Y.Map)) return [];
  return identityEntries(source).flatMap(([id, raw]) => { const value = readRankedRecord(raw); return value ? [{ id, ...value }] : []; })
    .sort((a, b) => compareCodeUnits(a.rank, b.rank) || compareCodeUnits(a.id, b.id)).map(value => [value.id, value.source]);
}
