import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { IDBObjectStore } from "fake-indexeddb";
import { bootApp, closeApp } from "../../../../src/test/_app-boot.mjs";
import { createMemoryBackend, intern, persist, setBackend } from "../../../../src/adapters/storage/02c-blobs.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { StateFirstProvider } from "../../../../src/adapters/collab/native/state-first-provider.ts";
import { MERGE_TOO_LARGE_MESSAGE } from "../../../../src/application/collaboration/state.ts";
import { sharedSaveStatus } from "../../../../src/application/save/status.ts";
import { addGalleryPicture } from "../../../../src/core/document/gallery.ts";
import { collaborationState } from "../../../../src/bootstrap/wiring/collaboration-owner.ts";
import { toggleFileMenu } from "../../../../src/bootstrap/wiring/file-menu-controls.ts";
import { localFileMenuControls } from "../../../../src/bootstrap/wiring/local-files.ts";
import type { RetainedSharedScript } from "../../../../src/bootstrap/wiring/retained-shared-script.ts";
import { currentDocument, sharedSession } from "../../../../src/bootstrap/wiring/session-owner.ts";
import type { SharedSwitchOutcome } from "../../../../src/bootstrap/wiring/shared-session.ts";
import { writerControls } from "../../../../src/bootstrap/wiring/writer.ts";
import { REPLICAS, seedSession, typeAt, type OpenReplica } from "./local-store-fixture.ts";
import { eventResult } from "./indexeddb-fixture.ts";
import { NAME, serverHarness } from "./server-harness.ts";

const png = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z7cAAAAASUVORK5CYII=", "base64"
));

function hook() {
  return (window as unknown as { __sharedTest: {
    enterRetained: (entry: RetainedSharedScript, signal?: AbortSignal) => Promise<SharedSwitchOutcome>;
    leave: () => SharedSwitchOutcome | Promise<SharedSwitchOutcome>;
  } }).__sharedTest;
}

function el(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

async function waitUntil(check: () => boolean, signal?: AbortSignal): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await delay(10, undefined, { signal });
  }
  assert.fail("Timed out waiting for condition");
}

function capture() {
  let replica: OpenReplica | undefined;
  const connect: NonNullable<RetainedSharedScript["connect"]> = copy => {
    replica = copy;
    return () => {};
  };
  return { connect, replica() { assert.ok(replica); return replica; } };
}

before(async () => {
  await bootApp();
  window.Element.prototype.scrollBy = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  setBackend({ ...createMemoryBackend(), persistent: true });
});

after(async () => {
  if (sharedSession()) await hook().leave();
  closeApp();
});

test("relay join renders Saved on this device, File menu hides file-only controls, and picture upload status appears and clears", { timeout: 20_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const run = kit.launch();
  const port = await run.port();
  const token = kit.invitation().token;
  const putStarted = eventResult<undefined>(), putFinish = eventResult<Response>();
  const realFetch = globalThis.fetch;
  let heldPut = false;
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT" && !heldPut) {
      heldPut = true;
      putStarted.resolve(undefined);
      return putFinish.promise.then(() => realFetch(input, init));
    }
    return realFetch(input, init);
  });

  let connected = false;
  const result = await hook().enterRetained({
    deployment: "status-pictures",
    script: NAME,
    relayUrl: "ws://127.0.0.1:" + port,
    invitation: { token },
    onRelayConnected: ready => { connected = ready; }
  });
  assert.deepEqual(result, { ok: true });
  t.after(async () => {
    putFinish.resolve(new Response(null, { status: 201 }));
    if (sharedSession()) await hook().leave();
  });

  await waitUntil(() => connected && el("btn-save").textContent === "Saved on this device", t.signal);
  assert.equal(el("btn-save").getAttribute("data-state"), "ok");
  assert.equal((el("btn-save") as HTMLButtonElement).disabled, true);

  toggleFileMenu(true);
  assert.equal(el("menu-autosave").hidden, true);
  const createBundle = document.querySelector<HTMLElement>('#file-menu [data-file-action="create-bundle"]');
  assert.equal(createBundle?.hidden, true);
  assert.equal(el("fm-card-meta").textContent, "Saved on this device · Shared script");

  const picture = intern(png);
  assert.ok(picture);
  assert.deepEqual(await persist([picture.sha256]), []);
  const { nativeEditorRecords } = await import("../../../../src/bootstrap/wiring/shared-session.ts");
  const row = currentDocument()?.rows[0];
  assert.ok(row);
  const added = nativeEditorRecords()?.gallery(row.id, "Picture added", r => { addGalleryPicture(r, picture, "pixel.png"); return true; });
  assert.equal(added?.changed, true);

  await putStarted.promise;
  await waitUntil(() => el("btn-save").textContent === "Saved on this device · uploading pictures", t.signal);
  assert.equal(el("btn-save").getAttribute("data-state"), "pending");
  assert.equal(el("fm-card-meta").textContent, "Saved on this device · uploading pictures · Shared script");

  putFinish.resolve(new Response(null, { status: 201 }));
  await waitUntil(() => el("btn-save").textContent === "Saved on this device", t.signal);
  assert.equal(el("btn-save").getAttribute("data-state"), "ok");
  assert.equal(el("fm-card-meta").textContent, "Saved on this device · Shared script");

  toggleFileMenu(false);
  assert.deepEqual(await hook().leave(), { ok: true });
});

test("local write failure is visible and recoverable by Try again from inside Writer", { timeout: 15_000 }, async t => {
  const source = seedSession({ A: "Writer save recovery" });
  const state = source.encodeState();
  source.close();
  const opened = capture();
  let fail = false;
  const add = IDBObjectStore.prototype.add;
  t.mock.method(IDBObjectStore.prototype, "add", function (this: IDBObjectStore, value: unknown) {
    if (fail && this.name === REPLICAS) throw new DOMException("Storage limit reached", "QuotaExceededError");
    return add.call(this, value);
  });

  const result = await hook().enterRetained({
    deployment: "writer-save-fail",
    script: "writer-save-fail",
    invitation: { token: randomBytes(32).toString("base64url"), state },
    connect: opened.connect
  });
  assert.deepEqual(result, { ok: true });
  t.after(async () => {
    writerControls()?.closeWriter();
    if (sharedSession()) await hook().leave();
  });

  const replica = opened.replica();
  assert.equal((await replica.flush()).kind, "stored");
  writerControls()?.openWriter();
  assert.equal(el("writer").hidden, false);

  fail = true;
  typeAt(replica.session, 0, "Edit under quota failure: ");
  const failed = await replica.flush();
  assert.equal(failed.kind, "failed");

  await waitUntil(() => el("btn-save").textContent === "Could not save on this device", t.signal);
  assert.equal(el("btn-save").getAttribute("data-state"), "warn");
  assert.equal(el("btn-save").getAttribute("data-actionable"), "true");
  assert.equal((el("btn-save") as HTMLButtonElement).disabled, false);
  assert.equal(el("writer-collab-status").querySelector(".writer-collab-label")?.textContent, "Could not save on this device");
  assert.equal(el("save-error-banner").hidden, false);
  assert.equal(el("writer").contains(el("save-error-banner")), true);

  el("save-error-dismiss").click();
  assert.equal(el("save-error-banner").hidden, true);
  el("writer-collab-status").click();
  assert.equal(el("save-error-banner").hidden, false);
  assert.equal(el("writer").contains(el("save-error-banner")), true);

  fail = false;
  el("save-error-retry").click();
  await waitUntil(() => el("btn-save").textContent === "Offline · saved on this device", t.signal);
  assert.equal(el("save-error-banner").hidden, true);
  assert.equal(replica.hasUnstoredChanges(), false);

  writerControls()?.closeWriter();
  assert.deepEqual(await hook().leave(), { ok: true });
});

test("access removed stops syncing, shows banner inside Writer, keeps copy exportable, and Leave lands standalone", { timeout: 20_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const run = kit.launch();
  const port = await run.port();
  const token = kit.invitation().token;
  let connected = false;
  const result = await hook().enterRetained({
    deployment: "writer-access-removed",
    script: NAME,
    relayUrl: "ws://127.0.0.1:" + port,
    invitation: { token },
    onRelayConnected: ready => { connected = ready; }
  });
  assert.deepEqual(result, { ok: true });
  t.after(async () => {
    writerControls()?.closeWriter();
    if (sharedSession()) await hook().leave();
  });

  await waitUntil(() => connected && el("btn-save").textContent === "Saved on this device", t.signal);
  writerControls()?.openWriter();
  assert.equal(el("writer").hidden, false);

  const seenLabels: string[] = [];
  const stopSeen = collaborationState().onChange(snap => {
    if (snap.active) seenLabels.push(sharedSaveStatus(snap).label);
  });
  t.after(stopSeen);

  run.send("revoke:" + kit.invitation().id);
  await waitUntil(() => el("btn-save").textContent === "Access removed · local work kept", t.signal);
  assert.equal(seenLabels.every(label => !label.startsWith("Offline") && !label.startsWith("Saved")), true, JSON.stringify(seenLabels));
  assert.deepEqual(collaborationState().snapshot().pictures, { checking: 0, uploading: 0, downloading: 0 });
  assert.equal(el("btn-save").getAttribute("data-state"), "warn");
  assert.equal(el("btn-save").getAttribute("data-actionable"), "true");
  assert.equal(el("writer-collab-status").querySelector(".writer-collab-label")?.textContent, "Access removed · local work kept");
  assert.equal(el("collab-access-banner").hidden, false);
  assert.equal(el("writer").contains(el("collab-access-banner")), true);

  const exported = await localFileMenuControls().buildFileData("splitpage", "Access removed copy");
  assert.equal(typeof exported.data, "string");
  assert.ok(String(exported.data).includes("word"));

  el("collab-access-dismiss").click();
  assert.equal(el("collab-access-banner").hidden, true);
  el("btn-save").click();
  assert.equal(el("collab-access-banner").hidden, false);

  el("collab-access-leave").click();
  await waitUntil(() => !sharedSession(), t.signal);
  assert.equal(el("collab-access-banner").hidden, true);
  assert.equal(el("writer-collab-status").hidden, true);
  writerControls()?.closeWriter();
});

test("merge over 15 MB limit via relay onStateless never shows offline or saved, clears picture counts, and opens banner", { timeout: 20_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const run = kit.launch();
  const port = await run.port();
  const token = kit.invitation().token;
  let triggerStateless: (() => void) | undefined;
  const origAttach = StateFirstProvider.prototype.attach;
  t.mock.method(StateFirstProvider.prototype, "attach", function (this: StateFirstProvider) {
    const config = this.configuration;
    triggerStateless = () => { void config.onStateless?.({ payload: "merge-too-large" }); };
    return origAttach.call(this);
  });
  const realFetch = globalThis.fetch;
  const putStarted = eventResult<undefined>(), putFinish = eventResult<Response>();
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      putStarted.resolve(undefined);
      return putFinish.promise;
    }
    return realFetch(input, init);
  });

  let connected = false;
  const result = await hook().enterRetained({
    deployment: "merge-limit-relay",
    script: NAME,
    relayUrl: "ws://127.0.0.1:" + port,
    invitation: { token },
    onRelayConnected: ready => { connected = ready; }
  });
  assert.deepEqual(result, { ok: true });
  t.after(async () => {
    putFinish.resolve(new Response(null, { status: 201 }));
    if (sharedSession()) await hook().leave();
  });

  await waitUntil(() => connected && el("btn-save").textContent === "Saved on this device", t.signal);
  const picture = intern(png);
  assert.ok(picture);
  assert.deepEqual(await persist([picture.sha256]), []);
  const { nativeEditorRecords } = await import("../../../../src/bootstrap/wiring/shared-session.ts");
  const row = currentDocument()?.rows[0];
  assert.ok(row);
  nativeEditorRecords()?.gallery(row.id, "Picture added", r => { addGalleryPicture(r, picture, "pixel.png"); return true; });
  await putStarted.promise;
  await waitUntil(() => collaborationState().snapshot().pictures.uploading === 1, t.signal);

  const seenLabels: string[] = [];
  const stopSeen = collaborationState().onChange(snap => {
    if (snap.active) seenLabels.push(sharedSaveStatus(snap).label);
  });
  t.after(stopSeen);

  assert.ok(triggerStateless);
  triggerStateless();
  await waitUntil(() => el("btn-save").textContent === "Too large to sync · local work kept", t.signal);

  assert.equal(seenLabels.every(label => !label.startsWith("Offline") && !label.startsWith("Saved")), true, JSON.stringify(seenLabels));
  assert.deepEqual(collaborationState().snapshot().pictures, { checking: 0, uploading: 0, downloading: 0 });
  assert.equal(el("btn-save").getAttribute("data-state"), "warn");
  assert.equal(el("btn-save").getAttribute("data-actionable"), "true");
  assert.equal(el("collab-size-banner").hidden, false);
  assert.equal(el("collab-size-text").textContent, MERGE_TOO_LARGE_MESSAGE);

  el("collab-size-leave").click();
  await waitUntil(() => !sharedSession(), t.signal);
  assert.equal(el("collab-size-banner").hidden, true);
});

test("picture persist failure shows Could not save on this device, opens banner, and clears on Try again", { timeout: 20_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const run = kit.launch();
  const port = await run.port();
  const token = kit.invitation().token;
  let failBlobPersist = true;
  const mem = createMemoryBackend();
  setBackend({
    ...mem,
    persistent: true,
    put: (sha, bytes, mime, replaceDamaged) =>
      failBlobPersist ? Promise.reject(new DOMException("Disk full", "QuotaExceededError")) : mem.put(sha, bytes, mime, replaceDamaged)
  });
  const realFetch = globalThis.fetch;
  const putFinish = eventResult<Response>();
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") return putFinish.promise;
    return realFetch(input, init);
  });

  t.after(() => { setBackend({ ...createMemoryBackend(), persistent: true }); });

  let connected = false;
  const result = await hook().enterRetained({
    deployment: "pic-persist-fail",
    script: NAME,
    relayUrl: "ws://127.0.0.1:" + port,
    invitation: { token },
    onRelayConnected: ready => { connected = ready; }
  });
  assert.deepEqual(result, { ok: true });
  t.after(async () => {
    putFinish.resolve(new Response(null, { status: 201 }));
    if (sharedSession()) await hook().leave();
  });

  await waitUntil(() => connected && el("btn-save").textContent === "Saved on this device", t.signal);
  const picture = intern(png);
  assert.ok(picture);
  const { nativeEditorRecords } = await import("../../../../src/bootstrap/wiring/shared-session.ts");
  const row = currentDocument()?.rows[0];
  assert.ok(row);
  nativeEditorRecords()?.gallery(row.id, "Picture added", r => { addGalleryPicture(r, picture, "pixel.png"); return true; });

  await waitUntil(() => el("btn-save").textContent === "Could not save on this device", t.signal);
  assert.equal(el("save-error-banner").hidden, false);

  failBlobPersist = false;
  putFinish.resolve(new Response(null, { status: 201 }));
  el("save-error-retry").click();
  await waitUntil(() => el("save-error-banner").hidden && el("btn-save").textContent === "Saved on this device", t.signal);
  assert.deepEqual(await hook().leave(), { ok: true });
});

test("changing the invitation rebinds pictures to the new credential on the same session", { timeout: 20_000 }, async t => {
  const session = seedSession({ A: "Keep this session" });
  const put = eventResult<string | null>();
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      put.resolve(new Headers(init.headers).get("Authorization"));
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    return realFetch(input, init);
  });

  const { createRetainedPictureBinding } = await import("../../../../src/bootstrap/wiring/retained-shared-script.ts");
  const binding = createRetainedPictureBinding({
    pictureOrigin: "http://127.0.0.1:19999",
    script: NAME,
    token: "guest-fixture",
    sessionCurrent: () => true,
    onLocalError: () => {}
  });
  t.after(() => { binding.detach(); session.close(); collaborationState().leave(); });
  collaborationState().enter();
  binding.bindCopy({ session });
  binding.activate();
  binding.replaceToken(session, "owner-fixture");

  const picture = intern(png);
  assert.ok(picture);
  assert.deepEqual(await persist([picture.sha256]), []);
  const row = session.document().rows[0];
  assert.ok(row);
  assert.equal(session.commands.setField({ kind: "gallery", id: row.id }, { imageRef: picture }).kind, "written");
  assert.equal(await put.promise, "Bearer owner-fixture");
});

test("session-replaced rebinds picture session so subsequent pictures keep uploading", { timeout: 20_000 }, async t => {
  const firstSession = seedSession({ A: "Before replace" });
  const secondSession = openNativeSession({ kind: "state", state: firstSession.encodeState() }, { actor: "tester", sanitize: v => String(v ?? "") });
  t.after(() => { firstSession.close(); secondSession.close(); });

  const putStarted = eventResult<undefined>(), putFinish = eventResult<Response>();
  const uploadedUrls: string[] = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      uploadedUrls.push(String(input));
      putStarted.resolve(undefined);
      return putFinish.promise;
    }
    return realFetch(input, init);
  });

  collaborationState().enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });
  const { createRetainedPictureBinding } = await import("../../../../src/bootstrap/wiring/retained-shared-script.ts");
  let active = true;
  const binding = createRetainedPictureBinding({
    pictureOrigin: "http://127.0.0.1:19999",
    script: NAME,
    token: "fixture-token",
    sessionCurrent: () => active,
    onLocalError: err => { collaborationState().setLocalWriteError(err); }
  });
  t.after(() => {
    active = false;
    putFinish.resolve(new Response(null, { status: 201 }));
    binding.detach();
    collaborationState().leave();
  });

  binding.bindCopy({ session: firstSession });
  binding.activate();
  assert.equal(el("btn-save").textContent, "Saved on this device");

  firstSession.close();
  binding.onRelayEvent({ kind: "session-replaced", session: secondSession, undoHistory: "fresh" });
  binding.onRelayEvent({ kind: "status", status: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });

  const picture = intern(png);
  assert.ok(picture);
  assert.deepEqual(await persist([picture.sha256]), []);
  const row = secondSession.document().rows[0];
  assert.ok(row);
  assert.equal(secondSession.commands.setField({ kind: "gallery", id: row.id }, { imageRef: picture }).kind, "written");

  await putStarted.promise;
  await waitUntil(() => el("btn-save").textContent === "Saved on this device · uploading pictures", t.signal);
  assert.equal(uploadedUrls.length, 1);

  putFinish.resolve(new Response(null, { status: 201 }));
  await waitUntil(() => el("btn-save").textContent === "Saved on this device", t.signal);
  assert.deepEqual(collaborationState().snapshot().pictures, { checking: 0, uploading: 0, downloading: 0 });
});
