import * as Y from "yjs";
import { NativeReplica, nativeMarkName } from "../native/variant.ts";
import type { NativeDeltaItem, NativeField, NativeScheme } from "../native/variant.ts";

export type KeyScheme = NativeScheme | "act+norm";

const SUFFIX = "\u001f";

interface Extent { first: number; last: number }

function extents(delta: readonly NativeDeltaItem[]): Map<string, Extent> {
  const result = new Map<string, Extent>();
  let index = 0;
  for (const item of delta) {
    const length = typeof item.insert === "string" ? item.insert.length : 1;
    for (const [key, value] of Object.entries(item.attributes ?? {})) {
      if (value !== true) continue;
      const extent = result.get(key);
      if (extent) extent.last = index + length; else result.set(key, { first: index, last: index + length });
    }
    index += length;
  }
  return result;
}

function freshKey(doc: Y.Doc, name: string): string {
  const clock = Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) ?? 0;
  return `${name}${SUFFIX}${doc.clientID.toString(36)}.${clock.toString(36)}`;
}

// why: the rule of the design note, section 1: a format command turns off, in its own transaction, every key of the
// same kind it had seen whose whole run lies inside its range, since the new key shows wherever the old one did
export class NormalisingReplica extends NativeReplica {
  turnedOff = 0;

  constructor(client: number, captureTimeout = 0) { super(client, captureTimeout, "act"); }

  override format(beat: string, field: NativeField, from: number, to: number, marks: Record<string, true | null>): void {
    const cell = this.cell(beat, field), seen = new Set(extents(cell.text.toDelta() as NativeDeltaItem[]).keys());
    this.transact(() => {
      super.format(beat, field, from, to, marks);
      const start = cell.start + from, end = cell.start + to;
      for (const [name, value] of Object.entries(marks)) {
        if (!value) continue;
        for (const [key, extent] of extents(cell.text.toDelta() as NativeDeltaItem[])) {
          if (!seen.has(key) || nativeMarkName(key) !== name || extent.first < start || extent.last > end) continue;
          cell.text.format(extent.first, extent.last - extent.first, { [key]: null });
          this.turnedOff++;
        }
      }
    });
  }
}

export function makeReplica(scheme: KeyScheme, client: number): NativeReplica {
  return scheme === "act+norm" ? new NormalisingReplica(client) : new NativeReplica(client, 0, scheme);
}

export function baseScheme(scheme: KeyScheme): NativeScheme { return scheme === "name" ? "name" : "act"; }

// why: the design's past-limit step: every key of one kind in a text becomes one fresh key over the characters that
// showed the kind, in one transaction of the acting copy
export function collapse(replica: NativeReplica, text: Y.Text, name: string): number {
  const delta = text.toDelta() as NativeDeltaItem[], runs: Extent[] = [];
  const keys = [...extents(delta)].filter(([key]) => key !== name && nativeMarkName(key) === name);
  let index = 0;
  for (const item of delta) {
    const length = typeof item.insert === "string" ? item.insert.length : 1;
    if (Object.entries(item.attributes ?? {}).some(([key, value]) => value === true && nativeMarkName(key) === name)) {
      const last = runs.at(-1);
      if (last && last.last === index) last.last = index + length; else runs.push({ first: index, last: index + length });
    }
    index += length;
  }
  if (!keys.length) return 0;
  replica.transact(() => {
    const key = freshKey(replica.doc, name);
    for (const [old, extent] of keys) text.format(extent.first, extent.last - extent.first, { [old]: null });
    for (const run of runs) text.format(run.first, run.last - run.first, { [key]: true });
  });
  return keys.length;
}

// why: a rebuilt document holds what shows and nothing of its history: one key per kind per run of characters
export function rebuiltDelta(delta: readonly NativeDeltaItem[], client: number, serial: { next: number }): NativeDeltaItem[] {
  const open = new Map<string, string>(), result: NativeDeltaItem[] = [];
  for (const item of delta) {
    const names = new Set(Object.entries(item.attributes ?? {}).filter(([, value]) => value === true).map(([key]) => nativeMarkName(key)));
    for (const name of [...open.keys()]) if (!names.has(name)) open.delete(name);
    for (const name of names) if (!open.has(name)) open.set(name, `${name}${SUFFIX}${client.toString(36)}.${(serial.next++).toString(36)}`);
    const attributes = Object.fromEntries([...names].map(name => [open.get(name) as string, true]));
    result.push(names.size ? { insert: item.insert, attributes } : { insert: item.insert });
  }
  return result;
}

export interface KeyCount { perCharacter: number[]; mostOfOneKind: number; total: number }

export function countKeys(delta: readonly NativeDeltaItem[]): KeyCount {
  const perCharacter: number[] = [];
  let mostOfOneKind = 0, total = 0;
  for (const item of delta) {
    const keys = Object.entries(item.attributes ?? {}).filter(([, value]) => value === true).map(([key]) => key), kinds = new Map<string, number>();
    for (const key of keys) kinds.set(nativeMarkName(key), (kinds.get(nativeMarkName(key)) ?? 0) + 1);
    const length = typeof item.insert === "string" ? item.insert.length : 1;
    for (let index = 0; index < length; index++) perCharacter.push(keys.length);
    total += keys.length * length;
    mostOfOneKind = Math.max(mostOfOneKind, ...kinds.values(), 0);
  }
  return { perCharacter, mostOfOneKind, total };
}

export function quantile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] as number;
}
