import assert from "node:assert/strict";
import type { SplitRepairEvidence, SplitRepairSnapshot } from "../../src/split-reconcile/records.ts";

export type SplitCounterTuple = readonly [compositionMark: number, dropEmptySince: number, hold: number, syncCalls: number, commits: number, compositionCommits: number, nestedPaintsSuppressed: number, generation: number];

const composition4: readonly SplitCounterTuple[] = [
  [0,0,0,0,0,0,0,0], [1,0,0,1,0,0,0,0], [1,0,0,1,0,0,0,0],
  [1,1,0,4,1,1,1,0], [1,1,0,4,1,1,1,0], [1,1,0,4,2,1,2,0]
];
const removed4: readonly SplitCounterTuple[] = [
  [0,0,0,0,0,0,0,0], [1,0,0,1,0,0,0,0], [1,0,0,1,0,0,0,0],
  [1,1,0,4,1,1,1,0], [1,1,0,4,1,1,1,0], [1,1,0,4,2,1,1,0]
];
const composition3: readonly SplitCounterTuple[] = [
  [0,0,0,0,0,0,0,0], [1,0,0,1,0,0,0,0], [1,0,0,1,0,0,0,0],
  [1,1,0,3,1,1,1,0], [1,1,0,3,1,1,1,0], [1,1,0,3,2,1,2,0]
];
const ordinary: readonly SplitCounterTuple[] = [
  [0,0,0,0,0,0,0,0], [0,0,0,1,0,0,0,0], [0,0,0,1,0,0,0,0],
  [0,0,0,1,0,0,0,0], [0,0,0,1,1,0,1,0], [0,0,0,1,2,0,2,0]
];
const control: readonly SplitCounterTuple[] = [
  [0,0,0,0,0,0,0,0], [1,0,0,1,0,0,0,0], [1,0,0,1,0,0,0,0],
  [1,1,0,4,1,1,0,0], [1,1,0,4,1,1,0,0]
];
const staleFailure: readonly SplitCounterTuple[] = [
  [0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0]
];

export const splitCounterExpectations: Readonly<Record<string, readonly SplitCounterTuple[]>> = {
  "controls/T04/D3": control,
  "controls/T04/dup": control,
  "controls/T04/late-C": control,
  "controls/T04 removed/D3": control,
  "controls/T04 removed/late-C": control,
  "cases/T04/D3": composition4,
  "cases/T04/dup": composition4,
  "cases/T04/late-C": composition4,
  "cases/T04 removed/D3": removed4,
  "cases/T04 removed/late-C": removed4,
  "cases/T01/D1": ordinary,
  "cases/T01/D3": ordinary,
  "cases/T01/dup": ordinary,
  "cases/T01/rev": ordinary,
  "cases/T01/late-C": ordinary,
  "cases/T01 composition/D1": composition3,
  "cases/T01 composition/D3": composition3,
  "cases/T01 composition/dup": composition3,
  "cases/T01 composition/rev": composition3,
  "cases/T01 composition/late-C": composition3,
  "cases/T02/D3": staleFailure,
  "cases/T02/dup": staleFailure,
  "cases/T02/late-C": staleFailure
};

export function assertSplitCaseCounters(key: string, stages: readonly SplitRepairSnapshot[], expected = splitCounterExpectations): void {
  const literal = expected[key]; assert.ok(literal, `${key}: missing case expectation`);
  assert.equal(stages.length, literal.length, `${key}: stage coverage`);
  for (const [index, stage] of stages.entries()) {
    assert.deepEqual(Object.keys(stage.app.counts).sort(), ["compositionMark", "dropEmptySince", "hold"], `${key}/${index}: owner counter coverage`);
    const tuple: SplitCounterTuple | undefined = literal[index]; assert.ok(tuple, `${key}/${index}: missing stage expectation`);
    assert.equal(tuple.length, 8, `${key}/${index}: counter coverage`);
    const actual: SplitCounterTuple = [stage.app.counts.compositionMark, stage.app.counts.dropEmptySince, stage.app.counts.hold, stage.syncs.length, stage.commits.length,
      stage.commits.filter(name => name === "compositionend:cellEditing.sync").length, stage.coordination.nestedPaintsSuppressed, stage.app.generation];
    assert.deepEqual(actual, tuple, `${key}/${index}: literal stage counters`);
  }
}

export function assertAllSplitCounters(evidence: SplitRepairEvidence, expected = splitCounterExpectations): void {
  const observed = (["controls", "cases"] as const).flatMap(group => evidence[group].map(item => `${group}/${item.trace}/${item.order}`));
  assert.deepEqual(observed.sort(), Object.keys(expected).sort(), "literal case coverage");
  for (const group of ["controls", "cases"] as const) for (const item of evidence[group]) assertSplitCaseCounters(`${group}/${item.trace}/${item.order}`, item.stages, expected);
}
