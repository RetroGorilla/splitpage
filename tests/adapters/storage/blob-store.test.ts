import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { createBlobStore, createIdbBlobBackend, createMemoryBlobBackend } from "../../../src/adapters/storage/blob-store.ts";
import type { BlobBackend, BlobStoreHost, PreferredBlobBackend } from "../../../src/adapters/storage/blob-store.ts";
import { createImageIngestion } from "../../../src/core/document/media.ts";
import { image } from "../../../src/test/golden-helpers.mjs";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface Recorded {
  host: BlobStoreHost;
  warnings: unknown[][];
  queued: (() => void)[];
  urls: { bytes: Uint8Array; mime: string }[];
  revoked: string[];
}

function hostWith(preferred: PreferredBlobBackend | null): Recorded {
  const rec: Recorded = { warnings: [], queued: [], urls: [], revoked: [], host: null as unknown as BlobStoreHost };
  rec.host = {
    preferred: preferred,
    fallback: createMemoryBlobBackend,
    objectUrl: (bytes, mime) => { rec.urls.push({ bytes: bytes, mime: mime }); return "blob:test/" + rec.urls.length; },
    revokeObjectUrl: (url) => { rec.revoked.push(url); },
    later: (run) => { rec.queued.push(run); },
    now: () => 1000,
    warn: (...args) => { rec.warnings.push(args); }
  };
  return rec;
}

function runQueued(rec: Recorded): void {
  while (rec.queued.length) (rec.queued.shift() as () => void)();
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("built with its backend: the preferred one is opened on first use and nothing else is asked", async () => {
  const puts: string[] = [];
  const backend: BlobBackend = {
    name: "fake", persistent: true,
    get: () => Promise.resolve(null),
    put: (s) => { puts.push(s); return Promise.resolve(); },
    missing: (shas) => Promise.resolve(shas.slice())
  };
  let opens = 0;
  const rec = hostWith({ available: () => true, open: () => { opens++; return Promise.resolve(backend); } });
  const store = createBlobStore(rec.host);
  assert.equal(store.backendInfo(), null, "nothing opened at construction");
  assert.equal(opens, 0);
  const a = image("png", 11, 2);
  const ref = store.intern(a.bytes);
  assert.deepEqual(ref, a.record);
  store.queuePersist([a.sha256]);
  assert.deepEqual(puts, [], "a queued persist waits for the host's later");
  runQueued(rec);
  await tick();
  await tick();
  assert.equal(opens, 1);
  assert.deepEqual(puts, [a.sha256]);
  assert.deepEqual(store.backendInfo(), { name: "fake", persistent: true });
  assert.equal(store.isDurable(a.sha256), true);
});

test("a preferred backend that will not open: one warning, then memory, and it is not tried again", async () => {
  let opens = 0;
  const rec = hostWith({ available: () => true, open: () => { opens++; return Promise.reject(new Error("blocked")); } });
  const store = createBlobStore(rec.host);
  const a = image("gif", 12, 2);
  store.intern(a.bytes);
  assert.deepEqual(await store.persist([a.sha256]), []);
  assert.deepEqual(store.backendInfo(), { name: "memory", persistent: false });
  assert.equal(store.isDurable(a.sha256), false);
  store.setBackend(null);
  assert.deepEqual(await store.ensureBytes(["0".repeat(64)]), ["0".repeat(64)]);
  assert.equal(opens, 1);
  assert.equal(rec.warnings.length, 1);
});

test("with no backend and none available, a queued persist is dropped and nothing is scheduled", () => {
  const rec = hostWith({ available: () => false, open: () => Promise.reject(new Error("none")) });
  const store = createBlobStore(rec.host);
  const a = image("png", 13, 2);
  store.intern(a.bytes);
  store.queuePersist([a.sha256]);
  assert.equal(rec.queued.length, 0);
});

test("every read hands out bytes the caller owns (E14)", () => {
  const rec = hostWith(null);
  const store = createBlobStore(rec.host);
  const a = image("jpeg", 14, 2);
  store.intern(a.bytes);
  const out = store.bytesFor(a.sha256) as Uint8Array;
  out.fill(7);
  const again = store.bytesFor(a.sha256) as Uint8Array;
  assert.deepEqual(again, a.bytes);
  assert.equal(sha(again), a.sha256);
  assert.equal(store.urlFor(a.sha256), "blob:test/1");
  assert.equal(store.urlFor(a.sha256), "blob:test/1", "one object URL per picture");
  store.revokeUrls();
  assert.deepEqual(rec.revoked, ["blob:test/1"]);
});

test("persist hands the backend a copy: a backend writing into it changes nothing in the store", async () => {
  let given: Uint8Array | null = null;
  const rec = hostWith(null);
  const store = createBlobStore(rec.host);
  store.setBackend({
    name: "scribbler", persistent: true,
    get: () => Promise.resolve(null),
    put: (_s, bytes) => { given = bytes; bytes.fill(1); return Promise.resolve(); },
    missing: () => Promise.resolve([])
  });
  const a = image("webp", 15, 2);
  store.intern(a.bytes);
  assert.deepEqual(await store.persist([a.sha256]), []);
  assert.notEqual(given, null);
  assert.deepEqual(store.bytesFor(a.sha256), a.bytes);
});

test("the IndexedDB backend stores a picture as a Blob record and reads the same bytes back", async () => {
  let now = 5000;
  const factory = new IDBFactory();
  const idb = createIdbBlobBackend(() => factory as unknown as IDBFactory, () => now);
  assert.equal(idb.available(), true);
  const backend = await idb.open();
  const a = image("png", 16, 2);
  const bytes = a.bytes as Uint8Array;
  await backend.put(a.sha256, bytes, "image/png");
  const info = await idb.record(a.sha256);
  assert.deepEqual(info, { mime: "image/png", size: a.bytes.length, isBlob: true, addedAt: 5000, usedAt: 5000 });
  const got = await backend.get(a.sha256);
  assert.deepEqual(got && got.bytes, a.bytes);
  assert.deepEqual(await backend.missing([a.sha256, "1".repeat(64), "junk"]), ["1".repeat(64), "junk"]);
  now += 25 * 60 * 60 * 1000;
  await backend.put(a.sha256, bytes, "image/png");
  assert.equal((await idb.record(a.sha256))?.usedAt, now, "a put of a held picture a day later touches it");
  assert.equal(createIdbBlobBackend(() => null, () => now).available(), false);
  await assert.rejects(createIdbBlobBackend(() => null, () => now).open(), /no-indexeddb/);
});

test("adopt keeps what an ingestion handed over as it is, in order, and checks anything else by hashing it (#320)", () => {
  const rec = hostWith(null);
  const store = createBlobStore(rec.host);
  const a = image("png", 17, 2), b = image("jpeg", 18, 2), c = image("gif", 19, 2);
  const ingest = createImageIngestion(store.recordFor);
  ingest.fromDataUrl(b.dataUrl);
  ingest.fromDataUrl(a.dataUrl);
  const taken = ingest.take();
  store.adopt(taken);
  assert.deepEqual(store.recordFor(b.sha256), b.record);
  assert.deepEqual(store.recordFor(a.sha256), a.record);
  assert.deepEqual(store.bytesFor(a.sha256), a.bytes);
  assert.deepEqual(ingest.known(a.sha256), a.record, "the ingestion now finds it in the store");

  const forged = { ref: { sha256: "f".repeat(64), width: 1, height: 1, mime: "image/png" }, bytes: new Uint8Array(c.bytes as Uint8Array) };
  store.adopt([forged]);
  assert.equal(store.has("f".repeat(64)), false, "a ref nobody hashed is not believed");
  assert.deepEqual(store.recordFor(c.sha256), c.record, "the bytes are kept under their own hash");
  forged.bytes.fill(0);
  assert.deepEqual(store.bytesFor(c.sha256), c.bytes, "and copied, since the caller still holds them");
});

test("internDataUrl hashes the decoded bytes once and keeps them: the same picture however it is spelled", () => {
  const store = createBlobStore(hostWith(null).host);
  const a = image("webp", 20, 2);
  assert.deepEqual(store.internDataUrl(a.dataUrl), a.record);
  assert.deepEqual(store.internDataUrl(a.dataUrl.replace("base64,", "base64,\n")), a.record);
  assert.deepEqual(store.bytesFor(a.sha256), a.bytes);
  assert.equal(store.internDataUrl("data:image/png;base64,aGVsbG8="), null);
});
