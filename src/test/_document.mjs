import { liveDocumentPort } from "../js/02b-doc-id.js";
import { sessionStarted } from "../legacy/session-bridge.ts";
import { appSessionDeps } from "./_app-session.mjs";
import { startTestSession } from "./_session.mjs";

function asGiven(doc) {
  return doc;
}

export function loadTestDocument(doc) {
  if (!sessionStarted()) startTestSession(Object.assign(appSessionDeps(), { entry: asGiven }));
  liveDocumentPort.assign(doc);
  return doc;
}

export function loadDocumentWithoutSession(doc) {
  if (sessionStarted()) throw new Error("loadDocumentWithoutSession: a session is running, so use loadTestDocument");
  liveDocumentPort.assign(doc);
  return doc;
}
