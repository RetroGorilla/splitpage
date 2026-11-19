import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { compareNotices } from "../../src/native-notice/compare.ts";
import { inSyncNow } from "../../src/native-notice/yjs.ts";
import type { StoredReading } from "../native-delete/model.ts";
import { rankedSeed, replicaFrom, write } from "./kit.ts";

function sampleDocument(size: number): StoredReading {
  const document: StoredReading = { order: [], segments: {}, beats: {}, visuals: {}, headings: {} };
  for (let i = 0; i < size; i += 6) {
    const segment = "segment-" + i, heading = "scene-" + i;
    document.order.push(segment);
    document.headings[heading] = {};
    const units: StoredReading["segments"][string]["units"] = [..."Scene name"];
    document.segments[segment] = { head: { kind: "h", id: heading }, units };
    for (let j = i; j < Math.min(size, i + 6); j++) {
      const id = "beat-" + j;
      units.push({ kind: "b", id }, ..."Narration for this beat has two short sentences. Then it ends.");
      document.beats[id] = { status: "todo" };
      document.visuals[id] = "Visual setup and camera direction for this beat.";
    }
  }
  return document;
}

function milliseconds(samples: number[]) {
  const times = samples.sort((left, right) => left - right);
  const median = times[Math.floor(times.length / 2)], p95 = times[Math.floor(times.length * 0.95)];
  assert.ok(median !== undefined && p95 !== undefined);
  return [median, p95].map(time => Number(time.toFixed(3)));
}

test("comparison and checkpoint timings, and three representations of the same base", () => {
  for (const size of [30, 300, 900]) {
    const source = rankedSeed(sampleDocument(size));
    try {
      for (const id of source.beats.keys()) source.beat(id).set("notes", "A note");
      write(source, { op: "mark", id: "beat-1", field: "audio", from: 0, to: 9, key: "t:TAG" });
      write(source, { op: "erase", id: "beat-2", field: "audio", from: 3, to: 4 });
      const { base } = inSyncNow(source);
      const mine = structuredClone(base).map(beat => beat.id === "beat-1"
        ? { ...beat, visual: [...beat.visual, { insert: " changed" }] } : beat);
      const merged = structuredClone(base).filter(beat => beat.id !== "beat-1");
      const bytes = source.encode();
      const capture: number[] = [], comparison: number[] = [];
      for (let run = 0; run < 116; run++) {
        const start = performance.now();
        const result = compareNotices(base, mine, merged);
        const time = performance.now() - start;
        assert.equal(result[0]?.kind, "visual");
        assert.equal(result.length, 1);
        if (run >= 15) comparison.push(time);
      }
      for (let run = 0; run < 25; run++) {
        const doc = replicaFrom(bytes, 501);
        try {
          const start = performance.now();
          const checkpoint = inSyncNow(doc);
          const time = performance.now() - start;
          assert.equal(checkpoint.base.length, size);
          if (run >= 5) capture.push(time);
        } finally { doc.destroy(); }
      }
      console.log(JSON.stringify({ beats: size, readingBytes: Buffer.byteLength(JSON.stringify(base)),
        stateBytes: bytes.length, snapshotBytes: Y.encodeSnapshot(Y.snapshot(source.doc)).length,
        compareMs: milliseconds(comparison), captureMs: milliseconds(capture) }));
    } finally { source.destroy(); }
  }
});
