import * as Y from "yjs";

export interface SharedJoinIndex { readonly locations: (join: string) => readonly string[] }
export function createSharedJoinIndex(beats: Y.Map<unknown>) {
  const members = new Map<string, Set<string>>(), held = new Map<string, Set<string>>();
  const patch = (beat: string, join: string, present: boolean) => {
    let own = held.get(beat); if (!own) { own = new Set(); held.set(beat, own); }
    let owners = members.get(join); if (!owners) { owners = new Set(); members.set(join, owners); }
    if (present) { own.add(join); owners.add(beat); }
    else { own.delete(join); owners.delete(beat); if (!owners.size) members.delete(join); }
  };
  const store = (beat: string): unknown => { const record = beats.get(beat); return record instanceof Y.Map ? record.get("joins") : null; };
  const refresh = (beat: string) => {
    for (const join of [...held.get(beat) ?? []]) patch(beat, join, false);
    const joins = store(beat); if (joins instanceof Y.Map) for (const join of joins.keys()) patch(beat, join, true);
  };
  for (const beat of beats.keys()) refresh(beat);
  const changed = (events: readonly Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    const refreshed = new Set<string>();
    for (const event of events) {
      if (!event.path.length && event instanceof Y.YMapEvent) for (const beat of event.keysChanged) refreshed.add(String(beat));
      else if (event.path.length === 1 && event instanceof Y.YMapEvent && event.keysChanged.has("joins")) refreshed.add(String(event.path[0]));
    }
    for (const beat of refreshed) refresh(beat);
    for (const event of events) if (event.path.length === 2 && event.path[1] === "joins" && event instanceof Y.YMapEvent && !refreshed.has(String(event.path[0]))) {
      for (const join of event.keysChanged) patch(String(event.path[0]), String(join), event.target.has(String(join)));
    }
  };
  const index: SharedJoinIndex = Object.freeze({ locations: (join: string) => Object.freeze([...(members.get(join) ?? [])].sort()) });
  return { index, changed };
}
