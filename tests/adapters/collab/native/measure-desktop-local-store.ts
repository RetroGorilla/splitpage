import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { replicasAt } from "./desktop-local-store-fixture.ts";
import { eventResult } from "./indexeddb-fixture.ts";
import { STORE_OPTIONS, STORED, seedSession } from "./local-store-fixture.ts";

const directory = await mkdtemp(join(tmpdir(), "splitpage-native-replica-measure-"));
const source = seedSession({ A: "start" });
const seed = source.encodeState();
source.close();
const target = 2_000_000;
let padding = target - seed.byteLength;
let doc = new Y.Doc();
try {
  for (let attempt = 0; ; attempt++) {
    Y.applyUpdate(doc, seed);
    doc.getText("padding").insert(0, "p".repeat(padding));
    const bytes = Y.encodeStateAsUpdate(doc).byteLength;
    if (bytes === target) break;
    assert.ok(attempt < 10, "could not make a 2 MB checkpoint");
    doc.destroy();
    doc = new Y.Doc();
    padding += target - bytes;
  }
  const { invoke } = replicasAt(directory).window();
  const opened = await invoke(["open", "measurement"]);
  assert.equal(opened.kind, "opened");
  const { lease } = opened;
  const checkpoint = Y.encodeStateAsUpdate(doc);
  assert.deepEqual(await invoke(["write", "measurement", lease, 1, true, checkpoint]), STORED);
  const samples: number[] = [];
  const text = doc.getText("later");
  for (let index = 0; index < 2000; index++) {
    const frame = eventResult<Uint8Array>();
    doc.once("update", frame.resolve);
    text.insert(index, "x");
    const bytes = await frame.promise;
    const start = performance.now();
    const receipt = await invoke(["write", "measurement", lease, index + 2, false, bytes]);
    if (index < 1000) samples.push(performance.now() - start);
    assert.deepEqual(receipt, STORED);
  }
  assert.deepEqual(await invoke(["close", "measurement", lease]), STORED);
  const { store } = replicasAt(directory).window();
  const start = performance.now();
  const restored = await store.open("measurement", STORE_OPTIONS);
  const openMs = performance.now() - start;
  assert.equal(restored.kind, "opened");
  try {
    assert.equal(restored.generation, 2001);
    assert.equal(restored.session.ydoc.getText("later").toString(), "x".repeat(2000));
  } finally {
    restored.session.close();
    await restored.closed;
  }
  samples.sort((a, b) => a - b);
  const median = ((samples[499] ?? NaN) + (samples[500] ?? NaN)) / 2;
  console.log(`Append with fsync (1000): median ${median.toFixed(4)} ms, worst ${samples.at(-1)?.toFixed(4)} ms`);
  console.log(`Open (checkpoint ${checkpoint.byteLength} bytes, 2000 log records): ${openMs.toFixed(4)} ms`);
} finally {
  doc.destroy();
  await rm(directory, { recursive: true, force: true });
}
