import type { SharedStatusEvent, SharedContentRef } from "../../core/collab/operations.ts";
import { readSharedStatusEvent } from "../../core/collab/read-operation.ts";
import { ROW_STATUS_IDS } from "../../core/document/timing.ts";
import { TAG_STATUS_IDS } from "../../core/document/tags.ts";
import { BROLL_STATUS_IDS } from "../../core/document/broll.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { withSharedSnapshot } from "./snapshot.ts";
import { createSharedPreparation, applySharedMapWrites } from "./prepare.ts";
import type { SharedPreparationView, SharedPreparationResult, SharedPreparedWrite } from "./prepare.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { countSharedRead } from "./read-counts.ts";
import { sharedStructureReference } from "./structure-identity.ts";

function sameTarget(a: SharedStatusEvent["target"], b: SharedStatusEvent["target"]): boolean {
  return a.scope === b.scope && a.record === b.record;
}

function stableEvent(event: SharedStatusEvent): boolean {
  return isStableSharedIdentity(event.id) && isStableSharedIdentity(event.target.record)
    && isStableSharedIdentity(event.by) && event.parents.every(isStableSharedIdentity);
}

function eventsFor(view: SharedPreparationView, target: SharedStatusEvent["target"]): Map<string, SharedStatusEvent> {
  const events = new Map<string, SharedStatusEvent>();
  for (const id of view.statusEvents(target)) {
    if (!isStableSharedIdentity(id)) continue;
    countSharedRead("statusEvents");
    const event = readSharedStatusEvent(view.get(["statusEvents", id]));
    if (event && stableEvent(event) && id === event.id && sameTarget(event.target, target)) events.set(id, event);
  }
  return events;
}

function heads(events: ReadonlyMap<string, SharedStatusEvent>): string[] {
  const parents = new Set<string>([...events.values()].flatMap(event => event.parents));
  return [...events.keys()].filter(id => !parents.has(id)).sort();
}

function targetPath(target: SharedStatusEvent["target"]): string[] {
  return [target.scope === "beat" ? "beats" : target.scope === "tag" ? "tags" : "shots", target.record];
}

function storedStatus(view: SharedPreparationView, target: SharedStatusEvent["target"]): string {
  const ids = target.scope === "beat" ? ROW_STATUS_IDS : target.scope === "tag" ? TAG_STATUS_IDS : BROLL_STATUS_IDS;
  const value = view.get([...targetPath(target), "status"]);
  return typeof value === "string" && (ids as readonly string[]).includes(value) ? value : ids[0];
}

function resolveStatus(view: SharedPreparationView, target: SharedStatusEvent["target"], events = eventsFor(view, target)): string {
  const stored = storedStatus(view, target);
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
    if (event) resolved.set(id, view.kind(["retiredStatus", id]) !== "missing"
      ? resolve(event.parents.filter(parent => events.has(parent))) : event.value);
  }
  return resolve(heads(events));
}

export function readSharedStatus(handle: SharedDocumentHandle, target: SharedStatusEvent["target"]): string {
  return withSharedSnapshot(handle, copy => {
    const view = createSharedPreparation(copy as unknown as SharedDocumentHandle).view;
    return resolveStatus(view, readStatusOwner(view, target));
  });
}

function readStatusOwner(view: SharedPreparationView, target: SharedStatusEvent["target"]): SharedStatusEvent["target"] {
  const owner = target.scope === "beat" ? view.resolveOwner(target.record, "audioText") : null;
  return owner ? { scope: "beat", record: owner.owner as SharedContentRef } : target;
}

export function readSharedStatusHeads(handle: SharedDocumentHandle, target: SharedStatusEvent["target"]): string[] {
  return withSharedSnapshot(handle, copy => { const view = createSharedPreparation(copy as unknown as SharedDocumentHandle).view; return heads(eventsFor(view, readStatusOwner(view, target))); });
}

export function readSharedStatusNotices(handle: SharedDocumentHandle, target: SharedStatusEvent["target"]): string[] {
  return withSharedSnapshot(handle, copy => {
    const view = createSharedPreparation(copy as unknown as SharedDocumentHandle).view, events = [...eventsFor(view, readStatusOwner(view, target)).values()];
    const conflicts = events.filter(event => events.some(other => other.value !== event.value
      && JSON.stringify([...new Set(event.parents)].sort()) === JSON.stringify([...new Set(other.parents)].sort())));
    return [...new Set(conflicts.map(event => `${event.by}: concurrent status change did not apply`))].sort();
  });
}

export function prepareSharedStatusEvent(operation: SharedStatusEvent, view: SharedPreparationView): SharedPreparationResult {
  let event = readSharedStatusEvent(operation);
  if (event && !stableEvent(event)) return { ok: false, reason: "unstable-identity" };
  if (event?.target.scope === "beat") {
    const owner = view.resolveOwner(sharedStructureReference(view, event.target.record), "audioText");
    if (!owner) return { ok: false, reason: "missing-status-target" };
    event = readSharedStatusEvent({ ...event, target: { scope: "beat", record: owner.owner } });
  }
  if (!event || view.kind(targetPath(event.target)) !== "map") return { ok: false, reason: "missing-status-target" };
  const key = JSON.stringify([view.writer, event.id]);
  if (view.kind(["statusEvents", key]) !== "missing") return { ok: false, reason: "duplicate-status-event" };
  const events = eventsFor(view, event.target);
  for (const known of events.values()) {
    if (known.parents.some(parent => !events.has(parent))) return { ok: false, reason: "incomplete-status-ancestry" };
  }
  const parents: string[] = [];
  for (const parent of event.parents) {
    if (events.has(parent)) { parents.push(parent); continue; }
    const candidates = [...events.keys()].filter(id => {
      try { const scoped: unknown = JSON.parse(id); return Array.isArray(scoped) && scoped.length === 2 && scoped[1] === parent; }
      catch { return false; }
    });
    if (candidates.length !== 1 || candidates[0] === undefined) return { ok: false, reason: "stale-or-ambiguous-status-parent" };
    parents.push(candidates[0]);
  }
  if (JSON.stringify([...new Set(parents)].sort()) !== JSON.stringify(heads(events))) return { ok: false, reason: "stale-status-parents" };
  const stored = readSharedStatusEvent({ ...event, id: key, parents, prior: resolveStatus(view, event.target, events) });
  if (!stored) return { ok: false, reason: "invalid-status-event" };
  const writes: SharedPreparedWrite[] = [{ path: ["statusEvents", key], kind: "set", value: stored }];
  return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
}
