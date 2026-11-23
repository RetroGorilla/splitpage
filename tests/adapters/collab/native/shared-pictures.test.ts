import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { refsIn } from "../../../../shared/blob-policy.ts";
import { sharedPictureHttp } from "../../../../src/adapters/collab/native/picture-http.ts";
import { startSharedPictures } from "../../../../src/adapters/collab/native/shared-pictures.ts";
import { createBlobStore, createMemoryBlobBackend } from "../../../../src/adapters/storage/blob-store.ts";
import { fileImagesMissing } from "../../../../src/adapters/formats/project-file.ts";
import { buildExportDocument } from "../../../../src/core/document/export-document.ts";
import { imageRecordOf } from "../../../../src/core/document/media.ts";
import { enterSharedDocument } from "../../../../src/core/migrate.ts";
import { NAME, serverHarness } from "./server-harness.ts";

const png = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z7cAAAAASUVORK5CYII=", "base64"
));
const picture = imageRecordOf(png);
assert.ok(picture);
const pictureHash = picture.sha256;

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
