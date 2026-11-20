import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mock } from "node:test";
import { IDBObjectStore } from "fake-indexeddb";
import * as Y from "yjs";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { cells } from "./helpers.ts";
import { eventResult, idbDone } from "./indexeddb-fixture.ts";
import { STORE_OPTIONS, fixture, stored, storedEntries, typeAt } from "./local-store-fixture.ts";
import { LARGE_BEATS, largeDocument } from "./structural.ts";

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return ((sorted[Math.floor((sorted.length - 1) / 2)] ?? NaN) + (sorted[mid] ?? NaN)) / 2;
}

function encodeCost(seed: Uint8Array, target: number) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, seed);
    const width = Math.floor((target - seed.length) / LARGE_BEATS);
    doc.transact(() => {
      for (let index = 0; index < LARGE_BEATS; index++) doc.getText("padding-" + index).insert(0, "n".repeat(width));
    });
    const samples: number[] = [];
    let bytes = 0;
    for (let sample = 0; sample < 120; sample++) {
      const start = performance.now();
      bytes = Y.encodeStateAsUpdate(doc).length;
      if (sample >= 20) samples.push(performance.now() - start);
    }
    return { bytes, ms: median(samples).toFixed(4) };
  } finally { doc.destroy(); }
}

const source = openNativeSession({
  kind: "document", document: largeDocument(), conversion: { cells, creation: "seed", at: "2026-01-01", by: "Editor" }
}, STORE_OPTIONS);
const seed = source.encodeState();
source.close();
const plain = openNativeSession({ kind: "state", state: seed }, STORE_OPTIONS);
const { factory, store } = fixture();
const measured = await store.open("measure", STORE_OPTIONS);
assert.equal(measured.kind, "opened");
const add = IDBObjectStore.prototype.add;
let submittedAt = 0;
IDBObjectStore.prototype.add = function (value, key) {
  const request = add.call(this, value, key);
  submittedAt = performance.now();
  return request;
};
try {
  Y.applyUpdate(measured.session.ydoc, seed, "initial copy");
  assert.deepEqual(await measured.flush(), stored(1));
  const baseline: number[] = [], submission: number[] = [], receipt: number[] = [];
  const addedSubmission: number[] = [], addedReceipt: number[] = [];
  for (let index = 0; index < 1100; index++) {
    const beat = "B" + (index % LARGE_BEATS);
    const baseStart = performance.now();
    typeAt(plain, 60, "x", beat);
    await Promise.resolve();
    const baseMs = performance.now() - baseStart;

    const storeStart = performance.now();
    typeAt(measured.session, 60, "x", beat);
    assert.deepEqual(await measured.flush(), stored(index + 2));
    const submissionMs = submittedAt - storeStart, receiptMs = performance.now() - storeStart;
    if (index >= 100) {
      baseline.push(baseMs);
      submission.push(submissionMs);
      receipt.push(receiptMs);
      addedSubmission.push(submissionMs - baseMs);
      addedReceipt.push(receiptMs - baseMs);
    }
  }
  console.log(`900 beats, 1000 samples after 100 warmups, Node ${process.version} ${process.arch}`);
  console.log(`Median ms: without ${median(baseline).toFixed(4)}, through submission ${median(submission).toFixed(4)}, through receipt ${median(receipt).toFixed(4)}`);
  console.log(`Median paired added ms: submission ${median(addedSubmission).toFixed(4)}, receipt ${median(addedReceipt).toFixed(4)}`);
} finally {
  IDBObjectStore.prototype.add = add;
  plain.close();
  measured.session.close();
  await measured.closed;
}

const initial = await store.open("size", STORE_OPTIONS);
assert.equal(initial.kind, "opened");
mock.timers.enable({ apis: ["setTimeout"] });
const edits = (start: number, end: number, session: typeof initial.session) => {
  for (let index = start; index < end; index++) typeAt(session, 60, "x", "B" + (index % LARGE_BEATS));
};
Y.applyUpdate(initial.session.ydoc, seed, "initial copy");
edits(0, 511, initial.session);
assert.deepEqual(await initial.flush(), stored(512));
initial.session.close();
mock.timers.tick(0);
await initial.closed;

const hydrationSamples: number[] = [];
for (let index = 0; index < 40; index++) {
  const start = performance.now();
  const opened = await store.open("size", STORE_OPTIONS);
  hydrationSamples.push(performance.now() - start);
  assert.equal(opened.kind, "opened");
  assert.equal(opened.generation, 512);
  opened.session.close();
  await opened.closed;
}
console.log(`Open and replay 512 records, median ${median(hydrationSamples).toFixed(4)} ms`);

const size = await store.open("size", STORE_OPTIONS);
assert.equal(size.kind, "opened");
const put = IDBObjectStore.prototype.put;
try {
  edits(511, 10000, size.session);
  assert.deepEqual(await size.flush(), stored(10001));
  const before = await storedEntries(factory, "size");
  const characters = size.session.document().rows.reduce((count, row) =>
    count + (row.audioText?.length ?? 0) + (row.visualText?.length ?? 0), 0);
  const checkpoint = eventResult<string>();
  IDBObjectStore.prototype.put = function (value, key) {
    void idbDone(this.transaction).then(checkpoint.resolve);
    return put.call(this, value, key);
  };
  mock.timers.tick(0);
  assert.equal(await checkpoint.promise, "complete");
  const after = await storedEntries(factory, "size");
  assert.equal(before.length, 10001);
  assert.equal(after.length, 1);
  assert.deepEqual(after[0]?.bytes, size.session.encodeState());
  const total = (entries: typeof before) => entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  console.log(`After 10000 edits: ${characters} live cell characters, payload before ${total(before)} bytes (${(total(before) / characters).toFixed(4)} B/char), after ${total(after)} bytes (${(total(after) / characters).toFixed(4)} B/char)`);
} finally {
  IDBObjectStore.prototype.put = put;
  size.session.close();
  mock.timers.tick(0);
  await size.closed;
  mock.timers.reset();
}
for (const target of [1000000, 5000000]) {
  const sample = encodeCost(seed, target);
  console.log(`Checkpoint encode: ${sample.bytes} bytes, median ${sample.ms} ms`);
}
