import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { IDBObjectStore } from "fake-indexeddb";
import { bootApp, closeApp, rewireRunningApp } from "../../../../src/test/_app-boot.mjs";
import { DB_NAME, REPLICAS, seedSession, STORE_OPTIONS, storedEntries, typeAt, type OpenReplica } from "./local-store-fixture.ts";
import { eventResult, idbResult } from "./indexeddb-fixture.ts";
import { createBrowserNativeLocalStore } from "../../../../src/adapters/collab/native/browser-local-store.ts";
import type { RetainedSharedScript } from "../../../../src/bootstrap/wiring/retained-shared-script.ts";
import type { SharedSwitchOutcome } from "../../../../src/bootstrap/wiring/shared-session.ts";
import type { DraftPayload } from "../../../../src/application/recovery/draft-origin.ts";
import { desktopFixture, desktopTestCipher, replicaFileFaults, replicasAt } from "./desktop-local-store-fixture.ts";

function hook() {
  return (window as unknown as { __sharedTest: {
    enterRetained: (entry: RetainedSharedScript, signal?: AbortSignal) => Promise<SharedSwitchOutcome>;
    leave: () => SharedSwitchOutcome | Promise<SharedSwitchOutcome>;
  } }).__sharedTest;
}

function invitation() {
  const source = seedSession({ A: "Retained narration" });
  try { return { token: randomBytes(32).toString("base64url"), state: source.encodeState() }; }
  finally { source.close(); }
}

function capture() {
  let replica: OpenReplica | undefined;
  const connect: NonNullable<RetainedSharedScript["connect"]> = copy => {
    replica = copy;
    return () => {};
  };
  return { connect, replica() { assert.ok(replica); return replica; } };
}

const identity = (script: string) => ({ deployment: "local-fixture", script });
const scope = (script: string) => "local-fixture/" + script;
const ok = { ok: true };

async function finishStartup() {
  const { localFilesOwner } = await import("../../../../src/bootstrap/wiring/local-files.ts");
  await localFilesOwner().tryResumeLastProject();
}

before(async () => {
  localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
  await bootApp();
  await finishStartup();
});
after(closeApp);

async function currentText() {
  const { currentDocument } = await import("../../../../src/bootstrap/wiring/session-owner.ts");
  return currentDocument()?.rows[0]?.audioText ?? "";
}

test("the mounted app reopens the retained script offline after restarting and Leave clears its device state", async () => {
  const entry = identity("restart"), opened = capture(), credential = invitation();
  assert.deepEqual(await hook().enterRetained({ ...entry, invitation: credential, connect: opened.connect }), ok);
  assert.equal((await opened.replica().flush()).kind, "stored");
  const oldHook = hook();
  await rewireRunningApp({});
  await finishStartup();
  await opened.replica().closed;
  assert.notEqual(hook(), oldHook);
  assert.deepEqual(await oldHook.enterRetained(entry), { ok: false, reason: "app-stopped" });
  assert.deepEqual(await hook().enterRetained(entry), ok);
  assert.match(await currentText(), /Retained narration/);
  assert.deepEqual(await hook().leave(), ok);
  assert.deepEqual(await storedEntries(window.indexedDB, scope(entry.script)), []);
  const database = await idbResult(window.indexedDB.open(DB_NAME));
  try {
    for (const store of ["memberships", "invitations"]) {
      assert.equal((await idbResult(database.transaction(store).objectStore(store).get(scope(entry.script)))) === undefined, true);
    }
  } finally { database.close(); }
  assert.equal((await hook().enterRetained(entry)).ok, false);
});

test("Leave keeps the writer and its copy when disconnect throws, then retries that disconnect before erasing", async t => {
  const entry = identity("disconnect-retry"), credential = invitation(), opened = capture();
  const log = t.mock.method(console, "error", () => {});
  let attempts = 0;
  const disconnect = t.mock.fn(() => {
    if (++attempts === 1) throw new Error(credential.token);
  });
  assert.deepEqual(await hook().enterRetained({ ...entry, invitation: credential, connect(replica, token) {
    opened.connect(replica, token);
    return disconnect;
  } }), ok);
  const copy = opened.replica();
  assert.equal((await copy.flush()).kind, "stored");
  assert.deepEqual(await hook().leave(), { ok: false, reason: "leave-failed" });
  assert.equal(disconnect.mock.callCount(), 1);
  assert.equal((await copy.membership?.token()) === credential.token, true);
  assert.deepEqual(await createBrowserNativeLocalStore().open(scope(entry.script), STORE_OPTIONS), { kind: "failed", reason: "locked" });
  assert.equal((await storedEntries(window.indexedDB, scope(entry.script))).length, 1);
  typeAt(copy.session, 0, "Still editing: ");
  assert.match(await currentText(), /Still editing/);
  assert.equal(JSON.stringify(log.mock.calls.map(call => call.arguments.map(String))).includes(credential.token), false);
  assert.deepEqual(await hook().leave(), ok);
  assert.equal(disconnect.mock.callCount(), 2);
  assert.match(await currentText(), /Still editing/);
  assert.deepEqual(await storedEntries(window.indexedDB, scope(entry.script)), []);
  assert.equal((await hook().enterRetained(entry)).ok, false);
});

test("an interrupted Leave cannot erase the next tab's saved copy even if the old command is repeated", async t => {
  const entry = identity("interrupted-erase"), credential = invitation(), opened = capture();
  let disconnected = false;
  assert.deepEqual(await hook().enterRetained({ ...entry, invitation: credential, connect(replica, token) {
    assert.equal(token === credential.token, true);
    opened.connect(replica, token);
    return () => { disconnected = true; };
  } }), ok);
  assert.equal((await opened.replica().flush()).kind, "stored");
  const remove = IDBObjectStore.prototype.delete;
  const fault = t.mock.method(IDBObjectStore.prototype, "delete", function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
    const request = remove.call(this, query);
    if (this.name === REPLICAS) request.addEventListener("success", () => this.transaction.abort());
    return request;
  });
  assert.deepEqual(await hook().leave(), { ok: false, reason: "shared-copy-erase-failed" });
  assert.equal(disconnected, true);
  fault.mock.restore();

  const next = await createBrowserNativeLocalStore().open(scope(entry.script), STORE_OPTIONS);
  assert.equal(next.kind, "opened");
  assert.equal((await next.membership?.token()) === credential.token, true);
  typeAt(next.session, 0, "New writer: ");
  assert.equal((await next.flush()).kind, "stored");
  next.session.close();
  await next.closed;
  assert.deepEqual(await hook().leave(), { ok: false, reason: "not-shared" });
  assert.deepEqual(await hook().enterRetained(entry), ok);
  assert.match(await currentText(), /New writer: Retained narration/);
  assert.deepEqual(await hook().leave(), ok);
});

test("a refused entry leaves storage untouched and an interrupted membership transaction rolls both records back", async t => {
  const entry = identity("interrupted-membership"), credential = invitation(), opened = capture();
  const factory = window.indexedDB;
  const open = t.mock.method(factory, "open", factory.open.bind(factory));
  document.dispatchEvent(new window.Event("compositionstart", { bubbles: true }));
  try {
    assert.deepEqual(await hook().enterRetained({ ...entry, invitation: credential, connect: opened.connect }),
      { ok: false, reason: "buffer-composition" });
    assert.equal(open.mock.callCount(), 0);
  } finally {
    document.dispatchEvent(new window.Event("compositionend", { bubbles: true }));
    open.mock.restore();
  }
  const put = IDBObjectStore.prototype.put;
  const fault = t.mock.method(IDBObjectStore.prototype, "put", function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = put.call(this, value, key);
    if (this.name === "invitations") request.addEventListener("success", () => this.transaction.abort());
    return request;
  });
  assert.deepEqual(await hook().enterRetained({ ...entry, invitation: credential }), { ok: false, reason: "enter-failed" });
  fault.mock.restore();
  const database = await idbResult(factory.open(DB_NAME));
  try {
    for (const store of ["memberships", "invitations"]) {
      assert.equal((await idbResult(database.transaction(store).objectStore(store).get(scope(entry.script)))) === undefined, true);
    }
  } finally { database.close(); }
  assert.deepEqual(await hook().enterRetained({ ...entry, invitation: credential }), ok);
  assert.deepEqual(await hook().leave(), ok);
});

test("a competing opening settles an invitation while draft flush is held", { timeout: 5000 }, async t => {
  const { draftRecoveryPorts } = await import("../../../../src/bootstrap/wiring/drafts.ts");
  const { documentSources, openDocument } = await import("../../../../src/bootstrap/wiring/transition-owners.ts");
  const { sessionEntryRefusal } = await import("../../../../src/bootstrap/wiring/session-owner.ts");
  const reached = eventResult<undefined>(), release = eventResult<{ ok: true }>();
  const flush = t.mock.method(draftRecoveryPorts().drafts, "flush", () => {
    reached.resolve(undefined);
    return release.promise;
  });
  const entry = identity("cancel-flush");
  const connect = t.mock.fn(() => () => {});
  const pending = hook().enterRetained({ ...entry, invitation: invitation(), connect });
  await reached.promise;
  const unregister = documentSources().register({ id: "cancel-invitation", takes: opening => opening.kind === "cancel-invitation", open: () => true });
  try { assert.equal(await openDocument({ kind: "cancel-invitation" }), true); }
  finally { unregister(); }
  assert.equal((await pending).ok, false);
  assert.equal(sessionEntryRefusal(), null);
  flush.mock.restore();
  assert.deepEqual(await hook().enterRetained({ ...entry, invitation: invitation() }), ok);
  release.resolve({ ok: true });
  assert.deepEqual(await hook().leave(), ok);
  assert.equal(connect.mock.callCount(), 0);
});

test("stopping the app settles entry while storage opens and the late lease closes independently", { timeout: 5000 }, async t => {
  const entry = identity("cancel-open");
  const factory = window.indexedDB, open = factory.open.bind(factory);
  const reached = eventResult<undefined>(), release = eventResult<undefined>();
  const gate = t.mock.method(factory, "open", (name: string, version?: number) => {
    const request = open(name, version);
    if (name === DB_NAME) request.addEventListener("success", event => {
      const success = request.onsuccess;
      request.onsuccess = null;
      reached.resolve(undefined);
      void release.promise.then(() => { success?.call(request, event); });
    });
    return request;
  });
  const connect = t.mock.fn(() => () => {});
  const pending = hook().enterRetained({ ...entry, invitation: invitation(), connect });
  await reached.promise;
  gate.mock.restore();
  await rewireRunningApp({});
  await finishStartup();
  assert.equal((await pending).ok, false);
  const next = identity("entry-after-stop");
  assert.deepEqual(await hook().enterRetained({ ...next, invitation: invitation() }), ok);
  release.resolve(undefined);
  const name = scope(entry.script);
  await navigator.locks.request(DB_NAME + ":" + name, () => {});
  assert.equal(connect.mock.callCount(), 0);
  assert.deepEqual(await storedEntries(factory, name), []);
  const replica = await createBrowserNativeLocalStore().open(name, STORE_OPTIONS);
  assert.equal(replica.kind, "opened");
  assert.equal(await replica.membership?.token(), null);
  replica.session.close();
  await replica.closed;
  assert.deepEqual(await hook().leave(), ok);
});

for (const phase of ["success", "complete"] as const) test(`cancellation at membership ${phase} leaves no credential`, { timeout: 5000 }, async t => {
  const entry = identity("cancel-write");
  const cancellation = new AbortController();
  const put = IDBObjectStore.prototype.put;
  const reached = eventResult<undefined>();
  const gate = t.mock.method(IDBObjectStore.prototype, "put", function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = put.call(this, value, key);
    const target = phase === "success" ? request : this.transaction;
    if (this.name === "invitations" && key === scope(entry.script)) target.addEventListener(phase, () => {
      reached.resolve(undefined);
      cancellation.abort();
    });
    return request;
  });
  const connect = t.mock.fn(() => () => {});
  const pending = hook().enterRetained({ ...entry, invitation: invitation(), connect }, cancellation.signal);
  await reached.promise;
  assert.equal((await pending).ok, false);
  gate.mock.restore();
  assert.equal((await hook().enterRetained(entry)).ok, false);
  assert.deepEqual(await storedEntries(window.indexedDB, scope(entry.script)), []);
  assert.equal(connect.mock.callCount(), 0);
});

test("a cancelled invitation waiting for the previous writer to close leaves that writer's data intact", { timeout: 5000 }, async t => {
  const entry = identity("cancel-prior-close"), credential = invitation(), opened = capture();
  assert.deepEqual(await hook().enterRetained({ ...entry, invitation: credential, connect: opened.connect }), ok);
  const replica = opened.replica();
  await replica.flush();
  const reached = eventResult<undefined>(), release = eventResult<undefined>();
  const add = IDBObjectStore.prototype.add;
  const gate = t.mock.method(IDBObjectStore.prototype, "add", function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = add.call(this, value, key);
    if (this.name === REPLICAS) {
      const tx = this.transaction;
      tx.addEventListener("complete", event => {
        const complete = tx.oncomplete;
        tx.oncomplete = null;
        reached.resolve(undefined);
        void release.promise.then(() => { complete?.call(tx, event); });
      });
    }
    return request;
  });
  typeAt(replica.session, 0, "Finishing writer: ");
  await reached.promise;
  gate.mock.restore();
  await rewireRunningApp({});
  await finishStartup();
  assert.deepEqual(await createBrowserNativeLocalStore().open(scope(entry.script), STORE_OPTIONS), { kind: "failed", reason: "locked" });
  const connect = t.mock.fn(() => () => {});
  const deadline = AbortSignal.timeout(10);
  const keepClockRunning = setTimeout(() => {}, 100);
  try {
    assert.equal((await hook().enterRetained({ ...entry, invitation: invitation(), connect }, deadline)).ok, false);
    assert.equal(deadline.aborted, true);
  } finally {
    clearTimeout(keepClockRunning);
    release.resolve(undefined);
  }
  await replica.closed;
  const reopened = capture();
  assert.deepEqual(await hook().enterRetained({ ...entry, connect: reopened.connect }), ok);
  assert.equal((await reopened.replica().membership?.token()) === credential.token, true);
  assert.match(await currentText(), /Finishing writer: Retained narration/);
  assert.equal(connect.mock.callCount(), 0);
  assert.deepEqual(await hook().leave(), ok);
});

for (const retained of [false, true]) {
  test(`cancellation during membership preparation preserves the ${retained ? "retained" : "fresh"} copy`, { timeout: 5000 }, async t => {
    const entry = identity(retained ? "cancel-retained" : "cancel-fresh");
    const original = invitation(), incoming = invitation();
    const store = createBrowserNativeLocalStore();
    const name = scope(entry.script);
    if (retained) {
      const opened = capture();
      assert.deepEqual(await hook().enterRetained({ ...entry, invitation: original, connect: opened.connect }), ok);
      typeAt(opened.replica().session, 0, "Previous writer: ");
      await opened.replica().flush();
      await rewireRunningApp({});
      await finishStartup();
      await opened.replica().closed;
    }
    const previous = await storedEntries(window.indexedDB, name);
    const reached = eventResult<undefined>(), release = eventResult<undefined>();
    const get = IDBObjectStore.prototype.get;
    const gate = t.mock.method(IDBObjectStore.prototype, "get", function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      const request = get.call(this, key);
      if (this.name === "invitations" && key === name) {
        const tx = this.transaction;
        tx.addEventListener("complete", event => {
          const complete = tx.oncomplete;
          tx.oncomplete = null;
          reached.resolve(undefined);
          void release.promise.then(() => { complete?.call(tx, event); });
        });
      }
      return request;
    });
    const cancellation = new AbortController();
    const connect = t.mock.fn(() => () => {});
    const pending = hook().enterRetained({ ...entry, invitation: incoming, connect }, cancellation.signal);
    await reached.promise;
    cancellation.abort();
    assert.equal((await pending).ok, false);
    gate.mock.restore();
    release.resolve(undefined);
    const database = await idbResult(window.indexedDB.open(DB_NAME));
    try {
      const tx = database.transaction(["memberships", "invitations"]);
      const [member, token] = await Promise.all(["memberships", "invitations"].map(key => idbResult(tx.objectStore(key).get(name))));
      assert.equal(member, retained ? true : undefined);
      assert.equal(token === (retained ? original.token : undefined), true);
    } finally { database.close(); }
    assert.deepEqual(await storedEntries(window.indexedDB, name), previous);
    assert.equal(connect.mock.callCount(), 0);
    if (!retained) assert.equal((await hook().enterRetained(entry)).ok, false);
    assert.deepEqual(await hook().enterRetained(retained ? entry : { ...entry, invitation: original }), ok);
    assert.match(await currentText(), retained ? /Previous writer: Retained narration/ : /Retained narration/);
    assert.deepEqual(await hook().leave(), ok);
    assert.deepEqual(await store.delete(name), { kind: "stored" });
  });
}

for (const target of ["browser", "desktop"] as const) {
  test("persistent " + target + " storage failure keeps editing, switch and close safe", async t => {
    const opened = capture(), credential = invitation();
    const entry = identity(target + "-quota");
    const { useDesktopForTest, restoreDesktop } = await import("../../../../src/adapters/desktop/desktop-port.ts");
    let fail = false;
    const desktopStates: boolean[] = [];
    const draftBodies: string[] = [];
    const log = t.mock.method(console, "error", () => {});
    if (target === "desktop") {
      const { directory } = await desktopFixture(t);
      const { fileSystem } = replicaFileFaults();
      const { invoke } = replicasAt(directory, { ...fileSystem, open(...args) {
        if (fail && args[1] === "a+") return Promise.reject(Object.assign(new Error("Disk full"), { code: "ENOSPC" }));
        return fileSystem.open(...args);
      } }, desktopTestCipher(randomBytes(32))).window();
      useDesktopForTest({
        nativeReplica: invoke,
        setDocumentState: state => { desktopStates.push(state.dirty); },
        writeDraft: async payload => {
          const { stateJson, baseJson, seq } = payload as DraftPayload;
          draftBodies.push(stateJson, baseJson ?? "");
          return { ok: true, seq, bytes: 0 };
        },
        discardDraft: async () => ({ ok: true }), draftRestoreDone: () => {}
      });
    } else {
      const add = IDBObjectStore.prototype.add;
      t.mock.method(IDBObjectStore.prototype, "add", function (this: IDBObjectStore, value: unknown) {
        if (fail && this.name === REPLICAS) throw new DOMException("Storage limit reached", "QuotaExceededError");
        return add.call(this, value);
      });
    }
    try {
      assert.deepEqual(await hook().enterRetained({ ...entry, invitation: credential, connect: opened.connect }), ok);
      const replica = opened.replica();
      assert.equal((await replica.flush()).kind, "stored");
      fail = true;
      typeAt(replica.session, 0, "Only in memory: ");
      const failure = await replica.flush();
      assert.equal(failure.kind, "failed");
      assert.equal(failure.reason, "quota");
      assert.match(await currentText(), /Only in memory/);
      const { startNewScript } = await import("../../../../src/bootstrap/wiring/file-menu-controls.ts");
      assert.equal(startNewScript(), false);
      const unload = new window.Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      assert.equal(unload.defaultPrevented, true);
      assert.match(await currentText(), /Only in memory/);
      if (target === "desktop") {
        assert.equal(desktopStates.at(-1), true);
        const { flushDraftNow } = await import("../../../../src/bootstrap/wiring/recovery-owners.ts");
        const writes = draftBodies.length;
        assert.deepEqual(await flushDraftNow(), { ok: false, code: "DETACHED" });
        assert.equal(draftBodies.length, writes);
      }
      assert.deepEqual(await hook().leave(), ok);
      assert.match(await currentText(), /Only in memory/);
      if (target === "desktop") {
        const { flushDraftNow } = await import("../../../../src/bootstrap/wiring/recovery-owners.ts");
        assert.equal((await flushDraftNow()).ok, true);
        assert.match(draftBodies.join("\n"), /Only in memory/);
      }
      const digest = createHash("sha256").update(credential.token).digest();
      const logged = JSON.stringify(log.mock.calls.map(call => call.arguments.map(String)));
      for (const value of [...draftBodies.filter(Boolean).map(body => JSON.stringify(JSON.parse(body))), logged]) {
        assert.equal([credential.token, digest.toString("hex"), digest.toString("base64url")].some(secret => value.includes(secret)), false);
      }
    } finally { if (target === "desktop") restoreDesktop(); }
  });
}
