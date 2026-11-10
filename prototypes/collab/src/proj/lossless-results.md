# Projection loss repairs

This report supersedes the canonical round-trip and PROJ-cue conclusions in the earlier projection-results.md and PROJ-roundtrip histories. The canonical fixture set and independent app-save manifest are unchanged: 291 inputs, transferred as encoded Yjs updates to freshly initialized receiving replicas, with no source-document back channel. No schema candidate is recommended here.

| Candidate | Exact direct-app-save bytes | Declared-exclusion fixture | Byte-identical outside declared exclusion | Original bytes identical |
| --- | ---: | ---: | ---: | ---: |
| A | 290/291 | 1/291 | 291/291 | 7/291 |
| B | 290/291 | 1/291 | 291/291 | 7/291 |

The unchanged 7/291 original-byte figure reflects rewriting by the app's own save; it is not a projection failure.

## Causes and representation

Both losses were normalization in the projection, not missing shared fields. The previous deltaToHtml called core toHtml, whose buildTree calls normalizeCell. Its cellChars strips U+200B, and settleCues recalculates cue flags from line position. Direct app save preserves the four affected fixtures' stored HTML. The projection now renders stored runs without normalizeCell. It retains the app's escaping, wrapper precedence, tag registry resolution and atom markup, but neither strips stored characters nor derives cue membership on the default export path.

Under A, stored narration characters and cue:true attributes live in the document-wide flow Y.Text; under B they live in each segment's Y.Text. Under both, visual characters and cue:true attributes live in each visual component's Y.Text. No raw source HTML shadow or source-document cache was added. Three unicode-and-atoms inputs now preserve $.rows.3.visualText, and migrate-golden.json/scenarios/media in cells/output preserves $.rows.1.audioText, including its mid-line audio-cue wrapper. results.json retains every comparison, exact difference and first differing byte.

Every U+200B in stored document HTML is a literal shared text character, including one next to an atom or at a trailing line break. There is no character-value heuristic for identifying caret padding. surfaceToDelta accepts provenance-bearing parts: {storedHtml: string} is parsed as stored content; {caretSentinel: U+200B} is presentation-only and contributes no shared item. The mixed-beat control has two stored U+200B characters, a who atom, a line break and two caret sentinels; encoded transfer retains exactly the two stored characters and no sentinels. Making it import the sentinel tokens fails that control. This is an explicit prototype adapter boundary, not a claim that the real Writer currently supplies such provenance. Its legacy untyped DOM U+200B nodes are inherently ambiguous after flattening; real Writer integration must retain node provenance rather than strip all U+200B.

## Literal device-local exclusion

Only supplement.splitpage excludes the following two complete field values from shared state:

```json
[
  {
    "path": "$.rows.0.imageLinks.0.location",
    "value": {
      "kind": "path",
      "path": "C:\\shoot\\take.mp4"
    }
  },
  {
    "path": "$.rows.0.imageLinks.1.location",
    "value": {
      "kind": "bundled",
      "name": "notes.pdf"
    }
  }
]
```

The path is the existing fictional fixture value, not a path on the measurement machine. exclusions.ts checks the fixture name, two links, both exact original values and the app-save JSON formatting before removing only these properties from the expected app-save bytes. The projected bytes must equal those remaining bytes exactly. It does not strip fields from the actual output. Controls reject a changed nonexcluded size, changed whitespace, another fixture name, changed excluded value, and carrying the locations into the output. The shared-state probe also checks that neither location is encoded. No broader exclusion is allowed.

Product-owner question: what does a second person see for a link whose location exists only on the first person's device? This experiment preserves name/size/poster metadata but does not establish that product behavior.

## Gate and deliberate defects

Before positive fixture results count, run test/harness.test.ts, test/marks.test.ts and test/proj/lossless.test.ts. The existing checker still rejects lost remote characters, stale base, duplicated restoration/join identity, omitted lengthSeconds, lost comment marks and lost tag marks. The new probes delete one stored U+200B or remove stored cue attributes in shared Y.Text, transfer the defective state to another initialized replica, and require the exact same byte gate to reject it. These probes use unchanged independent app-save bytes. The omitted mapping checks remain 192 declaration checks, not transport mutations.

Six new literal HTML regressions failed before the renderer fix (three per candidate) and pass afterward. test/proj/projection.test.ts now demands exact equality for every former text/cue loss, with only the literal local-location exclusion. No app-reference, fixture source or hand-written expected document changed. test/proj/review.test.ts still checks quoted attribute characters/entities and __proto__/constructor/prototype transport. test/proj/cues.test.ts checks all six cue-bearing inputs under both candidates: stored projection is exact; derivation still loses the mid-line cue and invents a flag on the intentionally unmarked SFX control. PROJ-cue therefore requires stored flags. A-H10 passes on this corpus with the explicit device-local exclusion, not as an unconditional all-data byte claim.

## Limits and reproduction

The previous opaque-value, merged-domain-limit, detached-anchor, absent-blob-resolution and real-editor integration limits remain. No performance run was repeated. Existing timing numbers describe the earlier renderer, not this changed implementation. The incremental projector's three --check commands refuse the changed projection source digest; its pinned files and evidence were left untouched as requested. Semantic incremental/full equality controls still run in the whole prototype suite.

Validation on the combined tree after the public-evidence cleanup: 49/49 checker/mark/lossless controls, 239/239 projection tests, 18/18 incremental semantic controls; whole prototype suite 1,231/1,234, with only the three pinned performance-source evidence tests failing. The default reference --check reproduces all 291 app-save entries. Root lint, typecheck, dependency and comment gates pass. The generated report --check passes. No app, browser, desktop suite or timing benchmark was run.

```text
node --test --test-concurrency=1 prototypes/collab/test/harness.test.ts prototypes/collab/test/marks.test.ts prototypes/collab/test/proj/lossless.test.ts
node prototypes/collab/src/proj/lossless-report.ts --check
node tools/projection-reference.mjs --check
node prototypes/collab/src/perf/setup.ts --check
node prototypes/collab/src/perf/run.ts --check
node prototypes/collab/src/perf/report.ts --check
```
