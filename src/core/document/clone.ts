export type MutableClone<T> = T extends object ? { -readonly [K in keyof T]: MutableClone<T[K]> } : T;

export function cloneState<T>(s: T): MutableClone<T> { return JSON.parse(JSON.stringify(s)) as MutableClone<T>; }
