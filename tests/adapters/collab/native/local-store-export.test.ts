import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserNativeLocalStore } from "../../../../src/adapters/collab/native/browser-local-store.ts";
import { bootApp, closeApp } from "../../../../src/test/_app-boot.mjs";
import { stored, STORE_OPTIONS, seedReplica, storedBytes, typeAt } from "./local-store-fixture.ts";

async function exportAppData() {
  const hook = (window as unknown as { __appDataTest: { build: () => Promise<Record<string, unknown>> } }).__appDataTest;
  const result = await hook.build();
  assert.equal(result.format, "splitpage-app-data");
  Reflect.deleteProperty(result, "exportedAt");
  return result;
}

test("existing app-data export leaves native replicas outside its bundle", { timeout: 30000 }, async t => {
  const factory = window.indexedDB;
  const connections = new Set<IDBDatabase>();
  const open = factory.open.bind(factory);
  t.mock.method(factory, "open", (name: string, version?: number) => {
    const request = open(name, version);
    request.addEventListener("success", () => { connections.add(request.result); });
    return request;
  });
  t.after(() => {
    closeApp();
    for (const connection of connections) connection.close();
  });
  await bootApp(undefined, undefined);
  const before = await exportAppData();
  const store = createBrowserNativeLocalStore({ indexedDB: factory, locks: navigator.locks });
  const name = "deployment/retained-replica";
  const replica = await store.open(name, { ...STORE_OPTIONS, noticeJournal: true });
  assert.equal(replica.kind, "opened");
  try {
    const invitation = randomBytes(32).toString("base64url");
    assert.ok(replica.membership);
    await replica.membership.join(invitation);
    seedReplica(replica.session, { A: "Offline narration" });
    assert.deepEqual(await replica.flush(), stored(1));
    typeAt(replica.session, 0, "Journaled ", "A");
    assert.deepEqual(await replica.flush(), stored(2));
    assert.equal(replica.session.pendingEdits?.data().entries.length, 1);
    const bundle = await exportAppData();
    const digest = createHash("sha256").update(invitation).digest();
    for (const value of [bundle, replica.session.document(), replica.session.ydoc.toJSON()]) {
      const decoded = JSON.stringify(value);
      assert.equal(decoded.includes(invitation), false);
      assert.equal(decoded.includes(digest.toString("hex")), false);
      assert.equal(decoded.includes(digest.toString("base64url")), false);
    }
    assert.equal(JSON.stringify(bundle).includes("Journaled "), false);
    assert.deepEqual(bundle, before);
    assert.deepEqual(await storedBytes(factory, name), replica.session.encodeState());
  } finally { replica.session.close(); await replica.closed; }
});
