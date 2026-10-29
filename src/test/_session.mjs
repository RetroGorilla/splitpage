import "./_session-merge-started.mjs";
import { documentGuardStarted, startDocumentGuard } from "../application/identity/document-guard.ts";
import "./_production-tags-started.mjs";
import { wireProductionIndex } from "../bootstrap/wiring/production-index.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { stampRow } from "../bootstrap/wiring/session-merge.ts";
import { bulkTagCell } from "../features/tags/production-tags.js";

import { sessionStarted, startSessionBridge } from "../bootstrap/wiring/session-owner.ts";
import { legacySessionPorts } from "../bootstrap/wiring.ts";
import { startPageEffects } from "../bootstrap/effects.ts";
import { effectsStarted } from "../bootstrap/wiring/effects-owner.ts";
import { undoPorts, startUndo, undoStarted } from "../bootstrap/wiring/undo.ts";

export function startTestSession(deps) {
  if (sessionStarted()) throw new Error("startTestSession: a session is already started, so the dependencies passed would be ignored");
  if (!effectsStarted()) startPageEffects(window);
  if (!undoStarted()) startUndo(undoPorts());
  const stopGuard = documentGuardStarted() ? () => {} : startDocumentGuard(false, console.error);
  const stopIndex = wireProductionIndex({ cell: bulkTagCell, stamp: stampRow });
  try {
    const stopSession = startSessionBridge(legacySessionPorts(Object.assign({ entry: migrateRows }, deps)));
    return () => {
      try { stopSession(); } finally { stopIndex(); stopGuard(); }
    };
  } catch (error) {
    stopIndex();
    stopGuard();
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
