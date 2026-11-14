import { canonicalSharedProjection } from "../../core/collab/projection/canonical.ts";
import type { SharedProjectionKind } from "../../core/collab/projection/canonical.ts";

export type SharedProjectionWork = "segment" | "visual" | "record" | "fields" | "group" | "cell" | "snapshot" | "compare-row" | "compare-field" | "broll-scan" | "who-scan" | "split-observation";

export class SharedProjectionCache {
  private readonly slots = new Map<string, { readonly dependencies: readonly unknown[]; readonly value: unknown; readonly children: ReadonlySet<string> }>();
  private readonly used = new Set<string>();
  private readonly building: Set<string>[] = [];
  private readonly canonicalValues = new WeakMap<object, Map<SharedProjectionKind, unknown>>();

  private readonly count: ((work: SharedProjectionWork, key: string, units?: number) => void) | undefined;
  constructor(count?: (work: SharedProjectionWork, key: string, units?: number) => void) { this.count = count; }

  begin(): void { this.used.clear(); }
  end(): void { for (const key of this.slots.keys()) if (!this.used.has(key)) this.slots.delete(key); }
  counted(work: SharedProjectionWork, key: string, units?: number): void { this.count?.(work, key, units); }

  read<T>(slot: readonly string[], dependencies: readonly unknown[], build: () => T, work?: SharedProjectionWork): T {
    const key = JSON.stringify(slot), previous = this.slots.get(key);
    this.used.add(key);
    for (const parent of this.building) parent.add(key);
    if (previous && previous.dependencies.length === dependencies.length && dependencies.every((value, index) => Object.is(value, previous.dependencies[index]))) {
      for (const child of previous.children) { this.used.add(child); for (const parent of this.building) parent.add(child); }
      return previous.value as T;
    }
    if (work) this.count?.(work, slot.at(-1) ?? "");
    const children = new Set<string>(); this.building.push(children);
    try {
      const value = build();
      this.slots.set(key, { dependencies: [...dependencies], value, children });
      return value;
    } finally { this.building.pop(); }
  }

  array<T>(slot: readonly string[], values: readonly T[]): readonly T[] { return this.read(slot, values, () => values); }

  canonical(value: unknown, kind: SharedProjectionKind = "document"): unknown {
    return canonicalSharedProjection(value, kind, (source, context, build) => {
      let kinds = this.canonicalValues.get(source);
      if (!kinds) { kinds = new Map(); this.canonicalValues.set(source, kinds); }
      if (!kinds.has(context)) kinds.set(context, build());
      return kinds.get(context);
    });
  }
}

export function freezeSharedProjection<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freezeSharedProjection(entry);
    Object.freeze(value);
  }
  return value;
}
