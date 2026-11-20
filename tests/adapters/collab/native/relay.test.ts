import assert from "node:assert/strict";
import test from "node:test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import { openNativeRelay } from "../../../../src/adapters/collab/native/relay.ts";
import { openRelayFixture, relayFrameType, seedRelaySession } from "./relay-harness.ts";

function seedState() {
  const seed = seedRelaySession();
  const state = seed.encodeState();
  seed.close();
  return state;
}

test("a closing or closed session is refused before constructing a provider", async t => {
  const session = seedRelaySession();
  const attach = t.mock.method(HocuspocusProvider.prototype, "attach");
  const options = {
    url: "ws://127.0.0.1:1", name: "script", token: "",
    sessionOptions: { actor: "writer", sanitize: () => "" }, onEvent: () => undefined
  };
  session.close();
  assert.equal(session.ydoc.isDestroyed, false);
  assert.throws(() => openNativeRelay(session, options), /closing or closed/);
  await Promise.resolve();
  assert.equal(session.ydoc.isDestroyed, true);
  assert.throws(() => openNativeRelay(session, options), /closing or closed/);
  assert.equal(attach.mock.callCount(), 0);
});

test("token refusals and repeated drops before a download never use the first-load restart allowance", { timeout: 15_000 }, async t => {
  let accept = true;
  const kit = await openRelayFixture(t, { async onAuthenticate() { if (!accept) throw { reason: "token-refused" }; } });
  const bridge = kit.bridge(), { signals } = kit;
  bridge.configure = link => {
    if (!accept) return;
    link.download = (frame, forward) => { if (relayFrameType(frame) !== messageYjsSyncStep2) forward(); };
  };
  const copy = kit.copy(await bridge.listen());
  const first = await signals.until(() => bridge.links[0]?.sent.includes(messageYjsSyncStep2) ? bridge.links[0] : undefined);
  accept = false;
  first.cut();
  for (let attempt = 0; attempt < 3; attempt++) {
    const event = await signals.until(() => copy.events.filter(event => event.kind === "authentication-failed")[attempt]);
    assert.deepEqual(event, { kind: "authentication-failed", reason: "token-refused" });
    bridge.links[attempt + 1]?.cut();
  }
  await signals.until(() => !copy.relay.status().connected || undefined);
  assert.equal(copy.relay.status().firstSyncDone, false);
  assert.equal(copy.session.ydoc.isDestroyed, false);
  assert.equal(copy.events.some(event => event.kind === "first-load-too-large"), false);
});

test("the first state reply marks first sync even when stock synced and pending zero arrive early", { timeout: 12_000 }, async t => {
  const state = seedState();
  const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
  const bridge = kit.bridge();
  let resume: (() => void) | undefined;
  bridge.configure = link => {
    link.download = (frame, forward) => {
      const type = relayFrameType(frame);
      if (type === messageYjsSyncStep2) resume = forward;
      else if (type !== messageYjsUpdate) forward();
    };
  };
  const stock = HocuspocusProvider.prototype.decrementUnsyncedChanges;
  let stockSynced = false;
  t.mock.method(HocuspocusProvider.prototype, "decrementUnsyncedChanges", function (this: HocuspocusProvider) {
    stock.call(this);
    stockSynced = this.synced;
  });
  const viewer = kit.copy(await bridge.listen());
  await kit.signals.until(() => stockSynced && viewer.relay.status().pendingChangeCount === 0 || undefined);
  assert.deepEqual(viewer.relay.status(), { connected: true, firstSyncDone: false, pendingChangeCount: 0 });
  assert.deepEqual(viewer.session.document().rows, []);
  (await kit.signals.until(() => resume))();
  await kit.signals.until(() => viewer.relay.status().firstSyncDone || undefined);
  assert.equal(viewer.session.document().rows[0]?.audioText, "word");
  assert.deepEqual(kit.authenticated, [{ name: "relay-script", token: "test-token" }]);
});

test("status callbacks run after the provider write and a throwing caller cannot break delivery",
  { timeout: 12_000 }, async t => {
    const kit = await openRelayFixture(t);
    let wrote = false;
    let reported = false;
    let inWrite = false;
    const writer = kit.copy(kit.url, { kind: "empty" }, event => {
      if (wrote && event.kind === "status" && event.status.pendingChangeCount === 1) {
        reported = !inWrite;
        throw new Error("status subscriber");
      }
    });
    const reader = kit.copy();
    await kit.signals.until(() => writer.relay.status().firstSyncDone && reader.relay.status().firstSyncDone &&
      writer.relay.status().pendingChangeCount === 0 || undefined);
    wrote = true;
    inWrite = true;
    writer.session.ydoc.getText("delivery").insert(0, "peer");
    inWrite = false;
    await kit.signals.until(() => reader.session.ydoc.getText("delivery").toString() === "peer" || undefined);
    assert.equal(reported, true);
  }
);

test("a failed session exchanges providers and resyncs a real server frame delivered late to its retired document",
  { timeout: 15_000 }, async t => {
    const state = seedState();
    const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
    const bridge = kit.bridge();
    const viewer = kit.copy(await bridge.listen()), peer = kit.copy();
    const { signals } = kit;
    await signals.until(() => viewer.relay.status().firstSyncDone && peer.relay.status().firstSyncDone || undefined);
    const old = viewer.session, first = bridge.links[0];
    assert(first);
    let late: Buffer | undefined;
    first.download = (frame, forward) => {
      if (relayFrameType(frame) === messageYjsUpdate) late = frame;
      else forward();
    };
    peer.session.ydoc.getText("late").insert(0, "from server");
    const frame = await signals.until(() => late);
    const destroy = HocuspocusProvider.prototype.destroy;
    let deliveries = 0;
    t.mock.method(HocuspocusProvider.prototype, "destroy", function (this: HocuspocusProvider) {
      destroy.call(this);
      if (this.document === old.ydoc) {
        this.onMessage(new MessageEvent("message", { data: Uint8Array.from(frame).buffer }));
        deliveries++;
      }
    });
    let resume: (() => void) | undefined;
    bridge.configure = link => {
      link.download = (frame, forward) => {
        if (relayFrameType(frame) === messageYjsSyncStep2) resume = forward;
        else forward();
      };
    };

    const at = old.commands.anchorText({ beat: "R", cell: "narration" }, 0);
    assert(at.kind === "anchored");
    const failure = new Error("interrupted cleanup");
    old.ydoc.once("afterTransactionCleanup", () => { throw failure; });
    assert.throws(() => old.commands.typeText(at.range, "x", {}), failure);
    const event = await signals.until(() => viewer.events.find(event => event.kind === "session-replaced"));
    const replacement = event.session;
    assert.equal(deliveries, 1);
    assert.equal(old.ydoc.isDestroyed, true);
    assert.equal(old.ydoc.getText("late").toString(), "from server");
    assert.equal(event.undoHistory, "fresh");
    assert.notEqual(replacement.ydoc, old.ydoc);
    assert.equal(viewer.relay.session(), replacement);
    assert.equal(replacement.document().rows[0]?.audioText, "xword");
    assert.deepEqual(replacement.commands.undo(), { kind: "unchanged" });
    assert.equal(replacement.ydoc.getText("late").toString(), "");
    assert.equal(viewer.relay.status().firstSyncDone, false);

    (await signals.until(() => resume))();
    await signals.until(() => viewer.relay.status().firstSyncDone || undefined);
    await signals.until(() => peer.session.document().rows[0]?.audioText === "xword" || undefined);
    assert.equal(replacement.ydoc.getText("late").toString(), "from server");
    assert.equal(replacement.document().rows[0]?.audioText, "xword");
  }
);

for (const kind of ["relay", "session", "failed while closing"] as const) {
  test(`requested close retires both without replacing the session: ${kind}`, { timeout: 12_000 }, async t => {
    const kit = await openRelayFixture(t);
    const bridge = kit.bridge();
    const { session, relay, events } = kit.copy(await bridge.listen(), { kind: "state", state: seedState() });
    await kit.signals.until(() => relay.status().firstSyncDone || undefined);
    if (kind === "failed while closing") {
      const at = session.commands.anchorText({ beat: "R", cell: "narration" }, 0);
      assert(at.kind === "anchored");
      const failure = new Error("interrupted close");
      session.ydoc.once("afterTransactionCleanup", () => {
        relay.close();
        throw failure;
      });
      assert.throws(() => session.commands.typeText(at.range, "x", {}), failure);
    } else if (kind === "relay") relay.close();
    else session.close();
    await kit.signals.until(() => bridge.links[0]?.closed && !relay.status().connected || undefined);
    assert.equal(session.ydoc.isDestroyed, true);
    assert.equal(relay.session(), session);
    assert.equal(events.some(event => event.kind === "session-replaced"), false);
  });
}

test("after first sync the connection can recover from repeated drops", { timeout: 15_000 }, async t => {
  const kit = await openRelayFixture(t);
  const bridge = kit.bridge();
  const copy = kit.copy(await bridge.listen());
  await kit.signals.until(() => copy.relay.status().firstSyncDone || undefined);
  for (let index = 0; index < 2; index++) {
    const live = bridge.links[index];
    assert(live);
    live.cut();
    await kit.signals.until(() => bridge.links[index + 1]?.sent.includes(messageYjsSyncStep2) || undefined);
    assert.equal(copy.relay.status().firstSyncDone, true);
  }
  assert.equal(copy.events.some(event => event.kind === "first-load-too-large"), false);
});

test("an interrupted first reply replaces the failed session and gives the replacement its own first-load allowance",
  { timeout: 15_000 }, async t => {
    const state = seedState();
    const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
    const bridge = kit.bridge(), { signals } = kit;
    bridge.configure = link => {
      const attempt = bridge.links.length;
      link.download = (frame, forward) => {
        const type = relayFrameType(frame);
        if (type === messageYjsUpdate || (type === messageYjsSyncStep2 && (attempt === 1 || attempt === 3))) return;
        forward();
      };
    };
    const copy = kit.copy(await bridge.listen());
    const failure = new Error("first reply cleanup");
    const logs: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    copy.session.ydoc.once("afterTransactionCleanup", () => { throw failure; });
    async function dropStartedLoad(index: number) {
      const link = await signals.until(() => bridge.links[index]?.sent.includes(messageYjsSyncStep2) ? bridge.links[index] : undefined);
      assert.equal(copy.relay.status().firstSyncDone, false);
      link.cut();
    }
    await dropStartedLoad(0);
    const replacement = await signals.until(() => copy.events.find(event => event.kind === "session-replaced"));
    assert.equal(copy.session.ydoc.isDestroyed, true);
    assert(logs.some(args => args.includes(failure)));
    assert.deepEqual(replacement.session.commands.undo(), { kind: "unchanged" });
    await dropStartedLoad(2);
    await signals.until(() => copy.relay.status().firstSyncDone || undefined);
    assert.equal(copy.relay.session(), replacement.session);
    assert.equal(replacement.session.document().rows[0]?.audioText, "word");
    assert.equal(copy.events.some(event => event.kind === "first-load-too-large"), false);
  }
);

test("the stock receive wait permits one first-load restart on a slow link, then reports the script cannot load",
  { timeout: 100_000 }, async t => {
    const state = seedState();
    const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
    const bridge = kit.bridge();
    const downloads: number[] = [];
    bridge.configure = link => {
      let transfer: ReturnType<typeof setTimeout> | undefined;
      link.signal.addEventListener("abort", () => clearTimeout(transfer), { once: true });
      link.download = (frame, forward) => {
        if (transfer !== undefined) return;
        if (relayFrameType(frame) !== messageYjsSyncStep2) {
          forward();
          return;
        }
        downloads.push(performance.now());
        transfer = setTimeout(forward, 45_000);
      };
    };
    const copy = kit.copy(await bridge.listen());
    const outcome = await kit.signals.until(() => copy.events.find(event => event.kind === "first-load-too-large"));
    assert.equal(downloads.length, 2);
    assert((downloads[1] ?? 0) - (downloads[0] ?? 0) >= 30_000);
    assert(performance.now() - (downloads[1] ?? 0) >= 30_000);
    await kit.signals.until(() => bridge.links[1]?.closed || undefined);
    assert.equal(copy.relay.status().firstSyncDone, false);
    assert.equal(copy.relay.status().connected, false);
    assert.equal(copy.session.ydoc.isDestroyed, true);
    assert.match(outcome.message, /too large.*connection/);
  }
);
