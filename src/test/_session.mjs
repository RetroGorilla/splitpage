import { migrateRows } from "../js/02-state.js";
import { sessionStarted, startSessionBridge } from "../legacy/session-bridge.ts";
import { legacySessionPorts } from "../bootstrap/wiring.ts";

export function startTestSession() {
  if (!sessionStarted()) startSessionBridge(legacySessionPorts({ entry: migrateRows }));
}
