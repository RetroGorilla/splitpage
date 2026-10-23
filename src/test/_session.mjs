import { wireProductionIndex } from "../bootstrap/wiring/production-index.ts";
import { migrateRows } from "../js/02-state.js";
import { sessionStarted, startSessionBridge } from "../legacy/session-bridge.ts";
import { legacySessionPorts } from "../bootstrap/wiring.ts";
import { startPageEffects } from "../bootstrap/effects.ts";
import { effectsStarted } from "../legacy/effects-bridge.ts";

export function startTestSession(deps) {
  if (sessionStarted()) throw new Error("startTestSession: a session is already started, so the dependencies passed would be ignored");
  if (!effectsStarted()) startPageEffects(window);
  const stopIndex = wireProductionIndex();
  try {
    const stopSession = startSessionBridge(legacySessionPorts(Object.assign({ entry: migrateRows }, deps)));
    return () => {
      try { stopSession(); } finally { stopIndex(); }
    };
  } catch (error) {
    stopIndex();
    throw error;
  }
}

function missing(port) {
  return function () { throw new Error("The session's " + port + " port was not provided"); };
}

export function unwiredSessionDeps() {
  const given = {
    dirty: missing("dirty"),
    draft: missing("draft"),
    save: missing("save"),
    edit: missing("edit capability"),
    editorName: missing("editor name"),
    attribute: missing("attribution"),
    refresh: missing("refresh"),
    records: () => null
  };
  return {
    given,
    deps: {
      effects: given,
      editorName: () => given.editorName(),
      refresh: (jobs) => given.refresh(jobs),
      records: (doc, changes) => given.records(doc, changes)
    }
  };
}
