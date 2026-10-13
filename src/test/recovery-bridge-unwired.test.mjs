import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";

const bridge = await import("../legacy/recovery-bridge.ts");
const { DRAFT_LIMITS } = await import("../adapters/storage/draft-store-idb.ts");

function ports(over) {
  return Object.assign({ indexedDB: new IDBFactory(), limits: DRAFT_LIMITS, now: () => Date.now(), writerId: "w-test", desktop: () => null }, over);
}

test("before the draft recovery is started, every accessor throws instead of running on a default", () => {
  assert.equal(bridge.recoveryStarted(), false);
  assert.throws(() => bridge.browserDrafts(), /The draft recovery is not started yet/);
  assert.throws(() => bridge.desktopDrafts(), /not started yet/);
  assert.throws(() => bridge.useBrowserDraftFactory(null), /not started yet/);
});

test("started once, with the ports it is handed; a second start throws until the first is stopped", async () => {
  const stop = bridge.startRecovery(ports());
  try {
    assert.equal(bridge.recoveryStarted(), true);
    assert.throws(() => bridge.startRecovery(ports()), /already started/);
    assert.equal(bridge.browserDrafts().writer.writerId(), "w-test");
    assert.equal(await bridge.browserDrafts().store.available(), true);
    assert.equal(bridge.desktopDrafts().writable(), false, "the desktop store reads the bridge it was handed");
    const swapped = bridge.useBrowserDraftFactory(null);
    assert.equal(bridge.browserDrafts(), swapped);
    assert.equal(await swapped.store.available(), false);
    assert.equal(swapped.writer.writerId(), "w-test", "a new store keeps the page's writer id");
  } finally {
    stop();
  }
  assert.equal(bridge.recoveryStarted(), false);
  assert.throws(() => bridge.browserDrafts(), /not started yet/);
});
