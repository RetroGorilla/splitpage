const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
// why: a rank ending in "0" has no string between it and itself + "0", so valid ranks end in 1-9, A-Z or a-z
const RANK_PATTERN = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

function assertRank(value: string, label: string): void {
  if (typeof value !== "string" || !RANK_PATTERN.test(value)) {
    throw new RangeError(`Invalid ${label} rank: expected base-62 digits not ending in "0"`);
  }
}

export function nativeRankBetween(before: string | null, after: string | null): string {
  if (before !== null) assertRank(before, "before");
  if (after !== null) assertRank(after, "after");
  if (before !== null && after !== null && before >= after) {
    throw new RangeError("Expected before rank to sort strictly before after rank");
  }
  let prefix = "";
  let upper = after;
  for (let i = 0; ; i++) {
    const lo = before !== null && i < before.length ? DIGITS.indexOf(before.charAt(i)) : 0;
    const hi = upper !== null && i < upper.length ? DIGITS.indexOf(upper.charAt(i)) : BASE;
    if (hi - lo > 1) return prefix + DIGITS.charAt(Math.floor((lo + hi) / 2));
    prefix += DIGITS.charAt(lo);
    if (hi > lo) upper = null;
  }
}
