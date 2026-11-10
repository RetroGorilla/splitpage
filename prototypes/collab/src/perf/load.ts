import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { createProjectionReplica, toDocument } from "../proj/document.ts";
import { isProjectionEntry } from "../proj/entry.ts";
import type { SchemaCandidate } from "../schema.ts";

export function measureLoad(state: Uint8Array, candidate: SchemaCandidate) {
  if (!globalThis.gc) throw new Error("Load measurements require --expose-gc");
  globalThis.gc(); globalThis.gc();
  const baselineHeapBytes = process.memoryUsage().heapUsed;
  const replica = createProjectionReplica(candidate, 90);
  const start = performance.now();
  Y.applyUpdate(replica.doc, state);
  const loadMs = performance.now() - start;
  globalThis.gc(); globalThis.gc();
  const loadedHeapBytes = process.memoryUsage().heapUsed;
  const projectionStart = performance.now();
  const document = toDocument(replica.doc, candidate);
  const firstProjectionMs = performance.now() - projectionStart;
  globalThis.gc(); globalThis.gc();
  const projectedHeapBytes = process.memoryUsage().heapUsed;
  if (!document.rows) throw new Error("Missing load projection");
  const gc = replica.doc.gc;
  replica.destroy();
  return { loadMs, firstProjectionMs, baselineHeapBytes, loadedHeapBytes, projectedHeapBytes, incrementalHeapBytes: projectedHeapBytes - baselineHeapBytes, gc };
}

if (isProjectionEntry(import.meta.url)) {
  const candidate = process.argv[2];
  if (candidate !== "A" && candidate !== "B") throw new Error("Expected candidate A or B");
  const path = process.argv[3];
  if (!path) throw new Error("Expected encoded-state path");
  process.stdout.write(JSON.stringify(measureLoad(readFileSync(path), candidate)));
}
