import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import { openNativeRelay } from "../../../../src/adapters/collab/native/relay.ts";
import type { NativeRelayEvent } from "../../../../src/adapters/collab/native/relay.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { desktopFixture } from "./desktop-local-store-fixture.ts";
import { cells } from "./helpers.ts";
import { STORE_OPTIONS, fixture as browserFixture, typeAt } from "./local-store-fixture.ts";
import { AT } from "./record-harness.ts";
import { openRelayFixture, relayFrameType } from "./relay-harness.ts";
import { structureScript } from "./structure-harness.ts";

const JOURNAL_OPTIONS = { ...STORE_OPTIONS, noticeJournal: true as const };

function seedTwoBeats(): Uint8Array {
  const seed = openNativeSession({
    kind: "document",
    document: structureScript({ A: "alpha", B: "beta", C: "gamma" }),
    conversion: { cells, creation: "seed", at: AT, by: "writer" }
  }, STORE_OPTIONS);
  try { return seed.encodeState(); }
  finally { seed.close(); }
}

async function createStorePair(t: TestContext, backend: "browser" | "desktop") {
  if (backend === "browser") {
    const { store } = browserFixture();
    return { open: (name: string) => store.open(name, JOURNAL_OPTIONS) };
  }
  const desktop = await desktopFixture(t, false);
  return { open: (name: string) => desktop.restart().store.open(name, JOURNAL_OPTIONS) };
}

for (const backend of ["browser", "desktop"] as const) {
  for (const peerAction of ["edit", "remove"] as const) {
    test(`${backend}: offline edit against peer ${peerAction} with restart reports clash without clearing on reconnect`,
      { timeout: 20_000 }, async t => {
        const state = seedTwoBeats();
        const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
        const { signals, url } = kit;
        const stores = await createStorePair(t, backend);
        const scriptScope = `deployment/offline-${backend}-${peerAction}`;

        const peer = kit.copy();
        await signals.until(() => peer.relay.status().firstSyncDone || undefined);

        const initial = await stores.open(scriptScope);
        assert.equal(initial.kind, "opened");
        const initialRelay = openNativeRelay(initial.session, {
          url, name: "relay-script", token: "test-token", sessionOptions: JOURNAL_OPTIONS,
          reopen: initial.reopen,
          onEvent() { signals.notify(); }
        });
        await signals.until(() => initialRelay.status().firstSyncDone && initialRelay.status().pendingChangeCount === 0 || undefined);
        assert.equal(initial.session.document().rows.length, 3);
        assert.deepEqual(initial.session.pendingEdits?.data(), { through: 0, entries: [] });

        initialRelay.close();
        await initial.closed;

        const offline = await stores.open(scriptScope);
        assert.equal(offline.kind, "opened");
        offline.session.ydoc.clientID = 2;
        assert.equal(offline.session.commands.setField({ kind: "beat", id: "B", field: "status" }, "ready").kind, "written");
        typeAt(offline.session, 0, "local ", "B");
        assert.equal((await offline.flush()).kind, "stored");
        assert.equal(offline.session.pendingEdits?.data().entries.length, 1);
        offline.session.close();
        await offline.closed;

        peer.session.ydoc.clientID = 3;
        if (peerAction === "edit") {
          assert.equal(peer.session.commands.setField({ kind: "beat", id: "B", field: "status" }, "shot").kind, "written");
        } else {
          assert.equal(peer.session.commands.removeRows(["B"]).kind, "written");
        }
        await signals.until(() => peer.relay.status().pendingChangeCount === 0 || undefined);

        const returned = await stores.open(scriptScope);
        assert.equal(returned.kind, "opened");
        returned.session.subscribe(() => signals.notify());
        const returnedRelay = openNativeRelay(returned.session, {
          url, name: "relay-script", token: "test-token", sessionOptions: JOURNAL_OPTIONS,
          reopen: returned.reopen,
          onEvent() { signals.notify(); }
        });
        t.after(async () => {
          returnedRelay.close();
          await returned.closed;
        });
        await signals.until(() => returnedRelay.status().firstSyncDone && returnedRelay.status().pendingChangeCount === 0 || undefined);

        const clashes = returned.session.offlineNotice("returning");
        assert.equal(clashes.length, 1);
        assert.equal(clashes[0]?.id, "B");
        if (peerAction === "edit") {
          assert.equal(clashes[0]?.possibleRemoval, false);
          assert.deepEqual(clashes[0]?.kinds, ["record"]);
          assert.equal(clashes[0]?.mine?.fields.status, "ready");
          assert.equal(clashes[0]?.merged?.fields.status, "shot");
        } else {
          assert.equal(clashes[0]?.possibleRemoval, true);
          assert.equal(clashes[0]?.merged, null);
          assert.ok(clashes[0]?.kinds.includes("narration"));
          assert.ok(clashes[0]?.kinds.includes("record"));
          assert.equal(clashes[0]?.mine?.narration.map(run => run.text).join(""), "local beta");
        }
        assert.equal((await returned.flush()).kind, "stored");
      });
  }
}

test("reconnect does not clear offline edits even when onUnsyncedChanges hits zero before peer SyncStep2 arrives",
  { timeout: 20_000 }, async t => {
    const state = seedTwoBeats();
    const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
    const bridge = kit.bridge();
    const address = await bridge.listen();
    const { signals } = kit;

    const peer = kit.copy();
    const writer = openNativeSession({ kind: "empty" }, JOURNAL_OPTIONS);
    writer.subscribe(() => signals.notify());
    writer.pendingEdits?.subscribe(() => signals.notify());
    const events: NativeRelayEvent[] = [];
    const relay = openNativeRelay(writer, {
      url: address, name: "relay-script", token: "test-token", sessionOptions: JOURNAL_OPTIONS,
      onEvent(event) { events.push(event); signals.notify(); }
    });
    t.after(() => relay.close());
    await signals.until(() => relay.status().firstSyncDone && peer.relay.status().firstSyncDone
      && relay.status().pendingChangeCount === 0 || undefined);

    const firstLink = bridge.links[0];
    assert.ok(firstLink);
    firstLink.cut();
    await signals.until(() => !relay.status().connected || undefined);

    typeAt(writer, 0, "offline ", "B");
    assert.equal(writer.pendingEdits?.data().entries.length, 1);

    assert.equal(peer.session.commands.removeRows(["B"]).kind, "written");
    await signals.until(() => peer.relay.status().pendingChangeCount === 0 || undefined);

    let releasePeerReply: (() => void) | undefined;
    bridge.configure = link => {
      link.download = (frame, forward) => {
        if (relayFrameType(frame) === messageYjsSyncStep2) {
          releasePeerReply = forward;
          signals.notify();
          return;
        }
        forward();
      };
    };

    await signals.until(() => releasePeerReply && relay.status().connected && relay.status().pendingChangeCount === 0 || undefined);
    assert.equal(writer.pendingEdits?.data().entries.length, 1);

    releasePeerReply?.();
    await signals.until(() => !writer.document().rows.some(row => row.id === "B") || undefined);

    typeAt(writer, 0, "later online ", "C");
    await signals.until(() => peer.session.document().rows.some(row => row.audioText === "later online gamma")
      && relay.status().pendingChangeCount === 0 || undefined);

    const clashes = writer.offlineNotice("returning");
    assert.equal(clashes.length, 1);
    assert.equal(clashes[0]?.id, "B");
    assert.equal(clashes[0]?.possibleRemoval, true);

    writer.pendingEdits?.clearThrough(1);
    assert.deepEqual(writer.offlineNotice("returning"), []);
    typeAt(writer, 0, "clean ", "A");
    await signals.until(() => peer.session.document().rows.some(row => row.id === "A" && row.audioText === "clean alphaoffline ")
      && relay.status().pendingChangeCount === 0 || undefined);
    await signals.until(() => writer.pendingEdits?.data().entries.length === 0 || undefined);
    assert.deepEqual(writer.pendingEdits?.data().entries, []);
  });

test("connected sends clear confirmed journal entries on applied confirmation and produce no spurious clashes",
  { timeout: 20_000 }, async t => {
    const state = seedTwoBeats();
    const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
    const { signals, url } = kit;
    const { store } = browserFixture();
    const scriptScope = "deployment/online-confirm";

    const peer = kit.copy();
    const replica = await store.open(scriptScope, JOURNAL_OPTIONS);
    assert.equal(replica.kind, "opened");
    replica.session.subscribe(() => signals.notify());
    replica.session.pendingEdits?.subscribe(() => signals.notify());
    const relay = openNativeRelay(replica.session, {
      url, name: "relay-script", token: "test-token", sessionOptions: JOURNAL_OPTIONS,
      reopen: replica.reopen,
      onEvent() { signals.notify(); }
    });
    t.after(async () => {
      relay.close();
      await replica.closed;
    });
    await signals.until(() => relay.status().firstSyncDone && peer.relay.status().firstSyncDone
      && relay.status().pendingChangeCount === 0 || undefined);

    typeAt(replica.session, 0, "first ", "B");
    typeAt(replica.session, 6, "second ", "B");
    assert.equal(replica.session.commands.setField({ kind: "beat", id: "B", field: "status" }, "ready").kind, "written");
    assert.equal(replica.session.pendingEdits?.data().entries.length, 1);

    await signals.until(() => peer.session.document().rows.find(row => row.id === "B")?.status === "ready"
      && replica.session.pendingEdits?.data().entries.length === 0 || undefined);
    assert.deepEqual(replica.session.pendingEdits?.data().entries, []);
    assert.equal((await replica.flush()).kind, "stored");

    assert.equal(peer.session.commands.removeRows(["B"]).kind, "written");
    await signals.until(() => !replica.session.document().rows.some(row => row.id === "B") || undefined);
    assert.deepEqual(replica.session.offlineNotice("returning"), []);

    relay.close();
    await replica.closed;
    const reopened = await store.open(scriptScope, JOURNAL_OPTIONS);
    assert.equal(reopened.kind, "opened");
    try {
      assert.deepEqual(reopened.session.pendingEdits?.data().entries, []);
      assert.deepEqual(reopened.session.offlineNotice("returning"), []);
    } finally { reopened.session.close(); await reopened.closed; }
  });

test("an online send dropped on a dead socket stays in the journal and clashes after reconnect",
  { timeout: 20_000 }, async t => {
    const state = seedTwoBeats();
    const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
    const bridge = kit.bridge();
    const address = await bridge.listen();
    const { signals } = kit;

    const peer = kit.copy();
    const writer = openNativeSession({ kind: "empty" }, JOURNAL_OPTIONS);
    writer.subscribe(() => signals.notify());
    writer.pendingEdits?.subscribe(() => signals.notify());
    const relay = openNativeRelay(writer, {
      url: address, name: "relay-script", token: "test-token", sessionOptions: JOURNAL_OPTIONS,
      onEvent() { signals.notify(); }
    });
    t.after(() => relay.close());
    await signals.until(() => relay.status().firstSyncDone && peer.relay.status().firstSyncDone
      && relay.status().pendingChangeCount === 0 || undefined);

    const firstLink = bridge.links[0];
    assert.ok(firstLink);
    firstLink.upload = (frame, forward) => {
      if (relayFrameType(frame) === messageYjsUpdate) firstLink.dropped.push(frame);
      else forward();
    };
    typeAt(writer, 0, "unconfirmed ", "B");
    await signals.until(() => firstLink.dropped.length > 0 || undefined);
    assert.equal(relay.status().connected, true);
    assert.equal(writer.pendingEdits?.data().entries.length, 1);

    firstLink.cut();
    await signals.until(() => !relay.status().connected || undefined);
    assert.equal(peer.session.commands.removeRows(["B"]).kind, "written");
    await signals.until(() => peer.relay.status().pendingChangeCount === 0 || undefined);

    await signals.until(() => bridge.links[1]?.sent.includes(messageYjsSyncStep2) && !writer.document().rows.some(row => row.id === "B") || undefined);
    const clashes = writer.offlineNotice("returning");
    assert.equal(clashes.length, 1);
    assert.equal(clashes[0]?.id, "B");
    assert.equal(clashes[0]?.possibleRemoval, true);
    assert.equal(clashes[0]?.mine?.narration.map(run => run.text).join(""), "unconfirmed beta");
  });

test("a read-only SyncStatus(0) refusal does not clear the pending journal entry", { timeout: 20_000 }, async t => {
  const state = seedTwoBeats();
  const kit = await openRelayFixture(t, {
    async onLoadDocument() { return state; },
    async onAuthenticate({ connectionConfig }) { connectionConfig.readOnly = true; }
  });
  const { signals, url } = kit;
  const writer = openNativeSession({ kind: "empty" }, JOURNAL_OPTIONS);
  const relay = openNativeRelay(writer, {
    url, name: "relay-script", token: "test-token", sessionOptions: JOURNAL_OPTIONS,
    onEvent() { signals.notify(); }
  });
  t.after(() => relay.close());
  await signals.until(() => relay.status().firstSyncDone || undefined);

  typeAt(writer, 0, "readonly ", "B");
  assert.equal(writer.pendingEdits?.data().entries.length, 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(writer.pendingEdits?.data().entries.length, 1);
  assert.equal(relay.status().pendingChangeCount > 0, true);
});

test("relay session replacement preserves the pending edits journal without a local store", { timeout: 20_000 }, async t => {
  const state = seedTwoBeats();
  const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
  const { signals, url } = kit;
  const writer = openNativeSession({ kind: "empty" }, JOURNAL_OPTIONS);
  const events: NativeRelayEvent[] = [];
  const relay = openNativeRelay(writer, {
    url, name: "relay-script", token: "test-token", sessionOptions: JOURNAL_OPTIONS,
    onEvent(event) { events.push(event); signals.notify(); }
  });
  t.after(() => relay.close());
  await signals.until(() => relay.status().firstSyncDone && relay.status().pendingChangeCount === 0 || undefined);

  const fault = new Error("interrupted relay write");
  writer.ydoc.once("afterTransactionCleanup", () => { throw fault; });
  assert.throws(() => typeAt(writer, 0, "kept ", "B"), fault);
  const replaced = await signals.until(() => events.find(event => event.kind === "session-replaced"));
  assert.equal(replaced.session.document().rows[1]?.audioText, "kept beta");
  assert.deepEqual(replaced.session.pendingEdits?.data().entries.map(entry => entry.id), ["B"]);
});

test("releaseOfflineGate retains online acks until offline notice runs and then clears both", { timeout: 20_000 }, async t => {
  const state = seedTwoBeats();
  const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
  const { signals, url } = kit;

  const writer = openNativeSession({ kind: "state", state }, JOURNAL_OPTIONS);
  typeAt(writer, 0, "offline ", "A");
  assert.equal(writer.pendingEdits?.through(), 1);

  const peer = openNativeSession({ kind: "empty" }, JOURNAL_OPTIONS);
  const peerRelay = openNativeRelay(peer, {
    url, name: "relay-script", token: "test-token", sessionOptions: JOURNAL_OPTIONS,
    onEvent() { signals.notify(); }
  });
  t.after(() => peerRelay.close());
  await signals.until(() => peerRelay.status().firstSyncDone || undefined);
  assert.equal(peer.commands.removeRows(["A"]).kind, "written");
  await signals.until(() => peerRelay.status().pendingChangeCount === 0 || undefined);

  const events: NativeRelayEvent[] = [];
  const relay = openNativeRelay(writer, {
    url, name: "relay-script", token: "test-token", sessionOptions: JOURNAL_OPTIONS,
    onEvent(event) { events.push(event); signals.notify(); }
  });
  t.after(() => relay.close());
  await signals.until(() => events.some(event => event.kind === "synced") || undefined);

  typeAt(writer, 0, "online ", "B");
  await signals.until(() => relay.status().pendingChangeCount === 0 || undefined);
  assert.equal(writer.pendingEdits?.hasPendingThrough(1), true);
  assert.deepEqual(writer.pendingEdits?.data().entries.map(entry => entry.id), ["A", "B"]);

  const clashes = writer.offlineNotice("returning");
  assert.deepEqual(clashes.map(clash => clash.id), ["A"]);
  relay.releaseOfflineGate();
  assert.equal(writer.pendingEdits?.hasPending(), false);
  assert.deepEqual(writer.offlineNotice("returning"), []);
});

test("post-clear checkpoint refresh tracks remaining in-flight edits and clears on their ack", { timeout: 20_000 }, async t => {
  const state = seedTwoBeats();
  const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
  const { signals, url } = kit;
  const writer = openNativeSession({ kind: "empty" }, JOURNAL_OPTIONS);
  const relay = openNativeRelay(writer, {
    url, name: "relay-script", token: "test-token", sessionOptions: JOURNAL_OPTIONS,
    onEvent() { signals.notify(); }
  });
  t.after(() => relay.close());
  await signals.until(() => relay.status().firstSyncDone && relay.status().pendingChangeCount === 0 || undefined);

  typeAt(writer, 0, "one ", "A");
  typeAt(writer, 0, "two ", "A");
  assert.equal(writer.pendingEdits?.data().entries.length, 1);

  await signals.until(() => {
    const checkpoint = writer.pendingEdits?.data().checkpoint;
    if (checkpoint && checkpoint.through >= 2) return true;
    return !writer.pendingEdits?.hasPending() || undefined;
  });
  await signals.until(() => !writer.pendingEdits?.hasPending() || undefined);
  assert.deepEqual(writer.offlineNotice("returning"), []);
});

test("undo and redo press updates ack through relay and throwing commands do not wedge confirmations", { timeout: 20_000 }, async t => {
  const state = seedTwoBeats();
  const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
  const { signals, url } = kit;
  const writer = openNativeSession({ kind: "empty" }, JOURNAL_OPTIONS);
  const events: NativeRelayEvent[] = [];
  const relay = openNativeRelay(writer, {
    url, name: "relay-script", token: "test-token", sessionOptions: JOURNAL_OPTIONS,
    onEvent(event) { events.push(event); signals.notify(); }
  });
  t.after(() => relay.close());
  await signals.until(() => relay.status().firstSyncDone && relay.status().pendingChangeCount === 0 || undefined);

  typeAt(writer, 0, "typed ", "A");
  await signals.until(() => !writer.pendingEdits?.hasPending() || undefined);

  assert.equal(writer.commands.undo().kind, "written");
  assert.equal(writer.document().rows[0]?.audioText, "alpha");
  await signals.until(() => !writer.pendingEdits?.hasPending() || undefined);

  assert.equal(writer.commands.redo().kind, "written");
  assert.equal(writer.document().rows[0]?.audioText, "typed alpha");
  await signals.until(() => !writer.pendingEdits?.hasPending() || undefined);

  const error = new Error("mid-command throw");
  writer.ydoc.once("afterTransactionCleanup", () => { throw error; });
  assert.throws(() => typeAt(writer, 0, "boom ", "B"), error);
  assert.equal(writer.inCommand(), false);
  const replaced = await signals.until(() => events.find(event => event.kind === "session-replaced"));
  await signals.until(() => relay.status().firstSyncDone && relay.status().pendingChangeCount === 0 || undefined);
  relay.releaseOfflineGate();

  typeAt(replaced.session, 0, "after ", "B");
  await signals.until(() => !replaced.session.pendingEdits?.hasPending() || undefined);
  assert.equal(replaced.session.document().rows[1]?.audioText, "after boom beta");
});
