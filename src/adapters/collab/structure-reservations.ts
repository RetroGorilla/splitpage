import * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, assertSharedDocumentIdle } from "./state.ts";
import { cleanId } from "../../core/document/text-policy.ts";
import { readProjectionInlineValue } from "./projection-reader.ts";
import type { SharedStructureIdentityReservations } from "./structure-identity.ts";

let reservations: WeakMap<SharedDocumentHandle, SharedStructureIdentityReservations> | null = null;

export function observeSharedStructureIdentities(handle: SharedDocumentHandle): SharedStructureIdentityReservations {
  const state = collabState(handle); assertSharedDocumentIdle(state);
  reservations ??= new WeakMap();
  const previous = reservations.get(handle); if (previous) return previous;
  const counts = new Map<string, number>(), detach: (() => void)[] = [];
  const count = (raw: unknown, delta: number) => {
    if (typeof raw !== "string") return;
    const identity = cleanId(raw), next = (counts.get(identity) ?? 0) + delta;
    if (next > 0) counts.set(identity, next); else counts.delete(identity);
  };
  for (const name of ["segments", "beats", "headings", "visuals", "gallery", "comments", "replies", "people", "tags", "shots"] as const) {
    const root = state.roots[name], held = new Map<string, readonly unknown[]>();
    const update = (key: string) => {
      for (const identity of held.get(key) ?? []) count(identity, -1);
      held.delete(key);
      if (!root.has(key)) return;
      const value = root.get(key), identities = [key, value instanceof Y.Map ? value.get("id") : undefined];
      const text: unknown = value instanceof Y.Map ? value.get("text") : null;
      if (text instanceof Y.Text) for (const delta of text.toDelta() as { insert: unknown }[]) {
        const atom = readProjectionInlineValue(delta.insert);
        if (atom && typeof atom !== "string" && atom.atom === "broll") identities.push(atom.id);
      }
      held.set(key, identities); for (const identity of identities) count(identity, 1);
    };
    for (const key of root.keys()) update(key);
    const observe: Parameters<typeof root.observeDeep>[0] = events => {
      const changed = new Set<string>();
      for (const event of events) {
        if (!event.path.length && event instanceof Y.YMapEvent) for (const key of event.keysChanged) { if (typeof key === "string") changed.add(key); }
        else if (event.path.length === 1 && event instanceof Y.YMapEvent && (event.keysChanged.has("id") || event.keysChanged.has("text"))) changed.add(String(event.path[0]));
        else if (event.path.length === 2 && event.path[1] === "text" && event.target instanceof Y.Text) {
          // why: Reading a text event's delta opens another transaction during observer delivery.
          for (let item = event.target._start; item; item = item.right) {
            if (item.content instanceof Y.ContentEmbed && (event.adds(item) || event.deletes(item))) { changed.add(String(event.path[0])); break; }
          }
        }
      }
      for (const key of changed) update(key);
    };
    root.observeDeep(observe); detach.push(() => root.unobserveDeep(observe));
  }
  const order = state.roots.order, values = order.toArray(); for (const value of values) count(value, 1);
  const observeOrder: Parameters<typeof order.observe>[0] = event => {
    let offset = 0;
    for (const change of event.delta) {
      if (change.retain) offset += change.retain;
      if (change.delete) for (const value of values.splice(offset, change.delete)) count(value, -1);
      if (change.insert) {
        const inserted = change.insert as string[];
        for (const value of inserted) count(value, 1);
        for (let at = 0; at < inserted.length; at += 1024) values.splice(offset + at, 0, ...inserted.slice(at, at + 1024));
        offset += inserted.length;
      }
    }
  };
  order.observe(observeOrder); detach.push(() => order.unobserve(observeOrder));
  state.doc.once("destroy", () => { for (const stop of detach) stop(); });
  const view = Object.freeze({ has: (identity: string) => counts.has(cleanId(identity)) });
  reservations.set(handle, view); return view;
}
