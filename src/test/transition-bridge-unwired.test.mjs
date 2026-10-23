import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import "./_location-started.mjs";

const bridge = await import("../legacy/transition-bridge.ts");
const { currentDocument, liveDocumentPort, liveSession, requestRefresh } = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { startTestSession, unwiredSessionDeps } = await import("./_session.mjs");

const unwired = unwiredSessionDeps();
startTestSession(unwired.deps);

function script(title) {
  return migrateRows({ title: title, docId: "d" + "1".repeat(32), rows: [{ id: "r1", visualText: "", audioText: "", status: "todo" }] });
}

test("before the transitions are started, every accessor throws instead of running on a default", () => {
  assert.throws(() => bridge.documentTransitions(), /The document transitions are not started yet/);
  assert.throws(() => bridge.captureOperation(), /not started yet/);
  assert.throws(() => bridge.stillOwns({}), /not started yet/);
});

function startWith(log) {
  return bridge.startTransitions({
    live: { current: liveDocumentPort.current, assign: (doc) => { log.push("assign"); liveDocumentPort.assign(doc); }, stamp: liveDocumentPort.stamp },
    destination: { set: (d) => log.push("destination:" + d.kind), confirm: (doc, why) => log.push("baseline:" + why) },
    identity: { mint: () => "d" + "9".repeat(32), writtenOut: () => false, markWrittenOut: (out) => log.push("writtenOut:" + out) }
  });
}

test("started once, with the ports it is handed; a second start throws until the first is stopped", () => {
  const log = [];
  const stop = startWith(log);
  try {
    assert.throws(() => startWith([]), /already started/);
    const next = script("New");
    const arrived = bridge.documentTransitions().startNew({ from: { document: next }, reason: "a new script", destination: bridge.NO_DESTINATION });
    assert.equal(arrived.document, next);
    assert.deepEqual(log, ["assign", "destination:none", "baseline:a new script", "writtenOut:false"]);
    assert.equal(liveSession().read((doc) => doc), next, "the session holds the new document as the transition returns");
  } finally {
    stop();
  }
  assert.throws(() => bridge.documentTransitions(), /not started yet/);
});

test("a replacement through the API disposes the old document's session: its armed refresh never runs and its subscriptions hear nothing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const ran = [];
  unwired.given.refresh = (jobs) => ran.push(...jobs);
  Object.assign(unwired.given, { dirty: () => {}, draft: () => {}, save: () => {} });
  const stop = startWith([]);
  try {
    bridge.documentTransitions().open({ from: { document: script("Old") }, reason: "opened" });
    const heard = [];
    liveSession().subscribe((change) => heard.push(change.kind));
    requestRefresh("old-document");
    const epoch = liveSession().epoch();
    bridge.documentTransitions().startNew({ from: { document: script("New") }, reason: "a new script" });
    assert.equal(liveSession().epoch(), epoch + 1);
    t.mock.timers.tick(5000);
    assert.deepEqual(ran, [], "the old document's refresh did not run");
    liveSession().noteEdit();
    assert.deepEqual(heard, [], "the old document's subscription heard nothing of the new one");
  } finally {
    stop();
  }
});

test("captureOperation and stillOwns follow the live session, document, destination and connection", async () => {
  const stop = startWith([]);
  const loc = await import("../legacy/location-bridge.ts");
  const saves = await import("../legacy/save-bridge.ts");
  const stopSaves = saves.startSaves({
      destination: () => loc.currentHome(),
    keyOf: (h) => ({ owner: h, name: "" }),
    obsolete: () => {},
    ownership: { capture: bridge.captureOperation, stillOwns: bridge.stillOwns },
    autosave: { enabledAtStart: () => false, changed: () => {} }
  }, { start: (run, ms) => setTimeout(run, ms), stop: (handle) => clearTimeout(handle) });
  try {
    bridge.documentTransitions().open({ from: { document: script("Owned") }, reason: "opened" });
    saves.noteSaveChange();
    saves.confirmSavedNow();
    const ctx = bridge.captureOperation();
    assert.equal(ctx.docId, currentDocument().docId);
    assert.equal(ctx.destination, loc.currentHome());
    assert.equal(ctx.destinationGeneration, saves.confirmedGeneration(), "the destination's confirmed generation is captured");
    assert.equal(ctx.connection, loc.currentConn());
    assert.equal(bridge.stillOwns(ctx), true);
    loc.documentLocation().updateConnection({ token: "another" });
    assert.equal(bridge.stillOwns(ctx), false, "a token change is another connection");
    const again = bridge.captureOperation();
    bridge.documentTransitions().open({ from: { document: script("Owned") }, reason: "reopened" });
    assert.equal(bridge.stillOwns(again), false, "a same-id reopen is another epoch");
    loc.documentLocation().updateConnection({ token: "" });
  } finally {
    stopSaves();
    stop();
  }
});
