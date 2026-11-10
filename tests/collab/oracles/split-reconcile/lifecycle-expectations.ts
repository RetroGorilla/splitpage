// why: literal data of prototypes/collab/test/split-reconcile/lifecycle-expectations.ts; its assertions read prototype
// evidence types and stay there. tools/test-collab-oracle-copies.mjs pins every copied declaration to the original.
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
