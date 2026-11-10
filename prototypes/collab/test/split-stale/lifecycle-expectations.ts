import assert from "node:assert/strict";
import type { SplitCounterTuple } from "../split-reconcile/lifecycle-expectations.ts";
import { assertSplitCaseCounters } from "../split-reconcile/lifecycle-expectations.ts";
import type { SplitStaleEvidence } from "../../src/split-stale/records.ts";

const control: readonly SplitCounterTuple[] = [
  [0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0]
];
const stale: readonly SplitCounterTuple[] = [
  [0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0], [0,0,0,0,1,0,0,0], [0,0,0,0,1,0,0,0], [0,0,0,0,2,0,1,0]
];
const boundary: readonly SplitCounterTuple[] = [
  [0,0,0,0,0,0,0,0], [0,0,0,1,0,0,0,0], [0,0,0,1,0,0,0,0], [0,0,0,1,1,0,1,0], [0,0,0,1,2,0,2,0]
];
const whitespaceFailure: readonly SplitCounterTuple[] = [
  [0,0,0,0,0,0,0,0], [0,0,0,4,0,0,0,0], [0,0,0,4,0,0,0,0], [0,0,0,4,0,0,0,0]
];
const controlPhases = ["painted", "remote-before-input", "after-input", "failure"];
const stalePhases = ["painted", "remote-before-input", "after-input", "forward", "undo"];
const boundaryPhases = ["painted", "after-input", "after-remote", "forward", "undo"];
const failurePhases = ["painted", "after-input", "after-remote", "failure"];

export const staleCounterExpectations: Readonly<Record<string, readonly SplitCounterTuple[]>> = {
  "controls/T02/D3": control,
  "controls/T02/dup": control,
  "controls/T02/late-C": control,
  "cases/T02/D3": stale,
  "cases/T02/dup": stale,
  "cases/T02/late-C": stale,
  "cases/T02 boundary/D3": boundary,
  "cases/T03/D1": whitespaceFailure,
  "cases/T03/D3": whitespaceFailure
};
const phases: Readonly<Record<string, readonly string[]>> = {
  "controls/T02/D3": controlPhases,
  "controls/T02/dup": controlPhases,
  "controls/T02/late-C": controlPhases,
  "cases/T02/D3": stalePhases,
  "cases/T02/dup": stalePhases,
  "cases/T02/late-C": stalePhases,
  "cases/T02 boundary/D3": boundaryPhases,
  "cases/T03/D1": failurePhases,
  "cases/T03/D3": failurePhases
};

export function assertStaleCounters(evidence: SplitStaleEvidence, expected = staleCounterExpectations): void {
  const observed = (["controls", "cases"] as const).flatMap(group => evidence[group].map(item => `${group}/${item.trace}/${item.order}`));
  assert.deepEqual(observed.sort(), Object.keys(expected).sort(), "literal stale case coverage");
  assert.deepEqual(observed.sort(), Object.keys(phases).sort(), "literal stale phase coverage");
  for (const group of ["controls", "cases"] as const) for (const item of evidence[group]) {
    const key = `${group}/${item.trace}/${item.order}`;
    assert.deepEqual(item.stages.map(stage => stage.phase), phases[key], `${key}: literal phase order`);
    assertSplitCaseCounters(key, item.stages.map(stage => stage.binding), expected);
  }
}
