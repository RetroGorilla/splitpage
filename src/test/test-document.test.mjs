import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const bridge = await import("../legacy/session-bridge.ts");
const homeMod = await import("../legacy/location-bridge.ts");
const { baseStateReason } = await import("../js/03-sync.js");
const { documentIdentityPort } = await import("../js/02b-doc-id.js");
const { loadTestDocument } = await import("./_document.mjs");
const { liveDocumentPort } = bridge;

function raw(title) {
  return { title: title, rows: [{ id: "r1", visualText: "B-roll: gulls", audioText: "<b>x</b>" }], brollShots: [] };
}

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

test("the session adopts each later document at once, in a new epoch of the same session", () => {
  const heard = [];
  bridge.liveSession().subscribe((change) => heard.push(change.kind));
  const epoch = bridge.liveSession().epoch();
  const next = raw("Second");
  loadTestDocument(next);
  assert.equal(liveDocumentPort.current(), next);
  assert.equal(bridge.readSession((held) => held), next);
  assert.equal(bridge.liveSession().epoch(), epoch + 1);
  assert.equal(bridge.liveSession().generation(), 0);
  assert.deepEqual(heard, ["adopt"], "the session's subscribers hear the adoption");
});

test("no document leaves the session holding none", () => {
  loadTestDocument(null);
  assert.equal(liveDocumentPort.current(), null);
  assert.equal(bridge.readSession((held) => held), null);
});

test("loading a test document sets no destination, baseline or identity", () => {
  const home = homeMod.currentHome();
  const reason = baseStateReason();
  const writtenOut = documentIdentityPort.writtenOut();
  loadTestDocument(raw("Third"));
  assert.equal(homeMod.currentHome(), home);
  assert.equal(baseStateReason(), reason);
  assert.equal(documentIdentityPort.writtenOut(), writtenOut);
});
