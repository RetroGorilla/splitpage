import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { refsIn } from "../../../../shared/blob-policy.ts";
import { sharedPictureHttp } from "../../../../src/adapters/collab/native/picture-http.ts";
import { startSharedPictures } from "../../../../src/adapters/collab/native/shared-pictures.ts";
import { IDLE_COLLABORATION_SNAPSHOT } from "../../../../src/application/collaboration/state.ts";
import { sharedSaveStatus } from "../../../../src/application/save/status.ts";
import { createBlobStore, createMemoryBlobBackend } from "../../../../src/adapters/storage/blob-store.ts";
import { fileImagesMissing } from "../../../../src/adapters/formats/project-file.ts";
import { buildExportDocument } from "../../../../src/core/document/export-document.ts";
import { imageRecordOf } from "../../../../src/core/document/media.ts";
import { enterSharedDocument } from "../../../../src/core/migrate.ts";
import { NAME, serverHarness } from "./server-harness.ts";
import { eventResult } from "./indexeddb-fixture.ts";

const png = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z7cAAAAASUVORK5CYII=", "base64"
));
const picture = imageRecordOf(png);
assert.ok(picture);
const pictureHash = picture.sha256;

test("reconnect during a held request preserves one immediate retry before backoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const started = eventResult<undefined>(), held = eventResult<Response>();
  let calls = 0;
  const http = sharedPictureHttp("http://127.0.0.1", NAME, "fixture", () => {
    if (++calls === 1) {
      started.resolve(undefined);
      return held.promise;
    }
    return Promise.resolve(new Response(null, { status: 503 }));
  });
  const worker = startSharedPictures(http, localStore(), () => {});
  try {
    worker.track([pictureHash]);
    t.mock.timers.tick(0);
    await started.promise;
    worker.reconnect();
    worker.reconnect();
    t.mock.timers.tick(0);
    assert.equal(calls, 1);
    held.resolve(new Response(null, { status: 503 }));
    await nextTurn();
    t.mock.timers.tick(0);
    await nextTurn();
    assert.equal(Date.now(), 0);
    assert.equal(calls, 2);
    t.mock.timers.tick(999);
    await nextTurn();
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(calls, 3);
  } finally { worker.stop(); }
});

test("download validation refusal suppresses retries until that reference is removed", async () => {
  for (const status of [413, 415, 422]) {
    const calls: string[] = [];
    const original = pictureHash, replacement = "f".repeat(64);
    let settled = () => {};
    const http = sharedPictureHttp("http://127.0.0.1", NAME, "fixture", async url => {
      calls.push(String(url).split("/").at(-1) ?? "");
      return new Response(null, { status });
    });
    const worker = startSharedPictures(http, localStore(), () => settled());
    async function reject(sha: string) {
      const done = new Promise<void>(resolve => { settled = resolve; });
      worker.track([sha]);
      await done;
      assert.ok(worker.rejected([sha]));
    }
    try {
      await reject(original);
      worker.reconnect();
      await worker.prepareExport([original]);
      assert.deepEqual(calls, [original]);
      await reject(replacement);
      assert.equal(worker.rejected([original]), false);
      await reject(original);
      assert.deepEqual(calls, [original, replacement, original]);
    } finally { worker.stop(); }
  }
});

function localStore() {
  const store = createBlobStore({
    preferred: null, fallback: createMemoryBlobBackend, objectUrl: () => "",
    revokeObjectUrl() {}, later: queueMicrotask, warn() {}
  });
  store.setBackend({ ...createMemoryBlobBackend(), persistent: true });
  return store;
}

for (const upload of [true, false]) {
  test(upload ? "two copies discover a late upload and refetch damaged bytes" : "a copy exports with a warning when the uploader never returns",
    { timeout: 15_000 }, async t => {
      const kit = serverHarness(t);
      kit.seed();
      const run = kit.launch();
      const port = await run.port();
      const first = kit.copy(port), second = kit.copy(port);
      await kit.until(() => first.relay.status().firstSyncDone && second.relay.status().firstSyncDone || undefined);
      const origin = "http://127.0.0.1:" + port;
      const token = kit.invitation().token;
      let get = 0, damaged = 0;
      const statuses: number[] = [];
      const readerHttp = sharedPictureHttp(origin, NAME, token, async (url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization") === "Bearer " + token, true);
        get++;
        const response = await fetch(url, init);
        statuses.push(response.status);
        if (response.status !== 200 || damaged) return response;
        damaged++;
        await response.body?.cancel();
        const bytes = png.slice();
        bytes[30] = (bytes[30] ?? 0) ^ 1;
        return new Response(bytes, { status: 200 });
      });
      const writerStore = localStore(), readerStore = localStore();
      const putStatuses: number[] = [];
      const writerHttp = sharedPictureHttp(origin, NAME, token, async (url, init) => {
        const response = await fetch(url, init);
        putStatuses.push(response.status);
        return response;
      });
      const writer = startSharedPictures(writerHttp, writerStore, () => {});
      const reader = startSharedPictures(readerHttp, readerStore, () => {});
      t.after(() => { writer.stop(); reader.stop(); });
      const row = first.session.document().rows[0];
      assert.ok(row);
      writerStore.intern(png);
      assert.deepEqual(await writerStore.persist([picture.sha256]), []);
      assert.equal(first.session.commands.setField({ kind: "gallery", id: row.id }, { imageRef: picture }).kind, "written");
      await kit.until(() => refsIn(second.session.document()).includes(picture.sha256) || undefined);
      reader.track(refsIn(second.session.document()));
      while (!statuses.length) await delay(10, undefined, { signal: t.signal });
      assert.equal(statuses[0], 404);
      assert.equal(readerStore.bytesFor(picture.sha256), null);
      if (upload) {
        writer.track(refsIn(first.session.document()));
        for (let i = 0; i < 250 && !reader.ready([picture.sha256]); i++) await delay(10, undefined, { signal: t.signal });
        assert.ok(reader.ready([picture.sha256]), JSON.stringify({ putStatuses, statuses, damaged }));
        assert.equal(damaged, 1);
        assert.ok(get >= 3);
        assert.deepEqual(readerStore.bytesFor(picture.sha256), png);
      } else {
        first.close();
        writer.stop();
        const captured = buildExportDocument(enterSharedDocument(second.session.document()), "2026-01-01T00:00:00Z", {
          production: [], commentNumbers: {}, broll: []
        });
        await reader.prepareExport(refsIn(captured.document));
        assert.deepEqual(fileImagesMissing(captured), [picture.sha256]);
        assert.deepEqual(refsIn(second.session.document()), [picture.sha256]);
        run.send("revoke:" + kit.invitation().id);
        await kit.until(() => second.events.some(event => event.kind === "authentication-failed") || undefined);
        reader.reconnect();
        while (!reader.refused()) await delay(10, undefined, { signal: t.signal });
        assert.equal(statuses.at(-1), 403);
        const refusedCount = get;
        reader.reconnect();
        await reader.prepareExport([picture.sha256]);
        assert.equal(get, refusedCount);
      }
    });
}

test("picture session exposes uploading and downloading counts with change notifications", { timeout: 10_000 }, async t => {
  const uploadStarted = eventResult<undefined>(), uploadFinish = eventResult<Response>();
  const uploadStore = localStore();
  uploadStore.intern(png);
  assert.deepEqual(await uploadStore.persist([pictureHash]), []);
  const uploadHttp = sharedPictureHttp("http://127.0.0.1", NAME, "fixture", (_url, init) => {
    assert.equal(init?.method, "PUT");
    uploadStarted.resolve(undefined);
    return uploadFinish.promise;
  });
  const uploader = startSharedPictures(uploadHttp, uploadStore, () => {});
  const uploadSnapshots: { checking: number; uploading: number; downloading: number }[] = [];
  const stopUploadCounts = uploader.subscribeCounts(counts => uploadSnapshots.push({ ...counts }));
  try {
    assert.deepEqual(uploader.counts(), { checking: 0, uploading: 0, downloading: 0 });
    uploader.track([pictureHash]);
    assert.deepEqual(uploader.counts(), { checking: 0, uploading: 1, downloading: 0 });
    await uploadStarted.promise;
    assert.deepEqual(uploader.counts(), { checking: 0, uploading: 1, downloading: 0 });
    uploadFinish.resolve(new Response(null, { status: 201 }));
    while (uploader.counts().uploading > 0) await delay(5, undefined, { signal: t.signal });
    assert.deepEqual(uploader.counts(), { checking: 0, uploading: 0, downloading: 0 });
    assert.deepEqual(uploadSnapshots, [
      { checking: 0, uploading: 1, downloading: 0 },
      { checking: 0, uploading: 0, downloading: 0 }
    ]);
  } finally {
    stopUploadCounts();
    uploader.stop();
  }

  const downloadStarted = eventResult<undefined>(), downloadFinish = eventResult<Response>();
  const downloadStore = localStore();
  const downloadHttp = sharedPictureHttp("http://127.0.0.1", NAME, "fixture", (_url, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    downloadStarted.resolve(undefined);
    return downloadFinish.promise;
  });
  const downloader = startSharedPictures(downloadHttp, downloadStore, () => {});
  const downloadSnapshots: { checking: number; uploading: number; downloading: number }[] = [];
  const stopDownloadCounts = downloader.subscribeCounts(counts => downloadSnapshots.push({ ...counts }));
  try {
    downloader.track([pictureHash]);
    await downloadStarted.promise;
    assert.deepEqual(downloader.counts(), { checking: 0, uploading: 0, downloading: 1 });
    downloadFinish.resolve(new Response(png, { status: 200 }));
    while (downloader.counts().downloading > 0 || downloader.counts().checking > 0) await delay(5, undefined, { signal: t.signal });
    assert.deepEqual(downloader.counts(), { checking: 0, uploading: 0, downloading: 0 });
    assert.equal(downloadSnapshots.some(s => s.downloading === 1), true);
    assert.deepEqual(downloadSnapshots.at(-1), { checking: 0, uploading: 0, downloading: 0 });
  } finally {
    stopDownloadCounts();
    downloader.stop();
  }
});

test("queued remote pictures are counted as downloading instead of checking so status stays syncing or offline", async t => {
  const remoteA = pictureHash, remoteB = "a".repeat(64), remoteC = "b".repeat(64);
  const firstStarted = eventResult<undefined>(), releaseFirst = eventResult<Response>();
  const store = localStore();
  const http = sharedPictureHttp("http://127.0.0.1", NAME, "fixture", url => {
    if (String(url).endsWith(remoteA)) {
      firstStarted.resolve(undefined);
      return releaseFirst.promise;
    }
    return new Promise<Response>(() => {});
  });
  const worker = startSharedPictures(http, store, () => {});
  try {
    worker.track([remoteA, remoteB, remoteC]);
    assert.deepEqual(worker.counts(), { checking: 0, uploading: 0, downloading: 3 });
    await firstStarted.promise;
    assert.equal(worker.counts().checking, 0);
    assert.ok(worker.counts().downloading >= 2);
    const online = sharedSaveStatus({
      ...IDLE_COLLABORATION_SNAPSHOT,
      active: true,
      relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 },
      pictures: worker.counts()
    });
    assert.equal(online.label, "Saved on this device · syncing");
    const offline = sharedSaveStatus({
      ...IDLE_COLLABORATION_SNAPSHOT,
      active: true,
      relay: { connected: false, firstSyncDone: false, pendingChangeCount: 0 },
      pictures: worker.counts()
    });
    assert.equal(offline.label, "Offline · saved on this device");
  } finally {
    releaseFirst.resolve(new Response(null, { status: 503 }));
    worker.stop();
  }
  await delay(1, undefined, { signal: t.signal });
});

test("picture persist failure notifies storageError and clears once retryStorage succeeds", async t => {
  const store = localStore();
  store.intern(png);
  let failPersist = true;
  const realPersist = store.persist;
  const wrappedStore = {
    ...store,
    persist: async (shas: unknown) => failPersist ? [...(Array.isArray(shas) ? shas as string[] : [])] : realPersist(shas)
  };
  const uploadDone = eventResult<undefined>();
  const http = sharedPictureHttp("http://127.0.0.1", NAME, "fixture", () => {
    uploadDone.resolve(undefined);
    return Promise.resolve(new Response(null, { status: 201 }));
  });
  const worker = startSharedPictures(http, wrappedStore, () => {});
  const storageEvents: boolean[] = [];
  const stopStorage = worker.subscribeStorageError(failed => storageEvents.push(failed));
  try {
    worker.track([pictureHash]);
    while (!worker.storageError()) await delay(5, undefined, { signal: t.signal });
    assert.deepEqual(storageEvents, [true]);
    assert.equal(worker.counts().checking, 0);
    assert.equal(worker.counts().uploading, 1);

    failPersist = false;
    worker.retryStorage();
    await uploadDone.promise;
    while (worker.storageError() || worker.counts().uploading > 0) await delay(5, undefined, { signal: t.signal });
    assert.deepEqual(storageEvents, [true, false]);
    assert.deepEqual(worker.counts(), { checking: 0, uploading: 0, downloading: 0 });
  } finally {
    stopStorage();
    worker.stop();
  }
});

test("picture counts stay steady across transient retries and drop to zero on access refusal or rejection", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const store = localStore();
  store.intern(png);
  assert.deepEqual(await store.persist([pictureHash]), []);
  let attempts = 0;
  const firstAttempt = eventResult<undefined>(), releaseFirst = eventResult<Response>();
  const http = sharedPictureHttp("http://127.0.0.1", NAME, "fixture", () => {
    attempts++;
    if (attempts === 1) {
      firstAttempt.resolve(undefined);
      return releaseFirst.promise;
    }
    return Promise.resolve(new Response(null, { status: 201 }));
  });
  const uploader = startSharedPictures(http, store, () => {});
  const seen: { checking: number; uploading: number; downloading: number }[] = [];
  const stopCounts = uploader.subscribeCounts(c => seen.push({ ...c }));
  try {
    uploader.track([pictureHash]);
    t.mock.timers.tick(0);
    await firstAttempt.promise;
    releaseFirst.resolve(new Response(null, { status: 503 }));
    await nextTurn();
    assert.deepEqual(uploader.counts(), { checking: 0, uploading: 1, downloading: 0 });
    t.mock.timers.tick(500);
    await nextTurn();
    assert.equal(attempts, 2);
    await nextTurn();
    assert.deepEqual(uploader.counts(), { checking: 0, uploading: 0, downloading: 0 });
    assert.deepEqual(seen, [
      { checking: 0, uploading: 1, downloading: 0 },
      { checking: 0, uploading: 0, downloading: 0 }
    ]);
  } finally {
    stopCounts();
    uploader.stop();
  }

  for (const status of [403, 422]) {
    const done = eventResult<undefined>();
    const dlStore = localStore();
    const dlHttp = sharedPictureHttp("http://127.0.0.1", NAME, "fixture", () => {
      done.resolve(undefined);
      return Promise.resolve(new Response(null, { status }));
    });
    const worker = startSharedPictures(dlHttp, dlStore, () => {});
    try {
      worker.track([pictureHash]);
      t.mock.timers.tick(0);
      await done.promise;
      await nextTurn();
      await nextTurn();
      assert.deepEqual(worker.counts(), { checking: 0, uploading: 0, downloading: 0 });
    } finally {
      worker.stop();
    }
  }
});

test("track drop, stop while in flight, and reconnect during backoff keep counts and listeners clean", async t => {
  const storeA = localStore();
  let capturedSignal: AbortSignal | undefined;
  const startedA = eventResult<undefined>();
  const workerA = startSharedPictures(
    sharedPictureHttp("http://127.0.0.1", NAME, "fixture", (_u, init) => {
      capturedSignal = init?.signal ?? undefined;
      startedA.resolve(undefined);
      return new Promise<Response>(() => {});
    }),
    storeA,
    () => {}
  );
  try {
    workerA.track([pictureHash]);
    await startedA.promise;
    assert.equal(workerA.counts().downloading, 1);
    workerA.track([]);
    assert.equal(capturedSignal?.aborted, true);
    assert.deepEqual(workerA.counts(), { checking: 0, uploading: 0, downloading: 0 });
  } finally {
    workerA.stop();
  }

  const storeB = localStore();
  const startedB = eventResult<undefined>(), resolveB = eventResult<Response>();
  const workerB = startSharedPictures(
    sharedPictureHttp("http://127.0.0.1", NAME, "fixture", () => {
      startedB.resolve(undefined);
      return resolveB.promise;
    }),
    storeB,
    () => {}
  );
  const eventsB: { checking: number; uploading: number; downloading: number }[] = [];
  workerB.subscribeCounts(c => eventsB.push({ ...c }));
  workerB.track([pictureHash]);
  await startedB.promise;
  workerB.stop();
  assert.deepEqual(eventsB, [
    { checking: 0, uploading: 0, downloading: 1 },
    { checking: 0, uploading: 0, downloading: 0 }
  ]);
  resolveB.resolve(new Response(png, { status: 200 }));
  await delay(10);
  assert.equal(eventsB.length, 2);

  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let calls = 0;
  const firstFail = eventResult<undefined>(), secondDone = eventResult<undefined>();
  const workerC = startSharedPictures(
    sharedPictureHttp("http://127.0.0.1", NAME, "fixture", () => {
      calls++;
      if (calls === 1) {
        firstFail.resolve(undefined);
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      secondDone.resolve(undefined);
      return Promise.resolve(new Response(png, { status: 200 }));
    }),
    localStore(),
    () => {}
  );
  try {
    workerC.track([pictureHash]);
    t.mock.timers.tick(0);
    await firstFail.promise;
    await nextTurn();
    assert.deepEqual(workerC.counts(), { checking: 0, uploading: 0, downloading: 1 });
    workerC.reconnect();
    t.mock.timers.tick(0);
    await secondDone.promise;
    await nextTurn();
    await nextTurn();
    assert.deepEqual(workerC.counts(), { checking: 0, uploading: 0, downloading: 0 });
  } finally {
    workerC.stop();
  }
});
