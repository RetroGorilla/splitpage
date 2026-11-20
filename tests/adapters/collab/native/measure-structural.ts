import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import { readNativeOnce } from "../../../../src/adapters/collab/native/reader.ts";
import type { NativeScriptReader } from "../../../../src/adapters/collab/native/reader.ts";
import { largeState, loadedCopy, splitUpdate } from "./structural.ts";

const LIMIT_MS = 8;
// why: measured 5.3 to 5.6 ms after slice 2 against 8.4 to 9.2 ms before it on the same machine; the limit sits
// between them, so a return of the per-character row building fails while ordinary noise does not
const COLD_LIMIT_MS = 7.5;
const flag = (name: string, fallback: number): number => Number(process.argv.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const rounds = flag("rounds", 5), samples = flag("samples", 40), warmup = flag("warmup", 8);

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length / 2;
  return ((sorted[Math.floor(middle - 0.5)] ?? NaN) + (sorted[Math.ceil(middle - 0.5)] ?? NaN)) / 2;
};
const p95 = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? NaN;

function timeRows(reader: NativeScriptReader): number {
  const start = performance.now();
  reader.rows();
  return performance.now() - start;
}

function sampleUpdate(state: Uint8Array, update: Uint8Array): { incremental: number; parses: number; full: number } {
  const copy = loadedCopy(state, 2), before = copy.reader.counts();
  const start = performance.now();
  Y.applyUpdate(copy.doc, update, "remote");
  const changes = copy.reader.refresh();
  for (const id of changes.rows) copy.reader.row(id);
  const incremental = performance.now() - start, parses = copy.reader.counts().parses - before.parses;
  const full = readNativeOnce(copy.roots, timeRows);
  copy.doc.destroy();
  return { incremental, parses, full };
}

function moveUpdate(state: Uint8Array): Uint8Array {
  const writer = loadedCopy(state, 77);
  const result = moveNativeBlocks(writer, ["B451"], "B481");
  if (result.kind !== "written") throw new Error(`No move of B451: ${result.kind}`);
  const update = Y.encodeStateAsUpdate(writer.doc, Y.encodeStateVectorFromUpdate(state));
  writer.doc.destroy();
  return update;
}

const state = largeState(), lines: string[] = [], failures: string[] = [];
lines.push(`Node ${process.version} ${process.arch}. ${rounds} rounds of ${samples} samples, the first ${warmup} of each round untimed.`);
lines.push("Each sample: a warm copy of the 900-beat script receives one change from another copy; the time covers applying the update,");
lines.push("the reader's refresh and reading every changed row. Cells: median of the per-round medians [smallest-largest].", "");
lines.push(`| Case | Median ms | p95 ms | Segments reparsed | Full rebuild ms | Limit ${LIMIT_MS} ms |`, "| --- | --- | --- | --- | --- | --- |");
for (const [name, update, expectedParses] of [
  ["Split inside a segment", splitUpdate(state, "B451", 60).update, 1],
  ["Split at a segment's start", splitUpdate(state, "B480", 0).update, 1],
  ["Move one beat", moveUpdate(state), 0]
] as const) {
  const medians: number[] = [], tails: number[] = [], fulls: number[] = [], parses = new Set<number>();
  for (let round = 0; round < rounds; round++) {
    const timed: number[] = [], full: number[] = [];
    for (let n = 0; n < samples; n++) {
      const sample = sampleUpdate(state, update);
      parses.add(sample.parses);
      if (n >= warmup) { timed.push(sample.incremental); full.push(sample.full); }
    }
    medians.push(median(timed)); tails.push(p95(timed)); fulls.push(median(full));
  }
  const cell = (values: number[]): string => `${median(values).toFixed(3)} [${Math.min(...values).toFixed(3)}-${Math.max(...values).toFixed(3)}]`;
  const within = median(medians) <= LIMIT_MS, parsedAsExpected = parses.size === 1 && parses.has(expectedParses);
  lines.push(`| ${name} | ${cell(medians)} | ${cell(tails)} | ${[...parses].join(", ")} | ${cell(fulls)} | ${within ? "within" : "over"} |`);
  if (!within) failures.push(`${name}: median ${median(medians).toFixed(3)} ms is over ${LIMIT_MS} ms`);
  if (!parsedAsExpected) failures.push(`${name}: reparsed ${[...parses].join(", ")} segments, expected ${expectedParses}`);
}
const cold: number[] = [], coldTails: number[] = [], loaded = loadedCopy(state, 3);
for (let round = 0; round < rounds; round++) {
  const timed: number[] = [];
  for (let n = 0; n < samples; n++) {
    const elapsed = readNativeOnce(loaded.roots, timeRows);
    if (n >= warmup) timed.push(elapsed);
  }
  cold.push(median(timed)); coldTails.push(p95(timed));
}
loaded.reader.close();
const coldCell = (values: number[]): string => `${median(values).toFixed(3)} [${Math.min(...values).toFixed(3)}-${Math.max(...values).toFixed(3)}]`;
const coldWithin = median(cold) <= COLD_LIMIT_MS;
lines.push("", "A cold read: a fresh reader builds every row of the loaded 900-beat script. Same rounds and cells.", "");
lines.push(`| Case | Median ms | p95 ms | Limit ${COLD_LIMIT_MS} ms |`, "| --- | --- | --- | --- |");
lines.push(`| Cold read of every row | ${coldCell(cold)} | ${coldCell(coldTails)} | ${coldWithin ? "within" : "over"} |`);
if (!coldWithin) failures.push(`Cold read: median ${median(cold).toFixed(3)} ms is over ${COLD_LIMIT_MS} ms`);
dom.window.close();
process.stdout.write(lines.join("\n") + "\n");
if (failures.length) {
  process.stderr.write(failures.join("\n") + "\n");
  process.exitCode = 1;
}
