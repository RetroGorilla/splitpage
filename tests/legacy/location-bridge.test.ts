import test from "node:test";
import assert from "node:assert/strict";
import type { EffectPorts, Notice } from "../../src/application/effects/ports.ts";
import { startEffects } from "../../src/legacy/effects-bridge.ts";
import {
  checkServer,
  currentConn,
  currentHome,
  documentLocation,
  handServerCheckTo,
  locationStarted,
  reviewBlocked,
  reviewMode,
  serverStatus,
  setHome,
  startLocation,
  stillOnServer
} from "../../src/legacy/location-bridge.ts";
import { VIEWING_ONLY } from "../../src/application/collaboration/review.ts";

function noticeRecorder(): { shown: unknown[][]; ports: EffectPorts<Element> } {
  const shown: unknown[][] = [];
  const notice: Notice = { isConnected: true, dismiss: () => {}, removeEventListener: () => {} };
  return {
    shown,
    ports: {
      notices: {
        show: (...args) => { shown.push(args); return notice; },
        showAction: () => notice
      },
      menuItems: { setLabel: () => {}, setReason: () => {} },
      clipboard: { copyText: () => Promise.resolve(true) }
    }
  };
}

test("before the location is started, reading or changing it throws, and nothing counts as still on a server", () => {
  assert.equal(locationStarted(), false);
  assert.throws(() => currentHome(), /not started yet/);
  assert.throws(() => currentConn(), /not started yet/);
  assert.throws(() => setHome("none"), /not started yet/);
  assert.throws(() => serverStatus(), /not started yet/);
  assert.throws(() => reviewMode(), /not started yet/);
  assert.equal(stillOnServer({}), false);
});

test("the location outlives a stop and restart, as the document it describes does", () => {
  const stop = startLocation({ storage: () => null });
  assert.throws(() => startLocation({ storage: () => null }), /already started/);
  const connection = documentLocation().setConnection({ serverUrl: "http://a:1/" });
  const home = setHome("server", { id: "doc-1", rev: 2 });
  serverStatus().recordMode({ available: true });
  stop();
  assert.equal(locationStarted(), false);
  assert.throws(() => currentHome(), /not started yet/);
  assert.equal(stillOnServer(connection), false, "a server check that outlives the location is not on any server");
  const again = startLocation({ storage: () => null });
  try {
    assert.equal(currentHome(), home);
    assert.equal(currentConn(), connection);
    assert.equal(stillOnServer(connection), true);
    assert.equal(serverStatus().mode().available, true);
  } finally {
    setHome("none");
    documentLocation().setConnection({});
    serverStatus().forgetMode();
    again();
  }
});

test("reviewBlocked tells a reviewer through the notices and says nothing to an editor", () => {
  const stopLocation = startLocation({ storage: () => null });
  const recorder = noticeRecorder();
  const stopEffects = startEffects(recorder.ports);
  try {
    assert.equal(reviewBlocked(), false);
    assert.deepEqual(recorder.shown, []);
    documentLocation().setConnection({ serverUrl: "http://a:1/", token: "t", role: "review", scope: "doc-1" });
    setHome("server", { id: "doc-1" });
    assert.equal(reviewMode(), true);
    assert.equal(reviewBlocked(), true);
    assert.deepEqual(recorder.shown, [[VIEWING_ONLY, "warn", undefined]]);
  } finally {
    setHome("none");
    documentLocation().setConnection({});
    stopEffects();
    stopLocation();
  }
});

test("checking the server runs the check handed to the bridge", async () => {
  assert.throws(() => checkServer(), /Nothing checks the server yet/);
  let runs = 0;
  handServerCheckTo(async () => { runs++; });
  await checkServer();
  assert.equal(runs, 1);
});
