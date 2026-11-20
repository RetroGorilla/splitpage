import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { IDBObjectStore } from "fake-indexeddb";
import * as Y from "yjs";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { cells } from "./helpers.ts";
import { DB_NAME, REPLICAS, STORED, STORE_OPTIONS, fixture, storedBytes, typeAt, type StoreSession } from "./local-store-fixture.ts";
import { idbResult } from "./indexeddb-fixture.ts";
import { LARGE_BEATS, largeDocument } from "./structural.ts";

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[mid]!) / 2;
}

function keystroke(session: StoreSession, index: number): number {
  const start = performance.now();
  typeAt(session, 60, "x", "B" + (index % LARGE_BEATS));
  return performance.now() - start;
}

const source = openNativeSession({
  kind: "document", document: largeDocument(), conversion: { cells, creation: "seed", at: "2026-01-01", by: "Editor" }
}, STORE_OPTIONS);
const state = source.encodeState();
source.close();
const plain = openNativeSession({ kind: "state", state }, STORE_OPTIONS);
const { factory, store } = fixture(), replica = await store.open("measure", STORE_OPTIONS);
assert.equal(replica.kind, "opened");
const { session, flush } = replica;
const put = IDBObjectStore.prototype.put;
let publishedAt = 0, submittedIn = 0;
session.subscribe(change => {
  if (change.kind === "changed") publishedAt = performance.now();
});
IDBObjectStore.prototype.put = function (value, key) {
  const request = put.call(this, value, key);
  if (key === "measure") submittedIn = performance.now() - publishedAt;
  return request;
};
try {
  Y.applyUpdate(session.ydoc, state, "initial copy");
  assert.deepEqual(await flush(), STORED);
  const without: number[] = [], withStore: number[] = [], active: number[] = [], added: number[] = [];
  const submit: number[] = [], receipt: number[] = [];
  for (let index = 0; index < 1100; index++) {
    const baseMs = keystroke(plain, index);
    await Promise.resolve();
    const start = performance.now();
    const storeMs = keystroke(session, index);
    assert.deepEqual(await flush(), STORED);
    if (index >= 100) {
      without.push(baseMs);
      withStore.push(storeMs);
      active.push(storeMs + submittedIn);
      added.push(storeMs + submittedIn - baseMs);
      submit.push(submittedIn);
      receipt.push(performance.now() - start);
    }
  }
  const sizeReplica = await store.open("size", STORE_OPTIONS);
  assert.equal(sizeReplica.kind, "opened");
  try {
    Y.applyUpdate(sizeReplica.session.ydoc, state, "initial copy");
    assert.deepEqual(await sizeReplica.flush(), STORED);
    for (let index = 0; index < 10000; index++) {
      keystroke(sizeReplica.session, index);
      assert.deepEqual(await sizeReplica.flush(), STORED);
    }
    const length = sizeReplica.session.encodeState().length;
    const diskLength = (await storedBytes(factory, "size"))?.length;
    const db = await idbResult(factory.open(DB_NAME));
    let snapshots: number;
    try { snapshots = await idbResult(db.transaction(REPLICAS).objectStore(REPLICAS).count()); }
    finally { db.close(); }
    assert.equal(diskLength, length);
    assert.equal(snapshots, 2);
    console.log(`900 beats, 1000 samples after 100 warmups, Node ${process.version} ${process.arch}`);
    console.log(`Median command ms: without ${median(without).toFixed(4)}, with ${median(withStore).toFixed(4)}`);
    console.log(`Median command plus snapshot submission ms: ${median(active).toFixed(4)}, paired added ${median(added).toFixed(4)}`);
    console.log(`Median snapshot encode and IndexedDB submission ms: ${median(submit).toFixed(4)}`);
    console.log(`Median command through commit receipt ms: ${median(receipt).toFixed(4)}`);
    console.log(`After 10000 edits: ${diskLength} stored payload bytes / ${length} encoded bytes, one snapshot per replica`);
  } finally { sizeReplica.session.close(); await sizeReplica.closed; }
} finally {
  IDBObjectStore.prototype.put = put;
  plain.close();
  session.close();
  await replica.closed;
}
