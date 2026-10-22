import { preferencesStarted, startPreferences } from "../legacy/preferences-bridge.ts";
import { locationStarted, startLocation } from "../legacy/location-bridge.ts";
import { liveSession, sessionStarted } from "../legacy/session-bridge.ts";
import { appSessionDeps } from "./_app-session.mjs";
import { startTestSession } from "./_session.mjs";

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
  liveSession().adopt(doc);
  return doc;
}
