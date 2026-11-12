import { preferencesStarted, startPreferences } from "../bootstrap/wiring/preferences-owner.ts";
import { locationStarted, startLocation } from "../bootstrap/wiring/location-owner.ts";
import { standaloneSession, sessionStarted } from "../bootstrap/wiring/session-owner.ts";
import { appSessionDeps } from "./_app-session.mjs";
import { startTestSession } from "./_session.mjs";
import { savesStarted, startSaves } from "../bootstrap/wiring/save-owners.ts";

function asGiven(doc) {
  return doc;
}

function startSession() {
  if (!preferencesStarted()) startPreferences();
  if (!locationStarted()) startLocation();
  startTestSession(Object.assign(appSessionDeps(), { entry: asGiven }));
}

export function loadTestDocument(doc) {
  if (!sessionStarted()) startSession();
  if (!savesStarted()) {
    startSaves({
      destination: () => null,
      keyOf: () => ({ owner: null, name: "document-only test" }),
      obsolete: () => {},
      ownership: {
        capture: () => { throw new Error("A document-only test must provide save ownership before writing"); },
        stillOwns: () => false
      },
      autosave: { enabledAtStart: () => false, changed: () => {} }
    }, {
      start: () => { throw new Error("A document-only test must provide timers before scheduling autosave"); },
      stop: () => {}
    });
  }
  standaloneSession().adopt(doc);
  return doc;
}
