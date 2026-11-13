export const stage0TraceTable = "docs/collaboration/stage-0/8-schema-hypotheses.md";

export type Stage2Package = "3" | "5" | "6a" | "6b" | "9b-9e" | "10" | "11";
export type FixtureStatus = "pending" | "covered" | "candidate A only";

export interface FixtureEntry {
  oracle: string;
  trace: string;
  stage0Row: string;
  workPackage: Stage2Package | null;
  status: FixtureStatus;
}

function pending(oracle: string, trace: string, stage0Row: string, workPackage: Stage2Package): FixtureEntry {
  return { oracle, trace, stage0Row, workPackage, status: "pending" };
}

function covered(oracle: string, trace: string, stage0Row: string, workPackage: Stage2Package): FixtureEntry {
  return { oracle, trace, stage0Row, workPackage, status: "covered" };
}

function candidateA(oracle: string, trace: string, stage0Row: string): FixtureEntry {
  return { oracle, trace, stage0Row, workPackage: null, status: "candidate A only" };
}

export const fixtureTable: readonly FixtureEntry[] = [
  pending("oracles.ts:deletionOracle", "T01", "T01", "5"),
  pending("oracles.ts:restorationOracle", "T10 undo", "T10", "11"),
  pending("oracles.ts:removedOracle", "T10 late recovery", "T10", "11"),
  pending("oracles.ts:joinNarrationOracle", "T06 narration", "T06", "5"),
  pending("oracles.ts:joinOracle", "T06", "T06", "5"),
  pending("oracles.ts:joinUndoOracle", "T06 Alice undo", "T06", "10"),
  pending("oracles.ts:joinBoldUndoOracle", "T06 bold undo", "T06", "10"),
  pending("oracles.ts:commentsOverlapOracle", "T11 step 1", "T11", "5"),
  pending("oracles.ts:commentsOracle", "T11 overlap", "T11", "5"),
  pending("oracles.ts:commentsReplyOracle", "T11 reply", "T11", "5"),
  covered("oracles.ts:commentsRemovedOracle", "T11 removed/split", "T11", "11"),
  covered("oracles.ts:commentsRestoredOracle", "T11 restored", "T11", "11"),
  pending("oracles.ts:lengthOracle", "PROJ omitted field", "Omitted field", "6a"),
  pending("oracles.ts:splitOracle", "T05", "T05", "5"),
  pending("oracles.ts:swappedSplitOracle", "T05 swapped clients", "T05", "5"),
  pending("oracles.ts:splitUndoOracle", "T05 undo", "T05", "10"),

  pending('buffer-oracles.ts:bufferOracles["T04"]', "T04", "T04", "9b-9e"),
  pending('buffer-oracles.ts:bufferOracles["T04 removed"]', "T04 removed", "T04 removed", "9b-9e"),
  pending('buffer-oracles.ts:bufferOracles["T01"]', "T01", "T01", "9b-9e"),
  pending('buffer-oracles.ts:bufferOracles["T01 composition"]', "T01 composition", "T01", "9b-9e"),
  pending('buffer-oracles.ts:bufferOracles["T02"]', "T02", "T02", "9b-9e"),
  pending('buffer-oracles.ts:bufferOracles["T02 boundary"]', "T02 boundary", "T02 boundary", "9b-9e"),
  pending('buffer-oracles.ts:bufferOracles["T03"]', "T03", "T03", "9b-9e"),
  pending('buffer-oracles.ts:bufferOracles["T03 replace"]', "T03 replace", "T03 replace", "9b-9e"),

  pending('buffer-replacements.ts:replacementIntentFixtures["typed identical text"]', "T03 replace", "T03 replace", "9b-9e"),
  pending('buffer-replacements.ts:replacementIntentFixtures["pasted identical text"]', "T03 replace", "T03 replace", "9b-9e"),
  pending('buffer-replacements.ts:replacementIntentFixtures["replacement sharing a prefix"]', "T03 replace", "T03 replace", "9b-9e"),
  pending('buffer-replacements.ts:replacementIntentFixtures["replacement sharing a suffix"]', "T03 replace", "T03 replace", "9b-9e"),
  pending('buffer-replacements.ts:replacementIntentFixtures["identical replacement with remote at left gap"]', "T03 replace", "T03 replace", "9b-9e"),
  pending('buffer-replacements.ts:replacementIntentFixtures["identical replacement with remote inside word"]', "T03 replace", "T03 replace", "9b-9e"),
  pending('buffer-replacements.ts:replacementIntentFixtures["identical replacement with remote at right gap"]', "T03 replace", "T03 replace", "9b-9e"),

  pending('structure-oracles.ts:beatOracles["T05 two splits"]', "T05 two splits", "T05 two splits", "5"),
  pending('structure-oracles.ts:beatOracles["T05 two splits undo"]', "T05 two splits undo", "T05 two splits", "10"),
  pending('structure-oracles.ts:beatOracles["T07"]', "T07", "T07", "5"),
  pending('structure-oracles.ts:beatOracles["T07 undo"]', "T07 undo", "T07", "10"),
  pending('structure-oracles.ts:beatOracles["T08 remove"]', "T08 remove", "T08 remove", "5"),
  pending('structure-oracles.ts:beatOracles["T08 remove undo"]', "T08 remove undo", "T08 remove", "10"),
  pending('structure-oracles.ts:beatOracles["T08 create"]', "T08 create", "T08 create", "5"),
  pending('structure-oracles.ts:beatOracles["T08 create undo"]', "T08 create undo", "T08 create", "10"),
  pending('structure-oracles.ts:beatOracles["T08 race"]', "T08 race", "T08 race", "5"),
  pending('structure-oracles.ts:beatOracles["T09"]', "T09", "T09", "5"),
  pending('structure-oracles.ts:beatOracles["T09 undo"]', "T09 undo", "T09", "10"),
  pending('structure-oracles.ts:beatOracles["T09 header"]', "T09 header", "T09 header", "5"),
  pending('structure-oracles.ts:beatOracles["T09 header undo"]', "T09 header undo", "T09 header", "10"),
  pending('structure-oracles.ts:beatOracles["T12 undo"]', "T12 undo", "T12", "10"),
  pending('structure-oracles.ts:beatOracles["T12 redo"]', "T12 redo", "T12", "10"),
  pending('structure-oracles.ts:beatOracles["T12 join"]', "T12 join", "T12 join", "5"),
  pending('structure-oracles.ts:beatOracles["T12 join undo"]', "T12 join undo", "T12 join", "10"),
  candidateA('structure-oracles.ts:beatOracles["MOVE concurrent A"]', "MOVE concurrent A", "MOVE concurrent"),
  pending('structure-oracles.ts:beatOracles["MOVE concurrent B"]', "MOVE concurrent B", "MOVE concurrent", "5"),
  pending('structure-oracles.ts:beatOracles["MOVE concurrent undo"]', "MOVE concurrent undo", "MOVE concurrent", "10"),
  pending('structure-oracles.ts:beatOracles["MOVE destination A"]', "MOVE destination undo", "MOVE destination", "10"),
  pending('structure-oracles.ts:beatOracles["MOVE destination B"]', "MOVE destination B", "MOVE destination", "5"),
  pending('structure-oracles.ts:beatOracles["MOVE delete"]', "MOVE delete", "MOVE delete", "11"),
  candidateA('structure-oracles.ts:beatOracles["MOVE delete A"]', "MOVE delete A", "MOVE delete"),
  pending('structure-oracles.ts:beatOracles["MOVE delete undo"]', "MOVE delete undo", "MOVE delete", "11"),
  pending('structure-oracles.ts:beatOracles["MOVE cut-paste"]', "MOVE cut-paste", "MOVE cut-paste", "3"),

  pending('marks/oracles.ts:markOracles["T11 fully deleted"]', "T11 fully deleted", "T11", "6b"),
  pending('marks/oracles.ts:markOracles["T20 nest"]', "T20 nest", "T20 nest", "5"),
  pending('marks/oracles.ts:markOracles["T20 nest undo"]', "T20 nest undo", "T20 nest", "10"),
  pending('marks/oracles.ts:markOracles["T20 cross"]', "T20 cross", "T20 cross", "6b"),
  pending('marks/oracles.ts:markOracles["T20 cross undo"]', "T20 cross undo", "T20 cross", "10"),
  pending('marks/oracles.ts:markOracles["T20 mark"]', "T20 mark", "T20 mark", "6b"),
  pending('marks/oracles.ts:markOracles["T20 mark undo"]', "T20 mark undo", "T20 mark", "10"),
  pending('marks/oracles.ts:markOracles["T21"]', "T21", "T21", "5"),
  pending('marks/oracles.ts:markOracles["T21 undo"]', "T21 undo", "T21", "10"),
  pending('marks/oracles.ts:markOracles["T21 comment undo"]', "T21 comment undo", "T21 comment", "10"),
  pending('marks/oracles.ts:markOracles["T21 comment redo"]', "T21 comment redo", "T21 comment", "10"),
  pending('marks/oracles.ts:markOracles["T21 scalar"]', "T21 scalar", "T21 scalar", "6b"),
  pending('marks/oracles.ts:markOracles["T21 scalar undo"]', "T21 scalar undo", "T21 scalar", "10"),

  pending('split-stale/lifecycle-expectations.ts:staleCounterExpectations["controls/T02/D3"]', "T02 Split control", "T02", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:staleCounterExpectations["controls/T02/dup"]', "T02 Split control", "T02", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:staleCounterExpectations["controls/T02/late-C"]', "T02 Split control", "T02", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:staleCounterExpectations["cases/T02/D3"]', "T02 Split stale", "T02", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:staleCounterExpectations["cases/T02/dup"]', "T02 Split stale", "T02", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:staleCounterExpectations["cases/T02/late-C"]', "T02 Split stale", "T02", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:staleCounterExpectations["cases/T02 boundary/D3"]', "T02 boundary Split", "T02 boundary", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:staleCounterExpectations["cases/T03/D1"]', "T03 Split whitespace", "T03", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:staleCounterExpectations["cases/T03/D3"]', "T03 Split whitespace", "T03", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:stalePhaseExpectations["controls/T02/D3"]', "T02 Split control", "T02", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:stalePhaseExpectations["controls/T02/dup"]', "T02 Split control", "T02", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:stalePhaseExpectations["controls/T02/late-C"]', "T02 Split control", "T02", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:stalePhaseExpectations["cases/T02/D3"]', "T02 Split stale", "T02", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:stalePhaseExpectations["cases/T02/dup"]', "T02 Split stale", "T02", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:stalePhaseExpectations["cases/T02/late-C"]', "T02 Split stale", "T02", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:stalePhaseExpectations["cases/T02 boundary/D3"]', "T02 boundary Split", "T02 boundary", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:stalePhaseExpectations["cases/T03/D1"]', "T03 Split whitespace", "T03", "9b-9e"),
  pending('split-stale/lifecycle-expectations.ts:stalePhaseExpectations["cases/T03/D3"]', "T03 Split whitespace", "T03", "9b-9e"),

  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["controls/T04/D3"]', "T04 Split control", "T04", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["controls/T04/dup"]', "T04 Split control", "T04", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["controls/T04/late-C"]', "T04 Split control", "T04", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["controls/T04 removed/D3"]', "T04 removed Split control", "T04 removed", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["controls/T04 removed/late-C"]', "T04 removed Split control", "T04 removed", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T04/D3"]', "T04 Split composition", "T04", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T04/dup"]', "T04 Split composition", "T04", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T04/late-C"]', "T04 Split composition", "T04", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T04 removed/D3"]', "T04 removed Split composition", "T04 removed", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T04 removed/late-C"]', "T04 removed Split composition", "T04 removed", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T01/D1"]', "T01 Split", "T01", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T01/D3"]', "T01 Split", "T01", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T01/dup"]', "T01 Split", "T01", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T01/rev"]', "T01 Split", "T01", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T01/late-C"]', "T01 Split", "T01", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T01 composition/D1"]', "T01 composition Split", "T01", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T01 composition/D3"]', "T01 composition Split", "T01", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T01 composition/dup"]', "T01 composition Split", "T01", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T01 composition/rev"]', "T01 composition Split", "T01", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T01 composition/late-C"]', "T01 composition Split", "T01", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T02/D3"]', "T02 Split stale failure", "T02", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T02/dup"]', "T02 Split stale failure", "T02", "9b-9e"),
  pending('split-reconcile/lifecycle-expectations.ts:splitCounterExpectations["cases/T02/late-C"]', "T02 Split stale failure", "T02", "9b-9e")
];
