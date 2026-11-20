import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { forceCloseDatabase, IDBObjectStore, IDBVersionChangeEvent } from "fake-indexeddb";
import { createBrowserNativeLocalStore } from "../../../../src/adapters/collab/native/browser-local-store.ts";
import type { NativeLocalStore, NativeLocalStoreFailure, NativeLocalStoreReceipt } from "../../../../src/adapters/collab/native/local-store.ts";
import { eventResult, failNextIdbWrite, idbDone, idbResult } from "./indexeddb-fixture.ts";
import { DB_NAME, REPLICAS, STORED, STORE_OPTIONS, fixture, seedReplica, storedBytes, typeAt, type OpenReplica } from "./local-store-fixture.ts";

const bounded = { timeout: 5000 };

async function open(t: TestContext, store: NativeLocalStore, name: string) {
  const replica = await store.open(name, STORE_OPTIONS);
  assert.equal(replica.kind, "opened");
  t.after(async () => { replica.session.close(); await replica.closed; });
  return replica;
}

function nextFailure(replica: OpenReplica): Promise<NativeLocalStoreFailure> {
  return new Promise(resolve => {
    const unsubscribe = replica.subscribe(receipt => {
      if (receipt.kind === "failed") { unsubscribe(); resolve(receipt); }
    });
  });
}

function connectionFrom(request: IDBOpenDBRequest | undefined): IDBDatabase {
  assert.ok(request);
  return request.result;
}

test("local store saves edits before a same-turn flush and hydrates on restart with fresh undo", bounded, async t => {
  const { factory, store } = fixture(), opened = t.mock.method(factory, "open");
  const before = await open(t, store, "restart");
  assert.equal(before.restored, false);
  assert.equal(await before.persistent, false);
  seedReplica(before.session);
  typeAt(before.session, 0, "re");
  const bytes = before.session.encodeState();
  const expected = before.session.document();
  assert.deepEqual(await before.flush(), STORED);
  const connection = connectionFrom(opened.mock.calls[0]?.result);
  assert.deepEqual(await storedBytes(factory, "restart"), bytes);
  const lost = nextFailure(before);
  forceCloseDatabase(connection as unknown as Parameters<typeof forceCloseDatabase>[0]);
  assert.deepEqual(await lost, { kind: "failed", reason: "closed" });
  assert.deepEqual(await before.closed, { kind: "failed", reason: "closed" });
  assert.equal(before.session.ydoc.isDestroyed, false);
  typeAt(before.session, 0, "unsaved ");
  assert.deepEqual(await before.flush(), { kind: "failed", reason: "closed" });

  const after = await open(t, store, "restart");
  assert.equal(after.restored, true);
  assert.deepEqual(after.session.document(), expected);
  assert.deepEqual(after.session.commands.undo(), { kind: "unchanged" });
  assert.deepEqual(after.session.commands.redo(), { kind: "unchanged" });
  typeAt(after.session, 0, "next ");
  assert.equal(after.session.commands.undo().kind, "written");
  assert.deepEqual(after.session.document(), expected);
});

test("writes start automatically, coalesce while queued, and report only when the latest transaction completes", bounded, async t => {
  const { factory, store } = fixture(), { session, flush, subscribe } = await open(t, store, "commit");
  const receipts = t.mock.fn<(receipt: NativeLocalStoreReceipt) => void>();
  subscribe(receipts);
  const success = eventResult<undefined>();
  const put = IDBObjectStore.prototype.put;
  let complete = false;
  const observed = t.mock.method(IDBObjectStore.prototype, "put", function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    assert.equal(this.transaction.durability, "strict");
    const request = put.call(this, value, key);
    request.addEventListener("success", () => success.resolve(undefined));
    this.transaction.addEventListener("complete", () => { complete = true; });
    return request;
  });
  seedReplica(session);
  await success.promise;
  assert.equal(complete, false);
  typeAt(session, 0, "a");
  await Promise.resolve();
  typeAt(session, 1, "b");
  await Promise.resolve();
  const receipt = flush();
  assert.equal(await Promise.race([receipt, Promise.resolve("pending")]), "pending");
  assert.deepEqual(await receipt, STORED);
  assert.equal(observed.mock.callCount(), 2);
  assert.deepEqual(receipts.mock.calls.map(call => call.arguments[0]), [STORED]);
  assert.deepEqual(await storedBytes(factory, "commit"), session.encodeState());
});

test("an abort after request success leaves exactly the previous committed state", bounded, async t => {
  const { factory, store } = fixture(), replica = await open(t, store, "abort");
  const { session, flush } = replica;
  seedReplica(session);
  assert.deepEqual(await flush(), STORED);
  const before = session.encodeState();
  const failed = nextFailure(replica);
  failNextIdbWrite(t, "put", "abort");
  typeAt(session, 0, "interrupted ");
  const result = await flush();
  assert.equal(result.kind, "failed");
  assert.equal(result.reason, "io");
  assert.equal(await failed, result);
  assert.deepEqual(await storedBytes(factory, "abort"), before);
  assert.equal(session.document().rows[0]?.audioText, "interrupted start");
});

test("snapshot encoding failure is a write outcome and leaves the prior committed bytes", bounded, async t => {
  const { factory, store } = fixture(), replica = await open(t, store, "encode-error");
  const { session, flush } = replica;
  seedReplica(session);
  assert.deepEqual(await flush(), STORED);
  const before = session.encodeState();
  typeAt(session, 0, "pending ");
  const fault = new Error("encoder interrupted");
  const mock = t.mock.method(session.ydoc.store.clients, "forEach", () => { throw fault; });
  try {
    assert.deepEqual(await flush(), { kind: "failed", reason: "io", error: fault });
  } finally { mock.mock.restore(); }
  assert.deepEqual(await storedBytes(factory, "encode-error"), before);
  typeAt(session, 0, "next ");
  assert.deepEqual(await flush(), STORED);
  assert.deepEqual(await storedBytes(factory, "encode-error"), session.encodeState());
});

test("quota failure surfaces without polling and a later write saves both edits", bounded, async t => {
  const { factory, store } = fixture(), replica = await open(t, store, "quota");
  const { session, flush } = replica;
  seedReplica(session);
  assert.deepEqual(await flush(), STORED);
  const before = session.encodeState();
  const throwing = t.mock.fn(() => { throw new Error("status listener failed"); });
  const unsubscribe = replica.subscribe(throwing);
  const failed = nextFailure(replica);
  failNextIdbWrite(t, "put", "quota");
  typeAt(session, 0, "x");
  const result = await failed;
  assert.equal(result.reason, "quota");
  assert.equal(await flush(), result);
  assert.deepEqual(await storedBytes(factory, "quota"), before);
  unsubscribe();
  typeAt(session, 1, "y");
  assert.deepEqual(await flush(), STORED);
  assert.equal(throwing.mock.callCount(), 1);
  assert.deepEqual(await storedBytes(factory, "quota"), session.encodeState());
  const secondFailure = nextFailure(replica);
  failNextIdbWrite(t, "put", "quota");
  typeAt(session, 2, "z");
  assert.equal((await secondFailure).reason, "quota");
});

test("failed close persists the terminal state even when Yjs sends no update", bounded, async t => {
  const { factory, store } = fixture(), before = await open(t, store, "failed-session");
  const { session } = before;
  seedReplica(session);
  assert.deepEqual(await before.flush(), STORED);
  const close = eventResult<Uint8Array>();
  const changes: string[] = [];
  session.subscribe(event => {
    changes.push(event.kind);
    if (event.kind === "closed" && event.reason === "failed") close.resolve(event.state);
  });
  const fault = new Error("interrupted Yjs cleanup");
  session.ydoc.once("afterTransactionCleanup", () => { throw fault; });
  session.ydoc.once("destroy", () => session.ydoc.getText("detached").insert(0, "late mutation"));
  assert.throws(() => typeAt(session, 0, "kept "), fault);
  const [bytes, closed] = await Promise.all([close.promise, before.closed]);
  assert.deepEqual(closed, STORED);
  assert.deepEqual(changes, ["closed"]);
  assert.notDeepEqual(session.encodeState(), bytes);
  assert.deepEqual(await storedBytes(factory, "failed-session"), bytes);
  const after = await open(t, store, "failed-session");
  assert.equal(after.session.document().rows[0]?.audioText, "kept start");
});

test("a second tab cannot open or delete a writable replica and can take over after the close drains", bounded, async t => {
  const { factory, store } = fixture(), a = await open(t, store, "two-tabs");
  const otherTab = createBrowserNativeLocalStore({ indexedDB: factory, locks: navigator.locks });
  const locked = { kind: "failed", reason: "locked" };
  assert.deepEqual(await otherTab.open("two-tabs", STORE_OPTIONS), locked);
  assert.deepEqual(await otherTab.delete("two-tabs"), locked);
  const independent = await open(t, otherTab, "different-document");
  independent.session.close();
  assert.deepEqual(await independent.closed, STORED);
  assert.equal(await storedBytes(factory, "different-document"), undefined);
  seedReplica(a.session);
  typeAt(a.session, 0, "last ");
  const expected = a.session.encodeState();
  a.session.close();
  assert.deepEqual(await a.closed, STORED);
  const b = await open(t, otherTab, "two-tabs");
  assert.deepEqual(b.session.encodeState(), expected);
  typeAt(b.session, 0, "new ");
  assert.deepEqual(await b.flush(), STORED);
  b.session.close();
  assert.deepEqual(await b.closed, STORED);
  assert.deepEqual(await store.delete("two-tabs"), STORED);
  assert.equal((await open(t, store, "two-tabs")).restored, false);
});

test("deletion replaces no other replica and a replacement name opens empty", bounded, async t => {
  const { factory, store } = fixture();
  for (const name of ["deployment-a/instance", "deployment-b/instance"]) {
    const replica = await open(t, store, name);
    seedReplica(replica.session, { A: name });
    replica.session.close();
    assert.deepEqual(await replica.closed, STORED);
  }
  const other = await storedBytes(factory, "deployment-b/instance");
  assert.ok(other);
  assert.equal((await open(t, store, "deployment-a/replacement")).restored, false);
  assert.deepEqual(await store.delete("deployment-a/instance"), STORED);
  assert.equal(await storedBytes(factory, "deployment-a/instance"), undefined);
  assert.deepEqual(await storedBytes(factory, "deployment-b/instance"), other);
});

test("a database upgrade releases the old tab and preserves its confirmed replica bytes", bounded, async t => {
  const { factory, store } = fixture(), a = await open(t, store, "upgrade");
  seedReplica(a.session);
  assert.deepEqual(await a.flush(), STORED);
  const expected = a.session.encodeState();
  const changed = nextFailure(a);
  const upgraded = await idbResult(factory.open(DB_NAME, 2));
  t.after(() => upgraded.close());
  const result = { kind: "failed", reason: "version" };
  assert.deepEqual(await changed, result);
  assert.deepEqual(await a.closed, result);
  typeAt(a.session, 0, "later ");
  assert.deepEqual(await a.flush(), result);
  assert.deepEqual(await storedBytes(factory, "upgrade"), expected);
  const reopen = await store.open("upgrade", STORE_OPTIONS);
  assert.equal(reopen.kind, "failed");
  assert.equal(reopen.reason, "version");
});

test("an upgrade lets the active transaction finish and refuses the queued snapshot", bounded, async t => {
  const { factory, store } = fixture(), observed = t.mock.method(factory, "open");
  const replica = await open(t, store, "upgrade-in-flight");
  const { session } = replica;
  seedReplica(session);
  assert.deepEqual(await replica.flush(), STORED);
  const database = connectionFrom(observed.mock.calls[0]?.result);
  const put = IDBObjectStore.prototype.put;
  const writing = eventResult<undefined>();
  t.mock.method(IDBObjectStore.prototype, "put", function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = put.call(this, value, key);
    request.addEventListener("success", () => writing.resolve(undefined));
    return request;
  });
  const receipts = t.mock.fn<(receipt: NativeLocalStoreReceipt) => void>();
  replica.subscribe(receipts);
  typeAt(session, 0, "active ");
  const active = session.encodeState();
  await writing.promise;
  typeAt(session, 0, "queued ");
  await Promise.resolve();
  database.onversionchange?.(new IDBVersionChangeEvent("versionchange", { oldVersion: 1, newVersion: 2 }));
  const terminal = { kind: "failed", reason: "version" };
  assert.deepEqual(await replica.closed, terminal);
  assert.deepEqual(receipts.mock.calls.map(call => call.arguments[0]), [terminal]);
  assert.deepEqual(await storedBytes(factory, "upgrade-in-flight"), active);
  const upgraded = await idbResult(factory.open(DB_NAME, 2));
  upgraded.close();
});

test("a blocked upgrade returns a failure and cannot change the schema after the other tab closes", bounded, async t => {
  const { factory, store } = fixture();
  const original = factory.open.bind(factory);
  const first = await idbResult(original(DB_NAME, 1));
  t.after(() => first.close());
  const upgrade = original(DB_NAME, 2);
  const done = assert.rejects(idbResult(upgrade), { name: "AbortError" });
  t.mock.method(factory, "open", () => upgrade);
  assert.deepEqual(await store.open("blocked", STORE_OPTIONS), { kind: "failed", reason: "blocked" });
  first.close();
  await done;
  const current = await idbResult(original(DB_NAME));
  try { assert.equal(current.version, 1); } finally { current.close(); }
});

test("a version change during hydration returns an outcome and does not keep a stale connection", bounded, async t => {
  const { factory, store } = fixture();
  const initial = await open(t, store, "hydration");
  initial.session.close();
  await initial.closed;
  const get = IDBObjectStore.prototype.get;
  const mock = t.mock.method(IDBObjectStore.prototype, "get", function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    mock.mock.restore();
    const database = this.transaction.db;
    database.onversionchange?.(new IDBVersionChangeEvent("versionchange", { oldVersion: 1, newVersion: 2 }));
    return get.call(this, key);
  });
  const opening = await store.open("hydration", STORE_OPTIONS);
  if (opening.kind === "opened") { opening.session.close(); await opening.closed; }
  assert.equal(opening.kind, "failed");
  assert.equal(opening.reason, "version");
  const upgraded = await idbResult(factory.open(DB_NAME, 2));
  upgraded.close();
});

test("an already closed IndexedDB connection reports the write failure instead of throwing from the command", bounded, async t => {
  const { factory, store } = fixture(), observed = t.mock.method(factory, "open");
  const replica = await open(t, store, "closed-connection");
  seedReplica(replica.session);
  assert.deepEqual(await replica.flush(), STORED);
  const failed = nextFailure(replica);
  connectionFrom(observed.mock.calls[0]?.result).close();
  typeAt(replica.session, 0, "kept in memory ");
  const result = await replica.flush();
  assert.equal(result.kind, "failed");
  assert.equal(result.reason, "closed");
  assert.equal(await failed, result);
});

test("storage must supply both IndexedDB and locks; retention denial leaves the replica usable", bounded, async t => {
  const { factory } = fixture();
  const unavailable = { kind: "failed", reason: "unavailable" };
  assert.deepEqual(await createBrowserNativeLocalStore({ indexedDB: factory }).open("needs-locks", STORE_OPTIONS), unavailable);
  assert.deepEqual(await createBrowserNativeLocalStore({ locks: navigator.locks }).open("needs-db", STORE_OPTIONS), unavailable);
  const makeStore = (persist: () => Promise<boolean>) => createBrowserNativeLocalStore({
    indexedDB: factory, locks: navigator.locks, storage: { persist }
  });
  const request = t.mock.fn(async () => true);
  const allowed = await open(t, makeStore(request), "persisted");
  assert.equal(await allowed.persistent, true);
  assert.equal(request.mock.callCount(), 1);
  const denied = await open(t, makeStore(() => Promise.reject(new Error("blocked by policy"))), "denied");
  assert.equal(await denied.persistent, false);
  seedReplica(denied.session);
  assert.deepEqual(await denied.flush(), STORED);
});

test("an invalid stored record fails open and releases the connection and writer lock", bounded, async t => {
  const { factory, store } = fixture();
  const empty = await open(t, store, "corrupt");
  empty.session.close();
  assert.deepEqual(await empty.closed, STORED);
  const connection = await idbResult(factory.open(DB_NAME));
  try {
    const transaction = connection.transaction(REPLICAS, "readwrite");
    transaction.objectStore(REPLICAS).put("invalid", "corrupt");
    assert.equal(await idbDone(transaction), "complete");
  } finally { connection.close(); }
  const result = await store.open("corrupt", STORE_OPTIONS);
  assert.equal(result.kind, "failed");
  assert.equal(result.reason, "io");
  assert.deepEqual(await store.delete("corrupt"), STORED);
  assert.equal((await open(t, store, "corrupt")).restored, false);
});
