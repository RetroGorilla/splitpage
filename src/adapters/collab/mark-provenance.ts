import * as Y from "yjs";
import type { SharedContentRef } from "../../core/collab/operations.ts";
import type { SharedMarkRecord } from "./mark-record.ts";

interface NamedMarkRecord { readonly identity: SharedContentRef; readonly record: SharedMarkRecord }
export interface SharedMarkProvenance {
  readonly source: (identity: SharedContentRef) => SharedContentRef;
  readonly cancelled: ReadonlySet<SharedContentRef>;
}

function named(operation: string, name: string): readonly unknown[] | null {
  if (!operation.startsWith("[\"" + name + "\",")) return null;
  try {
    const raw: unknown = JSON.parse(operation);
    return Array.isArray(raw) ? raw as readonly unknown[] : null;
  } catch { return null; }
}

export function sharedRangeMarkOperation(operation: string, index: number, seen: readonly SharedContentRef[]): string {
  return JSON.stringify(seen.length ? ["range-mark", operation, index, [...seen].sort()] : ["range-mark", operation, index]);
}

export function sharedMarkRetractOperation(operation: string, index: number): string {
  return JSON.stringify(["mark-retract", operation, index]);
}

export function sharedMarkCopyOperation(operation: string, unit: number, mark: number, source: SharedContentRef): string {
  return JSON.stringify(["mark-copy", operation, unit, mark, source]);
}

export function sharedTextRestoreOperation(operation: string, unit: number, original: { readonly client: number; readonly clock: number }): string {
  return JSON.stringify(["text-restore", operation, unit, original.client, original.clock]);
}

export function readSharedTextRestoreOperation(operation: string): { readonly client: number; readonly clock: number } | null {
  const raw = named(operation, "text-restore"), client = raw?.[3], clock = raw?.[4];
  return typeof client === "number" && typeof clock === "number" ? { client, clock } : null;
}

export function readSharedMarkSeen(record: SharedMarkRecord): readonly unknown[] {
  const seen = record.type === "add" ? named(record.operation, "range-mark")?.[3] : null;
  return Array.isArray(seen) ? seen as readonly unknown[] : [];
}

function sameChange(first: NamedMarkRecord, other: NamedMarkRecord): boolean {
  const a = first.record, b = other.record;
  // why: decided row: the same change made by two people who had not seen each other's is one change.
  return a.type === "add" && b.type === "add" && a.born === null && b.born === null && a.start === b.start && a.end === b.end
    && a.mark.kind === b.mark.kind && a.mark.value === b.mark.value
    && !readSharedMarkSeen(a).includes(other.identity) && !readSharedMarkSeen(b).includes(first.identity);
}

export const SHARED_MARK_PROVENANCE_MARKER = "provenance";
export const sharedMarkProvenanceCost = { scans: 0, visits: 0 };

export function readSharedMarkProvenance(records: readonly NamedMarkRecord[], store: unknown): SharedMarkProvenance | null {
  // why: typing reads this for every command; the marker written with the first retraction or copy says when to look.
  if (!(store instanceof Y.Map) || !store.has(SHARED_MARK_PROVENANCE_MARKER)) return null;
  const sources = new Map<SharedContentRef, SharedContentRef>(), retracted: SharedContentRef[] = [];
  sharedMarkProvenanceCost.scans++;
  for (const { identity, record } of records) {
    sharedMarkProvenanceCost.visits++;
    if (record.type === "add") {
      const source = named(record.operation, "mark-copy")?.[4];
      if (typeof source === "string") sources.set(identity, source as SharedContentRef);
    } else if (record.type === "remove" && named(record.operation, "mark-retract")) for (const observed of record.observed) retracted.push(observed);
  }
  if (!sources.size && !retracted.length) return null;
  const source = (identity: SharedContentRef): SharedContentRef => sources.get(identity) ?? identity, cancelled = new Set<SharedContentRef>();
  for (const observed of retracted) {
    const own = source(observed), first = records.find(item => item.identity === own);
    cancelled.add(own);
    // why: the cancellation stays with the occurrence, so the same change is cancelled also when it arrives later.
    if (first) for (const other of records) if (other.identity !== own && sameChange(first, other)) cancelled.add(other.identity);
  }
  return { source, cancelled };
}
