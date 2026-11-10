export interface BeatStatusEvent {
  target: string;
  value: string;
  prior: string;
  parents: readonly string[];
  by?: string;
}

export function statusHeads(events: ReadonlyMap<string, BeatStatusEvent>): string[] {
  const parents = new Set([...events.values()].flatMap(event => event.parents));
  return [...events.keys()].filter(id => !parents.has(id));
}

export function resolveBeatStatus(events: ReadonlyMap<string, BeatStatusEvent>, retired: { has: (id: string) => boolean }, stored: string): string {
  const ancestry = new Map<string, Set<string>>();
  const ancestors = (id: string): Set<string> => {
    const cached = ancestry.get(id);
    if (cached) return cached;
    const result = new Set<string>();
    for (const parent of events.get(id)?.parents ?? []) if (events.has(parent)) {
      result.add(parent);
      for (const ancestor of ancestors(parent)) result.add(ancestor);
    }
    ancestry.set(id, result);
    return result;
  };
  const resolved = new Map<string, string>();
  const resolve = (heads: readonly string[]): string => {
    if (!heads.length) return stored;
    const values = heads.map(id => {
      const event = events.get(id);
      if (!event) return stored;
      if (!retired.has(id)) return event.value;
      const cached = resolved.get(id);
      if (cached !== undefined) return cached;
      const value = resolve(event.parents.filter(parent => events.has(parent)));
      resolved.set(id, value);
      return value;
    });
    if (new Set(values).size === 1) return values[0] ?? stored;
    let common: Set<string> | undefined;
    for (const id of heads) {
      const branch = ancestors(id);
      common = common === undefined ? new Set(branch) : new Set([...common].filter(ancestor => branch.has(ancestor)));
    }
    const shared = new Map([...events].filter(([id]) => common?.has(id)));
    return resolve(statusHeads(shared));
  };
  return resolve(statusHeads(events));
}
