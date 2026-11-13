import assert from "node:assert/strict";
import type { DeliveryOrder, ReplicaName } from "./delivery.ts";

export interface ReplicaReading<Output> {
  order: DeliveryOrder;
  replica: ReplicaName;
  output: Output;
}

type Kind = "primitive" | "object" | "null-prototype object" | "array" | "map" | "set";

function show(value: unknown): string {
  return typeof value === "bigint" ? `${value}n` : JSON.stringify(value) ?? String(value);
}

function unsupported(path: string, what: string): Error {
  return new Error(`${path}: unsupported output kind ${what}`);
}

function kindOf(value: unknown, path: string): Kind {
  if (typeof value === "function") throw unsupported(path, "function");
  if (value === null || typeof value !== "object") return "primitive";
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === Object.prototype) return "object";
  if (prototype === null) return "null-prototype object";
  if (prototype === Array.prototype) return "array";
  if (prototype === Map.prototype) return "map";
  if (prototype === Set.prototype) return "set";
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  throw unsupported(path, typeof name === "string" && name ? name : "object with an unknown prototype");
}

function ownProperties(value: object, path: string, skip: (key: string) => boolean): string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw unsupported(path, `symbol key ${String(key)}`);
    if (skip(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw unsupported(`${path}[${JSON.stringify(key)}]`, "accessor property");
    keys.push(key);
  }
  return keys;
}

function compareKeys(expected: readonly string[], actual: readonly string[], path: string): string | null {
  if (expected.length !== actual.length) return `${path}: keys ${JSON.stringify(expected)} against ${JSON.stringify(actual)}`;
  for (let index = 0; index < expected.length; index++) {
    if (expected[index] !== actual[index]) return `${path}: keys ${JSON.stringify(expected)} against ${JSON.stringify(actual)}`;
  }
  return null;
}

function compareProperties(expected: object, actual: object, path: string, skip: (key: string) => boolean): string | null {
  const wanted = ownProperties(expected, path, skip);
  const got = ownProperties(actual, path, skip);
  const keyDifference = compareKeys(wanted, got, path);
  if (keyDifference) return keyDifference;
  for (const key of wanted) {
    const found = difference((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], `${path}[${JSON.stringify(key)}]`);
    if (found) return found;
  }
  return null;
}

function compareEntries(expected: readonly (readonly [unknown, unknown])[], actual: readonly (readonly [unknown, unknown])[], path: string): string | null {
  if (expected.length !== actual.length) return `${path}: ${expected.length} entries against ${actual.length}`;
  for (const [index, [key, value]] of expected.entries()) {
    const other = actual[index];
    if (!other) return `${path}<${index}>: missing`;
    const keyDifference = difference(key, other[0], `${path}<key ${index}>`);
    if (keyDifference) return keyDifference;
    const valueDifference = difference(value, other[1], `${path}<${index}>`);
    if (valueDifference) return valueDifference;
  }
  return null;
}

const arrayIndex = /^(?:0|[1-9]\d*)$/;

function difference(expected: unknown, actual: unknown, path: string): string | null {
  const wantedKind = kindOf(expected, path);
  const gotKind = kindOf(actual, path);
  if (wantedKind !== gotKind) return `${path}: ${wantedKind} against ${gotKind}`;
  if (wantedKind === "primitive") {
    if (typeof expected === "symbol" || typeof actual === "symbol") throw unsupported(path, "symbol");
    return Object.is(expected, actual) ? null : `${path}: ${show(expected)} against ${show(actual)}`;
  }
  const wanted = expected as object;
  const got = actual as object;
  if (wantedKind === "map" || wantedKind === "set") {
    const extra = compareProperties(wanted, got, path, () => false);
    if (extra) return extra;
    if (wantedKind === "map") return compareEntries([...(wanted as Map<unknown, unknown>)], [...(got as Map<unknown, unknown>)], path);
    return compareEntries([...(wanted as Set<unknown>)].map((item, index) => [index, item] as const), [...(got as Set<unknown>)].map((item, index) => [index, item] as const), path);
  }
  if (wantedKind === "array") {
    ownProperties(wanted, path, () => false);
    ownProperties(got, path, () => false);
    const wantedItems = wanted as unknown[];
    const gotItems = got as unknown[];
    if (wantedItems.length !== gotItems.length) return `${path}: length ${wantedItems.length} against ${gotItems.length}`;
    for (let index = 0; index < wantedItems.length; index++) {
      const wantedHole = !Object.hasOwn(wantedItems, index);
      const gotHole = !Object.hasOwn(gotItems, index);
      if (wantedHole !== gotHole) return `${path}[${index}]: ${wantedHole ? "hole" : "value"} against ${gotHole ? "hole" : "value"}`;
      if (wantedHole) continue;
      const found = difference(wantedItems[index], gotItems[index], `${path}[${index}]`);
      if (found) return found;
    }
    return compareProperties(wanted, got, path, key => key === "length" || arrayIndex.test(key) && Number(key) < wantedItems.length);
  }
  return compareProperties(wanted, got, path, () => false);
}

export function assertReplicasAgree<Output>(reader: string, readings: readonly ReplicaReading<Output>[]): void {
  const [first, ...rest] = readings;
  if (!first) throw new Error(`${reader}: no readings`);
  if (new Set(readings.map(reading => reading.order)).size < 2) throw new Error(`${reader}: readings cover one delivery order only`);
  if (!readings.some(reading => reading.order === "late-C" && reading.replica === "C")) throw new Error(`${reader}: no late joiner C reading`);
  for (const reading of rest) {
    const found = difference(first.output, reading.output, reader);
    if (found) {
      assert.fail(`${reader}: replica ${reading.replica} after ${reading.order} differs from replica ${first.replica} after ${first.order} at ${found}`);
    }
  }
}
