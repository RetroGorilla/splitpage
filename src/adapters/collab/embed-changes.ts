import type * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import { readSharedIdentityEmbeds } from "./identity-structs.ts";
import { collabState, guardSharedCallback } from "./state.ts";

export interface SharedEmbedChangeReader { readonly read: (transaction: Y.Transaction) => ReturnType<typeof readSharedIdentityEmbeds> }
let readers: WeakMap<SharedDocumentHandle, { reader: SharedEmbedChangeReader; inspect: Set<() => void> }> | null = null;

export function sharedEmbedChangeReader(handle: SharedDocumentHandle, inspect?: () => void): SharedEmbedChangeReader {
  readers ??= new WeakMap(); let held = readers.get(handle);
  if (!held) {
    const observers = new Set<() => void>(), values = new WeakMap<Y.Transaction, ReturnType<typeof readSharedIdentityEmbeds>>();
    const state = collabState(handle), inspect = () => { for (const observer of observers) guardSharedCallback(state, observer); };
    const reader = Object.freeze({ read: (transaction: Y.Transaction) => {
      const previous = values.get(transaction); if (previous) return previous;
      // why: Both indexes consume the same pre-GC observation, so each changed struct needs only one visit.
      const value = readSharedIdentityEmbeds(transaction, inspect); values.set(transaction, value); return value;
    } });
    held = { reader, inspect: observers }; readers.set(handle, held);
  }
  if (inspect) held.inspect.add(inspect); return held.reader;
}
