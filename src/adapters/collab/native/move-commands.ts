import * as Y from "yjs";
import { nativeRankBetween, nativeValidRank } from "./rank.ts";
import type { NativeScript } from "./script.ts";
import { nativeAvailability } from "./text-commands.ts";
import type { NativeRefusal } from "./text-commands.ts";
import { nativeWellFormed } from "./values.ts";

type MoveRefusal = NativeRefusal | "stored";

export type NativeMoveOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: MoveRefusal };

type Block = ReturnType<NativeScript["reader"]["blocksForMove"]>[number];
type RankWrite = readonly [Y.Map<unknown>, string];

const WRITTEN: NativeMoveOutcome = Object.freeze({ kind: "written" });
const UNCHANGED: NativeMoveOutcome = Object.freeze({ kind: "unchanged" });

function refused(reason: MoveRefusal): NativeMoveOutcome {
  return Object.freeze({ kind: "refused", reason });
}

function idsOf(blocks: readonly string[]): string[] | null {
  try {
    if (!Array.isArray(blocks)) return null;
    const list: readonly unknown[] = blocks, length = list.length, copied: unknown[] = [];
    if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) return null;
    for (let index = 0; index < length; index++) copied.push(list[index]);
    const ids = new Set<string>();
    for (const value of copied) {
      if (!nativeWellFormed(value) || !value || ids.has(value)) return null;
      ids.add(value);
    }
    return [...ids];
  } catch { return null; }
}

function recordOf(script: NativeScript, block: Block): Y.Map<unknown> | "missing" | "stored" {
  const { roots } = script, beat = block.kind === "b";
  const record = (beat ? roots.beats : roots.headings).get(block.id);
  const cell = (beat ? roots.visuals : roots.names).get(block.id);
  if (!(record instanceof Y.Map) || !(cell instanceof Y.Text)) return "missing";
  if (record.has("rank") && !nativeValidRank(record.get("rank"))) return "stored";
  return record;
}

function planMove(script: NativeScript, ids: readonly string[], drop: string | null): RankWrite[] | "missing" | "stored" {
  const order = script.reader.blocksForMove(), indices = new Map<string, number>();
  order.forEach((block, index) => indices.set(block.id, indices.has(block.id) ? -1 : index));
  const selected = new Set(ids), moving: Y.Map<unknown>[] = [];
  let previous = -1;
  for (const id of ids) {
    const index = indices.get(id) ?? -1, block = order[index];
    if (!block || index <= previous) return "missing";
    const record = recordOf(script, block);
    if (typeof record === "string") return record;
    moving.push(record);
    previous = index;
  }
  if (drop !== null && (selected.has(drop) || (indices.get(drop) ?? -1) < 0)) return "missing";
  const rest = order.filter(block => !selected.has(block.id)), at = drop === null ? rest.length : rest.findIndex(block => block.id === drop);
  const left = rest[at - 1], right = rest[at], writes: RankWrite[] = [];
  const checkedBounds = new Map<Block, Y.Map<unknown>>();
  const checkBound = (block: Block): "missing" | "stored" | null => {
    const record = recordOf(script, block);
    if (typeof record === "string") return record;
    if (block.bound !== null && !nativeValidRank(block.bound)) return "stored";
    checkedBounds.set(block, record);
    return null;
  };
  for (const block of [left, right]) {
    if (!block) continue;
    const invalid = checkBound(block);
    if (invalid) return invalid;
  }
  if (!moving.length || ids.every((id, index) => order[at + index]?.id === id)) return writes;

  const tied = right !== undefined && (left?.rank === right.rank || right.rank === "");
  let end = at;
  if (tied) {
    while (rest[end]?.rank === right.rank) end++;
    for (const block of rest.slice(at + 1, end + 1)) {
      const invalid = checkBound(block);
      if (invalid) return invalid;
    }
  }
  let before = left?.bound ?? null;
  const after = rest[end]?.bound ?? null;
  // why: independent writers opening the same gap need distinct keys, even when the reader's stored order is the inverse
  const client = script.doc.clientID, clock = Y.decodeStateVector(Y.encodeStateVector(script.doc)).get(client) ?? 0;
  const suffix = client.toString(36).padStart(7, "0") + clock.toString(36) + "V";
  const nextRank = (): string => { before = nativeRankBetween(before, after) + suffix; return before; };
  if (left) {
    const record = checkedBounds.get(left);
    if (record && !record.has("rank")) writes.push([record, before ?? nextRank()]);
  }
  for (const record of moving) writes.push([record, nextRank()]);
  for (const block of rest.slice(at, tied ? end : at + 1)) {
    const record = checkedBounds.get(block);
    if (record && (tied || !record.has("rank"))) writes.push([record, tied ? nextRank() : block.rank]);
  }
  return writes;
}

export function moveNativeBlocks(script: NativeScript, blocks: readonly string[], drop: string | null): NativeMoveOutcome {
  const ids = idsOf(blocks), unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  if (!ids || (drop !== null && (!nativeWellFormed(drop) || !drop))) return refused("missing");
  return script.doc.transact(() => {
    const writes = planMove(script, ids, drop);
    if (typeof writes === "string") return refused(writes);
    if (!writes.length) return UNCHANGED;
    for (const [record, rank] of writes) record.set("rank", rank);
    return WRITTEN;
  }, script.origin);
}
