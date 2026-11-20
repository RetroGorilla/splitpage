import * as Y from "yjs";
import { isValidNativeRank, nativeRankBetween } from "./rank.ts";
import type { NativeRankedBlock } from "./reader.ts";
import type { NativeScript } from "./script.ts";
import { nativeAvailability } from "./text-commands.ts";
import { nativeWellFormed } from "./values.ts";

export interface NativeMoveBlock {
  readonly kind: "beat" | "heading";
  readonly id: string;
}

export type NativeMoveRefusal = "missing" | "drop" | "list" | "stored" | "busy" | "closed";

export type NativeMoveOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: NativeMoveRefusal };

interface PlannedWrite {
  readonly record: Y.Map<unknown>;
  readonly rank: string;
}

const WRITTEN: NativeMoveOutcome = Object.freeze({ kind: "written" });
const UNCHANGED: NativeMoveOutcome = Object.freeze({ kind: "unchanged" });

function refused(reason: NativeMoveRefusal): NativeMoveOutcome {
  return Object.freeze({ kind: "refused", reason });
}

function blockKey(block: NativeMoveBlock): string {
  return block.kind + ":" + block.id;
}

function copyBlock(value: unknown): NativeMoveBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Readonly<Record<string, unknown>>, kind: unknown = raw.kind, id: unknown = raw.id;
  if ((kind !== "beat" && kind !== "heading") || !nativeWellFormed(id) || !id) return null;
  return Object.freeze({ kind, id });
}

// why: caller inputs are copied by index from one length read so no iterator or getter runs during the transaction
function copyBlocks(blocks: readonly NativeMoveBlock[]): readonly NativeMoveBlock[] | null {
  try {
    if (!Array.isArray(blocks)) return null;
    const list: readonly unknown[] = blocks, length = list.length;
    if (!Number.isSafeInteger(length) || length < 0) return null;
    const copied: NativeMoveBlock[] = [], seen = new Set<string>();
    for (let index = 0; index < length; index++) {
      if (!Object.hasOwn(list, index)) return null;
      const block = copyBlock(list[index]);
      if (!block) return null;
      const key = blockKey(block);
      if (seen.has(key)) return null;
      seen.add(key);
      copied.push(block);
    }
    return copied;
  } catch { return null; }
}

function copyDrop(drop: NativeMoveBlock | null): { readonly target: NativeMoveBlock | null } | null {
  try {
    if (drop === null) return { target: null };
    const target = copyBlock(drop);
    return target ? { target } : null;
  } catch { return null; }
}

function liveRecord(script: NativeScript, block: NativeRankedBlock): Y.Map<unknown> | null {
  const { roots, reader } = script;
  if (block.kind === "beat") {
    const record = roots.beats.get(block.id);
    return record instanceof Y.Map && roots.visuals.get(block.id) instanceof Y.Text && reader.beatBoundary(block.id) !== null ? record : null;
  }
  const record = roots.headings.get(block.id);
  return record instanceof Y.Map && roots.names.get(block.id) instanceof Y.Text && record.get("removed") !== true && reader.headingBoundary(block.id, false) !== null ? record : null;
}

function storedRankValid(record: Y.Map<unknown>): boolean {
  return !record.has("rank") || isValidNativeRank(record.get("rank"));
}

function checkedNeighbour(script: NativeScript, block: NativeRankedBlock): Y.Map<unknown> | "missing" | "stored" {
  const record = liveRecord(script, block);
  if (!record) return "missing";
  if (!storedRankValid(record)) return "stored";
  if (block.bound !== null && !isValidNativeRank(block.bound)) return "stored";
  return record;
}

function sameSequence(order: readonly NativeRankedBlock[], remaining: readonly NativeRankedBlock[], moving: readonly NativeRankedBlock[], insertAt: number): boolean {
  let cursor = 0;
  for (let index = 0; index < insertAt; index++) if (order[cursor++] !== remaining[index]) return false;
  for (const block of moving) if (order[cursor++] !== block) return false;
  for (let index = insertAt; index < remaining.length; index++) if (order[cursor++] !== remaining[index]) return false;
  return cursor === order.length;
}

// why: design section 2 and decision 9: a move writes ranks only, carrying a joined row's members together without
// changing `joined`, pinning any rankless drop neighbour to its shown rank (rule (e)) and re-ranking right-side ties
export function moveNativeBlocks(script: NativeScript, blocks: readonly NativeMoveBlock[], drop: NativeMoveBlock | null): NativeMoveOutcome {
  const copiedBlocks = copyBlocks(blocks), copiedDrop = copyDrop(drop), unavailable = nativeAvailability(script);
  if (unavailable === "closed" || unavailable === "busy") return refused(unavailable);
  if (!copiedBlocks) return refused("list");
  if (!copiedDrop) return refused("drop");
  let outcome: NativeMoveOutcome = refused("missing");
  script.doc.transact(() => {
    const order = script.reader.rankedOrder(), byKey = new Map<string, NativeRankedBlock>(), membersByHead = new Map<string, NativeRankedBlock[]>();
    for (const entry of order) {
      byKey.set(blockKey(entry), entry);
      if (entry.kind === "beat" && entry.head !== null) {
        const group = membersByHead.get(entry.head) ?? [];
        group.push(entry);
        membersByHead.set(entry.head, group);
      }
    }
    const target = copiedDrop.target ? byKey.get(blockKey(copiedDrop.target)) ?? null : null;
    if (copiedDrop.target && (!target || (target.kind === "beat" && target.head !== target.id) || !liveRecord(script, target))) return;
    if (!copiedBlocks.length) { outcome = UNCHANGED; return; }
    const moving: NativeRankedBlock[] = [], movingRecords: Y.Map<unknown>[] = [], movingKeys = new Set<string>();
    for (const ref of copiedBlocks) {
      const entry = byKey.get(blockKey(ref));
      if (!entry || (entry.kind === "beat" && entry.head !== entry.id)) return;
      const expanded = entry.kind === "beat" ? membersByHead.get(entry.id) ?? [] : [entry];
      if (!expanded.length) return;
      for (const item of expanded) {
        const record = liveRecord(script, item);
        if (!record) return;
        if (!storedRankValid(record)) { outcome = refused("stored"); return; }
        moving.push(item);
        movingRecords.push(record);
        movingKeys.add(blockKey(item));
      }
    }
    if (target && movingKeys.has(blockKey(target))) { outcome = refused("drop"); return; }
    const remaining = order.filter(entry => !movingKeys.has(blockKey(entry)));
    const insertAt = target ? remaining.indexOf(target) : remaining.length;
    if (insertAt < 0) return;
    if (sameSequence(order, remaining, moving, insertAt)) { outcome = UNCHANGED; return; }
    const writes: PlannedWrite[] = [], toAllocate: Y.Map<unknown>[] = [];
    const left = insertAt > 0 ? remaining[insertAt - 1] ?? null : null;
    let leftBound: string | null = null;
    if (left) {
      const record = checkedNeighbour(script, left);
      if (typeof record === "string") { outcome = refused(record); return; }
      if (left.bound !== null) {
        leftBound = left.bound;
        if (!record.has("rank")) writes.push({ record, rank: leftBound });
      } else toAllocate.push(record);
    }
    toAllocate.push(...movingRecords);
    let upper: NativeRankedBlock | null = null, upperRecord: Y.Map<unknown> | null = null;
    for (let stop = insertAt; stop < remaining.length; stop++) {
      const entry = remaining[stop];
      if (!entry) break;
      const record = checkedNeighbour(script, entry);
      if (typeof record === "string") { outcome = refused(record); return; }
      if (entry.bound !== null && (leftBound === null || entry.bound > leftBound)) {
        upper = entry;
        upperRecord = record;
        break;
      }
      toAllocate.push(record);
    }
    const rightBound = upper ? upper.bound : null;
    if (upper && upperRecord && rightBound !== null && !upperRecord.has("rank")) {
      writes.push({ record: upperRecord, rank: rightBound });
    }
    let cursor = leftBound;
    for (const record of toAllocate) {
      try { cursor = nativeRankBetween(cursor, rightBound); }
      catch (error) { if (error instanceof RangeError) { outcome = refused("stored"); return; } throw error; }
      writes.push({ record, rank: cursor });
    }
    for (const { record, rank } of writes) {
      if (!record.has("rank") || record.get("rank") !== rank) record.set("rank", rank);
    }
    outcome = WRITTEN;
  }, script.origin);
  return outcome;
}
