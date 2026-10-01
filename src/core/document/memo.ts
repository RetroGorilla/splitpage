const MEMO_CHAR_BUDGET = 2000000;

export function contentMemo<T>(compute: (html: string) => T): (html: string | null | undefined) => T {
  const cache = new Map<string, T>();
  let chars = 0;
  return function (html) {
    const key = html || "";
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const val = compute(key);
    if (chars > MEMO_CHAR_BUDGET) { cache.clear(); chars = 0; }
    cache.set(key, val);
    chars += key.length;
    return val;
  };
}
