import assert from "node:assert/strict";
import test from "node:test";
import { SET_NAMES, sweep } from "./sweep.ts";
import type { Sweep } from "./sweep.ts";

const pick = (total: Sweep) => [total.runs, total.problems, total.orphans, total.dropped, total.droppedRuns, total.bareRuns, total.missingRank, total.stale, total.presses, total.passedOver, total.emptyPresses];

// why: runs, problems, orphan ids, record or cell ids that disappeared, runs with one, runs with a boundary lacking
// either, rankless runs, stale steps, presses, presses that passed over an entry, presses that changed nothing
const EXPECTED: Record<string, Record<"K" | "R" | "U" | "U0", number[]>> = {
  "E9": { K: [2257, 0, 2440, 0, 0, 0, 0, 0, 0, 0, 0], R: [2257, 0, 2440, 0, 0, 0, 0, 0, 0, 0, 0], U: [2257, 0, 2440, 0, 0, 0, 0, 0, 0, 0, 0], U0: [2257, 0, 2440, 0, 0, 0, 0, 0, 0, 0, 0] },
  "E10": { K: [1145, 0, 55, 32, 8, 0, 0, 0, 1816, 0, 8], R: [1145, 0, 55, 32, 8, 0, 0, 0, 1816, 0, 8], U: [1145, 0, 63, 0, 0, 0, 0, 0, 1816, 0, 8], U0: [1145, 0, 55, 32, 8, 0, 0, 0, 1816, 0, 8] },
  "E11 mixed": { K: [3000, 0, 1223, 192, 67, 0, 3, 15, 1104, 11, 0], R: [3000, 0, 1223, 192, 67, 0, 3, 15, 1104, 11, 0], U: [3000, 0, 1293, 0, 0, 0, 3, 15, 1104, 11, 0], U0: [3000, 0, 1223, 192, 67, 0, 3, 15, 1104, 11, 0] },
  "E11 double split": { K: [1000, 0, 290, 32, 13, 0, 1, 10, 259, 2, 0], R: [1000, 0, 290, 32, 13, 0, 1, 10, 259, 2, 0], U: [1000, 0, 303, 0, 0, 0, 1, 10, 259, 2, 0], U0: [1000, 0, 290, 32, 13, 0, 1, 10, 259, 2, 0] }
};

for (const name of SET_NAMES) test(`E17 ${name}: E14's replays under K, R, U and the no-op U`, t => {
  const results = Object.fromEntries((["K", "R", "U", "U0"] as const).map(option => [option, sweep(option, name)]));
  t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(results).map(([option, total]) => [option, { ...total, samples: total.samples.slice(0, 3) }]))));
  for (const [option, total] of Object.entries(results)) assert.deepEqual(pick(total), EXPECTED[name]?.[option as "K"], `${name} ${option}`);
});
