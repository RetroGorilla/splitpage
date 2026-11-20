import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBObjectStore } from "fake-indexeddb";
import { openNativeRelay } from "../../../../src/adapters/collab/native/relay.ts";
import type { NativeRelayEvent } from "../../../../src/adapters/collab/native/relay.ts";
import { eventResult, failNextIdbWrite } from "./indexeddb-fixture.ts";
import { DB_NAME, fixture, seedReplica, seedSession, STORE_OPTIONS, stored, typeAt } from "./local-store-fixture.ts";
import { openRelayFixture } from "./relay-harness.ts";

test("the relay replacement keeps the writer lease and writes to the same journal", { timeout: 12000 }, async t => {
  const { signals, url } = await openRelayFixture(t);
  const { store } = fixture();
  const replica = await store.open("relay-script", STORE_OPTIONS);
  assert.equal(replica.kind, "opened");
  const original = replica.session;
  seedReplica(original);
  assert.deepEqual(await replica.flush(), stored(1));
  await assert.rejects(replica.reopen(original), /no handover/);
  const events: NativeRelayEvent[] = [];
  const relay = openNativeRelay(original, {
    url, name: "relay-script", token: "test-token", sessionOptions: STORE_OPTIONS,
    reopen: replica.reopen,
    onEvent(event) { events.push(event); signals.notify(); }
  });
  t.after(() => relay.close());
  await signals.until(() => relay.status().firstSyncDone || undefined);
  const held = eventResult<() => boolean>(), put = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, "put", function (this: IDBObjectStore, value: unknown) {
    const dispatch = this.transaction.dispatchEvent.bind(this.transaction);
    t.mock.method(this.transaction, "dispatchEvent", (event: Event) => {
      if (event.type !== "complete") return dispatch(event);
      held.resolve(() => dispatch(event));
      return true;
    });
    return put.call(this, value);
  });
  const fault = new Error("interrupted relay session");
  original.ydoc.once("afterTransactionCleanup", () => { throw fault; });
  assert.throws(() => typeAt(original, 0, "kept "), fault);
  const deliver = await held.promise;
  const recorded = replica.flush();
  let granted = false;
  const claimant = navigator.locks.request(`${DB_NAME}:relay-script`, () => { granted = true; });
  try {
    assert.deepEqual(await store.open("relay-script", STORE_OPTIONS), { kind: "failed", reason: "locked" });
    assert.equal(relay.session(), original);
    const unrelated = seedSession({ A: "different" });
    try { await assert.rejects(replica.reopen(unrelated), /no handover/); }
    finally { unrelated.close(); }
    assert.equal(replica.reopen(original), replica.reopen(original));
  } finally { deliver(); }
  assert.equal((await recorded).generation, 2);
  const event = await signals.until(() => events.find(event => event.kind === "session-replaced"));
  assert.equal(event.session.document().rows[0]?.audioText, "kept start");
  assert.equal(replica.session, event.session);
  assert.equal(granted, false);
  assert.deepEqual(event.session.commands.undo(), { kind: "unchanged" });
  await assert.rejects(replica.reopen(original), /no handover/);
  await signals.until(() => relay.status().firstSyncDone || undefined);
  typeAt(event.session, 0, "replacement ");
  assert.deepEqual(await replica.flush(), stored(3));
  relay.close();
  assert.equal((await replica.closed).kind, "stored");
  await claimant;
  assert.equal(granted, true);
  const contender = await store.open("relay-script", STORE_OPTIONS);
  assert.equal(contender.kind, "opened");
  try { assert.equal(contender.session.document().rows[0]?.audioText, "replacement kept start"); }
  finally { contender.session.close(); await contender.closed; }
});

for (const mode of ["checkpoint fails", "relay closes"] as const) {
  test(`store-backed recovery releases the lease if the ${mode} during handover`, { timeout: 12000 }, async t => {
    const { signals, url } = await openRelayFixture(t);
    const { store } = fixture();
    const replica = await store.open("relay-script", STORE_OPTIONS);
    assert.equal(replica.kind, "opened");
    const original = replica.session;
    seedReplica(original);
    assert.deepEqual(await replica.flush(), stored(1));
    const events: NativeRelayEvent[] = [];
    const entered = eventResult<undefined>(), release = eventResult<undefined>();
    const relay = openNativeRelay(original, {
      url, name: "relay-script", token: "test-token", sessionOptions: STORE_OPTIONS,
      reopen: async failed => {
        const replacement = await replica.reopen(failed);
        entered.resolve(undefined);
        await release.promise;
        return replacement;
      },
      onEvent(event) { events.push(event); signals.notify(); }
    });
    t.after(() => relay.close());
    await signals.until(() => relay.status().firstSyncDone || undefined);
    if (mode === "checkpoint fails") failNextIdbWrite(t, "put", "quota");
    const fault = new Error("interrupted relay session");
    original.ydoc.once("afterTransactionCleanup", () => { throw fault; });
    assert.throws(() => typeAt(original, 0, "pending "), fault);
    if (mode === "checkpoint fails") {
      const outcome = await signals.until(() => events.find(event => event.kind === "session-reopen-failed"));
      const closed = await replica.closed;
      assert.equal(closed.kind, "failed");
      assert.ok(closed.error instanceof DOMException);
      assert.equal(closed.error.name, "QuotaExceededError");
      assert.equal(relay.session(), original);
      assert.deepEqual(outcome.error, {
        kind: "failed", reason: "quota", generation: 2, committed: 1, error: closed.error
      });
    } else {
      await entered.promise;
      relay.close();
      release.resolve(undefined);
      assert.equal((await replica.closed).kind, "stored");
      assert.deepEqual(replica.session.commands.undo(), { kind: "refused", reason: "closed" });
      assert.equal(events.some(event => event.kind === "session-replaced"), false);
    }
    const reopened = await store.open("relay-script", STORE_OPTIONS);
    assert.equal(reopened.kind, "opened");
    try { assert.equal(reopened.session.document().rows[0]?.audioText, mode === "checkpoint fails" ? "start" : "pending start"); }
    finally { reopened.session.close(); await reopened.closed; }
  });
}
