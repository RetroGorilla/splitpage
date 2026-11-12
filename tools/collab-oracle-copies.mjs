export const COLLAB_ORACLE_COPIES = Object.freeze([
  { copy: "tests/collab/oracles/oracles.ts", original: "prototypes/collab/test/oracles.ts", omitted: [], only: null, aliases: {} },
  { copy: "tests/collab/oracles/buffer-oracles.ts", original: "prototypes/collab/test/buffer-oracles.ts", omitted: [], only: null, aliases: {} },
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
