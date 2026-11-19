import * as Y from "yjs";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import type { NativeDeltaItem } from "../../src/native/variant.ts";
import type { Marker, StoredReading } from "../native-delete/model.ts";

export const MODES = ["forward", "reverse", "twice", "shuffled", "state"] as const;
export type Mode = typeof MODES[number];

const methods = [
  [Y.Text.prototype, "insert"], [Y.Text.prototype, "insertEmbed"], [Y.Text.prototype, "delete"], [Y.Text.prototype, "format"],
  [Y.Map.prototype, "set"], [Y.Map.prototype, "delete"], [Y.Array.prototype, "insert"], [Y.Array.prototype, "delete"],
  [Y.UndoManager.prototype, "undo"], [Y.UndoManager.prototype, "redo"]
] as const;

// why: a silent-write control: every library write call is listed, and the one numbered `omit` does nothing
export function watch(replica: ChosenReplica, run: () => void, omit = -1): string[] {
  const calls: string[] = [];
  const roots = new Map<unknown, string>([[replica.beats, "beats"], [replica.visuals, "visuals"], [replica.segments, "segments"], [replica.headings, "headings"]]);
  const restore = methods.map(([parent, key]) => {
    const descriptor = Object.getOwnPropertyDescriptor(parent, key);
    if (!descriptor) throw new Error(`No ${key}`);
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(parent, key, { ...descriptor, value(this: unknown, ...args: unknown[]): unknown {
      const index = calls.length;
      const where = parent === Y.Map.prototype ? `:${roots.get(this) ?? String(args[0]).replace(/^~stray:.*$/, "~stray claim")}` : "";
      calls.push(`${parent.constructor.name}.${key}${where}`);
      if (index !== omit) return original.apply(this, args);
      return parent === Y.UndoManager.prototype ? null : undefined;
    } });
    return () => { Object.defineProperty(parent, key, descriptor); };
  });
  try { if (omit !== -2) run(); } finally { for (const reset of restore) reset(); }
  return calls;
}

export function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

export function deliver(replica: ChosenReplica, packets: readonly Uint8Array[], mode: Mode, seed: number): void {
  const queue = mode === "reverse" ? packets.toReversed() : mode === "twice" ? [...packets, ...packets]
    : mode === "shuffled" ? shuffled(packets, seed) : packets;
  for (const packet of queue) Y.applyUpdate(replica.doc, packet, "remote");
}

const RANK = "e10Rank";
const marker = (value: unknown): Marker => {
  if (value && typeof value === "object" && "b" in value && typeof value.b === "string") return { kind: "b", id: value.b };
  if (value && typeof value === "object" && "h" in value && typeof value.h === "string") return { kind: "h", id: value.h };
  throw new Error("Unexpected stored marker");
};
const withoutRank = (record: Y.Map<unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record.toJSON() as Record<string, unknown>).filter(([key]) => key !== RANK));

export function readStored(replica: ChosenReplica): StoredReading {
  return {
    order: replica.order.toArray(),
    segments: Object.fromEntries([...replica.segments].map(([id, record]) => {
      const head = record.get("head"), text = record.get("text") as Y.Text | undefined;
      const units = ((text?.toDelta() ?? []) as NativeDeltaItem[]).flatMap<string | Marker>(item => typeof item.insert === "string" ? [...item.insert] : [marker(item.insert)]);
      return [id, { head: head === undefined ? null : marker(head), units }];
    })),
    beats: Object.fromEntries([...replica.beats].map(([id, record]) => [id, withoutRank(record)])),
    visuals: Object.fromEntries([...replica.visuals].map(([id, text]) => [id, text.toString()])),
    headings: Object.fromEntries([...replica.headings].map(([id, record]) => [id, withoutRank(record)]))
  };
}

export function readStyles(replica: ChosenReplica): unknown {
  return {
    segments: Object.fromEntries([...replica.segments].map(([id, record]) => [id, (record.get("text") as Y.Text).toDelta()])),
    heads: Object.fromEntries([...replica.segments].map(([id, record]) => [id, record.get("head") ?? null])),
    visuals: Object.fromEntries([...replica.visuals].map(([id, cell]) => [id, cell.toDelta()])),
    beats: replica.beats.toJSON(), headings: replica.headings.toJSON(), order: replica.order.toArray()
  };
}
