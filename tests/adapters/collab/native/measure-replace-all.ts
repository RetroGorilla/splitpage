import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { compoundSeed } from "./compound-harness.ts";
import { noticeCopy, noticeRange } from "./notice-harness.ts";

const rows = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) =>
  [`R${index}`, "A sentence with a match and a few words on either side."]));
const state = compoundSeed(rows);
const ranges = Array.from({ length: 500 }, (_, index) =>
  ({ row: `R${index * 4}`, cell: "narration" as const, start: 18, end: 23 }));
const replacement = "replacement";

function measure(batch: boolean) {
  const copy = noticeCopy(state, 2);
  try {
    const start = performance.now();
    if (batch) {
      assert.equal(copy.commands.replaceAll(ranges, replacement).kind, "written");
    } else {
      for (const { row, cell, start, end } of ranges) {
        const anchored = noticeRange(copy, row, cell, start, end);
        assert.equal(copy.commands.replaceText(anchored, [{ text: replacement, marks: {} }]).kind, "written");
      }
    }
    const ms = performance.now() - start;
    return { ms, bytes: copy.encodeState().byteLength, document: copy.document() };
  } finally { copy.close(); }
}

const samples = 7, batchTimes: number[] = [], singleTimes: number[] = [];
let batchBytes = 0, singleBytes = 0;
for (let sample = -1; sample < samples; sample++) {
  const [first, second] = [measure(sample % 2 === 0), measure(sample % 2 !== 0)];
  const [batch, singles] = sample % 2 === 0 ? [first, second] : [second, first];
  assert.deepEqual(batch.document, singles.document);
  if (sample < 0) continue;
  batchTimes.push(batch.ms);
  singleTimes.push(singles.ms);
  batchBytes = batch.bytes;
  singleBytes = singles.bytes;
}
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({
  rows: Object.keys(rows).length, ranges: ranges.length, samples, seedBytes: state.byteLength,
  batch: { medianMs: median(batchTimes), bytes: batchBytes, growthBytes: batchBytes - state.byteLength },
  singles: { medianMs: median(singleTimes), bytes: singleBytes, growthBytes: singleBytes - state.byteLength }
}));
