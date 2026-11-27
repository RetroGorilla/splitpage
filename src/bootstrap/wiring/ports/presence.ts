import { createPresenceState } from "../../../application/collaboration/presence.ts";

let state: ReturnType<typeof createPresenceState> | undefined;
const beatRemovals = new Set<(ids: readonly string[]) => void>();

export function sharedPresence() {
  return state ??= createPresenceState();
}

export function onBeatsRemoving(listener: (ids: readonly string[]) => void): () => void {
  beatRemovals.add(listener);
  return () => { beatRemovals.delete(listener); };
}

export function beforeBeatsRemoved(ids: readonly string[]): void {
  for (const listener of beatRemovals) listener(ids);
}
