import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { NativeScriptReader } from "../../../../src/adapters/collab/native/reader.ts";
import { largeState, loadedCopy, splitUpdate } from "./structural.ts";

const LIMIT_MS = 8;
const flag = (name: string, fallback: number): number => Number(process.argv.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const rounds = flag("rounds", 5), samples = flag("samples", 40), warmup = flag("warmup", 8);

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length / 2;
  return ((sorted[Math.floor(middle - 0.5)] ?? NaN) + (sorted[Math.ceil(middle - 0.5)] ?? NaN)) / 2;
};
const p95 = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? NaN;

function sampleSplit(state: Uint8Array, update: Uint8Array): { incremental: number; parses: number; full: number } {
  const copy = loadedCopy(state, 2), before = copy.reader.counts();
  const start = performance.now();
  Y.applyUpdate(copy.doc, update, "remote");
  const changes = copy.reader.refresh();
  for (const id of changes.rows) copy.reader.row(id);
  const incremental = performance.now() - start, parses = copy.reader.counts().parses - before.parses;
  const fresh = new NativeScriptReader(copy.roots), fullStart = performance.now();
  fresh.rows();
  const full = performance.now() - fullStart;
  fresh.close(); copy.reader.close();
  return { incremental, parses, full };
}

const state = largeState(), lines: string[] = [];
lines.push(`Node ${process.version} ${process.arch}. ${rounds} rounds of ${samples} samples, the first ${warmup} of each round untimed.`);
lines.push("Each sample: a warm copy of the 900-beat script receives one split from another copy; the time covers applying the update,");
lines.push("the reader's refresh and reading every changed row. Cells: median of the per-round medians [smallest-largest].", "");
lines.push(`| Case | Median ms | p95 ms | Segments reparsed | Full rebuild ms | Limit ${LIMIT_MS} ms |`, "| --- | --- | --- | --- | --- | --- |");
for (const [name, beat, offset] of [["Split inside a segment", "B451", 60], ["Split at a segment's start", "B480", 0]] as const) {
  const update = splitUpdate(state, beat, offset, "N1"), medians: number[] = [], tails: number[] = [], fulls: number[] = [], parses = new Set<number>();
  for (let round = 0; round < rounds; round++) {
    const timed: number[] = [], full: number[] = [];
    for (let n = 0; n < samples; n++) {
      const sample = sampleSplit(state, update);
      parses.add(sample.parses);
      if (n >= warmup) { timed.push(sample.incremental); full.push(sample.full); }
    }
    medians.push(median(timed)); tails.push(p95(timed)); fulls.push(median(full));
  }
  const cell = (values: number[]): string => `${median(values).toFixed(3)} [${Math.min(...values).toFixed(3)}-${Math.max(...values).toFixed(3)}]`;
  lines.push(`| ${name} | ${cell(medians)} | ${cell(tails)} | ${[...parses].join(", ")} | ${cell(fulls)} | ${median(medians) <= LIMIT_MS ? "within" : "over"} |`);
}
dom.window.close();
process.stdout.write(lines.join("\n") + "\n");
