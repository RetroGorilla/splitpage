export interface BeatStatusEvent {
  target: string;
  value: string;
  prior?: unknown;
  parents: readonly string[];
  by?: string;
}

export function isBeatStatusEvent(value: unknown): value is BeatStatusEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<BeatStatusEvent>;
  return typeof event.target === "string" && typeof event.value === "string"
    && Array.isArray(event.parents) && event.parents.every(parent => typeof parent === "string");
}

export function statusHeads(events: ReadonlyMap<string, BeatStatusEvent>): string[] {
  const parents = new Set([...events.values()].flatMap(event => event.parents));
  return [...events.keys()].filter(id => !parents.has(id));
}

export function resolveBeatStatus(input: ReadonlyMap<string, unknown>, retired: { has: (id: string) => boolean }, stored: string): string {
  const events = new Map<string, BeatStatusEvent>();
  for (const [id, event] of input) if (typeof id === "string" && isBeatStatusEvent(event)) events.set(id, event);
  if (new Set([...events.values()].map(event => event.target)).size > 1) return stored;
  const pending = new Map<string, number>(), children = new Map<string, string[]>(), ordered: string[] = [];
  for (const [id, event] of events) {
    const parents = new Set(event.parents.filter(parent => events.has(parent)));
    pending.set(id, parents.size);
    if (!parents.size) ordered.push(id);
    for (const parent of parents) { const entries = children.get(parent) ?? []; entries.push(id); children.set(parent, entries); }
  }
  for (let index = 0; index < ordered.length; index++) {
    const id = ordered[index]; if (id === undefined) continue;
    for (const child of children.get(id) ?? []) {
      const count = (pending.get(child) ?? 0) - 1; pending.set(child, count); if (!count) ordered.push(child);
    }
  }
  if (ordered.length !== events.size) return stored;
  const ancestry = new Map<string, Set<string>>();
  const ancestors = (id: string): Set<string> => {
    const cached = ancestry.get(id);
    if (cached) return cached;
    const result = new Set<string>();
    const stack = [...events.get(id)?.parents ?? []];
    while (stack.length) {
      const parent = stack.pop(); if (parent === undefined || result.has(parent) || !events.has(parent)) continue;
      result.add(parent);
      for (const ancestor of events.get(parent)?.parents ?? []) stack.push(ancestor);
    }
    ancestry.set(id, result);
    return result;
  };
  const resolved = new Map<string, string>();
  const resolve = (initial: readonly string[]): string => {
    let heads = initial;
    while (heads.length) {
      const values = heads.map(id => resolved.get(id) ?? stored);
      if (new Set(values).size === 1) return values[0] ?? stored;
      let common: Set<string> | undefined;
      for (const id of heads) {
        const branch = ancestors(id);
        common = common === undefined ? new Set(branch) : new Set([...common].filter(ancestor => branch.has(ancestor)));
      }
      const shared = new Map([...events].filter(([id]) => common?.has(id)));
      heads = statusHeads(shared);
    }
    return stored;
  };
  for (const id of ordered) {
    const event = events.get(id); if (!event) continue;
    resolved.set(id, retired.has(id) ? resolve(event.parents.filter(parent => events.has(parent))) : event.value);
  }
  return resolve(statusHeads(events));
}
