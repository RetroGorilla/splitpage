import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IDBObjectStore } from "fake-indexeddb";
import { clearDocument, IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { eventResult, idbResult } from "./indexeddb-fixture.ts";

const doc = new Y.Doc();
const leases: IDBDatabase[] = [];
let provider: IndexeddbPersistence | undefined;
try {
  const factory = indexedDB;
  const { promise: blockedDelete, resolve: deleteBlocked } = eventResult<void>();
  const remove = factory.deleteDatabase.bind(factory);
  factory.deleteDatabase = name => {
    const request = remove(name);
    request.addEventListener("blocked", () => deleteBlocked());
    return request;
  };
  const open = factory.open.bind(factory);
  provider = new IndexeddbPersistence("script", doc);
  await provider.whenSynced;

  const add = IDBObjectStore.prototype.add;
  const { promise: rejected, resolve: report } = eventResult<unknown>();
  process.once("unhandledRejection", report);
  IDBObjectStore.prototype.add = function (value, key) {
    IDBObjectStore.prototype.add = add;
    const request = add.call(this, value, key);
    const queue = (this.transaction as unknown as { _requests: { operation: () => unknown }[] })._requests;
    queue.at(-1)!.operation = () => { throw new DOMException("Storage limit reached", "QuotaExceededError"); };
    return request;
  };
  doc.getText("script").insert(0, "offline");
  assert.match(String(await rejected), /QuotaExceededError/);
  const blocker = await idbResult(open("script"));
  leases.push(blocker);
  const deletion = clearDocument("script");
  await blockedDelete;
  assert.equal(await Promise.race([deletion, Promise.resolve("pending")]), "pending");
  await provider.destroy();
  blocker.close();
  await deletion;

  const held = await idbResult(open("held", 1));
  leases.push(held);
  const { promise: blockedOpen, resolve: openBlocked } = eventResult<void>();
  factory.open = name => {
    const request = open(name, 2);
    request.addEventListener("blocked", () => openBlocked());
    return request;
  };
  const blockedDoc = new Y.Doc();
  provider = new IndexeddbPersistence("held", blockedDoc);
  await blockedOpen;
  assert.equal(await Promise.race([provider.whenSynced, Promise.resolve("pending")]), "pending");
  held.close();
  await provider.whenSynced;
  await provider.destroy();
  blockedDoc.destroy();
  console.log("blocked open; blocked delete; unhandled QuotaExceededError");
} finally {
  await provider?.destroy();
  doc.destroy();
  for (const lease of leases) lease.close();
}
