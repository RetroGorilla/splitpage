import type { DeliveryOrder, ReplicaName } from "./delivery.ts";

export interface ReplicaReading<Output> {
  order: DeliveryOrder;
  replica: ReplicaName;
  output: Output;
}

function entriesOf(value: object): readonly (readonly [unknown, unknown])[] | null {
  if (value instanceof Map) return [...value.entries()];
  if (value instanceof Set) return [...value.values()].map((item, index) => [index, item] as const);
  return null;
}

function difference(expected: unknown, actual: unknown, path: string): string | null {
  if (Object.is(expected, actual)) return null;
  if (expected === null || actual === null || typeof expected !== "object" || typeof actual !== "object") {
    return `${path}: ${JSON.stringify(expected) ?? String(expected)} against ${JSON.stringify(actual) ?? String(actual)}`;
  }
  if (Object.getPrototypeOf(expected) !== Object.getPrototypeOf(actual)) return `${path}: different kinds of value`;
  const wantedEntries = entriesOf(expected);
  const gotEntries = entriesOf(actual);
  if (wantedEntries && gotEntries) {
    if (wantedEntries.length !== gotEntries.length) return `${path}: ${wantedEntries.length} entries against ${gotEntries.length}`;
    for (const [index, [key, value]] of wantedEntries.entries()) {
      const other = gotEntries[index];
      if (!other) return `${path}[${index}]: missing`;
      const keyDifference = difference(key, other[0], `${path}<key ${index}>`);
      if (keyDifference) return keyDifference;
      const valueDifference = difference(value, other[1], `${path}<${String(key)}>`);
      if (valueDifference) return valueDifference;
    }
    return null;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return `${path}: length ${expected.length} against ${actual.length}`;
    for (let index = 0; index < expected.length; index++) {
      const found = difference(expected[index], actual[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  const wantedKeys = Object.keys(expected);
  const gotKeys = Object.keys(actual);
  if (wantedKeys.join("\0") !== gotKeys.join("\0")) return `${path}: keys ${JSON.stringify(wantedKeys)} against ${JSON.stringify(gotKeys)}`;
  for (const key of wantedKeys) {
    const found = difference((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

export function assertReplicasAgree<Output>(reader: string, readings: readonly ReplicaReading<Output>[]): void {
  const [first, ...rest] = readings;
  if (!first) throw new Error(`${reader}: no readings`);
  if (new Set(readings.map(reading => reading.order)).size < 2) throw new Error(`${reader}: readings cover one delivery order only`);
  if (!readings.some(reading => reading.order === "late-C" && reading.replica === "C")) throw new Error(`${reader}: no late joiner C reading`);
  for (const reading of rest) {
    const found = difference(first.output, reading.output, reader);
    if (found) {
      throw new Error(`${reader}: replica ${reading.replica} after ${reading.order} differs from replica ${first.replica} after ${first.order} at ${found}`);
    }
  }
}
