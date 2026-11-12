import { mock } from "node:test";

export function trapSharedCollectionWalks(...collections: readonly object[]): () => void {
  const held: { mock: { restore: () => void } }[] = [];
  for (const collection of collections) for (const key of ["values", "keys", "entries", "forEach", "toArray", Symbol.iterator]) {
    if (typeof Reflect.get(collection, key) !== "function") continue;
    held.push(mock.method(collection as Record<PropertyKey, () => unknown>, key, () => { throw new Error("Whole shared collection walk: " + String(key)); }));
  }
  return () => { for (const method of held) method.mock.restore(); };
}
