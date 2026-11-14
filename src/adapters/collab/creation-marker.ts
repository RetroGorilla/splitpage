import * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, assertSharedDocumentIdle, guardSharedCallback } from "./state.ts";

export const SHARED_CREATION_RETIREMENT_FIELD = "creationRetired";
let indexes: WeakMap<SharedDocumentHandle, ReadonlySet<string>> | null = null;

function marked(raw: unknown): boolean { return raw instanceof Y.Map && raw._map.get(SHARED_CREATION_RETIREMENT_FIELD)?.deleted === false; }

export function observeSharedCreationMarkers(handle: SharedDocumentHandle): ReadonlySet<string> {
  indexes ??= new WeakMap(); const previous = indexes.get(handle); if (previous) return previous;
  const state = collabState(handle); assertSharedDocumentIdle(state);
  const root = state.roots.beats, keys = new Set<string>();
  // why: marker presence follows changed items, so ordinary typing never rereads unrelated beat records.
  const refresh = (key: string) => {
    const item = root._map.get(key), record: unknown = item && !item.deleted ? item.content.getContent()[0] : null;
    if (marked(record)) keys.add(key); else keys.delete(key);
  };
  for (const key of root._map.keys()) refresh(key);
  const changed: Parameters<typeof root.observeDeep>[0] = events => guardSharedCallback(state, () => {
    for (const event of events) if (event instanceof Y.YMapEvent) {
      if (!event.path.length) for (const key of event.keysChanged) refresh(key);
      else if (event.path.length === 1 && event.keysChanged.has(SHARED_CREATION_RETIREMENT_FIELD)) refresh(String(event.path[0]));
    }
  });
  root.observeDeep(changed);
  state.doc.once("destroy", () => guardSharedCallback(state, () => { root.unobserveDeep(changed); indexes?.delete(handle); }));
  indexes.set(handle, keys); return keys;
}
