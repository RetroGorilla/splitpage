import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { dom } from "../../../../src/test/_dom.mjs";
import { noticeCopy, noticeRange } from "./notice-harness.ts";
import { largeState } from "./structural.ts";

const state = largeState(), samples = 1000, warmup = 100;

function timing(enabled: boolean): number[] {
  const copy = noticeCopy(state, 2, enabled ? true : undefined);
  copy.document();
  const times: number[] = [];
  try {
    for (let index = 0; index < warmup + samples; index++) {
      const start = performance.now();
      const caret = noticeRange(copy, "B451", "narration", 60 + index);
      const result = copy.commands.typeText(caret, "x", {});
      const elapsed = performance.now() - start;
      assert.equal(result.kind, "written");
      if (index >= warmup) times.push(elapsed);
    }
    if (enabled) assert.equal(copy.pendingEdits?.data().entries.length, warmup + samples);
    return times;
  } finally { copy.close(); }
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right), middle = (sorted.length - 1) / 2;
  return ((sorted[Math.floor(middle)] ?? NaN) + (sorted[Math.ceil(middle)] ?? NaN)) / 2;
}

try {
  const runs = Array.from({ length: 5 }, (_, round) => {
    const [first, second] = [timing(round % 2 === 1), timing(round % 2 === 0)];
    const [plain, journal] = round % 2 === 0 ? [first, second] : [second, first];
    return { plain: median(plain), journal: median(journal), added: median(journal.map((value, index) => value - (plain[index] ?? NaN))) };
  });
  const result = Object.fromEntries((["plain", "journal", "added"] as const).map(key => [key, median(runs.map(run => run[key]))]));
  process.stdout.write(JSON.stringify({ runtime: process.version, arch: process.arch, samples, warmup, runs, result }, null, 2) + "\n");
} finally { dom.window.close(); }
