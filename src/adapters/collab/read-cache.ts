interface Memo { readonly sources: readonly object[]; readonly versions: readonly number[]; readonly value: unknown }

export class CollabReadCaches {
  private open = 0;
  private readonly versions = new WeakMap<object, number>();
  private readonly memos = new WeakMap<object, Map<string, Memo>>();
  private readonly entries = new WeakMap<object, Map<string, Map<string, unknown>>>();
  private readonly watched = new WeakMap<object, Map<string, Set<string>>>();
  private readonly kept = new WeakMap<object, Map<string, unknown>>();

  // why: between a transaction's first write and its settled change list, a cached reading could predate the write.
  begin(): void { this.open++; }

  settle(changed: ReadonlyMap<object, ReadonlySet<string | null>>): void {
    for (const [type, keys] of changed) {
      this.versions.set(type, (this.versions.get(type) ?? 0) + 1);
      for (const slot of this.entries.get(type)?.values() ?? []) for (const key of keys) if (key !== null) slot.delete(key);
      for (const pending of this.watched.get(type)?.values() ?? []) for (const key of keys) if (key !== null) pending.add(key);
    }
    if (this.open > 0) this.open--;
  }

  get settled(): boolean { return this.open === 0; }

  memo<T>(sources: readonly [object, ...object[]], slot: string, read: () => T): T {
    if (this.open) return read();
    const owner = sources[0], versions = sources.map(source => this.versions.get(source) ?? 0);
    let slots = this.memos.get(owner);
    if (!slots) { slots = new Map(); this.memos.set(owner, slots); }
    const found = slots.get(slot);
    if (found && found.sources.length === sources.length && found.sources.every((source, index) => source === sources[index] && found.versions[index] === versions[index])) return found.value as T;
    const value = read();
    slots.set(slot, { sources: [...sources], versions, value });
    return value;
  }

  entry<T>(map: object, slot: string, key: string, read: () => T): T {
    if (this.open) return read();
    let slots = this.entries.get(map);
    if (!slots) { slots = new Map(); this.entries.set(map, slots); }
    let values = slots.get(slot);
    if (!values) { values = new Map(); slots.set(slot, values); }
    if (values.has(key)) return values.get(key) as T;
    const value = read();
    values.set(key, value);
    return value;
  }

  keep<T>(type: object, slot: string, create: () => T): T {
    let slots = this.kept.get(type);
    if (!slots) { slots = new Map(); this.kept.set(type, slots); }
    if (!slots.has(slot)) slots.set(slot, create());
    return slots.get(slot) as T;
  }

  drain(map: object, slot: string): ReadonlySet<string> | null {
    let slots = this.watched.get(map);
    if (!slots) { slots = new Map(); this.watched.set(map, slots); }
    const pending = slots.get(slot);
    slots.set(slot, new Set());
    return pending ?? null;
  }
}
