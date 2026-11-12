import * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, assertSharedDocumentIdle, guardSharedCallback } from "./state.ts";
import { isStableSharedIdentity } from "./identity.ts";

export interface SharedAttachmentOwnership {
  readonly keys: (collection: "visuals" | "gallery", beat: string) => readonly string[];
}

let indexes: WeakMap<SharedDocumentHandle, SharedAttachmentOwnership> | null = null;

export function observeSharedAttachmentOwnership(handle: SharedDocumentHandle): SharedAttachmentOwnership {
  indexes ??= new WeakMap(); const existing = indexes.get(handle); if (existing) return existing;
  const state = collabState(handle); assertSharedDocumentIdle(state);
  const groups = { visuals: new Map<string, Set<string>>(), gallery: new Map<string, Set<string>>() }, stops: (() => void)[] = [];
  for (const collection of ["visuals", "gallery"] as const) {
    const root = state.roots[collection], owners = new Map<string, string>(), byBeat = groups[collection];
    const update = (key: string) => {
      const previous = owners.get(key); if (previous) { const keys = byBeat.get(previous); keys?.delete(key); if (!keys?.size) byBeat.delete(previous); }
      owners.delete(key);
      const raw = root.get(key), owner: unknown = raw instanceof Y.Map ? raw.get("beat") : null;
      if (!key || !isStableSharedIdentity(key) || typeof owner !== "string" || !owner || !isStableSharedIdentity(owner)) return;
      let keys = byBeat.get(owner); if (!keys) { keys = new Set(); byBeat.set(owner, keys); }
      keys.add(key); owners.set(key, owner);
    };
    for (const key of root.keys()) update(key);
    const listener: Parameters<typeof root.observeDeep>[0] = events => guardSharedCallback(state, () => {
      const changed = new Set<string>();
      for (const event of events) {
        if (!event.path.length && event instanceof Y.YMapEvent) for (const key of event.keysChanged) { if (typeof key === "string") changed.add(key); }
        else if (event.path.length === 1 && event instanceof Y.YMapEvent && event.keysChanged.has("beat")) changed.add(String(event.path[0]));
      }
      for (const key of changed) update(key);
    });
    root.observeDeep(listener); stops.push(() => root.unobserveDeep(listener));
  }
  state.doc.once("destroy", () => guardSharedCallback(state, () => { for (const stop of stops) stop(); }));
  const index: SharedAttachmentOwnership = Object.freeze({ keys: (collection: "visuals" | "gallery", beat: string) => Object.freeze([...(groups[collection].get(beat) ?? [])].sort()) });
  indexes.set(handle, index); return index;
}
