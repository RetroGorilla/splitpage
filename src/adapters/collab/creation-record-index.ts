import * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, guardSharedCallback } from "./state.ts";

interface CreationRecordOwners { readonly groups: Map<string, Set<string>>; readonly owners: Map<string, string>; readonly pending: Set<string> }
type CreationOwnedCollection = "beats" | "headings" | "visuals" | "gallery" | "comments" | "replies";

function indexOf(handle: SharedDocumentHandle, collection: CreationOwnedCollection, field: string): CreationRecordOwners | null {
  const state = collabState(handle), { roots, reads } = state, root = roots[collection], consumer = "creation-owner:" + field;
  const belongs = (key: string): string | null => { const record = root.get(key), value: unknown = record instanceof Y.Map ? record.get(field) : null; return typeof value === "string" ? value : null; };
  // why: writes in the same undo are already visible in the store; its indexes refresh only after the transaction.
  if (!reads.settled || state.transactionDepth > 0) return null;
  const index = reads.keep<CreationRecordOwners>(root, consumer, () => {
    const made: CreationRecordOwners = { groups: new Map(), owners: new Map(), pending: new Set(root.keys()) };
    const changed: Parameters<typeof root.observeDeep>[0] = events => guardSharedCallback(state, () => {
      for (const event of events) if (event instanceof Y.YMapEvent) {
        if (!event.path.length) for (const key of event.keysChanged) made.pending.add(String(key));
        else if (event.path.length === 1 && event.keysChanged.has(field)) made.pending.add(String(event.path[0]));
      }
    });
    root.observeDeep(changed);
    state.doc.once("destroy", () => guardSharedCallback(state, () => { root.unobserveDeep(changed); }));
    return made;
  });
  const pending = [...index.pending]; index.pending.clear();
  for (const key of pending) {
    const previous = index.owners.get(key), group = previous === undefined ? null : index.groups.get(previous);
    group?.delete(key); if (previous !== undefined && !group?.size) index.groups.delete(previous);
    index.owners.delete(key);
    const next = belongs(key); if (next === null) continue;
    const keys = index.groups.get(next) ?? new Set<string>(); keys.add(key); index.groups.set(next, keys); index.owners.set(key, next);
  }
  return index;
}

export function sharedCreationRecordKeys(handle: SharedDocumentHandle, collection: CreationOwnedCollection, field: string, owner: string): readonly string[] {
  const index = indexOf(handle, collection, field);
  return index ? [...index.groups.get(owner) ?? []].sort() : [...collabState(handle).roots[collection].keys()]
    .filter(key => sharedCreationRecordOwner(handle, collection, field, key) === owner).sort();
}

export function sharedCreationRecordOwner(handle: SharedDocumentHandle, collection: CreationOwnedCollection, field: string, key: string): string | null {
  const index = indexOf(handle, collection, field); if (index) return index.owners.get(key) ?? null;
  const record = collabState(handle).roots[collection].get(key), value: unknown = record instanceof Y.Map ? record.get(field) : null;
  return typeof value === "string" ? value : null;
}
