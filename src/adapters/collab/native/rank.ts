const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const CHUNK_WIDTH = 6;
const CHUNK_STEP = 32;
const MAX_CHUNK = BASE ** CHUNK_WIDTH - 1;
const INITIAL_OPEN_RANK = "V00000V";
// why: a rank ending in "0" has no string between it and itself + "0", so valid ranks end in 1-9, A-Z or a-z
const RANK_PATTERN = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

export class NativeRankError extends RangeError {}

export function isValidNativeRank(value: unknown): value is string {
  return typeof value === "string" && RANK_PATTERN.test(value);
}

export function compareNativeRankedIds(left: string, leftRank: string | null, right: string, rightRank: string | null): number {
  const a = leftRank ?? "", b = rightRank ?? "";
  return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
}

function assertRank(value: string, label: string): void {
  if (!isValidNativeRank(value)) {
    throw new NativeRankError(`Invalid ${label} rank: expected base-62 digits not ending in "0"`);
  }
}

function decodeChunkAt(source: string, offset: number): number {
  let value = 0;
  for (let i = 0; i < CHUNK_WIDTH; i++) {
    const pos = offset + i;
    value = value * BASE + (pos < source.length ? DIGITS.indexOf(source.charAt(pos)) : 0);
  }
  return value;
}

function encodeChunk(value: number): string {
  let remaining = value;
  let result = "";
  for (let i = 0; i < CHUNK_WIDTH; i++) {
    result = DIGITS.charAt(remaining % BASE) + result;
    remaining = Math.floor(remaining / BASE);
  }
  return result;
}

function rankAfter(before: string): string {
  let offset = 0;
  while (offset < before.length) {
    const value = decodeChunkAt(before, offset);
    if (value < MAX_CHUNK) return "z".repeat(offset) + encodeChunk(Math.min(value + CHUNK_STEP, MAX_CHUNK)) + "V";
    offset += CHUNK_WIDTH;
  }
  return "z".repeat(offset) + encodeChunk(CHUNK_STEP) + "V";
}

function rankBefore(after: string): string {
  let offset = 0;
  for (;;) {
    const value = decodeChunkAt(after, offset);
    if (value > 0) return "0".repeat(offset) + encodeChunk(value >= CHUNK_STEP ? value - CHUNK_STEP : value - 1) + "V";
    offset += CHUNK_WIDTH;
  }
}

export function nativeRankBetween(before: string | null, after: string | null): string {
  if (before !== null) assertRank(before, "before");
  if (after !== null) assertRank(after, "after");
  if (before === null) {
    if (after === null) return INITIAL_OPEN_RANK;
    return rankBefore(after);
  }
  if (after === null) return rankAfter(before);
  if (before >= after) {
    throw new NativeRankError("Expected before rank to sort strictly before after rank");
  }
  let prefix = "";
  let upper: string | null = after;
  for (let i = 0; ; i++) {
    const lo = i < before.length ? DIGITS.indexOf(before.charAt(i)) : 0;
    const hi = upper !== null && i < upper.length ? DIGITS.indexOf(upper.charAt(i)) : BASE;
    if (hi - lo > 1) return prefix + DIGITS.charAt(Math.floor((lo + hi) / 2));
    prefix += DIGITS.charAt(lo);
    if (hi > lo) upper = null;
  }
}
