export const COLLAB_ORACLE_COPIES = Object.freeze([
  { copy: "tests/collab/oracles/oracles.ts", original: "prototypes/collab/test/oracles.ts", omitted: [], only: null, aliases: {} },
  {
    copy: "tests/collab/oracles/buffer-oracles.ts", original: "prototypes/collab/test/buffer-oracles.ts", omitted: [], only: null, aliases: {},
    decided: [
      { name: "rule 160: T01 undo caret", declaration: "bufferOracles", within: "  T01: {", from: "carets: { A: { beat: \"R1\", offset: 1, selection: { beat: \"R1\", from: 1, to: 4 } } }", to: "carets: { A: { beat: \"R1\", offset: 4 } }" },
      { name: "rule 160: T01 composition undo caret", declaration: "bufferOracles", within: "  \"T01 composition\": {", from: "carets: { A: { beat: \"R1\", offset: 1, selection: { beat: \"R1\", from: 1, to: 4 } } }", to: "carets: { A: { beat: \"R1\", offset: 4 } }" },
      { name: "rule 160: T03 replace undo caret", declaration: "bufferOracles", within: "  \"T03 replace\": {", from: "carets: { A: { beat: \"R1\", offset: 4, selection: { beat: \"R1\", from: 4, to: 7 } } }", to: "carets: { A: { beat: \"R1\", offset: 7 } }" }
    ]
  },
  { copy: "tests/collab/oracles/buffer-replacements.ts", original: "prototypes/collab/test/buffer-replacements.ts", omitted: [], only: null, aliases: {} },
  { copy: "tests/collab/oracles/structure-oracles.ts", original: "prototypes/collab/test/structure-oracles.ts", omitted: [], only: null, aliases: {} },
  { copy: "tests/collab/oracles/marks/oracles.ts", original: "prototypes/collab/test/marks/oracles.ts", omitted: [], only: null, aliases: {} },
  { copy: "tests/collab/oracles/undo-records/oracles.ts", original: "prototypes/collab/test/undo-records/oracles.ts", omitted: [], only: null, aliases: {} },
  {
    copy: "tests/collab/oracles/split-stale/lifecycle-expectations.ts", original: "prototypes/collab/test/split-stale/lifecycle-expectations.ts",
    omitted: ["assertStaleCounters"], only: null, aliases: { stalePhaseExpectations: "phases" }
  },
  {
    copy: "tests/collab/oracles/split-reconcile/lifecycle-expectations.ts", original: "prototypes/collab/test/split-reconcile/lifecycle-expectations.ts",
    omitted: ["assertSplitCaseCounters", "assertAllSplitCounters"], only: null, aliases: {}
  },
  { copy: "tests/collab/oracles/seed-beat.ts", original: "prototypes/collab/src/schema.ts", omitted: [], only: ["SeedBeat"], aliases: {} }
]);
