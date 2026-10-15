import { migrateRows } from "../js/02-state.js";
import { sessionStarted, startSessionBridge } from "../legacy/session-bridge.ts";
import { legacySessionPorts } from "../bootstrap/wiring.ts";

export function startTestSession(deps) {
  if (sessionStarted()) return null;
  return startSessionBridge(legacySessionPorts(Object.assign({ entry: migrateRows }, deps)));
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
