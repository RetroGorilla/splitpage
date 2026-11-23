import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { IDBObjectStore } from "fake-indexeddb";
import { refsIn } from "../../../../shared/blob-policy.ts";
import { bootApp, closeApp, rewireRunningApp } from "../../../../src/test/_app-boot.mjs";
import { DB_NAME, REPLICAS, seedSession, STORE_OPTIONS, storedEntries, typeAt, type OpenReplica } from "./local-store-fixture.ts";
import { idbResult } from "./indexeddb-fixture.ts";
import { createBrowserNativeLocalStore } from "../../../../src/adapters/collab/native/browser-local-store.ts";
import type { RetainedSharedScript } from "../../../../src/bootstrap/wiring/retained-shared-script.ts";
import type { SharedSwitchOutcome } from "../../../../src/bootstrap/wiring/shared-session.ts";
import type { DraftPayload } from "../../../../src/application/recovery/draft-origin.ts";
import { desktopFixture, desktopTestCipher, replicaFileFaults, replicasAt } from "./desktop-local-store-fixture.ts";
import { imageRecordOf } from "../../../../src/core/document/media.ts";
import { createMemoryBackend, setBackend } from "../../../../src/adapters/storage/02c-blobs.ts";
import { localFileMenuControls } from "../../../../src/bootstrap/wiring/local-files.ts";
import { notices } from "../../../../src/bootstrap/wiring/ports/effects.ts";
import { currentDocument } from "../../../../src/bootstrap/wiring/session-owner.ts";
import { NAME, serverHarness } from "./server-harness.ts";

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
const abandonedPicture = { sha256: "f".repeat(64), width: 1, height: 1, mime: "image/png" };

test("join uses the current picture references and export lists a later missing picture", { timeout: 10_000 }, async t => {
  const source = seedSession({ A: "Retained narration" });
  const row = source.document().rows[0];
  assert.ok(row);
  const target = { kind: "gallery", id: row.id } as const;
  assert.equal(source.commands.setField(target, { imageRef: abandonedPicture }).kind, "written");
  const state = source.encodeState();
  source.close();
  const png = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"));
  const replacement = imageRecordOf(png);
  assert.ok(replacement);
  let sawInitial = false, sawReplacement = false, replacementReady = false;
  let holdDownload = false, pendingDownload: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", (url: URL, init?: RequestInit) => {
    if (url.pathname.endsWith(replacement.sha256)) {
      sawReplacement = true;
      if (replacementReady) return Promise.resolve(new Response(png));
    } else {
      sawInitial = true;
      if (holdDownload && init?.signal) {
        pendingDownload = init.signal;
        const signal = pendingDownload;
        return new Promise<Response>(resolve => {
          signal.addEventListener("abort", () => resolve(new Response(null, { status: 404 })), { once: true });
        });
      }
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  const opened = capture();
  const joinLifetime = new AbortController();
  const entering = hook().enterRetained({
    ...identity("pictures"), pictureOrigin: window.location.origin, connect: opened.connect,
    signal: joinLifetime.signal,
    invitation: { state, token: randomBytes(32).toString("base64url") }
  });
  let joined = false;
  void entering.then(() => { joined = true; });
  while (!sawInitial) await delay(10, undefined, { signal: t.signal });
  assert.equal(joined, false);
  assert.equal(opened.replica().session.commands.setField(target, { imageRef: replacement }).kind, "written");
  while (!sawReplacement) await delay(10, undefined, { signal: t.signal });
  assert.equal(joined, false);
  replacementReady = true;
  assert.deepEqual(await entering, ok);
  joinLifetime.abort();
  t.after(async () => {
    if (!opened.replica().session.isClosingOrClosed()) {
      await opened.replica().flush();
      await hook().leave();
    }
  });

  assert.equal(opened.replica().session.commands.setField(target, {
    imageRef: abandonedPicture, imageName: "Pending reference.png"
  }).kind, "written");
  while (!refsIn(currentDocument()).includes(abandonedPicture.sha256)) {
    await delay(10, undefined, { signal: t.signal });
  }
  const warn = t.mock.method(notices, "show", () => {});
  const exported = await localFileMenuControls().buildFileData("splitpage", "Retained copy");
  assert.equal(typeof exported.data, "string");
  const saved = JSON.parse(String(exported.data)) as { rows: { imageRef?: { sha256: string }; visualImage?: string }[] };
  assert.equal(saved.rows[0]?.imageRef?.sha256, abandonedPicture.sha256);
  assert.ok(!saved.rows[0]?.visualImage);
  assert.ok(warn.mock.calls.some(call => /Pending reference\.png/.test(String(call.arguments[0]))));
  holdDownload = true;
  while (!pendingDownload) await delay(10, undefined, { signal: t.signal });
  assert.equal((await opened.replica().flush()).kind, "stored");
  assert.deepEqual(await hook().leave(), ok);
  assert.equal(pendingDownload.aborted, true);
});

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

async function openAfterCancelledJoin(name: string, signal: AbortSignal) {
  const store = createBrowserNativeLocalStore();
  for (;;) {
    const copy = await store.open(name, STORE_OPTIONS);
    if (copy.kind !== "failed" || copy.reason !== "locked") return copy;
    await delay(10, undefined, { signal });
  }
}

test("a retained invitation gets its first state from the existing relay provider", { timeout: 10_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const port = await kit.launch().port();
  const token = kit.invitation().token;
  assert.deepEqual(await hook().enterRetained({
    deployment: "live-relay", script: NAME,
    relayUrl: "ws://127.0.0.1:" + port, invitation: { token }, signal: t.signal
  }), ok);
  assert.equal(await currentText(), "word");
  assert.deepEqual(await hook().leave(), ok);
});

test("a stalled first sync can be cancelled without retaining the invitation", { timeout: 10_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const run = kit.launch();
  const port = await run.port();
  run.send("hold-load");
  await kit.until(() => run.messages.includes("load-armed") || undefined);
  const cancel = new AbortController();
  const deployment = "cancelled-first-sync";
  const joining = hook().enterRetained({
    deployment, script: NAME, relayUrl: "ws://127.0.0.1:" + port,
    invitation: { token: kit.invitation().token }, signal: cancel.signal
  });
  await kit.until(() => run.messages.includes("loading") || undefined);
  cancel.abort();
  assert.deepEqual(await joining, { ok: false, reason: "enter-failed" });
  const copy = await openAfterCancelledJoin(deployment + "/" + NAME, t.signal);
  assert.equal(copy.kind, "opened");
  try { assert.equal(await copy.membership?.token(), null); }
  finally { copy.session.close(); await copy.closed; }
});

test("cancelling a real relay join waiting for a picture preserves the previous membership", { timeout: 10_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const run = kit.launch();
  const port = await run.port();
  const writer = kit.copy(port), witness = kit.copy(port);
  await kit.until(() => writer.relay.status().firstSyncDone && witness.relay.status().firstSyncDone || undefined);
  const row = writer.session.document().rows[0];
  assert.ok(row);
  assert.equal(writer.session.commands.setField({ kind: "gallery", id: row.id }, { imageRef: abandonedPicture }).kind, "written");
  await kit.until(() => refsIn(witness.session.document()).includes(abandonedPicture.sha256) || undefined);

  const deployment = "cancelled-join";
  const scope = deployment + "/" + NAME;
  const store = createBrowserNativeLocalStore();
  const kept = await store.open(scope, STORE_OPTIONS);
  assert.equal(kept.kind, "opened");
  assert.ok(kept.membership);
  const previous = randomBytes(32).toString("base64url");
  await kept.membership.join(previous);
  kept.session.close();
  await kept.closed;

  const cancel = new AbortController();
  const request = globalThis.fetch;
  let wasPending = false;
  t.mock.method(globalThis, "fetch", async (url: URL, init?: RequestInit) => {
    const response = await request(url, init);
    if (url.pathname.endsWith(abandonedPicture.sha256) && response.status === 404) wasPending = true;
    return response;
  });
  const joining = hook().enterRetained({
    deployment, script: NAME, relayUrl: "ws://127.0.0.1:" + port,
    invitation: { token: kit.invitation().token }, signal: cancel.signal
  });
  while (!wasPending) await delay(10, undefined, { signal: t.signal });
  cancel.abort();
  assert.deepEqual(await joining, { ok: false, reason: "enter-failed" });
  const member = await openAfterCancelledJoin(scope, t.signal);
  assert.equal(member.kind, "opened");
  try { assert.equal(await member.membership?.token(), previous); }
  finally { member.session.close(); await member.closed; }
});

test("a picture held only in memory cannot complete a retained join", { timeout: 10_000 }, async t => {
  const source = seedSession({ A: "Retained narration" });
  const row = source.document().rows[0];
  assert.ok(row);
  const png = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d494844520000000d00000001", "hex"));
  const ref = imageRecordOf(png);
  assert.ok(ref);
  assert.equal(source.commands.setField({ kind: "gallery", id: row.id }, { imageRef: ref }).kind, "written");
  const state = source.encodeState();
  source.close();
  t.mock.method(globalThis, "fetch", () => Promise.resolve(new Response(png)));
  setBackend(createMemoryBackend());
  t.after(() => setBackend(null));
  const entry = identity("nondurable-picture");
  const result = await hook().enterRetained({
    ...entry, pictureOrigin: window.location.origin, invitation: { state, token: randomBytes(32).toString("base64url") }
  });
  assert.deepEqual(result, { ok: false, reason: "enter-failed" });
  const copy = await createBrowserNativeLocalStore().open(scope(entry.script), STORE_OPTIONS);
  assert.equal(copy.kind, "opened");
  try { assert.equal(await copy.membership?.token(), null); }
  finally { copy.session.close(); await copy.closed; }
});

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
