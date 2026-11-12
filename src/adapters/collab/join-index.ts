import * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, assertSharedDocumentIdle, guardSharedCallback } from "./state.ts";

export interface SharedJoinIndex { readonly locations: (join: string) => readonly string[] }
let indexes: WeakMap<SharedDocumentHandle, SharedJoinIndex> | null = null;

export function observeSharedJoinIndex(handle: SharedDocumentHandle): SharedJoinIndex {
  const state = collabState(handle); assertSharedDocumentIdle(state); indexes ??= new WeakMap();
  const existing = indexes.get(handle); if (existing) return existing;
  const beats = state.roots.beats, members = new Map<string, Set<string>>(), held = new Map<string, Set<string>>();
  const patch = (beat: string, join: string, present: boolean) => {
    let own = held.get(beat); if (!own) { own = new Set(); held.set(beat, own); }
    let owners = members.get(join); if (!owners) { owners = new Set(); members.set(join, owners); }
    if (present) { own.add(join); owners.add(beat); }
    else { own.delete(join); owners.delete(beat); if (!owners.size) members.delete(join); }
  };
  const store = (beat: string) => { const record = beats.get(beat); return record instanceof Y.Map ? record.get("joins") : null; };
  const refresh = (beat: string) => {
    for (const join of [...held.get(beat) ?? []]) patch(beat, join, false);
    const joins = store(beat); if (joins instanceof Y.Map) for (const join of joins.keys()) patch(beat, join, true);
  };
  for (const beat of beats.keys()) refresh(beat);
  const receive: Parameters<typeof beats.observeDeep>[0] = events => guardSharedCallback(state, () => {
    const refreshed = new Set<string>();
    for (const event of events) {
      if (!event.path.length && event instanceof Y.YMapEvent) for (const beat of event.keysChanged) refreshed.add(String(beat));
      else if (event.path.length === 1 && event instanceof Y.YMapEvent && event.keysChanged.has("joins")) refreshed.add(String(event.path[0]));
    }
    for (const beat of refreshed) refresh(beat);
    for (const event of events) if (event.path.length === 2 && event.path[1] === "joins" && event instanceof Y.YMapEvent && !refreshed.has(String(event.path[0]))) {
      for (const join of event.keysChanged) patch(String(event.path[0]), String(join), event.target.has(join));
    }
  });
  beats.observeDeep(receive);
  state.doc.once("destroy", () => guardSharedCallback(state, () => beats.unobserveDeep(receive)));
  const result = Object.freeze({ locations: (join: string) => Object.freeze([...(members.get(join) ?? [])].sort()) });
  indexes.set(handle, result); return result;
}
