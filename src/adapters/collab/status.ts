import * as Y from "yjs";
import type { SharedStatusEvent } from "../../core/collab/operations.ts";
import { readSharedStatusEvent } from "../../core/collab/read-operation.ts";
import { ROW_STATUS_IDS } from "../../core/document/timing.ts";
import { TAG_STATUS_IDS } from "../../core/document/tags.ts";
import { BROLL_STATUS_IDS } from "../../core/document/broll.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { withSharedSnapshot } from "./snapshot.ts";

function sameTarget(a: SharedStatusEvent["target"], b: SharedStatusEvent["target"]): boolean {
  return a.scope === b.scope && a.record === b.record;
}

function eventsFor(handle: SharedDocumentHandle, target: SharedStatusEvent["target"]): Map<string, SharedStatusEvent> {
  const events = new Map<string, SharedStatusEvent>();
  for (const [id, raw] of collabState(handle).roots.statusEvents) {
    const event = readSharedStatusEvent(raw);
    if (event && id === event.id && sameTarget(event.target, target)) events.set(id, event);
  }
  return events;
}

function heads(events: ReadonlyMap<string, SharedStatusEvent>): string[] {
  const parents = new Set<string>([...events.values()].flatMap(event => event.parents));
  return [...events.keys()].filter(id => !parents.has(id)).sort();
}

function targetRecord(handle: SharedDocumentHandle, target: SharedStatusEvent["target"]): Y.Map<unknown> | null {
  const roots = collabState(handle).roots;
  const raw = roots[target.scope === "beat" ? "beats" : target.scope === "tag" ? "tags" : "shots"].get(target.record);
  return raw instanceof Y.Map ? raw : null;
}

function storedStatus(handle: SharedDocumentHandle, target: SharedStatusEvent["target"]): string {
  const ids = target.scope === "beat" ? ROW_STATUS_IDS : target.scope === "tag" ? TAG_STATUS_IDS : BROLL_STATUS_IDS;
  const value = targetRecord(handle, target)?.get("status");
  return typeof value === "string" && (ids as readonly string[]).includes(value) ? value : ids[0];
}

function resolveStatus(handle: SharedDocumentHandle, target: SharedStatusEvent["target"]): string {
  const stored = storedStatus(handle, target), events = eventsFor(handle, target);
  const pending = new Map<string, number>(), children = new Map<string, string[]>(), ordered: string[] = [];
  for (const [id, event] of events) {
    const parents = new Set(event.parents.filter(parent => events.has(parent)));
    pending.set(id, parents.size);
    if (!parents.size) ordered.push(id);
    for (const parent of parents) {
      const entries = children.get(parent) ?? [];
      entries.push(id); children.set(parent, entries);
    }
  }
  for (let index = 0; index < ordered.length; index++) {
    const id = ordered[index];
    if (id === undefined) continue;
    for (const child of children.get(id) ?? []) {
      const count = (pending.get(child) ?? 0) - 1;
      pending.set(child, count);
      if (!count) ordered.push(child);
    }
  }
  if (ordered.length !== events.size) return stored;
  const ancestry = new Map<string, Set<string>>();
  const ancestors = (id: string): Set<string> => {
    const cached = ancestry.get(id);
    if (cached) return cached;
    const result = new Set<string>(), stack: string[] = [...events.get(id)?.parents ?? []];
    while (stack.length) {
      const parent = stack.pop();
      if (parent === undefined || result.has(parent) || !events.has(parent)) continue;
      result.add(parent);
      for (const ancestor of events.get(parent)?.parents ?? []) stack.push(ancestor);
    }
    ancestry.set(id, result);
    return result;
  };
  const resolved = new Map<string, string>();
  const resolve = (initial: readonly string[]): string => {
    let frontier = initial;
    while (frontier.length) {
      const values = frontier.map(id => resolved.get(id) ?? stored);
      if (new Set(values).size === 1) return values[0] ?? stored;
      let common: Set<string> | undefined;
      for (const id of frontier) {
        const branch = ancestors(id);
        common = common === undefined ? new Set(branch) : new Set([...common].filter(ancestor => branch.has(ancestor)));
      }
      frontier = heads(new Map([...events].filter(([id]) => common?.has(id))));
    }
    return stored;
  };
  for (const id of ordered) {
    const event = events.get(id);
    if (event) resolved.set(id, collabState(handle).roots.retiredStatus.has(id)
      ? resolve(event.parents.filter(parent => events.has(parent))) : event.value);
  }
  return resolve(heads(events));
}

export function readSharedStatus(handle: SharedDocumentHandle, target: SharedStatusEvent["target"]): string {
  return withSharedSnapshot(handle, copy => resolveStatus(copy as unknown as SharedDocumentHandle, target));
}

export function readSharedStatusHeads(handle: SharedDocumentHandle, target: SharedStatusEvent["target"]): string[] {
  return withSharedSnapshot(handle, copy => heads(eventsFor(copy as unknown as SharedDocumentHandle, target)));
}

export function readSharedStatusNotices(handle: SharedDocumentHandle, target: SharedStatusEvent["target"]): string[] {
  return withSharedSnapshot(handle, copy => {
    const events = [...eventsFor(copy as unknown as SharedDocumentHandle, target).values()];
    const conflicts = events.filter(event => events.some(other => other.value !== event.value
      && JSON.stringify([...new Set(event.parents)].sort()) === JSON.stringify([...new Set(other.parents)].sort())));
    return [...new Set(conflicts.map(event => `${event.by}: concurrent status change did not apply`))].sort();
  });
}

export function writeSharedStatusEvent(handle: SharedDocumentHandle, operation: SharedStatusEvent): string | null {
  const event = readSharedStatusEvent(operation);
  if (!event || !targetRecord(handle, event.target)) return "missing-status-target";
  const root = collabState(handle).roots.statusEvents;
  if (root.has(event.id)) return "duplicate-status-event";
  const events = eventsFor(handle, event.target);
  for (const known of events.values()) {
    if (known.parents.some(parent => !events.has(parent))) return "incomplete-status-ancestry";
  }
  if (JSON.stringify([...new Set(event.parents)].sort()) !== JSON.stringify(heads(events))) return "stale-status-parents";
  const stored = readSharedStatusEvent({ ...event, prior: resolveStatus(handle, event.target) });
  if (!stored) return "invalid-status-event";
  root.set(event.id, stored);
  return null;
}
