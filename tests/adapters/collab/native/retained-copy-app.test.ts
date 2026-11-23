import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { IDBObjectStore } from "fake-indexeddb";
import { bootApp, closeApp, rewireRunningApp } from "../../../../src/test/_app-boot.mjs";
import { DB_NAME, REPLICAS, seedSession, STORE_OPTIONS, storedEntries, typeAt, type OpenReplica } from "./local-store-fixture.ts";
import { idbResult } from "./indexeddb-fixture.ts";
import { createBrowserNativeLocalStore } from "../../../../src/adapters/collab/native/browser-local-store.ts";
import type { RetainedSharedScript } from "../../../../src/bootstrap/wiring/retained-shared-script.ts";
import type { SharedSwitchOutcome } from "../../../../src/bootstrap/wiring/shared-session.ts";
import type { DraftPayload } from "../../../../src/application/recovery/draft-origin.ts";
import { desktopFixture, desktopTestCipher, replicaFileFaults, replicasAt } from "./desktop-local-store-fixture.ts";

function hook() {
  return (window as unknown as { __sharedTest: {
    enterRetained: (entry: RetainedSharedScript) => Promise<SharedSwitchOutcome>;
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
