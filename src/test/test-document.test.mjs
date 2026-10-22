import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const bridge = await import("../legacy/session-bridge.ts");
const homeMod = await import("../js/_home.js");
const { baseStateReason } = await import("../js/03-sync.js");
const { documentIdentityPort, liveDocumentPort } = await import("../js/02b-doc-id.js");
const { loadDocumentWithoutSession, loadTestDocument } = await import("./_document.mjs");

function raw(title) {
  return { title: title, rows: [{ id: "r1", visualText: "B-roll: gulls", audioText: "<b>x</b>" }], brollShots: [] };
}

test("a document loaded without a session is the live document, and no session starts", () => {
  const doc = raw("Alone");
  assert.equal(loadDocumentWithoutSession(doc), doc);
  assert.equal(liveDocumentPort.current(), doc);
  assert.equal(bridge.sessionStarted(), false);
});

test("the first test document starts a session on the app's effects, and the session holds the document as given", () => {
  assert.equal(bridge.sessionStarted(), false);
  const doc = raw("First");
  const before = JSON.stringify(doc);
  assert.equal(loadTestDocument(doc), doc);
  assert.equal(bridge.sessionStarted(), true);
  assert.equal(liveDocumentPort.current(), doc);
  assert.equal(bridge.readSession((held) => held), doc);
  assert.equal(JSON.stringify(doc), before);
  assert.equal(bridge.editAllowed(), true);
});

test("the session adopts each later document when it is next read, in a new epoch", () => {
  const epoch = bridge.liveSession().epoch();
  const next = raw("Second");
  loadTestDocument(next);
  assert.equal(liveDocumentPort.current(), next);
  assert.equal(bridge.readSession((held) => held), next);
  assert.equal(bridge.liveSession().epoch(), epoch + 1);
  assert.equal(bridge.liveSession().generation(), 0);
});

test("no document leaves the session holding none", () => {
  loadTestDocument(null);
  assert.equal(liveDocumentPort.current(), null);
  assert.equal(bridge.readSession((held) => held), null);
});

test("loading a test document sets no destination, baseline or identity", () => {
  const home = homeMod.home;
  const reason = baseStateReason();
  const writtenOut = documentIdentityPort.writtenOut();
  loadTestDocument(raw("Third"));
  assert.equal(homeMod.home, home);
  assert.equal(baseStateReason(), reason);
  assert.equal(documentIdentityPort.writtenOut(), writtenOut);
});

test("once a session is running, loading a document without one throws", () => {
  assert.throws(() => loadDocumentWithoutSession(raw("Late")), /a session is running/);
});
