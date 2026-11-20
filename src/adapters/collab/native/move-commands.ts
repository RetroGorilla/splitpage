import * as Y from "yjs";
import { NativeRankError, isValidNativeRank, nativeRankBetween } from "./rank.ts";
import type { NativeRankedBlock } from "./reader.ts";
import { transactNativeCommand } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { nativeAvailability } from "./text-commands.ts";
import { nativeWellFormed } from "./values.ts";

export interface NativeMoveBlock {
  readonly kind: "beat" | "heading";
  readonly id: string;
}

export type NativeMoveRefusal = "missing" | "drop" | "list" | "stored" | "range" | "busy" | "closed";

export type NativeMoveOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: NativeMoveRefusal };

interface BlockSlot {
  readonly block: NativeRankedBlock;
  readonly record: Y.Map<unknown>;
}

interface PlannedWrite extends BlockSlot {
  readonly rank: string;
}

interface RawBlock {
  readonly ok: boolean;
  readonly kind?: unknown;
  readonly id?: unknown;
}

const WRITTEN: NativeMoveOutcome = Object.freeze({ kind: "written" });
const UNCHANGED: NativeMoveOutcome = Object.freeze({ kind: "unchanged" });

function refused(reason: NativeMoveRefusal): NativeMoveOutcome {
  return Object.freeze({ kind: "refused", reason });
}

function blockKey(block: { readonly kind: "beat" | "heading"; readonly id: string }): string {
  return block.kind + ":" + block.id;
}

function storedKey(block: { readonly kind: "beat" | "heading"; readonly id: string }): string {
  return (block.kind === "heading" ? "h:" : "b:") + block.id;
}

function readRawBlock(value: unknown): RawBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const raw = value as Readonly<Record<string, unknown>>;
  return { ok: true, kind: raw.kind, id: raw.id };
}

function validateRawBlock(raw: RawBlock | null): NativeMoveBlock | null {
  if (!raw || !raw.ok) return null;
  if ((raw.kind !== "beat" && raw.kind !== "heading") || !nativeWellFormed(raw.id) || !raw.id) return null;
  return Object.freeze({ kind: raw.kind, id: raw.id });
}

// why: copy every caller index and field of blocks and drop before validating any so no iterator runs and side-effect
// getters run before availability checks; indexed reads match readIds on prototype-supplied holes
function readRawBlocks(blocks: readonly NativeMoveBlock[]): readonly RawBlock[] | null {
  try {
    if (!Array.isArray(blocks)) return null;
    const list: readonly unknown[] = blocks, length = list.length;
    if (!Number.isSafeInteger(length) || length < 0) return null;
    const rawEntries: RawBlock[] = [];
    for (let index = 0; index < length; index++) rawEntries.push(readRawBlock(list[index]));
    return rawEntries;
  } catch { return null; }
}

function readRawDrop(drop: NativeMoveBlock | null): { readonly raw: RawBlock | null } | null {
  try {
    if (drop === null) return { raw: null };
    return { raw: readRawBlock(drop) };
  } catch { return null; }
}

function validateBlocks(rawEntries: readonly RawBlock[] | null): readonly NativeMoveBlock[] | null {
  if (!rawEntries) return null;
  const copied: NativeMoveBlock[] = [], seen = new Set<string>();
  for (const raw of rawEntries) {
    const block = validateRawBlock(raw);
    if (!block) return null;
    const key = blockKey(block);
    if (seen.has(key)) return null;
    seen.add(key);
    copied.push(block);
  }
  return copied;
}

function validateDrop(copied: { readonly raw: RawBlock | null } | null): { readonly target: NativeMoveBlock | null } | null {
  if (!copied) return null;
  if (copied.raw === null) return { target: null };
  const target = validateRawBlock(copied.raw);
  return target ? { target } : null;
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

function matchesExpected(
  preview: readonly { readonly kind: "beat" | "heading"; readonly id: string }[],
  remaining: readonly NativeRankedBlock[],
  moving: readonly NativeRankedBlock[],
  insertAt: number
): boolean {
  if (preview.length !== remaining.length + moving.length) return false;
  let cursor = 0;
  const same = (expected: NativeRankedBlock | undefined): boolean => {
    const actual = preview[cursor++];
    return !!actual && !!expected && actual.kind === expected.kind && actual.id === expected.id;
  };
  for (let index = 0; index < insertAt; index++) if (!same(remaining[index])) return false;
  for (const block of moving) if (!same(block)) return false;
  for (let index = insertAt; index < remaining.length; index++) if (!same(remaining[index])) return false;
  return true;
}

// why: design section 2 and decision 9: a move writes ranks only, carrying a joined row's members together without
// changing `joined`, pinning rankless drop neighbours and followers (rule (e)), and previewing via the reader's ranking
export function moveNativeBlocks(script: NativeScript, blocks: readonly NativeMoveBlock[], drop: NativeMoveBlock | null): NativeMoveOutcome {
  const rawBlocks = readRawBlocks(blocks), rawDrop = readRawDrop(drop), unavailable = nativeAvailability(script);
  if (unavailable === "closed" || unavailable === "busy") return refused(unavailable);
  const copiedBlocks = validateBlocks(rawBlocks);
  if (!copiedBlocks) return refused("list");
  const copiedDrop = validateDrop(rawDrop);
  if (!copiedDrop) return refused("drop");
  let outcome: NativeMoveOutcome = refused("missing");
  transactNativeCommand(script, () => {
    if (script.closed() || script.reader.isClosed()) { outcome = refused("closed"); return; }
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

    const writes: PlannedWrite[] = [], toAllocate: BlockSlot[] = [], handledKeys = new Set<string>(movingKeys);
    const left = insertAt > 0 ? remaining[insertAt - 1] ?? null : null;
    let leftBound: string | null = null;
    if (left) {
      const record = checkedNeighbour(script, left);
      if (typeof record === "string") { outcome = refused(record); return; }
      if (left.bound !== null) {
        leftBound = left.bound;
        if (!record.has("rank")) { writes.push({ block: left, record, rank: leftBound }); handledKeys.add(blockKey(left)); }
      } else { toAllocate.push({ block: left, record }); handledKeys.add(blockKey(left)); }
    }
    for (let index = 0; index < moving.length; index++) {
      const block = moving[index], record = movingRecords[index];
      if (block && record) toAllocate.push({ block, record });
    }
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
      toAllocate.push({ block: entry, record });
      handledKeys.add(blockKey(entry));
    }
    const rightBound = upper ? upper.bound : null;
    if (upper && upperRecord && rightBound !== null && !upperRecord.has("rank")) {
      writes.push({ block: upper, record: upperRecord, rank: rightBound });
      handledKeys.add(blockKey(upper));
    }

    // why: a rankless block directly after a moved block inherits that moved block's new rank under rule (e) unless pinned
    const leadingFollowers: { readonly slot: BlockSlot; readonly remainingAt: number }[] = [];
    for (let index = 1; index < order.length; index++) {
      const prev = order[index - 1], current = order[index];
      if (!prev || !current || !movingKeys.has(blockKey(prev))) continue;
      const key = blockKey(current);
      if (handledKeys.has(key)) continue;
      const record = checkedNeighbour(script, current);
      if (typeof record === "string") { outcome = refused(record); return; }
      if (record.has("rank")) continue;
      if (current.bound !== null) {
        writes.push({ block: current, record, rank: current.bound });
        handledKeys.add(key);
      } else {
        leadingFollowers.push({ slot: { block: current, record }, remainingAt: remaining.indexOf(current) });
        handledKeys.add(key);
      }
    }

    if (sameSequence(order, remaining, moving, insertAt)) { outcome = UNCHANGED; return; }

    let allocateList = toAllocate;
    if (leadingFollowers.length) {
      leadingFollowers.sort((a, b) => a.remainingAt - b.remainingAt);
      if (leftBound === null) {
        allocateList = leadingFollowers.map(item => item.slot).concat(toAllocate);
      } else {
        const afterLast = (leadingFollowers.at(-1)?.remainingAt ?? -1) + 1;
        let ceiling: string | null = leftBound;
        for (let i = afterLast; i < remaining.length; i++) {
          const bound = remaining[i]?.bound ?? null;
          if (bound !== null) { ceiling = bound; break; }
        }
        let cursor: string | null = null;
        for (const { slot } of leadingFollowers) {
          try { cursor = nativeRankBetween(cursor, ceiling); }
          catch (error) { if (error instanceof NativeRankError) { outcome = refused("stored"); return; } throw error; }
          writes.push({ ...slot, rank: cursor });
        }
      }
    }

    let cursor = leftBound;
    for (const slot of allocateList) {
      try { cursor = nativeRankBetween(cursor, rightBound); }
      catch (error) { if (error instanceof NativeRankError) { outcome = refused("stored"); return; } throw error; }
      writes.push({ ...slot, rank: cursor });
    }

    const overrides = new Map<string, string>();
    for (const { block, rank } of writes) overrides.set(storedKey(block), rank);
    if (!matchesExpected(script.reader.previewMoveOrder(overrides), remaining, moving, insertAt)) {
      outcome = refused("range");
      return;
    }

    for (const { record, rank } of writes) {
      if (!record.has("rank") || record.get("rank") !== rank) record.set("rank", rank);
    }
    outcome = WRITTEN;
  });
  return outcome;
}
