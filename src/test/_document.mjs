import { liveDocumentPort } from "../js/02b-doc-id.js";
import { preferencesStarted, startPreferences } from "../legacy/preferences-bridge.ts";
import { sessionStarted } from "../legacy/session-bridge.ts";
import { appSessionDeps } from "./_app-session.mjs";
import { startTestSession } from "./_session.mjs";

function asGiven(doc) {
  return doc;
}

function startSession() {
  if (!preferencesStarted()) startPreferences();
  startTestSession(Object.assign(appSessionDeps(), { entry: asGiven }));
}

export function loadTestDocument(doc) {
  if (!sessionStarted()) startSession();
  liveDocumentPort.assign(doc);
  return doc;
}

export function loadDocumentWithoutSession(doc) {
  if (sessionStarted()) throw new Error("loadDocumentWithoutSession: a session is running, so use loadTestDocument");
  liveDocumentPort.assign(doc);
  return doc;
}
