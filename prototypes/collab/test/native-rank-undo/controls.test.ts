import assert from "node:assert/strict";
import { test } from "node:test";
import { GENERATED_SPEC, generateHistory } from "../native-chosen/generate.ts";
import { play } from "../native-chosen/play.ts";
import type { Controls } from "../native-chosen/play.ts";
import { OPTIONS, makeOption } from "../../src/native-rank-undo/variants.ts";
import type { RankOption } from "../../src/native-rank-undo/variants.ts";
import { e15Checks } from "./storage.ts";
import { NAMES } from "./survey.ts";

const SEEDS = Number(process.env.E15_CONTROL_SEEDS ?? 25);

// why: a muted rank write that the reader does not show; each option's own rank calls, and nothing else, may do this
const SILENT: Record<RankOption, RegExp> = {
  A: /^move \/ YMap\.set:e10Rank$/, B: /^move \/ YMap\.set:e10Rank$/,
  C: /^move \/ YMap\.(set|delete):rank entry$/, D: /^move \/ YArray\.(push|delete)$/
};

export interface ControlTotals { used: number; effective: number; caught: number; throws: number; silent: number; coverage: number; silentKeys: string[]; throwKeys: string[]; coverageKeys: string[] }

export function controls(option: RankOption, seeds: number): ControlTotals {
  const counts: Controls = new Map(), make = makeOption(option), storage = e15Checks(option);
  for (let number = 1; number <= seeds; number++) {
    const steps = generateHistory(number, 40, false, NAMES, make).steps;
    const baseline = play({ spec: GENERATED_SPEC(), steps, writers: 3, mode: "forward", seed: number, checkLetters: false, make, names: NAMES, storage });
    assert.deepEqual([baseline.never, baseline.local], [[], []], `${option} seed ${number}: the baseline passes`);
    play({ spec: GENERATED_SPEC(), steps, writers: 3, mode: "forward", seed: number, controls: counts, checkLetters: false, make, names: NAMES, storage, ownCalls: true });
  }
  const totals: ControlTotals = { used: 0, effective: 0, caught: 0, throws: 0, silent: 0, coverage: 0, silentKeys: [], throwKeys: [], coverageKeys: [] };
  for (const [key, count] of counts) {
    totals.used += count.used; totals.effective += count.effective; totals.caught += count.failed; totals.throws += count.throws;
    totals.silent += count.storageOnly; totals.coverage += count.coverage;
    if (count.storageOnly) totals.silentKeys.push(`${key}: ${count.storageOnly}`);
    if (count.throws) totals.throwKeys.push(`${key}: ${count.throws}`);
    if (count.coverage) totals.coverageKeys.push(`${key}: ${count.coverage}`);
    assert.equal(count.effective - count.failed - count.throws - count.storageOnly, 0, `${option} ${key}: every effective control is caught, throws, or leaves the rows alone`);
  }
  return totals;
}

for (const option of OPTIONS) test(`E15 controls, option ${option}: each effective write muted once at the Yjs call`, t => {
  const totals = controls(option, SEEDS);
  t.diagnostic(JSON.stringify(totals));
  assert.equal(totals.coverage, 0, "a muted call never changes which calls follow");
  for (const key of totals.silentKeys) assert.match(key.slice(0, key.lastIndexOf(":")), SILENT[option], key);
  assert.ok(totals.caught > 0);
});
