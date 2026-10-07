export type Frozen<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends object ? { readonly [K in keyof T]: Frozen<T[K]> }
      : T;

export type Seal = <T>(value: T) => Frozen<T>;

export function deepFreeze<T>(value: T): Frozen<T> {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const v = pending.pop();
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    Object.freeze(v);
    for (const k of Object.keys(v)) pending.push((v as Record<string, unknown>)[k]);
  }
  return value as Frozen<T>;
}

export function noFreeze<T>(value: T): Frozen<T> {
  return value as Frozen<T>;
}
