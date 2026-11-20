import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { forceCloseDatabase, IDBObjectStore, IDBVersionChangeEvent } from "fake-indexeddb";
import type { IDBFactory } from "fake-indexeddb";
import * as Y from "yjs";
import { createBrowserNativeLocalStore } from "../../../../src/adapters/collab/native/browser-local-store.ts";
import type { NativeLocalStore, NativeLocalStoreReceipt } from "../../../../src/adapters/collab/native/local-store.ts";
import { eventResult, failNextIdbWrite, idbDone, idbResult } from "./indexeddb-fixture.ts";
import { DB_NAME, REPLICAS, STORED, STORE_OPTIONS, fixture, seedReplica, stored, storedBytes, storedEntries, typeAt, type OpenReplica } from "./local-store-fixture.ts";

import { localStoreContract } from "./local-store-contract.ts";

const bounded = { timeout: 10000 };

localStoreContract("IndexedDB", t => {
  const { factory, store } = fixture();
  return {
    store, other: createBrowserNativeLocalStore({ indexedDB: factory, locks: navigator.locks }),
    contention: "locked",
    failAppend: reason => failNextIdbWrite(t, "add", reason === "quota" ? "quota" : "abort")
  };
});

async function open(t: TestContext, store: NativeLocalStore, name: string) {
  const replica = await store.open(name, STORE_OPTIONS);
  assert.equal(replica.kind, "opened");
  t.after(async () => { replica.session.close(); await replica.closed; });
  return replica;
}

function watchConnections(t: TestContext, factory: IDBFactory): IDBDatabase[] {
  const opened: IDBDatabase[] = [];
  const original = factory.open.bind(factory);
  t.mock.method(factory, "open", (name: string, version?: number) => {
    const request = original(name, version);
    request.addEventListener("success", () => { opened.push(request.result); });
    return request;
  });
  return opened;
}

function assertClosed(connection: IDBDatabase | undefined): void {
  assert.ok(connection);
  assert.throws(() => connection.transaction(REPLICAS), { name: "InvalidStateError" });
}

function versionChange(database: IDBDatabase): void {
  database.onversionchange?.(new IDBVersionChangeEvent("versionchange", { oldVersion: 1, newVersion: 2 }));
}

function onReceipt(replica: OpenReplica, accept: (receipt: NativeLocalStoreReceipt) => boolean) {
  const event = eventResult<NativeLocalStoreReceipt>();
  const unsubscribe = replica.subscribe(result => {
    if (accept(result)) { unsubscribe(); event.resolve(result); }
  });
  return event.promise;
}

test("A gets its commit receipt even with B queued, and aborting B reopens at A", bounded, async t => {
  const { factory, store } = fixture(), handles = watchConnections(t, factory);
  const replica = await open(t, store, "receipt-order"), { session } = replica;
  seedReplica(session);
  assert.deepEqual(await replica.flush(), stored(1));
  const seen: NativeLocalStoreReceipt[] = [];
  replica.subscribe(() => { throw new Error("subscriber failed"); });
  replica.subscribe(result => { seen.push(result); });
  const requestSucceeded = eventResult<undefined>(), add = IDBObjectStore.prototype.add;
  const observe = t.mock.method(IDBObjectStore.prototype, "add", function (this: IDBObjectStore, value: unknown) {
    observe.mock.restore();
    assert.equal(this.transaction.durability, "strict");
    const request = add.call(this, value);
    request.addEventListener("success", () => requestSucceeded.resolve(undefined));
    return request;
  });
  typeAt(session, 0, "A");
  const savedA = session.encodeState();
  await requestSucceeded.promise;
  assert.deepEqual(seen, []);
  failNextIdbWrite(t, "add", "abort");
  typeAt(session, 1, "B");
  const failed = await replica.flush();
  assert.equal(failed.kind, "failed");
  assert.equal(failed.generation, 3);
  assert.equal(failed.committed, 2);
  assert.deepEqual(seen, [stored(2), failed]);
  const database = handles[0];
  assert.ok(database);
  forceCloseDatabase(database as unknown as Parameters<typeof forceCloseDatabase>[0]);
  const lost = await replica.closed;
  assert.equal(lost.kind, "failed");
  assert.equal(lost.reason, "closed");
  assert.deepEqual(lost.state, session.encodeState());
  assert.deepEqual(session.commands.undo(), { kind: "refused", reason: "closed" });
  assertClosed(database);

  const reopened = await open(t, store, "receipt-order");
  assert.equal(reopened.generation, 2);
  assert.equal(reopened.restored, true);
  assert.deepEqual(reopened.session.encodeState(), savedA);
  assert.deepEqual(reopened.session.commands.undo(), { kind: "unchanged" });
  assert.deepEqual(reopened.session.commands.redo(), { kind: "unchanged" });
  typeAt(reopened.session, 0, "next ");
  assert.equal(reopened.session.commands.undo().kind, "written");
});

test("flush alone retries quota failures, and the next edit never jumps over a retained update", bounded, async t => {
  const { factory, store } = fixture(), replica = await open(t, store, "retry"), { session } = replica;
  seedReplica(session);
  assert.deepEqual(await replica.flush(), stored(1));
  const fail = onReceipt(replica, result => result.kind === "failed");
  failNextIdbWrite(t, "add", "quota");
  typeAt(session, 0, "A");
  const failure = await fail;
  assert.equal(failure.kind, "failed");
  assert.equal(failure.reason, "quota");
  assert.equal(failure.committed, 1);
  assert.deepEqual(await replica.flush(), stored(2));
  const seen: NativeLocalStoreReceipt[] = [];
  replica.subscribe(result => { seen.push(result); });
  failNextIdbWrite(t, "add", "abort");
  typeAt(session, 1, "B");
  const aborted = await replica.flush();
  assert.equal(aborted.kind, "failed");
  assert.equal(aborted.generation, 3);
  typeAt(session, 2, "C");
  assert.deepEqual(await replica.flush(), stored(4));
  assert.deepEqual(seen, [aborted, stored(3), stored(4)]);
  assert.deepEqual((await storedEntries(factory, "retry")).map(entry => entry.generation), [1, 2, 3, 4]);
  assert.deepEqual(await storedBytes(factory, "retry"), session.encodeState());
});

test("an error on the request is reported when the abort has no transaction error", bounded, async t => {
  const { store } = fixture(), replica = await open(t, store, "request-error");
  const add = IDBObjectStore.prototype.add;
  t.mock.method(IDBObjectStore.prototype, "add", function (this: IDBObjectStore, value: unknown) {
    this.transaction.addEventListener("abort", () => Object.defineProperty(this.transaction, "error", { value: null }));
    return add.call(this, value);
  });
  failNextIdbWrite(t, "add", "quota");
  seedReplica(replica.session);
  const result = await replica.flush();
  assert.equal(result.kind, "failed");
  assert.equal(result.reason, "quota");
});

test("a failed generation is published even when a later generation is already queued", bounded, async t => {
  const { store } = fixture(), replica = await open(t, store, "superseded"), { session } = replica;
  seedReplica(session);
  assert.deepEqual(await replica.flush(), stored(1));
  const ready = eventResult<undefined>(), add = IDBObjectStore.prototype.add;
  const observer = t.mock.method(IDBObjectStore.prototype, "add", function (this: IDBObjectStore, value: unknown) {
    observer.mock.restore();
    const request = add.call(this, value);
    request.addEventListener("success", () => { ready.resolve(undefined); this.transaction.abort(); });
    return request;
  });
  const failed = onReceipt(replica, result => result.kind === "failed");
  typeAt(session, 0, "A");
  await ready.promise;
  typeAt(session, 1, "B");
  const receipt = await failed;
  assert.equal(receipt.kind, "failed");
  assert.equal(receipt.generation, 2);
  assert.equal(receipt.committed, 1);
  assert.deepEqual(await replica.flush(), stored(3));
});

test("requested close drains an active write and retries its abort before releasing the handle", bounded, async t => {
  const { factory, store } = fixture(), handles = watchConnections(t, factory);
  const replica = await open(t, store, "close-retry");
  const receipts: NativeLocalStoreReceipt[] = [];
  replica.subscribe(result => { receipts.push(result); });
  failNextIdbWrite(t, "add", "abort");
  seedReplica(replica.session);
  const bytes = replica.session.encodeState();
  replica.session.close();
  assert.deepEqual(await replica.closed, { ...stored(1), state: bytes });
  assert.equal(receipts[0]?.kind, "failed");
  assert.deepEqual(receipts.slice(1), [stored(1)]);
  assertClosed(handles[0]);
  assert.deepEqual(await storedBytes(factory, "close-retry"), bytes);
});

test("close after an already failed append tries it once and returns the unsaved state if still failing", bounded, async t => {
  const { factory, store } = fixture(), handles = watchConnections(t, factory);
  const replica = await open(t, store, "close-failure");
  seedReplica(replica.session);
  assert.deepEqual(await replica.flush(), stored(1));
  const initial = replica.session.encodeState();
  const fail = t.mock.method(IDBObjectStore.prototype, "add", () => { throw new DOMException("full", "QuotaExceededError"); });
  typeAt(replica.session, 0, "pending ");
  assert.equal((await replica.flush()).kind, "failed");
  const edited = replica.session.encodeState();
  replica.session.close();
  const result = await replica.closed;
  assert.equal(result.kind, "failed");
  assert.equal(result.reason, "quota");
  assert.equal(result.committed, 1);
  assert.equal(result.generation, 2);
  assert.deepEqual(result.state, edited);
  assert.equal(fail.mock.callCount(), 2);
  assert.deepEqual(await replica.flush(), result);
  assert.equal(fail.mock.callCount(), 2);
  assertClosed(handles[0]);
  assert.deepEqual(await storedBytes(factory, "close-failure"), initial);
});

test("failed session close checkpoints a private copy of the terminal bytes even without an update", bounded, async t => {
  const { factory, store } = fixture(), replica = await open(t, store, "failed-session"), { session } = replica;
  seedReplica(session);
  assert.deepEqual(await replica.flush(), stored(1));
  const closed = eventResult<Uint8Array>();
  const off = t.mock.method(session.ydoc, "off");
  const changes: string[] = [];
  session.subscribe(event => {
    changes.push(event.kind);
    if (event.kind === "closed" && event.reason === "failed") {
      closed.resolve(new Uint8Array(event.state));
      event.state.fill(0);
    }
  });
  const fault = new Error("interrupted Yjs cleanup");
  session.ydoc.once("afterTransactionCleanup", () => { throw fault; });
  session.ydoc.once("destroy", () => session.ydoc.getText("detached").insert(0, "late mutation"));
  assert.throws(() => typeAt(session, 0, "kept "), fault);
  const [bytes, receipt] = await Promise.all([closed.promise, replica.closed]);
  assert.deepEqual(receipt, { ...stored(2), state: bytes });
  assert.deepEqual(changes, ["closed"]);
  assert.equal(off.mock.calls.filter(call => call.arguments[0] === "update").length, 2);
  assert.notDeepEqual(session.encodeState(), bytes);
  const entries = await storedEntries(factory, "failed-session");
  assert.deepEqual(entries.map(entry => [entry.generation, entry.checkpoint, entry.bytes]), [[2, true, bytes]]);
  const reopened = await open(t, store, "failed-session");
  assert.equal(reopened.session.document().rows[0]?.audioText, "kept start");
});

test("checkpoint and range delete commit atomically, and only one compaction can be scheduled", bounded, async t => {
  const { factory, store } = fixture(), replica = await open(t, store, "checkpoint"), { session } = replica;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  seedReplica(session);
  for (let index = 0; index < 510; index++) typeAt(session, index, "x");
  assert.deepEqual(await replica.flush(), stored(511));
  t.mock.timers.tick(0);
  assert.equal((await storedEntries(factory, "checkpoint")).length, 511);
  typeAt(session, 510, "x");
  assert.deepEqual(await replica.flush(), stored(512));
  const before = await storedEntries(factory, "checkpoint");
  assert.equal(before.length, 512);

  const aborted = onReceipt(replica, result => result.kind === "failed" && result.operation === "compact");
  failNextIdbWrite(t, "put", "abort");
  t.mock.timers.tick(0);
  assert.equal((await aborted).kind, "failed");
  assert.deepEqual(await storedEntries(factory, "checkpoint"), before);

  const synchronousFailure = onReceipt(replica, result => result.kind === "failed" && result.operation === "compact");
  const put = IDBObjectStore.prototype.put;
  const injected = t.mock.method(IDBObjectStore.prototype, "put", () => {
    injected.mock.restore();
    throw new DOMException("full", "QuotaExceededError");
  });
  typeAt(session, 0, "y");
  assert.deepEqual(await replica.flush(), stored(513));
  t.mock.timers.tick(0);
  assert.equal((await synchronousFailure).kind, "failed");
  assert.equal((await storedEntries(factory, "checkpoint")).length, 513);

  const committed = eventResult<string>(), observed = t.mock.method(IDBObjectStore.prototype, "put", function (this: IDBObjectStore, value: unknown) {
    void idbDone(this.transaction).then(committed.resolve);
    return put.call(this, value);
  });
  const scheduled = t.mock.method(globalThis, "setTimeout");
  typeAt(session, 0, "z");
  assert.deepEqual(await replica.flush(), stored(514));
  typeAt(session, 0, "w");
  assert.deepEqual(await replica.flush(), stored(515));
  assert.equal(scheduled.mock.callCount(), 1);
  t.mock.timers.tick(0);
  assert.equal(await committed.promise, "complete");
  const checkpoint = session.encodeState();
  assert.deepEqual((await storedEntries(factory, "checkpoint")).map(entry => [entry.generation, entry.checkpoint, entry.bytes]), [[515, true, checkpoint]]);
  assert.equal(observed.mock.callCount(), 1);
  typeAt(session, 0, "tail ");
  assert.deepEqual(await replica.flush(), stored(516));
  const expected = session.encodeState();
  session.close();
  assert.deepEqual(await replica.closed, { ...stored(516), state: expected });
  const after = await open(t, store, "checkpoint");
  assert.equal(after.generation, 516);
  assert.deepEqual(after.session.encodeState(), expected);
  assert.deepEqual(after.session.commands.undo(), { kind: "unchanged" });
});

test("compaction leaves uncommitted edits outside its checkpoint", bounded, async t => {
  const { factory, store } = fixture(), replica = await open(t, store, "compact-pending"), { session } = replica;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  seedReplica(session);
  for (let index = 0; index < 511; index++) typeAt(session, 0, "x");
  assert.deepEqual(await replica.flush(), stored(512));
  const before = session.encodeState();
  failNextIdbWrite(t, "add", "abort");
  typeAt(session, 0, "pending ");
  t.mock.timers.tick(0);
  assert.equal((await replica.flush()).kind, "failed");
  assert.deepEqual(await storedBytes(factory, "compact-pending"), before);
  const clock = t.mock.timers;
  const submitted = t.mock.method(IDBObjectStore.prototype, "put");
  clock.tick(0);
  assert.equal(submitted.mock.callCount(), 0);
  session.close();
  const closing = replica.closed;
  clock.tick(0);
  assert.equal((await closing).kind, "stored");
});

test("close keeps the database handle and writer lock until an active checkpoint settles", bounded, async t => {
  const { factory, store } = fixture(), handles = watchConnections(t, factory);
  const replica = await open(t, store, "close-checkpoint"), { session } = replica;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  seedReplica(session);
  for (let index = 0; index < 511; index++) typeAt(session, 0, "x");
  assert.deepEqual(await replica.flush(), stored(512));
  const complete = eventResult<() => boolean>(), put = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, "put", function (this: IDBObjectStore, value: unknown) {
    const dispatch = this.transaction.dispatchEvent.bind(this.transaction);
    t.mock.method(this.transaction, "dispatchEvent", (event: Event) => {
      if (event.type !== "complete") return dispatch(event);
      complete.resolve(() => dispatch(event));
      return true;
    });
    return put.call(this, value);
  });
  const database = handles[0];
  assert.ok(database);
  const closeHandle = t.mock.method(database, "close");
  t.mock.timers.tick(0);
  const deliver = await complete.promise;
  try {
    session.close();
    await setImmediate();
    assert.equal(closeHandle.mock.callCount(), 0);
    assert.deepEqual(await store.open("close-checkpoint", STORE_OPTIONS), { kind: "failed", reason: "locked" });
  } finally { deliver(); }
  assert.equal((await replica.closed).kind, "stored");
  assertClosed(database);
});

test("the writer lock and key range also protect delete; the close drops receipt listeners", bounded, async t => {
  const { factory, store } = fixture(), handles = watchConnections(t, factory);
  const replica = await open(t, store, "deployment/first");
  const otherTab = createBrowserNativeLocalStore({ indexedDB: factory, locks: navigator.locks });
  const locked = { kind: "failed", reason: "locked" };
  assert.deepEqual(await otherTab.open("deployment/first", STORE_OPTIONS), locked);
  assert.deepEqual(await otherTab.delete("deployment/first"), locked);
  const independent = await open(t, otherTab, "deployment/second");
  seedReplica(independent.session);
  seedReplica(replica.session);
  const otherBytes = independent.session.encodeState();
  independent.session.close();
  await independent.closed;
  const listener = t.mock.fn<(receipt: NativeLocalStoreReceipt) => void>();
  replica.subscribe(listener);
  const detached = t.mock.fn<(receipt: NativeLocalStoreReceipt) => void>();
  replica.subscribe(detached)();
  const clear = Set.prototype.clear;
  let cleared = false;
  t.mock.method(Set.prototype, "clear", function (this: Set<unknown>) {
    if (this.has(listener)) cleared = true;
    clear.call(this);
  });
  replica.session.close();
  await replica.closed;
  assert.equal(cleared, true);
  assert.equal(detached.mock.callCount(), 0);
  assertClosed(handles[0]);
  assertClosed(handles[1]);
  assert.deepEqual(await store.delete("deployment/first"), STORED);
  assertClosed(handles[2]);
  assert.deepEqual(await storedEntries(factory, "deployment/first"), []);
  assert.deepEqual(await storedBytes(factory, "deployment/second"), otherBytes);
  const replacement = await open(t, otherTab, "deployment/first");
  assert.equal(replacement.restored, false);
  assert.equal(replacement.generation, 0);
});

test("lock request rejection is an outcome; close waits for the real lock release", bounded, async t => {
  const { factory, store } = fixture();
  const denied = createBrowserNativeLocalStore({
    indexedDB: factory, locks: { request: () => Promise.reject(new Error("lock service denied request")) }
  });
  const refusal = await denied.open("reject", STORE_OPTIONS);
  assert.equal(refusal.kind, "failed");
  assert.equal(refusal.reason, "io");

  const entered = eventResult<undefined>(), unblock = eventResult<undefined>();
  const request = navigator.locks.request.bind(navigator.locks);
  const locks = { request };
  t.mock.method(locks, "request", (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) =>
    request(name, options, async lock => {
      await callback(lock);
      entered.resolve(undefined);
      await unblock.promise;
    }));
  const delayed = createBrowserNativeLocalStore({ indexedDB: factory, locks });
  const replica = await open(t, delayed, "release");
  replica.session.close();
  try {
    await entered.promise;
    assert.equal(await Promise.race([replica.closed, Promise.resolve("waiting")]), "waiting");
    assert.deepEqual(await store.open("release", STORE_OPTIONS), { kind: "failed", reason: "locked" });
  } finally { unblock.resolve(undefined); }
  await replica.closed;
  assert.equal((await open(t, store, "release")).restored, false);
});

test("a version change closes the old session before an active append can release its lock", bounded, async t => {
  const { factory, store } = fixture(), handles = watchConnections(t, factory);
  const replica = await open(t, store, "version"), { session } = replica;
  seedReplica(session);
  assert.deepEqual(await replica.flush(), stored(1));
  const queued = eventResult<undefined>(), add = IDBObjectStore.prototype.add;
  const watcher = t.mock.method(IDBObjectStore.prototype, "add", function (this: IDBObjectStore, value: unknown) {
    const request = add.call(this, value);
    request.addEventListener("success", () => queued.resolve(undefined));
    return request;
  });
  const seen: NativeLocalStoreReceipt[] = [];
  replica.subscribe(result => { seen.push(result); });
  const off = t.mock.method(session.ydoc, "off");
  typeAt(session, 0, "active ");
  const active = session.encodeState();
  await queued.promise;
  typeAt(session, 0, "queued ");
  const final = session.encodeState();
  const database = handles[0];
  assert.ok(database);
  versionChange(database);
  assertClosed(database);
  assert.equal(off.mock.calls.some(call => call.arguments[0] === "update"), true);
  assert.deepEqual(session.commands.undo(), { kind: "refused", reason: "closed" });
  const result = { kind: "failed", reason: "version", generation: 3, committed: 2 };
  assert.deepEqual(await replica.closed, { ...result, state: final });
  assert.deepEqual(seen, [stored(2), result]);
  assert.equal(watcher.mock.callCount(), 1);
  assertClosed(database);
  assert.deepEqual(await storedBytes(factory, "version"), active);
  const upgraded = await idbResult(factory.open(DB_NAME, 2));
  upgraded.close();
  const old = await store.open("version", STORE_OPTIONS);
  assert.equal(old.kind, "failed");
  assert.equal(old.reason, "version");
});

test("a bare connection blocking a delete also bounds a later open and closes its late handle", bounded, async t => {
  const { factory, store } = fixture();
  const first = await open(t, store, "initial");
  first.session.close();
  await first.closed;
  const blocker = await idbResult(factory.open(DB_NAME));
  t.after(() => blocker.close());
  const deletion = factory.deleteDatabase(DB_NAME);
  const deleted = idbResult(deletion);
  await new Promise<void>(resolve => { deletion.onblocked = () => resolve(); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const issued = eventResult<IDBOpenDBRequest>();
  const original = factory.open.bind(factory);
  t.mock.method(factory, "open", (name: string, version?: number) => {
    const request = original(name, version);
    issued.resolve(request);
    return request;
  });
  const opening = store.open("queued-open", STORE_OPTIONS);
  const request = await issued.promise;
  t.mock.timers.tick(2000);
  assert.deepEqual(await opening, { kind: "failed", reason: "blocked" });
  const late = assert.rejects(idbResult(request), { name: "AbortError" });
  blocker.close();
  await deleted;
  await late;
  assert.equal((await open(t, store, "queued-open")).restored, false);
});

test("a directly blocked upgrade releases the lock and a refused upgrade cannot change the schema later", bounded, async t => {
  const { factory, store } = fixture(), original = factory.open.bind(factory);
  const blocker = await idbResult(original(DB_NAME, 1));
  t.after(() => blocker.close());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const issued = eventResult<IDBOpenDBRequest>();
  const mock = t.mock.method(factory, "open", (name: string) => {
    const request = original(name, 2);
    issued.resolve(request);
    return request;
  });
  const opening = store.open("blocked", STORE_OPTIONS);
  const request = await issued.promise;
  const done = assert.rejects(idbResult(request), { name: "AbortError" });
  assert.deepEqual(await opening, { kind: "failed", reason: "blocked" });
  blocker.close();
  await done;
  mock.mock.restore();
  const same = await idbResult(original(DB_NAME));
  try { assert.equal(same.version, 1); } finally { same.close(); }
});

test("a late successful database open closes its handle after reporting its timeout", bounded, async t => {
  const { factory, store } = fixture();
  const initial = await open(t, store, "slow");
  initial.session.close();
  await initial.closed;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = eventResult<{ request: IDBOpenDBRequest; deliver: () => boolean }>();
  const original = factory.open.bind(factory);
  const slow = t.mock.method(factory, "open", (name: string, version?: number) => {
    const request = original(name, version), dispatch = request.dispatchEvent.bind(request);
    t.mock.method(request, "dispatchEvent", (event: Event) => {
      if (event.type !== "success") return dispatch(event);
      held.resolve({ request, deliver: () => dispatch(event) });
      return true;
    });
    return request;
  });
  const opening = store.open("slow", STORE_OPTIONS);
  const { request, deliver } = await held.promise;
  t.mock.timers.tick(2000);
  assert.deepEqual(await opening, { kind: "failed", reason: "blocked" });
  try { deliver(); assertClosed(request.result); }
  finally { request.result.close(); }
  slow.mock.restore();
  assert.equal((await open(t, store, "slow")).restored, false);
});

for (const reason of ["io", "closed", "version"] as const) {
  test(`hydration settles a read abort as ${reason} and releases both the connection and lock`, bounded, async t => {
    const { factory, store } = fixture(), handles = watchConnections(t, factory);
    const getAll = IDBObjectStore.prototype.getAll;
    const hook = t.mock.method(IDBObjectStore.prototype, "getAll", function (this: IDBObjectStore, range?: IDBValidKey | IDBKeyRange) {
      hook.mock.restore();
      const request = getAll.call(this, range);
      request.addEventListener("success", () => {
        const database = this.transaction.db;
        if (reason === "version") versionChange(database);
        if (reason === "closed") database.onclose?.(new Event("close"));
        this.transaction.abort();
      });
      return request;
    });
    const result = await store.open("read-abort", STORE_OPTIONS);
    assert.equal(result.kind, "failed");
    assert.equal(result.reason, reason);
    assertClosed(handles[0]);
    assert.equal((await open(t, store, "read-abort")).restored, false);
  });
}

test("invalid persisted bytes and failed deletes close their handles", bounded, async t => {
  const { factory, store } = fixture(), handles = watchConnections(t, factory);
  const initial = await open(t, store, "invalid");
  initial.session.close();
  await initial.closed;
  const database = await idbResult(factory.open(DB_NAME));
  try {
    const tx = database.transaction(REPLICAS, "readwrite");
    tx.objectStore(REPLICAS).add({ name: "invalid", generation: 1, bytes: "not bytes", checkpoint: false });
    assert.equal(await idbDone(tx), "complete");
  } finally { database.close(); }
  const destroyed = t.mock.method(Y.Doc.prototype, "destroy");
  const corrupt = await store.open("invalid", STORE_OPTIONS);
  assert.equal(corrupt.kind, "failed");
  assert.equal(corrupt.reason, "io");
  assert.equal((corrupt.error as Error).message, "Invalid replica bytes");
  assert.equal(destroyed.mock.callCount(), 1);
  const scratch = destroyed.mock.calls[0]?.this;
  assert.ok(scratch instanceof Y.Doc);
  assert.equal(scratch.isDestroyed, true);
  assertClosed(handles[2]);
  const fault = t.mock.method(IDBObjectStore.prototype, "delete", () => { throw new DOMException("full", "QuotaExceededError"); });
  const denied = await store.delete("invalid");
  assert.equal(denied.kind, "failed");
  assert.equal(denied.reason, "quota");
  assertClosed(handles[3]);
  fault.mock.restore();
  assert.deepEqual(await store.delete("invalid"), STORED);
  assertClosed(handles[4]);
});

test("missing storage facilities refuse open and persistence availability is reported separately", bounded, async t => {
  const { factory } = fixture(), unsupported = { kind: "failed", reason: "unavailable" };
  assert.deepEqual(await createBrowserNativeLocalStore({ indexedDB: factory }).open("no-locks", STORE_OPTIONS), unsupported);
  assert.deepEqual(await createBrowserNativeLocalStore({ locks: navigator.locks }).open("no-db", STORE_OPTIONS), unsupported);
  const options = { indexedDB: factory, locks: navigator.locks };
  const absent = await open(t, createBrowserNativeLocalStore(options), "persistence-absent");
  assert.equal(await absent.persistent, false);
  const granted = t.mock.fn(async () => true);
  const allowed = await open(t, createBrowserNativeLocalStore({ ...options, storage: { persist: granted } }), "persistence");
  assert.equal(await allowed.persistent, true);
  assert.equal(granted.mock.callCount(), 1);
  const denied = await open(t, createBrowserNativeLocalStore({
    ...options, storage: { persist: () => Promise.reject(new Error("retention denied")) }
  }), "denied");
  assert.equal(await denied.persistent, false);
  seedReplica(denied.session);
  assert.deepEqual(await denied.flush(), stored(1));
});

test("the busy append queue checkpoints before its tail can grow past 2048 records", bounded, async t => {
  const { factory, store } = fixture(), replica = await open(t, store, "busy-checkpoint");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const commits: number[] = [];
  replica.subscribe(result => { if (result.kind === "stored") commits.push(result.generation); });
  let tail = 0, maxTail = 0;
  const checkpointAt: number[] = [], add = IDBObjectStore.prototype.add, put = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, "add", function (this: IDBObjectStore, value: unknown) {
    this.transaction.addEventListener("complete", () => { maxTail = Math.max(maxTail, ++tail); });
    return add.call(this, value);
  });
  t.mock.method(IDBObjectStore.prototype, "put", function (this: IDBObjectStore, value: unknown) {
    this.transaction.addEventListener("complete", () => { checkpointAt.push(commits.length); tail = 0; });
    return put.call(this, value);
  });
  failNextIdbWrite(t, "put", "abort");
  const text = replica.session.ydoc.getText("busy");
  const scheduled = t.mock.method(globalThis, "setTimeout"), canceled = t.mock.method(globalThis, "clearTimeout");
  for (let index = 0; index < 512; index++) text.insert(index, "x");
  assert.deepEqual(await replica.flush(), stored(512));
  const timer = scheduled.mock.calls[0]?.result;
  assert.notEqual(timer, undefined);
  for (let index = 512; index < 4300; index++) text.insert(index, "x");
  try {
    const failed = await replica.flush();
    assert.equal(failed.kind, "failed");
    assert.equal(failed.operation, "compact");
    assert.equal(failed.committed, 2048);
    assert.equal(commits.length, 2048);
    assert.ok(canceled.mock.calls.some(call => call.arguments[0] === timer));
    assert.deepEqual(await replica.flush(), stored(4300));
    assert.equal(maxTail, 2048);
    assert.deepEqual(checkpointAt, [2048, 4096]);
    assert.deepEqual(commits, Array.from({ length: 4300 }, (_, i) => i + 1));
    assert.deepEqual(await storedBytes(factory, "busy-checkpoint"), replica.session.encodeState());
  } finally {
    replica.session.close();
    t.mock.timers.tick(0);
    await replica.closed;
  }
});

test("the recovery checkpoint can replace a full tail without an intervening compaction read", bounded, async t => {
  const { store, factory } = fixture(), replica = await open(t, store, "full-tail-recovery"), { session } = replica;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  seedReplica(session);
  const text = session.ydoc.getText("tail");
  for (let index = 0; index < 2047; index++) text.insert(index, "x");
  assert.deepEqual(await replica.flush(), stored(2048));
  const reads = t.mock.method(IDBObjectStore.prototype, "getAll");
  const fault = new Error("interrupted cleanup");
  session.ydoc.once("afterTransactionCleanup", () => { throw fault; });
  assert.throws(() => typeAt(session, 0, "recovered "), fault);
  assert.equal((await replica.closed).generation, 2049);
  assert.equal(reads.mock.callCount(), 0);
  assert.deepEqual((await storedEntries(factory, "full-tail-recovery")).map(row => [row.generation, row.checkpoint]), [[2049, true]]);
});

for (const phase of ["queued", "committed"] as const) {
  test(`an idle compaction drops its read when a newer recovery checkpoint is ${phase}`, bounded, async t => {
    const { store, factory } = fixture(), replica = await open(t, store, `superseded-${phase}`), { session } = replica;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    seedReplica(session);
    const text = session.ydoc.getText("tail");
    for (let index = 0; index < 511; index++) text.insert(index, "x");
    assert.deepEqual(await replica.flush(), stored(512));

    const readReady = eventResult<() => boolean>(), getAll = IDBObjectStore.prototype.getAll;
    const holdRead = t.mock.method(IDBObjectStore.prototype, "getAll", function (this: IDBObjectStore, range?: IDBValidKey | IDBKeyRange) {
      holdRead.mock.restore();
      const dispatch = this.transaction.dispatchEvent.bind(this.transaction);
      t.mock.method(this.transaction, "dispatchEvent", (event: Event) => {
        if (event.type !== "complete") return dispatch(event);
        readReady.resolve(() => dispatch(event));
        return true;
      });
      return getAll.call(this, range);
    });
    const writeReady = eventResult<() => boolean>(), put = IDBObjectStore.prototype.put;
    const writes = t.mock.method(IDBObjectStore.prototype, "put", function (this: IDBObjectStore, value: unknown) {
      if (phase === "queued" && writes.mock.callCount() === 0) {
        const dispatch = this.transaction.dispatchEvent.bind(this.transaction);
        t.mock.method(this.transaction, "dispatchEvent", (event: Event) => {
          if (event.type !== "complete") return dispatch(event);
          writeReady.resolve(() => dispatch(event));
          return true;
        });
      }
      return put.call(this, value);
    });
    t.mock.timers.tick(0);
    const deliverRead = await readReady.promise;
    let replacement: Promise<OpenReplica["session"]> | undefined;
    session.subscribe(change => {
      if (change.kind === "closed" && change.reason === "failed") replacement = replica.reopen(session);
    });
    const storedRecovery = onReceipt(replica, result => result.kind === "stored" && result.generation === 513);
    const fault = new Error("interrupted cleanup");
    session.ydoc.once("afterTransactionCleanup", () => { throw fault; });
    assert.throws(() => typeAt(session, 0, "recovered "), fault);
    if (phase === "queued") {
      const deliverWrite = await writeReady.promise;
      try { deliverRead(); await setImmediate(); }
      finally { deliverWrite(); }
    } else {
      try { assert.deepEqual(await storedRecovery, stored(513)); }
      finally { deliverRead(); }
    }
    assert.ok(replacement);
    const reopened = await replacement;
    assert.equal(reopened.document().rows[0]?.audioText, "recovered start");
    assert.deepEqual((await storedEntries(factory, `superseded-${phase}`)).map(row => [row.generation, row.checkpoint]), [[513, true]]);
    assert.equal(writes.mock.callCount(), 1);

    const tail = reopened.ydoc.getText("tail");
    for (let index = 0; index < 511; index++) tail.insert(0, "x");
    assert.deepEqual(await replica.flush(), stored(1024));
    const reads = t.mock.method(IDBObjectStore.prototype, "getAll");
    t.mock.timers.tick(0);
    assert.equal(reads.mock.callCount(), 0);
  });
}

test("capacity to open the next writer after loss does not depend on a pending checkpoint timer", bounded, async t => {
  const { factory, store } = fixture(), handles = watchConnections(t, factory);
  const replica = await open(t, store, "timer-loss");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const text = replica.session.ydoc.getText("timer");
  for (let index = 0; index < 512; index++) text.insert(index, "x");
  assert.deepEqual(await replica.flush(), stored(512));
  const database = handles[0];
  assert.ok(database);
  const cancel = t.mock.method(globalThis, "clearTimeout");
  versionChange(database);
  assert.equal(cancel.mock.callCount(), 1);
  const barrier = setImmediate("pending");
  try {
    assert.notEqual(await Promise.race([replica.closed, barrier]), "pending");
    const next = await open(t, store, "timer-loss");
    assert.equal(next.generation, 512);
  } finally { t.mock.timers.tick(0); }
});

test("a checkpoint leaves generations committed after its read watermark on disk", bounded, async t => {
  const { factory, store } = fixture(), replica = await open(t, store, "watermark");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const text = replica.session.ydoc.getText("watermark");
  for (let index = 0; index < 512; index++) text.insert(index, "x");
  assert.deepEqual(await replica.flush(), stored(512));
  const held = eventResult<() => boolean>(), getAll = IDBObjectStore.prototype.getAll;
  const capture = t.mock.method(IDBObjectStore.prototype, "getAll", function (this: IDBObjectStore, range?: IDBValidKey | IDBKeyRange) {
    capture.mock.restore();
    const dispatch = this.transaction.dispatchEvent.bind(this.transaction);
    t.mock.method(this.transaction, "dispatchEvent", (event: Event) => {
      if (event.type !== "complete") return dispatch(event);
      held.resolve(() => dispatch(event));
      return true;
    });
    return getAll.call(this, range);
  });
  const checkpointed = eventResult<string>(), put = IDBObjectStore.prototype.put;
  const watch = t.mock.method(IDBObjectStore.prototype, "put", function (this: IDBObjectStore, value: unknown) {
    void idbDone(this.transaction).then(checkpointed.resolve);
    return put.call(this, value);
  });
  t.mock.timers.tick(0);
  const deliver = await held.promise;
  try {
    text.insert(512, "tail");
    assert.deepEqual(await replica.flush(), stored(513));
  } finally { deliver(); }
  assert.equal(await checkpointed.promise, "complete");
  assert.deepEqual((await storedEntries(factory, "watermark")).map(entry => [entry.generation, entry.checkpoint]), [[512, true], [513, false]]);
  const expected = replica.session.encodeState();
  replica.session.close();
  await replica.closed;
  const reopened = await open(t, store, "watermark");
  assert.deepEqual(reopened.session.encodeState(), expected);
  reopened.session.ydoc.getText("watermark").insert(0, "next");
  assert.deepEqual(await reopened.flush(), stored(514));
  const reading = t.mock.method(IDBObjectStore.prototype, "getAll");
  t.mock.timers.tick(0);
  assert.equal(reading.mock.callCount(), 0);
  assert.equal(watch.mock.callCount(), 1);
  assert.deepEqual((await storedEntries(factory, "watermark")).map(entry => entry.generation), [512, 513, 514]);
});

test("a scheduled checkpoint rechecks the closing session before it reads the journal", bounded, async t => {
  const { store } = fixture(), replica = await open(t, store, "closing-timer");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const text = replica.session.ydoc.getText("timer");
  for (let index = 0; index < 512; index++) text.insert(index, "x");
  assert.deepEqual(await replica.flush(), stored(512));
  const read = t.mock.method(IDBObjectStore.prototype, "getAll");
  replica.session.close();
  t.mock.timers.tick(0);
  await replica.closed;
  assert.equal(read.mock.callCount(), 0);
});

test("loss during a failed session close forbids the terminal checkpoint", bounded, async t => {
  const { factory, store } = fixture(), handles = watchConnections(t, factory);
  const { session, flush, closed } = await open(t, store, "failed-after-loss");
  seedReplica(session);
  assert.deepEqual(await flush(), stored(1));
  const confirmed = session.encodeState(), puts = t.mock.method(IDBObjectStore.prototype, "put");
  const cause = new Error("Yjs cleanup stopped");
  session.ydoc.once("afterTransactionCleanup", () => { throw cause; });
  assert.throws(() => typeAt(session, 0, "unconfirmed "), cause);
  const database = handles[0];
  assert.ok(database);
  versionChange(database);
  assertClosed(database);
  const result = await closed;
  assert.equal(result.kind, "failed");
  assert.equal(result.reason, "version");
  assert.equal(result.generation, 1);
  assert.equal(result.committed, 1);
  assert.notDeepEqual(result.state, confirmed);
  assert.equal(puts.mock.callCount(), 0);
  assert.deepEqual(await storedBytes(factory, "failed-after-loss"), confirmed);
});

test("loss while awaiting a hard checkpoint stops the append waiting behind it", bounded, async t => {
  const { store, factory } = fixture(), handles = watchConnections(t, factory);
  const replica = await open(t, store, "hard-checkpoint-loss");
  const writing = eventResult<undefined>(), put = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, "put", function (this: IDBObjectStore, value: unknown) {
    const request = put.call(this, value);
    request.addEventListener("success", () => writing.resolve(undefined));
    return request;
  });
  const failures: NativeLocalStoreReceipt[] = [];
  replica.subscribe(result => { if (result.kind === "failed") failures.push(result); });
  const text = replica.session.ydoc.getText("loss");
  for (let index = 0; index < 2049; index++) text.insert(index, "x");
  await writing.promise;
  const database = handles[0];
  assert.ok(database);
  versionChange(database);
  const result = await replica.closed;
  assert.equal(result.kind, "failed");
  assert.deepEqual(failures, [{ kind: "failed", reason: "version", generation: 2049, committed: 2048 }]);
  assert.deepEqual((await storedEntries(factory, "hard-checkpoint-loss")).map(entry => entry.generation), [2048]);
});

test("appending an existing record key fails without replacing that record", bounded, async t => {
  const { factory, store } = fixture(), replica = await open(t, store, "duplicate");
  seedReplica(replica.session);
  assert.deepEqual(await replica.flush(), stored(1));
  const committed = await storedEntries(factory, "duplicate"), original = committed[0];
  assert.ok(original);
  const database = await idbResult(factory.open(DB_NAME));
  try {
    const tx = database.transaction(REPLICAS, "readwrite");
    tx.objectStore(REPLICAS).add({ ...original, name: "duplicate", generation: 2 });
    assert.equal(await idbDone(tx), "complete");
  } finally { database.close(); }
  typeAt(replica.session, 0, "duplicate ");
  const result = await replica.flush();
  assert.equal(result.kind, "failed");
  assert.equal(result.generation, 2);
  assert.equal(result.committed, 1);
  assert.ok(result.error instanceof DOMException);
  assert.equal(result.error.name, "ConstraintError");
  assert.deepEqual((await storedEntries(factory, "duplicate"))[1]?.bytes, original.bytes);
});
