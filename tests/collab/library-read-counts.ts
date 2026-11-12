import * as Y from "yjs";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import { collabState } from "../../src/adapters/collab/state.ts";

interface LibraryReadTotals { texts: number; markEntries: number; records: number; statusEntries: number; orderEntries: number }
type NativeMethod = (this: object, ...args: unknown[]) => unknown;

export function measureLibraryReads<T>(handle: SharedDocumentHandle, beat: string, read: () => T, related: readonly Y.Doc[] = []) {
  const roots = collabState(handle).roots, own = new Set<object>();
  const collections = ["beats", "headings", "visuals", "gallery", "comments", "replies", "people", "tags", "shots"];
  const originalGet = Y.Map.prototype.get;
  const add = (value: unknown): void => {
    if (!(value instanceof Y.AbstractType) || own.has(value)) return;
    own.add(value);
    if (value instanceof Y.Map) for (const nested of value.values()) add(nested);
  };
  add(roots.beats.get(beat)); add(roots.segments.get("b:" + beat));
  for (const name of ["visuals", "gallery"] as const) for (const value of roots[name].values()) {
    if (value instanceof Y.Map && value.get("beat") === beat) add(value);
  }
  for (const doc of related) {
    for (const [name, key] of [["beats", beat], ["segments", "b:" + beat]] as const) {
      const root = doc.share.get(name); if (root instanceof Y.Map) add(root.get(key));
    }
    for (const name of ["visuals", "gallery"]) {
      const root = doc.share.get(name);
      if (root instanceof Y.Map) for (const value of root.values()) if (value instanceof Y.Map && value.get("beat") === beat) add(value);
    }
  }
  const totals: LibraryReadTotals = { texts: 0, markEntries: 0, records: 0, statusEntries: 0, orderEntries: 0 };
  const unrelated: LibraryReadTotals = { texts: 0, markEntries: 0, records: 0, statusEntries: 0, orderEntries: 0 };
  const restores: (() => void)[] = [];
  const count = (type: object, key?: unknown): void => {
    if (!(type instanceof Y.AbstractType) || !type.doc) return;
    const parent = type.parent, share = type.doc.share;
    let kind: keyof LibraryReadTotals | null = type instanceof Y.Text ? "texts" : null;
    let related = own.has(type);
    if (type === share.get("order")) { kind = "orderEntries"; related = key === "b:" + beat; }
    if (type === share.get("statusEvents")) {
      kind = "statusEntries";
      const raw: unknown = type instanceof Y.Map ? originalGet.call(type, key as string) : undefined;
      related = raw === undefined || !!raw && typeof raw === "object" && "target" in raw
        && !!raw.target && typeof raw.target === "object" && "record" in raw.target && raw.target.record === beat;
    } else if (parent instanceof Y.Map && (originalGet.call(parent, "markRecords") === type || originalGet.call(parent, "titleMarks") === type)) {
      kind = "markEntries";
    } else {
      for (const name of collections) if (type === share.get(name)) {
        kind = "records";
        related = own.has(originalGet.call(type as Y.Map<unknown>, key as string) as object);
      } else if (parent === share.get(name)) kind = "records";
    }
    if (kind) { totals[kind]++; if (!related) unrelated[kind]++; }
  };
  const wrap = (prototype: object, key: PropertyKey, make: (method: NativeMethod) => NativeMethod): void => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (!descriptor || typeof descriptor.value !== "function") throw new Error("Missing public library read method: " + String(key));
    Object.defineProperty(prototype, key, { ...descriptor, value: make(descriptor.value as NativeMethod) });
    restores.push(() => { Object.defineProperty(prototype, key, descriptor); });
  };
  for (const method of ["get", "has"] as const) wrap(Y.Map.prototype, method, original => function (...args) {
    count(this, args[0]); return original.apply(this, args);
  });
  for (const method of ["keys", "values", "entries", Symbol.iterator]) wrap(Y.Map.prototype, method, original => function (...args) {
    const iterator = original.apply(this, args) as IterableIterator<unknown>;
    return (function* (this: object) {
      for (const item of iterator) {
        const key = method === "keys" ? item : method === "values" ? undefined : (item as [unknown, unknown])[0];
        count(this, key); yield item;
      }
    }).call(this);
  });
  wrap(Y.Map.prototype, "forEach", original => function (...args) {
    const callback = args[0] as (value: unknown, key: string, map: Y.Map<unknown>) => void;
    return original.call(this, (value: unknown, key: string, map: Y.Map<unknown>) => {
      count(this, key); callback.call(args[1], value, key, map);
    });
  });
  wrap(Y.Map.prototype, "toJSON", original => function (...args) {
    const result = original.apply(this, args) as Record<string, unknown>;
    for (const key of Object.keys(result)) count(this, key);
    return result;
  });
  for (const method of ["toDelta", "toString", "toJSON"]) wrap(Y.Text.prototype, method, original => function (...args) {
    count(this); return original.apply(this, args);
  });
  for (const method of ["get", "toArray", "slice", "toJSON"]) wrap(Y.Array.prototype, method, original => function (...args) {
    const result = original.apply(this, args);
    if (Array.isArray(result)) for (const value of result) count(this, value);
    else count(this, result);
    return result;
  });
  for (const method of [Symbol.iterator]) wrap(Y.Array.prototype, method, original => function (...args) {
    const iterator = original.apply(this, args) as IterableIterator<unknown>;
    return (function* (this: object) { for (const value of iterator) { count(this, value); yield value; } }).call(this);
  });
  for (const method of ["forEach", "map"]) wrap(Y.Array.prototype, method, original => function (...args) {
    const callback = args[0] as (value: unknown, index: number, array: Y.Array<unknown>) => void;
    return original.call(this, (value: unknown, index: number, array: Y.Array<unknown>) => {
      count(this, value); return callback.call(args[1], value, index, array);
    });
  });
  try { return { result: read(), totals, unrelated }; }
  finally { for (const restore of restores.reverse()) restore(); }
}
