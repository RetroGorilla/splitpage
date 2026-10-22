import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";

const bridge = await import("../legacy/recovery-bridge.ts");
const { DRAFT_LIMITS } = await import("../adapters/storage/draft-store-idb.ts");

function ports(over) {
  return Object.assign({ indexedDB: new IDBFactory(), limits: DRAFT_LIMITS, now: () => Date.now(), writerId: "w-test", desktop: () => null, sessionStorage: () => null, localStorage: () => null, internImage: () => {} }, over);
}

test("before the draft recovery is started, every accessor throws instead of running on a default", () => {
  assert.equal(bridge.recoveryStarted(), false);
  assert.throws(() => bridge.browserDrafts(), /The draft recovery is not started yet/);
  assert.throws(() => bridge.desktopDrafts(), /not started yet/);
  assert.throws(() => bridge.useBrowserDraftFactory(null), /not started yet/);
  assert.throws(() => bridge.draftResume(), /not started yet/);
  assert.throws(() => bridge.conflictStash(), /not started yet/);
  assert.throws(() => bridge.legacySnapshots(), /not started yet/);
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
  assert.throws(() => bridge.draftResume(), /not started yet/);
});

test("the resume, the conflict stash and the legacy snapshots use the storage they are handed, and a restart starts the resume afresh", () => {
  const items = new Map();
  const memory = { getItem: (k) => (items.has(k) ? items.get(k) : null), setItem: (k, v) => { items.set(k, v); }, removeItem: (k) => { items.delete(k); } };
  const interned = [];
  let stop = bridge.startRecovery(ports({ sessionStorage: () => memory, localStorage: () => memory, internImage: (url) => { interned.push(url); } }));
  try {
    assert.equal(bridge.draftResume().serverResume(), null);
    assert.equal(bridge.draftResume().restorePending(), false);
    bridge.draftResume().setRestorePending(true);
    bridge.draftResume().armServerResume({ id: "doc-a", rev: 1, base: null, mine: null, at: 0, onDone: () => {} });
    assert.equal(bridge.conflictStash().save({ mine: { rows: [] }, blobs: { ["c".repeat(64)]: "data:image/png;base64,AA" } }), true);
    assert.ok(items.has("splitpage-conflict-stash"));
    bridge.conflictStash().accept(bridge.conflictStash().read(), null);
    assert.deepEqual(interned, ["data:image/png;base64,AA"]);
    items.set("splitpage-snapshots", "[]");
    assert.equal(bridge.legacySnapshots().readRaw(), "[]");
  } finally {
    stop();
  }
  stop = bridge.startRecovery(ports({ sessionStorage: () => memory, localStorage: () => memory }));
  try {
    assert.equal(bridge.draftResume().serverResume(), null, "a new start holds no server resume");
    assert.equal(bridge.draftResume().restorePending(), false);
    assert.ok(bridge.conflictStash().read(), "the stash lives in storage, not in the bridge");
  } finally {
    stop();
  }
});
