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
| Comments/replies and first marked anchor | `marks/projection.ts:75`, `marks/projection.ts:79`, `marks/projection.ts:81` | Yes: replies sort by createdAt/id, comments by id, anchors follow structural row/character order. Same-key fields use native Y.Map conflict resolution. |
| Resolve/reopen “later wins” | `proj/document.ts:161`, `proj/document.ts:245` | Yes: one atomic resolution value in a Y.Map key; causal later writes win and concurrent writes use Yjs's deterministic conflict rule, not map iteration or wall-clock recency. |
| Registries and shot props | `marks/commands.ts:49`, `proj/document.ts:215`, `proj/value.ts:47` | Yes: exact kind/name creates one deterministic tag id; export sorts rank/id. Other same-key fields use native Y.Map conflict resolution. |
| Gallery deduplication/first picture/poster | `structure-reader.ts:151`, `structure-reader.ts:155`, `structure-reader.ts:161`, `proj/document.ts:226`, `proj/document.ts:281` | Yes within each layout: structural input sorts beat-position/rank/id before first-match merges; full-document slots and links sort rank/id. |
| Repeated segment/boundary first occurrence | `structure-reader.ts:83`, `proj/document.ts:207` | Yes: first occurrence is in the converged Y.Array/Y.Text sequence, not an unordered map. |
| Full-document visual/anchor order | `proj/document.ts:258`, `proj/document.ts:272` | Yes: visuals sort rank/id, anchors take the first occurrence in agreed block/character order. |
| Measurement target comment | `perf/measure.ts:41` | Replica-local selector: takes the last map key. It selects a benchmark target rather than resolving shared content; no timings or convergence claim for this selector were made here. |

The two confirmed non-status defects are unchanged. Minimal histories and actual observations: [T21-other-readers-map-order.md](histories/T21-other-readers-map-order.md); executable controls: the two `other-reader finding` tests in `test/marks/status-index.test.ts`. They show removal authors `Alice/Bob/Bob` and visual text `X<br>Y` / `Y<br>X` / `Y<br>X` from byte-identical encoded state.

## Counts and retained timings

No timing was run. `timed-implementation.json`, `timings.json` and original timed hashes are unchanged. `marks/status-timing-changes.json`, `perf/setup.ts` and `perf/lifetime/audit.ts` pin the explicit changed-file list, before/after hashes, dependency digests and count-data hashes; tests reject unlisted source changes and damaged declarations. Retained report rows are labeled as predating this fix.

Two browser evidence bundles import the changed readers. Their recorded observations/hashes remain unchanged: `marks/status-browser-source.json` archives the three original reader sources and declares both new bundle hashes. The provenance checks reproduce each original recorded bundle byte-for-byte using those archived sources, require every unchanged input to remain compatible, and separately pin the new bundles. Deliberately wrong old/new bundle hashes fail. No browser was run and the old observations do not endorse the changed bundles; browser reruns remain for the coordinator.

Retiming needed: lifetime **structure, component and withIdentity** for both modes at all seven states; earlier A/B **local/remote character, remote status, remote comment, both bursts, remote split and remote join** rows. Lifetime apply/incremental/capture/resolve and earlier capture/resolve identity do not execute changed status work inside their measured intervals. The earlier export caveats still apply.

Regenerated lifetime checkpoints change only 26 `work.structure.gets.beats` counters, because all resolutions read stored status and cached index reads validate it. Encoded bytes, hashes of encoded states, operation/record counts, all other counters, cap crossings and sensitivity values are unchanged. Structural counts and all five sensitivity scenarios were also regenerated; only source metadata changes there.

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

Node 24.22.1, pinned dependencies, no app code changes. Full prototype suite: **1,659/1,659 pass, zero skipped** (`npm test -- --test-concurrency=1`). All four root gates pass: lint, typecheck, check:comments and check:deps. The mark mutation audit has 116 baseline passes, 34 detected defects and three previously withdrawn claims; the separate map-iteration control is also rejected. The new status files contain 61 tests, including the two unchanged-defect observations. No application hook, browser, Edge or development server was needed; test-owned local service fixtures are stopped by their existing cleanup.
