import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { bootApp, closeApp } from "../../../../src/test/_app-boot.mjs";
import { currentDocument, sharedSession } from "../../../../src/bootstrap/wiring/session-owner.ts";
import { historyOwner } from "../../../../src/bootstrap/wiring/history.ts";
import { collaborationState } from "../../../../src/bootstrap/wiring/collaboration-owner.ts";
import { sharedUndoRoute } from "../../../../src/bootstrap/wiring/undo.ts";
import { openDocument } from "../../../../src/bootstrap/wiring/transition-owners.ts";
import { toggleFileMenu } from "../../../../src/bootstrap/wiring/file-menu-controls.ts";
import { exportDocumentOf } from "../../../../src/bootstrap/wiring/export-capture.ts";
import type { RetainedSharedScript } from "../../../../src/bootstrap/wiring/retained-shared-script.ts";
import type { SharedSwitchOutcome } from "../../../../src/bootstrap/wiring/shared-session.ts";
import { buildSplitpageFile } from "../../../../src/adapters/formats/project-file.ts";
import { createMemoryBackend, has, setBackend } from "../../../../src/adapters/storage/02c-blobs.ts";
import { sharedPictureHttp } from "../../../../src/adapters/collab/native/picture-http.ts";
import { seedSession } from "./local-store-fixture.ts";
import { imageRecordOf } from "../../../../src/core/document/media.ts";
import { eventResult } from "./indexeddb-fixture.ts";
import { serverHarness } from "./server-harness.ts";

const png = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z7cAAAAASUVORK5CYII=", "base64"
));

function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  assert.ok(button, selector);
  assert.equal(button.hidden || button.disabled, false, selector);
  button.click();
}

test("shared history reads relay versions, saves a separate file, and restores an old pictured beat on both copies", { timeout: 30_000 }, async t => {
  Reflect.set(globalThis, "SPLITPAGE_COLLAB_UI", true);
  await bootApp();
  window.Element.prototype.scrollBy = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
    configurable: true, get(this: HTMLElement) { return this.parentElement; }
  });
  setBackend({ ...createMemoryBackend(), persistent: true });
  const hook = (window as unknown as { __sharedTest: {
    enterRetained: (entry: RetainedSharedScript) => Promise<SharedSwitchOutcome>;
    leave: () => Promise<SharedSwitchOutcome>;
  } }).__sharedTest;
  const kit = serverHarness(t);
  let requestedPicture = false;
  const releasePicture = eventResult<undefined>();
  t.after(async () => {
    releasePicture.resolve(undefined);
    if (sharedSession()) await hook.leave();
    Reflect.deleteProperty(globalThis, "SPLITPAGE_COLLAB_UI");
    closeApp();
  });
  async function wait(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 5000;
    do {
      if (await check()) return;
      await delay(10, undefined, { signal: t.signal });
    } while (Date.now() < deadline);
    assert.fail("Timed out waiting for " + check.toString() + " — " + document.getElementById("history-list")?.textContent);
  }

  const source = currentDocument();
  assert.ok(source);
  const originalFile = new File([buildSplitpageFile(exportDocumentOf(source))], "original.splitpage");
  const local = historyOwner().captureSnapshot("Before sharing on this device", source, { allowSeedSkip: false });
  assert.ok(local);
  assert.equal((await local.done).stored, true);

  const picture = imageRecordOf(png);
  assert.ok(picture);
  const historical = seedSession({ A: "Live beat", B: "Old pictured beat" });
  assert.equal(historical.commands.setField({ kind: "gallery", id: "B" }, { imageRef: picture }).kind, "written");
  const stored = historical.encodeState(), scriptDocId = historical.document().docId;
  historical.close();
  const run = kit.launch({ SPLITPAGE_VERSION_INTERVAL_MS: "100" });
  const port = await run.port();
  const { scriptId, owner, guest } = await run.createScriptWithCredentials(randomUUID(), stored);
  assert.ok(owner && guest);
  const pictureHttp = sharedPictureHttp("http://127.0.0.1:" + port, scriptId, owner.token);
  assert.equal(await pictureHttp.upload(picture.sha256, png, picture.mime, t.signal), "stored");
  const historyPath = `scripts/${scriptId}/versions`;
  async function listing() {
    const response = await run.owner(historyPath, {}, owner?.token);
    assert.equal(response.status, 200);
    return await response.json() as { id: string }[];
  }
  let oldId: string | undefined;
  await wait(async () => { oldId = (await listing())[0]?.id; return !!oldId; });

  const peer = kit.copy(port, { kind: "empty" }, scriptId, owner.token);
  await kit.until(() => peer.session.document().rows.length === 2 || undefined);
  assert.equal(peer.session.commands.removeRows(["B"]).kind, "written");
  await wait(async () => (await listing()).length === 2);

  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: URL | string | Request, options?: RequestInit) => {
    if (String(input).endsWith("/pictures/" + picture.sha256)) {
      requestedPicture = true;
      await releasePicture.promise;
    }
    return realFetch(input, options);
  });
  let downloaded: Blob | undefined;
  const urls = new Map<string, Blob>();
  t.mock.method(URL, "createObjectURL", (blob: Blob) => {
    const url = "blob:https://splitpage.test/" + randomUUID();
    urls.set(url, blob);
    return url;
  });
  t.mock.method(window.HTMLAnchorElement.prototype, "click", function (this: HTMLAnchorElement) {
    if (this.download.endsWith(".splitpage")) {
      const blob = urls.get(this.href);
      assert.ok(blob);
      downloaded = blob;
    }
  });

  const list = document.getElementById("history-list");
  assert.ok(list);
  for (const membership of [owner, guest]) {
    const entered = await hook.enterRetained({
      deployment: "history-" + membership.role, script: scriptId, relayUrl: "ws://127.0.0.1:" + port,
      invitation: { token: membership.token }
    });
    assert.deepEqual(entered, { ok: true });
    await wait(() => collaborationState().snapshot().relay.connected);
    toggleFileMenu(true);
    click('#file-menu [data-file-action="history"]');
    await wait(() => list.querySelectorAll("[data-shared-version]").length === 2);
    assert.doesNotMatch(list.textContent ?? "", /Before sharing on this device/);
    assert.equal(document.getElementById("history-older")?.hidden, true);
    if (membership.role === "owner") {
      click("#history-close");
      assert.deepEqual(await hook.leave(), { ok: true });
    }
  }

  const live = currentDocument();
  click(`[data-shared-version="${oldId}"]`);
  await wait(() => !!list.querySelector(".shared-history-preview"));
  assert.equal(list.querySelector(".shared-history-preview")?.getAttribute("contenteditable"), "false");
  assert.match(list.textContent ?? "", /Old pictured beat/);
  assert.deepEqual(currentDocument(), live);
  await wait(() => requestedPicture);
  assert.equal(has(picture.sha256), false);
  const oldBeat = Array.from(list.querySelectorAll("article")).find(beat => beat.textContent?.includes("Old pictured beat"));
  assert.ok(oldBeat);
  (oldBeat.querySelector("button") as HTMLButtonElement).click();
  await wait(() => currentDocument()?.rows.length === 2 && peer.session.document().rows.length === 2);
  const restored = currentDocument()?.rows.find(row => row.audioText === "Old pictured beat");
  assert.ok(restored);
  assert.notEqual(restored.id, "B");
  assert.deepEqual(restored.imageRef, picture);
  assert.equal(has(picture.sha256), false);
  releasePicture.resolve(undefined);
  await wait(() => has(picture.sha256));

  click('[data-shared-history="save"]');
  await wait(() => !!downloaded);
  assert.ok(downloaded);
  const savedText = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(downloaded as Blob);
  });
  const saved = JSON.parse(savedText) as { docId: string; rows: { id: string; visualImage: string }[] };
  assert.match(saved.docId, /^d[0-9a-f]{32}$/);
  assert.notEqual(saved.docId, source.docId);
  assert.notEqual(saved.docId, scriptDocId);
  assert.equal(saved.rows[1]?.id, "B");
  assert.match(saved.rows[1]?.visualImage ?? "", /^data:image\/png;/);
  assert.equal(currentDocument()?.docId, scriptDocId);
  sharedUndoRoute()?.replay?.("undo");
  await wait(() => currentDocument()?.rows.length === 1 && peer.session.document().rows.length === 1);
  assert.equal(currentDocument()?.rows[0]?.audioText, "Live beat");

  const relay = collaborationState().snapshot().relay;
  collaborationState().setRelay({ ...relay, connected: false });
  await wait(() => /You’re offline/.test(list.textContent ?? ""));
  assert.equal(list.querySelectorAll("[data-shared-version]").length, 0);
  click("#history-close");
  assert.deepEqual(await hook.leave(), { ok: true });
  await openDocument({ kind: "file", file: originalFile, handle: null, options: { skipSnapshot: true } });
  assert.equal(currentDocument()?.docId, source.docId);
  toggleFileMenu(true);
  click('#file-menu [data-file-action="history"]');
  await wait(() => /Before sharing on this device/.test(list.textContent ?? ""));
});
