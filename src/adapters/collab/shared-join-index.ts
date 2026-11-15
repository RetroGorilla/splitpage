import type * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedJoinIndex } from "./join-index.ts";
import { createSharedJoinIndex } from "./join-index.ts";
import { collabState, assertSharedDocumentIdle, guardSharedCallback } from "./state.ts";

let indexes: WeakMap<SharedDocumentHandle, ReturnType<typeof createSharedJoinIndex>> | null = null;

export function observeSharedJoinIndex(handle: SharedDocumentHandle): SharedJoinIndex {
  indexes ??= new WeakMap(); const previous = indexes.get(handle); if (previous) return previous.index;
  const state = collabState(handle); assertSharedDocumentIdle(state);
  const made = createSharedJoinIndex(state.roots.beats);
  const changed: Parameters<Y.Map<unknown>["observeDeep"]>[0] = events => guardSharedCallback(state, () => { made.changed(events); });
  state.roots.beats.observeDeep(changed);
  state.doc.once("destroy", () => guardSharedCallback(state, () => { state.roots.beats.unobserveDeep(changed); indexes?.delete(handle); }));
  indexes.set(handle, made); return made.index;
}
