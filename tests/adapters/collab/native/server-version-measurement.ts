import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { zstdCompressSync } from "node:zlib";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { DB_NAME, VERSION_CHUNK_BYTES } from "../../../../collab-server/storage.ts";
import { versionStorage } from "../../../../collab-server/version-storage.ts";
import { appendText, NAME, serverHarness, storedText } from "./server-harness.ts";

const MIB = 1024 * 1024;
const VERSION_BYTES = 4 * MIB;
const NEWEST_BYTES = VERSION_BYTES + 15 * 1024;
const SWEEP_MS = 2800;

function snapshot(seed: Uint8Array, opaque: Uint8Array): Uint8Array {
  const doc = new Doc();
  try {
    applyUpdate(doc, seed);
    doc.clientID = 1;
    doc.getMap("fixture").set("payload", opaque);
    return encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

function fullVersion(seed: Uint8Array, target: number) {
  const noise = new Uint8Array(randomBytes(target));
  let length = target - 1024;
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = snapshot(seed, noise.subarray(0, length));
    const compressed = zstdCompressSync(state);
    if (compressed.length === target) return { compressed, state };
    length += target - compressed.length;
  }
  assert.fail("Could not construct the requested compressed fixture size");
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const sample = (fraction: number) => Number(sorted[Math.ceil(sorted.length * fraction) - 1]?.toFixed(3));
  return { count: sorted.length, p50: sample(0.5), p95: sample(0.95), max: sample(1) };
}

test("measure live commits during full-budget history thinning", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  kit.provision(NAME);
  const seed = kit.seed();
  using db = new DatabaseSync(join(kit.directory, DB_NAME), { timeout: 5000 });
  const versions = versionStorage(db);
  const live = snapshot(seed, new Uint8Array(randomBytes(4 * MIB)));
  db.prepare("UPDATE documents SET state = ? WHERE name = ?").run(live, NAME);
  for (let i = 0; i < 16; i++) {
    const id = String(i);
    const { compressed, state } = fullVersion(seed, i === 15 ? NEWEST_BYTES : VERSION_BYTES - 1024);
    const time = i === 15 ? Date.now() : Date.now() - 100 * 24 * 3600_000 + i;
    versions.stage(id, NAME, 1, time, compressed.length, createHash("sha256").update(state).digest());
    for (let offset = 0; offset < compressed.length; offset += VERSION_CHUNK_BYTES) {
      versions.append(id, offset / VERSION_CHUNK_BYTES, compressed.subarray(offset, offset + VERSION_CHUNK_BYTES));
    }
  }
  db.exec("UPDATE versions SET status = 'published'; PRAGMA wal_checkpoint(TRUNCATE)");
  assert.equal(versions.total(), 64 * MIB);
  const retired = db.prepare(`SELECT count(*) AS chunks FROM version_chunks JOIN versions ON id = version_id
    WHERE status = 'retired'`);
  const retiredChunks = () => Number(retired.get()?.chunks);
  const run = kit.launch({
    SPLITPAGE_TEST_MEASURE_STORE: "1",
    SPLITPAGE_STORE_DEBOUNCE_MS: "0",
    SPLITPAGE_STORE_MAX_DEBOUNCE_MS: "0",
    SPLITPAGE_VERSION_THIN_INTERVAL_MS: String(SWEEP_MS)
  });
  const port = await run.port();
  const listeningAt = performance.now();
  const writer = kit.copy(port);
  await kit.until(() => writer.relay.status().firstSyncDone && writer.text() === "word" || undefined);
  let offset = 4;
  async function edit() {
    const startIndex = run.messages.length;
    const sentAt = performance.now();
    appendText(writer.session, "a", offset++);
    const store = await kit.until(() => run.messages.slice(startIndex).find((message): message is string =>
      typeof message === "string" && message.startsWith("measured-store:")));
    return { store: Number(store.split(":")[1]), edit: performance.now() - sentAt };
  }
  const baseline = [];
  for (let i = 0; i < 15; i++) {
    assert.equal(versions.total(), 64 * MIB);
    baseline.push(await edit());
  }
  assert.equal(versions.total(), 64 * MIB);
  await delay(Math.max(0, listeningAt + SWEEP_MS - 120 - performance.now()));
  let aroundPublication;
  while (versions.total() === 64 * MIB) aroundPublication = await edit();
  assert.ok(aroundPublication);
  const observedAt = performance.now();
  const overlap = [];
  const initialRetiredChunks = retiredChunks();
  while (retiredChunks() > 0) {
    const timing = await edit();
    if (retiredChunks() > 0) overlap.push(timing);
  }
  assert.ok(initialRetiredChunks > 0);
  assert.ok(overlap.length > 0);
  assert.equal(versions.total(), NEWEST_BYTES);
  assert.equal(storedText(kit.directory), "word" + "a".repeat(offset - 4));
  process.stdout.write(JSON.stringify({
    platform: process.platform, node: process.version, sqlite: db.prepare("SELECT sqlite_version() AS version").get()?.version,
    liveBytes: live.byteLength, beforeBytes: 64 * MIB, afterBytes: versions.total(),
    initialRetiredChunks, reclamationObservedMs: Number((performance.now() - observedAt).toFixed(3)),
    publicationSpanningStoreMs: Number(aroundPublication.store.toFixed(3)),
    publicationSpanningEditToCommitMs: Number(aroundPublication.edit.toFixed(3)),
    baselineStoreMs: summarize(baseline.map(({ store }) => store)),
    overlapStoreMs: summarize(overlap.map(({ store }) => store)),
    baselineEditToCommitMs: summarize(baseline.map(({ edit }) => edit)),
    overlapEditToCommitMs: summarize(overlap.map(({ edit }) => edit))
  }) + "\n");
  writer.close();
  await run.stop("clean");
});
