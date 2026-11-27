import { createPresenceState } from "../../../application/collaboration/presence.ts";

let state: ReturnType<typeof createPresenceState> | undefined;

export function sharedPresence() {
  return state ??= createPresenceState();
}
