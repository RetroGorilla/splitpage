import type { Frozen, Seal } from "./freeze.ts";

const MEMO_CHAR_BUDGET = 2000000;

export function contentMemo<T>(compute: (html: string) => T, seal: Seal): (html: string | null | undefined) => Frozen<T> {
  const cache = new Map<string, Frozen<T>>();
  let chars = 0;
  return function (html) {
    const key = html || "";
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const val = seal(compute(key));
    if (chars > MEMO_CHAR_BUDGET) { cache.clear(); chars = 0; }
    cache.set(key, val);
    chars += key.length;
    return val;
  };
}
