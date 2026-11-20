import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import "fake-indexeddb/auto";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { IndexeddbPersistence, PREFERRED_TRIM_SIZE, storeState } from "y-indexeddb";
import * as Y from "yjs";
import { eventResult, failNextIdbWrite, idbDone, idbResult } from "./indexeddb-fixture.ts";

function setup(t: TestContext) {
  const factory = new IDBFactory();
  t.mock.property(globalThis, "indexedDB", factory);
  return factory;
}

test("stock IndexedDB provider emits synced before commit and an aborted edit has no receipt", { timeout: 5000 }, async t => {
  const factory = setup(t), doc = new Y.Doc();
  t.after(() => doc.destroy());
  const add = IDBObjectStore.prototype.add;
  const transactions: Promise<string>[] = [];
  const observe = t.mock.method(IDBObjectStore.prototype, "add", function (this: IDBObjectStore, value: unknown) {
    if (this.name === "updates") transactions.push(idbDone(this.transaction));
    return add.call(this, value);
  });
  const provider = new IndexeddbPersistence("script", doc);
  t.after(() => provider.destroy());
  await provider.whenSynced;
  assert.equal(await Promise.race([transactions[0], Promise.resolve("synced")]), "synced");
  assert.equal(await transactions[0], "complete");
  failNextIdbWrite(t, "add", "abort");
  assert.equal(doc.getText("script").insert(0, "lost"), undefined);
  assert.equal(await transactions[1], "AbortError");
  observe.mock.restore();
  const disk = await idbResult(factory.open("script"));
  try {
    const stored = await idbResult(disk.transaction("updates").objectStore("updates").count());
    assert.equal(stored, 1);
    assert.equal(provider.synced, true);
    assert.equal(doc.getText("script").toString(), "lost");
  } finally { disk.close(); }
});

test("stock provider leaves the same name writable in both tabs, then still reports synced after upgrade", { timeout: 5000 }, async t => {
  const factory = setup(t), a = new Y.Doc(), b = new Y.Doc();
  const one = new IndexeddbPersistence("script", a), two = new IndexeddbPersistence("script", b);
  t.after(async () => { await Promise.all([one.destroy(), two.destroy()]); a.destroy(); b.destroy(); });
  await Promise.all([one.whenSynced, two.whenSynced]);
  a.getText("script").insert(0, "one");
  b.getText("script").insert(0, "two");
  assert.equal(a.getText("script").toString(), "one");
  assert.equal(b.getText("script").toString(), "two");
  await one.destroy();
  const upgraded = await idbResult(factory.open("script", 2));
  try {
    const stored = await idbResult(upgraded.transaction("updates").objectStore("updates").getAll()) as Uint8Array[];
    const reload = new Y.Doc();
    try {
      for (const update of stored) Y.applyUpdate(reload, update);
      assert.match(reload.getText("script").toString(), /^(onetwo|twoone)$/);
    } finally { reload.destroy(); }
    assert.throws(() => b.getText("script").insert(3, "!"), { name: "InvalidStateError" });
    assert.equal(two.synced, true);
  } finally { upgraded.close(); }
});

test("stock compaction waits for idle and its public promise resolves before the trim commits", { timeout: 5000 }, async t => {
  const factory = setup(t), doc = new Y.Doc(), provider = new IndexeddbPersistence("script", doc);
  t.after(async () => { await provider.destroy(); doc.destroy(); });
  await provider.whenSynced;
  const disk = await idbResult(factory.open("script"));
  t.after(() => disk.close());
  const count = () => idbResult(disk.transaction("updates").objectStore("updates").count());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (let index = 0; index < PREFERRED_TRIM_SIZE; index++) doc.getText("script").insert(index, "x");
  assert.equal(await count(), PREFERRED_TRIM_SIZE + 1);

  const add = IDBObjectStore.prototype.add;
  const { promise, resolve } = eventResult<{ done: Promise<string> }>();
  t.mock.method(IDBObjectStore.prototype, "add", function (this: IDBObjectStore, value: unknown) {
    resolve({ done: idbDone(this.transaction) });
    return add.call(this, value);
  });
  await storeState(provider);
  const { done: trimmed } = await promise;
  assert.equal(await Promise.race([trimmed, Promise.resolve("returned")]), "returned");
  assert.equal(await trimmed, "complete");
  assert.equal(await count(), 1);

  const automatic = eventResult<{ done: Promise<string> }>();
  for (let index = PREFERRED_TRIM_SIZE; index < 2 * PREFERRED_TRIM_SIZE; index++) doc.getText("script").insert(index, "x");
  t.mock.method(IDBObjectStore.prototype, "add", function (this: IDBObjectStore, value: unknown) {
    automatic.resolve({ done: idbDone(this.transaction) });
    return add.call(this, value);
  });
  t.mock.timers.tick(999);
  assert.equal(await count(), PREFERRED_TRIM_SIZE + 1);
  t.mock.timers.tick(1);
  assert.equal(await (await automatic.promise).done, "complete");
  assert.equal(await count(), 1);
});

test("stock blocked open/delete have no outcome, and quota escapes as an unhandled rejection", { timeout: 10000 }, () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./y-indexeddb-errors.ts", import.meta.url))], {
    encoding: "utf8", timeout: 5000
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "blocked open; blocked delete; unhandled QuotaExceededError");
});
