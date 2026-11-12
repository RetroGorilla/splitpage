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

// why: a name carries one number however many earlier marks there were, so its size does not grow with the history.
export function sharedRangeMarkOperation(operation: string, index: number, generation: number): string {
  return JSON.stringify(generation > 1 ? ["range-mark", operation, index, generation] : ["range-mark", operation, index]);
}

export function readSharedMarkGeneration(record: SharedMarkRecord): number {
  const raw = record.type === "add" ? named(record.operation, "range-mark")?.[3] : undefined;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 1 ? raw : 1;
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

// why: decided row: the same change made by two people who had not seen each other's is one change.
function changeKey(record: SharedMarkRecord): string | null {
  return record.type === "add" && record.born === null
    ? JSON.stringify([record.start, record.end, record.mark.kind, record.mark.value, readSharedMarkGeneration(record)]) : null;
}

export const SHARED_MARK_PROVENANCE_MARKER = "provenance";
export const sharedMarkProvenanceCost = { scans: 0, visits: 0 };

// why: the store's keys are already read and sorted, so finding the marker among them reads nothing from the library.
export function hasSharedMarkProvenanceMarker(sortedKeys: readonly string[]): boolean {
  let low = 0, high = sortedKeys.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1, key = sortedKeys[middle];
    if (key === SHARED_MARK_PROVENANCE_MARKER) return true;
    if (key !== undefined && key < SHARED_MARK_PROVENANCE_MARKER) low = middle + 1; else high = middle - 1;
  }
  return false;
}

export function readSharedMarkProvenance(records: readonly NamedMarkRecord[], sortedKeys: readonly string[]): SharedMarkProvenance | null {
  // why: typing reads this for every command; the marker written with the first retraction or copy says when to look.
  if (!hasSharedMarkProvenanceMarker(sortedKeys)) return null;
  const sources = new Map<SharedContentRef, SharedContentRef>(), retracted: SharedContentRef[] = [];
  const changes = new Map<string, SharedContentRef[]>(), changeOf = new Map<SharedContentRef, string>();
  sharedMarkProvenanceCost.scans++;
  for (const { identity, record } of records) {
    sharedMarkProvenanceCost.visits++;
    if (record.type === "add") {
      const source = named(record.operation, "mark-copy")?.[4], change = changeKey(record);
      if (typeof source === "string") sources.set(identity, source as SharedContentRef);
      if (change !== null) {
        const members = changes.get(change);
        if (members) members.push(identity); else changes.set(change, [identity]);
        changeOf.set(identity, change);
      }
    } else if (record.type === "remove" && named(record.operation, "mark-retract")) for (const observed of record.observed) retracted.push(observed);
  }
  if (!sources.size && !retracted.length) return null;
  const source = (identity: SharedContentRef): SharedContentRef => sources.get(identity) ?? identity, cancelled = new Set<SharedContentRef>();
  for (const observed of retracted) {
    sharedMarkProvenanceCost.visits++;
    const own = source(observed), change = changeOf.get(own);
    cancelled.add(own);
    if (change === undefined) continue;
    // why: the cancellation stays with the change, so one that arrives later is cancelled too; each change is read once.
    for (const member of changes.get(change) ?? []) { sharedMarkProvenanceCost.visits++; cancelled.add(member); }
    changes.delete(change);
  }
  return { source, cancelled };
}
