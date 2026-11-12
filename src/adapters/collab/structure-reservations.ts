import * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, assertSharedDocumentIdle } from "./state.ts";
import { cleanId } from "../../core/document/text-policy.ts";
import { readProjectionInlineValue } from "./projection-reader.ts";
import type { SharedStructureIdentityReservations } from "./structure-identity.ts";
import { readSharedIdentityEmbeds } from "./identity-structs.ts";

let reservations: WeakMap<SharedDocumentHandle, SharedStructureIdentityReservations> | null = null;

export function observeSharedStructureIdentities(handle: SharedDocumentHandle, inspect?: () => void): SharedStructureIdentityReservations {
  const state = collabState(handle); assertSharedDocumentIdle(state);
  reservations ??= new WeakMap();
  const previous = reservations.get(handle); if (previous) return previous;
  const counts = new Map<string, number>(), detach: (() => void)[] = [];
  const transactions = new WeakMap<Y.Transaction, readonly { text: Y.Text; identity: string; delta: 1 | -1 }[]>();
  const count = (raw: unknown, delta: number) => {
    if (typeof raw !== "string") return;
    const identity = cleanId(raw), next = (counts.get(identity) ?? 0) + delta;
    if (next > 0) counts.set(identity, next); else counts.delete(identity);
  };
  for (const name of ["segments", "beats", "headings", "visuals", "gallery", "comments", "replies", "people", "tags", "shots"] as const) {
    const root = state.roots[name], held = new Map<string, { identities: readonly unknown[]; text: Y.Text | null; atoms: Map<string, number> }>();
    const atom = (raw: unknown) => { const value = readProjectionInlineValue(raw); return value && typeof value !== "string" && value.atom === "broll" ? cleanId(value.id) : null; };
    const changes = (transaction: Y.Transaction) => {
      let known = transactions.get(transaction); if (known) return known;
      const result: { text: Y.Text; identity: string; delta: 1 | -1 }[] = [];
      for (const change of readSharedIdentityEmbeds(transaction, inspect)) {
        const identity = atom(change.value); if (identity !== null) result.push({ text: change.text, identity, delta: change.delta });
      }
      known = result; transactions.set(transaction, known); return known;
    };
    const update = (key: string) => {
      const previous = held.get(key);
      for (const identity of previous?.identities ?? []) count(identity, -1);
      for (const [identity, amount] of previous?.atoms ?? []) count(identity, -amount);
      held.delete(key);
      if (!root.has(key)) return;
      const value = root.get(key), identities = [key, value instanceof Y.Map ? value.get("id") : undefined];
      const text: unknown = value instanceof Y.Map ? value.get("text") : null, atoms = new Map<string, number>();
      if (text instanceof Y.Text) for (const delta of text.toDelta() as { insert: unknown }[]) {
        const identity = atom(delta.insert); if (identity !== null) atoms.set(identity, (atoms.get(identity) ?? 0) + 1);
      }
      held.set(key, { identities, text: text instanceof Y.Text ? text : null, atoms });
      for (const identity of identities) count(identity, 1); for (const [identity, amount] of atoms) count(identity, amount);
    };
    for (const key of root.keys()) update(key);
    const observe: Parameters<typeof root.observeDeep>[0] = (events, transaction) => {
      const changed = new Set<string>(), texts = new Map<Y.Text, string>();
      for (const event of events) {
        if (!event.path.length && event instanceof Y.YMapEvent) for (const key of event.keysChanged) { if (typeof key === "string") changed.add(key); }
        else if (event.path.length === 1 && event instanceof Y.YMapEvent && (event.keysChanged.has("id") || event.keysChanged.has("text"))) changed.add(String(event.path[0]));
        else if (event.path.length === 2 && event.path[1] === "text" && event.target instanceof Y.Text) {
          texts.set(event.target, String(event.path[0]));
        }
      }
      for (const key of changed) update(key);
      if (texts.size) for (const change of changes(transaction)) {
        const key = texts.get(change.text); if (key === undefined || changed.has(key)) continue;
        const entry = held.get(key); if (entry?.text !== change.text) continue;
        const next = (entry.atoms.get(change.identity) ?? 0) + change.delta;
        if (next > 0) entry.atoms.set(change.identity, next); else entry.atoms.delete(change.identity);
        count(change.identity, change.delta);
      }
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
