import { wireIdentity } from "../readers/identity.ts";
import { AbstractType, Doc } from "yjs";
import { createEncoder, toUint8Array, writeAny } from "lib0/encoding";
import { createDecoder, readAny } from "lib0/decoding";

export interface BeatStatusEvent {
  target: string;
  value: "todo" | "ready" | "shot";
  prior?: unknown;
  parents: readonly string[];
  by: string;
}

export function readStatusEvent(raw: unknown): BeatStatusEvent | null {
  if (!raw || typeof raw !== "object") return null;
  try {
    const constructor: unknown = (raw as { constructor?: unknown }).constructor;
    if (constructor === Doc || constructor === Uint8Array) return null;
    if ((raw instanceof AbstractType || raw instanceof Doc) && ![Object, Number, Boolean, Array, String, Date, BigInt].some(type => type === constructor)) return null;
    const encoded = createEncoder(); writeAny(encoded, raw as Parameters<typeof writeAny>[1]);
    const decoded: unknown = readAny(createDecoder(toUint8Array(encoded)));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || decoded instanceof Uint8Array) return null;
    for (const key of ["target", "value", "parents", "by"]) if (!Object.prototype.hasOwnProperty.call(decoded, key)) return null;
    const source = decoded as Record<string, unknown>, target = source.target, value = source.value, by = source.by, rawParents = source.parents;
    if (typeof target !== "string" || typeof by !== "string" || value !== "todo" && value !== "ready" && value !== "shot" || !Array.isArray(rawParents)) return null;
    const parents: string[] = [];
    for (let index = 0; index < rawParents.length; index++) {
      const parent: unknown = rawParents[index]; if (typeof parent !== "string") return null;
      parents.push(parent);
    }
    return { target, value, parents, by };
  } catch { return null; }
}

export function statusHeads(events: ReadonlyMap<string, BeatStatusEvent>): string[] {
  const parents = new Set([...events.values()].flatMap(event => event.parents));
  return [...events.keys()].filter(id => !parents.has(id));
}

export function resolveBeatStatus(input: ReadonlyMap<string, unknown>, retired: { has: (id: string) => boolean }, stored: string): string {
  const events = new Map<string, BeatStatusEvent>();
  for (const [id, raw] of input) {
    const event = readStatusEvent(raw); if (typeof id === "string" && event) events.set(wireIdentity(id), event);
  }
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
