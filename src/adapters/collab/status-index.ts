import type { SharedStatusEvent } from "../../core/collab/operations.ts";
import { readSharedStatusEvent } from "../../core/collab/read-operation.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { sharedPreparedValue } from "./prepare-value.ts";
import { countSharedRead } from "./read-counts.ts";

interface StatusIndex { readonly byTarget: Map<string, Set<string>>; readonly targetOf: Map<string, string>; readonly versions: Map<string, number> }

export function sharedStatusTargetKey(target: SharedStatusEvent["target"]): string { return JSON.stringify([target.scope, target.record]); }

function refreshed(handle: SharedDocumentHandle): StatusIndex | null {
  const state = collabState(handle), root = state.roots.statusEvents, caches = state.reads;
  if (!caches.settled) return null;
  const index = caches.keep<StatusIndex>(root, "status-index", () => ({ byTarget: new Map(), targetOf: new Map(), versions: new Map() }));
  // why: only the keys a transaction changed are read again, so one status change costs one event, not every event.
  for (const key of caches.drain(root, "status-index") ?? root.keys()) {
    const previous = index.targetOf.get(key);
    if (previous !== undefined) {
      index.versions.set(previous, (index.versions.get(previous) ?? 0) + 1);
      const keys = index.byTarget.get(previous);
      keys?.delete(key);
      if (!keys?.size) index.byTarget.delete(previous);
      index.targetOf.delete(key);
    }
    if (!root.has(key)) continue;
    countSharedRead("statusEvents");
    const event = readSharedStatusEvent(sharedPreparedValue(root.get(key)));
    if (!event) continue;
    const owner = sharedStatusTargetKey(event.target), keys = index.byTarget.get(owner) ?? new Set<string>();
    index.versions.set(owner, (index.versions.get(owner) ?? 0) + 1);
    keys.add(key); index.byTarget.set(owner, keys); index.targetOf.set(key, owner);
  }
  return index;
}

export function sharedStatusTargetVersion(handle: SharedDocumentHandle, target: SharedStatusEvent["target"]): number | null {
  const index = refreshed(handle); if (!index) return null;
  const state = collabState(handle), root = state.roots.retiredStatus;
  for (const key of state.reads.drain(root, "status-projection") ?? root.keys()) {
    const owner = index.targetOf.get(key);
    if (owner !== undefined) index.versions.set(owner, (index.versions.get(owner) ?? 0) + 1);
  }
  return index.versions.get(sharedStatusTargetKey(target)) ?? 0;
}

export function sharedStatusEventKeys(handle: SharedDocumentHandle, target: SharedStatusEvent["target"]): readonly string[] | null {
  const index = refreshed(handle);
  return index ? [...index.byTarget.get(sharedStatusTargetKey(target)) ?? []] : null;
}
