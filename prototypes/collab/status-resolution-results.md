# Stage 1a status resolution — #1376

The defect reproduced on `658a5f65`: 80/96 delivery/client/recreation cases disagreed across three replicas with byte-identical encoded state. The original JSON and failing history remain readable. The repaired matrix passes 96/96 with literal `todo` through all five readers.

The frontier contains events that are not parents of another retained event for that beat. An active event contributes its value; a retired event contributes the recursive resolution of its parents, retaining its causal links. Unanimous frontier values apply, while disagreement resolves the frontier's common causal ancestors recursively, using the beat's stored status when none exist.

No event-id spelling, client id, insertion order or delivery order selects a status. `prior` now records the resolved status at the command's observed causal cut; equal event/retirement sets and stored status produce the same prior on every replica, and resolution never reads it. Different causal cuts can legitimately record different priors. The existing local undo metadata, whole-frontier semantic retirement and consumption of an ineffective step remain; identical concurrent changes can be undone by either writer. No tested history contradicts the coordinator's reading or a decided two-event row; no product-decision row changed.

Literal fixtures were authored before their first execution. `test/marks/status-resolution.test.ts` covers 17 matrices of 96 cases: the original, four retirement subsets, four deeper/identical/shared-ancestor cases, and eight real semantic-undo cases (either writer, both orders, different/identical branches). Every case checks five readers on forward, reverse and encoded-state late-joining replicas; semantic retirements also arrive reversed and duplicated. Another 32 two-event cases cover both layouts, swapped author ids, both delivery/undo orders, duplicates and late joins at every phase. Six literal recursive controls vary event spelling, parents, insertion order and deliberately false priors.

The old unsorted `statusValue` is retained only as a deliberate defect: the independent literal checker rejects it and reproduces all 80 original disagreements. Existing T21/A-H12 histories now check every reader and include a late joiner. The three seeded lifetime equality runs and literal controls stay; the only changed semantic expectation is the old two-branch lifetime control's `ready` becoming `todo`, both before and after deleting/recreating c. Statuses are resolved before structural join ranking and recovery. Index controls cover overwrite, reassignment, deletion, stored-status changes and retirement; a single-key change reads one record, without the old whole-map rescan.

## Other-reader audit

Paths below are relative to `prototypes/collab/src`. “Independent” means equal replicated state yields the same choice; it does not endorse a product policy or locale portability.

| Reader | File:line | Replica-independent? Why |
| --- | --- | --- |
| Structural removal attribution | `structure-reader.ts:111` | **No.** First matching removal comes from unsorted beat/removal-map traversal; concurrent rA/rB select different authors. |
| Structural visual concatenation | `structure-reader.ts:133` | **No.** Appends components directly in visual-map iteration order. |
| Earlier removal reader | `reader.ts:102` | Yes: sorts removal ids before selecting one. |
| Joins | `reader.ts:109`, `structure-reader.ts:118`, `perf/operations.ts:56`, `perf/lifetime/projector.ts:63` | Yes: sort live join ids before selecting one. This uses ids, unlike the new status policy. |
| Tag acceptance/nesting | `marks/projection.ts:30`, `marks/projection.ts:44` | Yes: sorts by character position/extent and occurrence key. Character order comes from Y.Text. |
| Link choice and propagation | `marks/projection.ts:42`, `marks/projection.ts:54`, `proj/richtext.ts:132` | Yes: sort link keys at a character; whole-tag propagation scans the agreed character order. |
| Comments/replies and first marked anchor | `marks/projection.ts:75`, `marks/projection.ts:79`, `marks/projection.ts:81` | **No for replies:** equal timestamps and distinct canonically equivalent ids compare equal under localeCompare, preserving map order. Comment-id sorting has the same non-total comparator; anchor traversal follows structural row/character order. Same-key fields use native Y.Map conflict resolution. |
| Resolve/reopen “later wins” | `proj/document.ts:161`, `proj/document.ts:245` | Yes: one atomic resolution value in a Y.Map key; causal later writes win and concurrent writes use Yjs's deterministic conflict rule, not map iteration or wall-clock recency. |
| Registries and shot props | `marks/commands.ts:49`, `proj/document.ts:215`, `proj/value.ts:47` | Yes: exact kind/name creates one deterministic tag id; export sorts rank/id. Other same-key fields use native Y.Map conflict resolution. |
| Gallery deduplication/first picture/poster | `structure-reader.ts:151`, `structure-reader.ts:155`, `structure-reader.ts:161`, `proj/document.ts:226`, `proj/document.ts:281` | Yes within each layout: structural input sorts beat-position/rank/id before first-match merges; full-document slots and links sort rank/id. |
| Repeated segment/boundary first occurrence | `structure-reader.ts:83`, `proj/document.ts:207` | Yes: first occurrence is in the converged Y.Array/Y.Text sequence, not an unordered map. |
| Full-document visual/anchor order | `proj/document.ts:258`, `proj/document.ts:272` | Yes: visuals sort rank/id, anchors take the first occurrence in agreed block/character order. |
| Measurement target comment | `perf/measure.ts:41` | Replica-local selector: takes the last map key. It selects a benchmark target rather than resolving shared content; no timings or convergence claim for this selector were made here. |

The two confirmed non-status defects are unchanged. Minimal histories and actual observations: [T21-other-readers-map-order.md](histories/T21-other-readers-map-order.md); executable controls: the two `other-reader finding` tests in `test/marks/status-index.test.ts`. They show removal authors `Alice/Bob/Bob` and visual text `X<br>Y` / `Y<br>X` / `Y<br>X` from byte-identical encoded state.

Review correction: `localeCompare` is not a total order on distinct keys and can vary with machine locale data. “Sorted” does not establish machine-independent resolution for the tag, link, comment/reply or structural gallery rows that use it. The concrete reply counterexample is retained in [T21-reply-collation-order.md](histories/T21-reply-collation-order.md); that reader is deliberately unfixed here and belongs to the stacked reader-order PR.

## Review: malformed graphs and partial ancestry

The resolver now rejects any cycle in a beat's valid event graph by returning that beat's stored status, including a cycle disconnected from an otherwise valid frontier. Malformed record shapes are ignored, and missing or foreign-target parents are absent from the beat-local graph. Validation and evaluation are iterative, so self-parent graphs, multi-node cycles and long retired chains terminate without recursive calls; see [T21-status-parent-cycles.md](histories/T21-status-parent-cycles.md).

[T21-partial-status-ancestry.md](histories/T21-partial-status-ancestry.md) preserves an open Stage 2 question: authoring c while p is withheld records parents `[a,x]` and undo later reads todo; authoring after p arrives records `[a]` and undo reads shot. These are different event sets, not a replica disagreement. Actual command updates prove Yjs can integrate a without p when they originate on different clients: application parent-id strings do not create Yjs struct dependencies. Stage 2 must decide whether readers or commands wait for complete ancestry; no such policy is invented here.

## Review: one wire-stable status validator

All status readers, the index, conflict notices and undo now consume `readStatusEvent` output. It canonicalizes raw ContentAny values with the pinned wire codec, then requires a dense array of string parents, a string target/author and one of `todo/ready/shot`; invalid records are absent and no raw fields are used afterwards. Outgoing command payloads are validated too. `prior` still records the resolved observed cut and is ignored by resolution. Historical #1409 events without author metadata remain unchanged in the defect archive; current causal fixtures explicitly include valid author strings.

[T21-status-wire-validation.md](histories/T21-status-wire-validation.md) keeps the sparse-parent, invalid-status and non-coercible-author cases and the four retained seeds. The seeded property checks writer versus encoded reload after writes, deletions and recreations, including arbitrary retirement values, through complete outputs from every status reader and an observing index. It covers wire-sensitive strings, prototypes, hidden/inherited/getter fields and all requested value categories; storage refusals are recorded separately, and a refused retirement write does not skip checking the successful status write.

The four seeds make 1,720 write/recreate attempts: 1,544 accepted writes and 176 storage refusals, with 3,264 writer/reload checkpoints including deletions and refusals. Refused top-level kinds are symbols, functions, non-Uint8 typed arrays, ArrayBuffer, unsupported null-prototype objects and null constructors. See the retained test diagnostics for per-map counts.

Stage 2 limit, recorded without running a timing: the reviewer observed a **50,000-event same-valued chain on one beat** run beyond **8 seconds** in `projectStatus` and `readStructure`. The resolver completed; the conflict-notice scan compares every pair of the beat's events. This PR does not change that scan.

## Counts and retained timings

No timing was run. `timed-implementation.json`, `timings.json` and original timed hashes are unchanged. `marks/status-timing-changes.json`, `perf/setup.ts` and `perf/lifetime/audit.ts` pin the explicit changed-file list, before/after hashes, dependency digests and count-data hashes; tests reject unlisted source changes and damaged declarations. Retained report rows are labeled as predating this fix.

Two browser evidence bundles import the changed readers. Their recorded observations/hashes remain unchanged: `marks/status-browser-source.json` archives the three original reader sources and declares both new bundle hashes. The provenance checks reproduce each original recorded bundle byte-for-byte using those archived sources, require every unchanged input to remain compatible, and separately pin the new bundles. Deliberately wrong old/new bundle hashes fail. No browser was run and the old observations do not endorse the changed bundles; browser reruns remain for the coordinator.

Retiming needed: lifetime **structure, component and withIdentity** for both modes at all seven states; earlier A/B **local/remote character, remote status, remote comment, both bursts, remote split and remote join** rows. Lifetime apply/incremental/capture/resolve and earlier capture/resolve identity do not execute changed status work inside their measured intervals. The earlier export caveats still apply.

The initial status fix changed 26 `work.structure.gets.beats` counters, because all resolutions read stored status and cached index reads validate it. Its changes from main are preserved below. The malformed-graph review fix additionally changes 13 legacy `work.structure.gets.retiredStatus` counters: for both writer counts, blocks 1/5/10/20/36 go 29→58 / 145→290 / 290→580 / 580→1,160 / 1,044→2,088; synthetic 10,020/25,050/50,100 operations go 100→200 / 250→500 / 300→1,000. The zero-operation point is unchanged. All event values are now evaluated iteratively in topological order, so retired membership is checked for each valid event rather than just the final frontier. Encoded bytes, encoded-state hashes, operation/record counts, other counters, cap crossings and sensitivity values are unchanged. The before/after audit hashes preserve both source/count layers; no timing or recorded browser observation is rewritten.

The wire-validation round adds a third explicit source/dependency/count audit layer, including `perf/operations.ts`, and a third browser bundle layer. Regenerated lifetime and structural count data and all sensitivity rows equal the preceding reviewed head exactly: **zero counters or encoded-byte values moved**. Current source metadata and generated report digests changed; the implementation-size table's operations row goes 73→74 lines and its shared total 360→361 (the operations row occurs twice). The preservation check normalizes only those three literal source-size rows to the unchanged historical baseline; every measured table row, sample and numeric observation remains pinned. The same timing rows listed above need retiming; retained rows predate this validation too.

| Checkpoint (both writer counts) | Legacy beat gets, before → after | Indexed beat gets, before → after |
| --- | ---: | ---: |
| 1 block | 114 → 172 | 109 → 138 |
| 5 blocks | 570 → 860 | 545 → 690 |
| 10 blocks | 1,140 → 1,720 | 1,090 → 1,380 |
| 20 blocks | 2,280 → 3,440 | 2,180 → 2,760 |
| 36 blocks | 4,104 → 6,192 | 3,924 → 4,968 |
| Synthetic 0 operations | 1,500 → 1,500 | 1,200 → 1,200 |
| Synthetic 10,020 operations | 1,740 → 1,940 | 1,460 → 1,560 |
| Synthetic 25,050 operations | 2,100 → 2,600 | 1,850 → 2,100 |
| Synthetic 50,100 operations | 3,100 → 3,700 | 2,700 → 3,000 |

## Validation

Node 24.22.1, pinned dependencies, no app code changes. Full prototype suite after wire validation: **1,686/1,686 pass, zero skipped** (`npm test -- --test-concurrency=1`). All four root gates pass: lint, typecheck, check:comments and check:deps. The mark mutation audit has 116 baseline passes, 34 detected defects and three previously withdrawn claims; the separate map-iteration control is also rejected. The original status files retain their 61 tests; review adds nine 96-case malformed/foreign-parent/metadata matrices, a 20,000-event chain, persistent-index replacement/repair, the reply finding, both partial-ancestry rows, wire-validation literals/properties and audit-chain negative controls. No application hook, browser, Edge or development server was needed; test-owned local service fixtures are stopped by their existing cleanup.
