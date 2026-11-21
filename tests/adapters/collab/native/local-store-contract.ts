import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as Y from "yjs";
import type { NativeLocalStore, NativeLocalStoreReceipt } from "../../../../src/adapters/collab/native/local-store.ts";
import { applyNativePeerUpdate } from "../../../../src/adapters/collab/native/peer-update.ts";
import { eventResult } from "./indexeddb-fixture.ts";
import { STORE_OPTIONS, STORED, seedReplica, stored, typeAt } from "./local-store-fixture.ts";

interface ContractFixture {
  readonly store: NativeLocalStore;
  readonly other: NativeLocalStore;
  readonly failAppend: (reason?: "quota") => void;
}

const bounded = { timeout: 10000 };
const locked = { kind: "failed", reason: "locked" };

async function open(t: TestContext, store: NativeLocalStore, name: string) {
  const replica = await store.open(name, STORE_OPTIONS);
  assert.equal(replica.kind, "opened");
  t.after(async () => { replica.session.close(); await replica.closed; });
  return replica;
}

export function localStoreContract(
  backend: string, create: (t: TestContext) => ContractFixture | Promise<ContractFixture>, timerTestTimeout = bounded.timeout
): void {
  test(`${backend}: an acknowledged edit and a failed edit get separate receipts, and retry is FIFO`, bounded, async t => {
    const { store, failAppend } = await create(t), replica = await open(t, store, "retry-order");
    seedReplica(replica.session);
    assert.deepEqual(await replica.flush(), stored(1));
    const seen: NativeLocalStoreReceipt[] = [];
    replica.subscribe(() => { throw new Error("subscriber failed"); });
    replica.subscribe(receipt => {
      seen.push(receipt);
      if (receipt.kind === "stored" && receipt.generation === 2) failAppend("quota");
    });
    typeAt(replica.session, 0, "A");
    typeAt(replica.session, 1, "B");
    const failure = await replica.flush();
    assert.equal(failure.kind, "failed");
    assert.equal(failure.reason, "quota");
    assert.equal(failure.generation, 3);
    assert.equal(failure.committed, 2);
    assert.deepEqual(seen, [stored(2), failure]);
    typeAt(replica.session, 2, "C");
    assert.deepEqual(await replica.flush(), stored(4));
    assert.deepEqual(seen, [stored(2), failure, stored(3), stored(4)]);
    replica.session.close();
    assert.equal((await replica.closed).generation, 4);
    const after = await open(t, store, "retry-order");
    assert.equal(after.generation, 4);
    assert.equal(after.session.document().rows[0]?.audioText, "ABCstart");
    assert.deepEqual(after.session.commands.undo(), { kind: "unchanged" });
    assert.deepEqual(after.session.commands.redo(), { kind: "unchanged" });
  });

  test(`${backend}: closing drains and retries an active append before releasing the writer`, bounded, async t => {
    const { store, other, failAppend } = await create(t);
    const replica = await open(t, store, "close-retry-contract");
    const seen: NativeLocalStoreReceipt[] = [];
    replica.subscribe(receipt => { seen.push(receipt); });
    failAppend();
    seedReplica(replica.session);
    replica.session.close();
    assert.deepEqual(await other.open("close-retry-contract", STORE_OPTIONS), locked);
    assert.equal((await replica.closed).kind, "stored");
    assert.equal(seen[0]?.kind, "failed");
    assert.deepEqual(seen.slice(1), [stored(1)]);
    const after = await open(t, other, "close-retry-contract");
    assert.equal(after.session.document().rows[0]?.audioText, "start");
  });

  test(`${backend}: the writer blocks opens and deletes for the same script and releases on close`, bounded, async t => {
    const { store, other } = await create(t);
    const replica = await open(t, store, "deployment/first");
    assert.deepEqual(await other.open("deployment/first", STORE_OPTIONS), locked);
    assert.deepEqual(await other.delete("deployment/first"), locked);
    const independent = await open(t, other, "deployment/second");
    seedReplica(replica.session);
    seedReplica(independent.session, { A: "second" });
    replica.session.close();
    independent.session.close();
    assert.equal((await replica.closed).kind, "stored");
    assert.equal((await independent.closed).kind, "stored");
    assert.deepEqual(await store.delete("deployment/first"), STORED);
    const replacement = await open(t, other, "deployment/first");
    assert.equal(replacement.restored, false);
    assert.equal(replacement.generation, 0);
    const remaining = await open(t, store, "deployment/second");
    assert.equal(remaining.session.document().rows[0]?.audioText, "second");
  });

  test(`${backend}: a failed session hands over its committed terminal checkpoint under the same writer`, bounded, async t => {
    const { store, other } = await create(t);
    const replica = await open(t, store, "handover-contract");
    const original = replica.session;
    seedReplica(original);
    assert.deepEqual(await replica.flush(), stored(1));
    const handover = eventResult<ReturnType<typeof replica.reopen>>();
    original.subscribe(change => {
      if (change.kind !== "closed" || change.reason !== "failed") return;
      handover.resolve(replica.reopen(original));
      change.state.fill(0);
    });
    const fault = new Error("interrupted Yjs cleanup");
    original.ydoc.once("afterTransactionCleanup", () => { throw fault; });
    assert.throws(() => typeAt(original, 0, "kept "), fault);
    assert.deepEqual(await other.open("handover-contract", STORE_OPTIONS), locked);
    const replacement = await handover.promise;
    assert.equal(replica.session, replacement);
    assert.equal(replacement.document().rows[0]?.audioText, "kept start");
    assert.deepEqual(await replica.flush(), stored(2));
    assert.deepEqual(await other.open("handover-contract", STORE_OPTIONS), locked);
    assert.deepEqual(replacement.commands.undo(), { kind: "unchanged" });
    typeAt(replacement, 0, "still ");
    replacement.close();
    assert.equal((await replica.closed).generation, 3);
    const after = await open(t, other, "handover-contract");
    assert.equal(after.session.document().rows[0]?.audioText, "still kept start");
  });

  test(`${backend}: a receipt listener can retry the failed generation immediately`, bounded, async t => {
    const { store, failAppend } = await create(t), replica = await open(t, store, "listener-retry");
    const retried = eventResult<NativeLocalStoreReceipt>();
    const unsubscribe = replica.subscribe(receipt => {
      if (receipt.kind === "failed") {
        unsubscribe();
        void replica.flush().then(retried.resolve);
      }
    });
    failAppend();
    seedReplica(replica.session);
    assert.deepEqual(await retried.promise, stored(1));
  });

  test(`${backend}: a later Yjs listener cannot change the bytes queued for an append`, bounded, async t => {
    const { store } = await create(t), replica = await open(t, store, "update-bytes");
    seedReplica(replica.session);
    assert.deepEqual(await replica.flush(), stored(1));
    replica.session.ydoc.once("update", update => update.fill(255));
    typeAt(replica.session, 0, "keep ");
    assert.deepEqual(await replica.flush(), stored(2));
    replica.session.close();
    await replica.closed;
    const after = await open(t, store, "update-bytes");
    assert.equal(after.session.document().rows[0]?.audioText, "keep start");
  });

  test(`${backend}: hydration classifies warning, limit and ceiling before admitting the first command`, bounded, async t => {
    const { store } = await create(t), replica = await open(t, store, "size");
    seedReplica(replica.session);
    assert.deepEqual(await replica.flush(), stored(1));
    const bytes = replica.session.encodeState().byteLength;
    replica.session.close();
    await replica.closed;
    for (const [kind, warning, limit, ratio] of [
      ["warning", bytes - 1, bytes + 1024, 2],
      ["full", bytes - 2, bytes - 1, 2],
      ["ceiling", bytes - 4, bytes - 3, 1.001]
    ] as const) {
      const loaded = await store.open("size", { ...STORE_OPTIONS, sizeWarning: warning, sizeLimit: limit, sizeCeilingRatio: ratio });
      assert.equal(loaded.kind, "opened");
      try {
        const { session } = loaded;
        assert.equal(session.size, kind === "warning" ? "warning" : "full");
        const at = session.commands.anchorText({ beat: "A", cell: "narration" }, 0);
        assert.equal(at.kind, "anchored");
        if (kind === "warning") assert.equal(session.commands.typeText(at.range, "x", {}).kind, "written");
        else {
          const before = session.encodeState();
          assert.deepEqual(session.commands.typeText(at.range, "x", {}), {
            kind: "recovery", reason: "full", runs: [{ text: "x", marks: {} }]
          });
          const cut = session.commands.anchorText({ beat: "A", cell: "narration" }, 0, 1);
          assert.equal(cut.kind, "anchored");
          if (kind === "ceiling") {
            assert.deepEqual(session.commands.deleteText(cut.range), { kind: "recovery", reason: "full", runs: [] });
            assert.deepEqual(session.encodeState(), before);
          } else assert.equal(session.commands.deleteText(cut.range).kind, "written");
        }
      } finally { loaded.session.close(); await loaded.closed; }
    }
  });

  test(`${backend}: a peer frame waiting for its dependency stays out of the journal until resent and applied`, bounded, async t => {
    const { store } = await create(t), replica = await open(t, store, "peer-pending");
    seedReplica(replica.session);
    assert.deepEqual(await replica.flush(), stored(1));
    const peer = new Y.Doc(), text = peer.getText("peer");
    t.after(() => peer.destroy());
    const frames: Uint8Array[] = [];
    peer.on("update", update => frames.push(update));
    text.insert(0, "first");
    text.insert(5, " second");
    const [first, second] = frames;
    assert.ok(first && second);
    assert.equal(applyNativePeerUpdate(replica.session, second), true);
    assert.deepEqual(await replica.flush(), stored(1));
    replica.session.close();
    await replica.closed;
    const reopened = await open(t, store, "peer-pending");
    assert.equal(applyNativePeerUpdate(reopened.session, first), true);
    assert.equal(reopened.session.ydoc.getText("peer").toString(), "first");
    assert.equal(applyNativePeerUpdate(reopened.session, second), true);
    assert.equal(reopened.session.ydoc.getText("peer").toString(), "first second");
    assert.deepEqual(await reopened.flush(), stored(3));
  });

  test(`${backend}: ordinary close cancels its pending checkpoint timer`, { timeout: timerTestTimeout }, async t => {
    const { store } = await create(t), replica = await open(t, store, "close-cancel");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const scheduled = t.mock.method(globalThis, "setTimeout"), canceled = t.mock.method(globalThis, "clearTimeout");
    const text = replica.session.ydoc.getText("timer");
    for (let index = 0; index < 512; index++) text.insert(index, "x");
    assert.deepEqual(await replica.flush(), stored(512));
    const timer = scheduled.mock.calls[0]?.result;
    assert.notEqual(timer, undefined);
    replica.session.close();
    assert.equal((await replica.closed).generation, 512);
    assert.ok(canceled.mock.calls.some(call => call.arguments[0] === timer));
  });

  test(`${backend}: receipt publication uses the original listener set for each generation`, bounded, async t => {
    const { store } = await create(t), replica = await open(t, store, "listeners");
    const late = t.mock.fn<(receipt: NativeLocalStoreReceipt) => void>();
    const old = t.mock.fn<(receipt: NativeLocalStoreReceipt) => void>();
    const first = replica.subscribe(() => { first(); remove(); replica.subscribe(late); });
    const remove = replica.subscribe(old);
    seedReplica(replica.session);
    assert.deepEqual(await replica.flush(), stored(1));
    assert.equal(old.mock.callCount(), 1);
    assert.equal(late.mock.callCount(), 0);
    typeAt(replica.session, 0, "next ");
    assert.deepEqual(await replica.flush(), stored(2));
    assert.equal(old.mock.callCount(), 1);
    assert.deepEqual(late.mock.calls.map(call => call.arguments[0]), [stored(2)]);
  });
}
