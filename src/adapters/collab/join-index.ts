import * as Y from "yjs";
import { readSharedJoinEntry } from "./join-record.ts";
import { isStableSharedIdentity } from "./identity.ts";

export interface SharedJoinIndex {
  readonly locations: (join: string) => readonly string[];
  readonly neighbors: (beat: string) => readonly string[];
  readonly entries: (beat: string) => readonly { readonly id: string; readonly into: string; readonly glue: "" | " "; readonly generation: number }[];
}
export function createSharedJoinIndex(beats: Y.Map<unknown>) {
  const members = new Map<string, Set<string>>(), held = new Map<string, Set<string>>();
  const outgoing = new Map<string, Map<string, string>>(), incoming = new Map<string, Map<string, number>>();
  const entries = new Map<string, Map<string, { readonly id: string; readonly into: string; readonly glue: "" | " "; readonly generation: number }>>();
  const patch = (beat: string, join: string, present: boolean, raw?: unknown) => {
    const edges = outgoing.get(beat), previous = edges?.get(join);
    entries.get(beat)?.delete(join);
    if (previous !== undefined) {
      edges?.delete(join); if (!edges?.size) outgoing.delete(beat);
      const owners = incoming.get(previous), count = (owners?.get(beat) ?? 0) - 1;
      if (count) owners?.set(beat, count); else owners?.delete(beat);
      if (!owners?.size) incoming.delete(previous);
    }
    let own = held.get(beat); if (!own) { own = new Set(); held.set(beat, own); }
    let owners = members.get(join); if (!owners) { owners = new Set(); members.set(join, owners); }
    if (present) { own.add(join); owners.add(beat); }
    else { own.delete(join); owners.delete(beat); if (!owners.size) members.delete(join); }
    const entry = present && beat && join && [beat, join].every(isStableSharedIdentity) ? readSharedJoinEntry(raw) : null;
    if (entry) {
      let values = entries.get(beat); if (!values) { values = new Map(); entries.set(beat, values); }
      values.set(join, Object.freeze({ id: join, into: entry.into, glue: entry.glue, generation: entry.generation }));
      let edges = outgoing.get(beat); if (!edges) { edges = new Map(); outgoing.set(beat, edges); }
      let sources = incoming.get(entry.into); if (!sources) { sources = new Map(); incoming.set(entry.into, sources); }
      edges.set(join, entry.into); sources.set(beat, (sources.get(beat) ?? 0) + 1);
    }
  };
  const store = (beat: string): unknown => { const record = beats.get(beat); return record instanceof Y.Map ? record.get("joins") : null; };
  const refresh = (beat: string) => {
    for (const join of [...held.get(beat) ?? []]) patch(beat, join, false);
    const joins = store(beat); if (joins instanceof Y.Map) for (const join of joins.keys()) patch(beat, join, true, joins.get(join));
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
      for (const join of event.keysChanged) patch(String(event.path[0]), String(join), event.target.has(String(join)), event.target.get(String(join)));
    }
  };
  const index: SharedJoinIndex = Object.freeze({
    locations: (join: string) => Object.freeze([...(members.get(join) ?? [])].sort()),
    neighbors: (beat: string) => Object.freeze([...new Set([...(outgoing.get(beat)?.values() ?? []), ...(incoming.get(beat)?.keys() ?? [])])].filter(id => id !== beat).sort()),
    entries: (beat: string) => Object.freeze([...(entries.get(beat)?.values() ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  });
  return { index, changed };
}
