import * as Y from "yjs";
import type { Run } from "../../../core/text/runs.ts";

export const NATIVE_SIZE_LIMIT_BYTES = 15_000_000;
export const NATIVE_SIZE_WARNING_BYTES = 12_000_000;
export const NATIVE_SIZE_RECHECK_INTERVAL_BYTES = 60_000;

export type NativeSessionSize = "ok" | "warning" | "full";

export interface NativeSizeLimits {
  readonly limit: number;
  readonly warning: number;
}

export interface NativeSizeRefusal {
  readonly kind: "refused";
  readonly reason: "full";
}

export interface NativeSizeRecovery {
  readonly kind: "recovery";
  readonly reason: "full";
  readonly runs: readonly Run[];
}

export interface NativeSizeTracker {
  readonly limits: NativeSizeLimits;
  readonly interval: number;
  readonly state: NativeSessionSize;
  readonly estimate: number;
  readonly exact: number;
  readonly measures: number;
  readonly mayBeFull: () => boolean;
  readonly recordUpdate: (updateBytes: number, transaction: Y.Transaction, localCommand: boolean) => boolean;
  readonly isFullForAdd: () => boolean;
}

export const FULL_REFUSAL: NativeSizeRefusal = Object.freeze({ kind: "refused", reason: "full" });

// why: a delete range in an update can split two stored structs, adding two item headers beyond the update's bytes
const SPLIT_BYTES_PER_DELETE_RANGE = 64;

export function fullRecovery(runs: readonly Run[]): NativeSizeRecovery {
  return Object.freeze({ kind: "recovery", reason: "full", runs });
}

export function resolveNativeSizeLimits(sizeLimit?: number, sizeWarning?: number): NativeSizeLimits {
  const limit = sizeLimit ?? NATIVE_SIZE_LIMIT_BYTES;
  const warning = sizeWarning ?? Math.min(NATIVE_SIZE_WARNING_BYTES, limit);
  if (!Number.isFinite(limit) || limit <= 0) throw new RangeError("Size limit must be a positive finite number");
  if (!Number.isFinite(warning) || warning < 0 || warning > limit) {
    throw new RangeError("Size warning threshold must be a finite number between 0 and the size limit");
  }
  return Object.freeze({ limit, warning });
}

function deleteRangesOf(transaction: Y.Transaction): number {
  let count = 0;
  for (const items of transaction.deleteSet.clients.values()) count += items.length;
  return count;
}

export function createNativeSizeTracker(
  doc: Y.Doc,
  limits: NativeSizeLimits,
  measureBytes: (target: Y.Doc) => number = target => Y.encodeStateAsUpdate(target).byteLength
): NativeSizeTracker {
  const { limit, warning } = limits;
  const interval = Math.max(1, Math.min(NATIVE_SIZE_RECHECK_INTERVAL_BYTES, Math.floor(limit / 250)));

  function classify(bytes: number): NativeSessionSize {
    if (bytes >= limit) return "full";
    if (bytes >= warning) return "warning";
    return "ok";
  }

  function nextThresholdFor(current: NativeSessionSize): number {
    if (current === "ok") return warning;
    if (current === "warning") return limit;
    return Infinity;
  }

  let exact = measureBytes(doc);
  let estimate = exact;
  let state = classify(exact);
  let nextMeasureAt = nextThresholdFor(state);
  let measures = 1;

  function remeasure(): boolean {
    const previous = state;
    exact = measureBytes(doc);
    measures++;
    estimate = exact;
    state = classify(exact);
    const threshold = nextThresholdFor(state);
    nextMeasureAt = state === previous ? Math.max(threshold, exact + interval) : threshold;
    return state !== previous;
  }

  function recordUpdate(updateBytes: number, transaction: Y.Transaction, localCommand: boolean): boolean {
    const hasDeletes = transaction.deleteSet.clients.size > 0;
    // why: an inserted item can split an existing struct, whose added header is bounded by the update's own bytes
    const growth = updateBytes * 2 + (hasDeletes ? deleteRangesOf(transaction) * SPLIT_BYTES_PER_DELETE_RANGE : 0);
    estimate += growth;
    if (!localCommand && hasDeletes && state !== "ok") return remeasure();
    if (state === "full") return false;
    if (estimate >= nextMeasureAt || (!localCommand && estimate >= nextThresholdFor(state))) return remeasure();
    return false;
  }

  function mayBeFull(): boolean {
    return state === "full" || estimate >= limit;
  }

  function isFullForAdd(): boolean {
    if (state === "full") return true;
    if (estimate < limit) return false;
    remeasure();
    return exact >= limit;
  }

  return Object.freeze({
    limits,
    interval,
    get state() { return state; },
    get estimate() { return estimate; },
    get exact() { return exact; },
    get measures() { return measures; },
    mayBeFull,
    recordUpdate,
    isFullForAdd
  });
}
