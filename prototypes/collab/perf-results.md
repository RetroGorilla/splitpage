# Incremental projection performance: prepared experiment and structural evidence

The initial PR contained deterministic structural evidence only; its earlier game-session timing attempts remain void. The guarded timed follow-up below was run only after the coordinator authorized it and after the initial PR opened. A game was running during the accepted set; each run's recorded RAM and background CPU is disclosed below. No schema is selected.

Current reviewed source SHA-256: **3ef67a25a054d08783995254774aac057143b98805fa0bf9832f2019ba27659f**. The source-hash list covers every src/perf TypeScript module, every src/proj module, schema/model/structure/status helpers and the prototype lockfile. setup.json fixes Node v24.22.1, Yjs 13.6.33, five alternating paired runs, three warm-up operations per case and eleven samples per run. The recorded timed source is identified separately below; the source audit distinguishes that implementation from declared post-timing changes.

## What is implemented

Both incremental projectors import the existing fromDocument/toDocument implementation. The timed incremental integration added two src/proj lines: ProjectionOptions.blocks accepts a subset of existing blocks, and toDocument uses it instead of scanning every block. Subsequent export changes are declared below. No app code, buffer, slice, structure, marks, service, local or app-binding file changes.

A caches the document-wide delta, applies Yjs retain/delete/insert/format events, and walks its boundary chunks to find changed beats. A change at a late offset still processes the preceding cached sequence; it does not run a fresh full Y.Text.toDelta. B caches each segment's delta and parsed boundary list. A changed segment invalidates that list, and the order array supplies global position. Splits remain inner embeds in their original segment under the merged B mechanism, so B's locality is by segment rather than necessarily by beat. Both reuse unchanged projected beat objects, including across no-op or duplicate updates. The common text-to-span index makes reverse lookup local to a B segment; A's flow contains all spans.

Metadata events invalidate affected beat records. Gallery/visual ownership changes include both old and new owners. A tag-registry change or comment anchorId change conservatively reprojects all beats. Comment bodies and status events do not require rebuilding narration. Anchors derive from cached affected blocks and retained per-beat anchors. The full plain document remains equal to src/proj/toDocument; the common structural probe additionally reads joins, retired joins, soft removal and causal status events. That probe does not supply full gallery folding, split-descendant recovery attribution, crossing-mark resolution or app derivations. No new integrated structural/mark trace pass is claimed.

### Implementation size

| Source counted in each candidate | A lines | B lines |
| --- | ---: | ---: |
| delta.ts (shared) | 57 | 57 |
| blocks.ts (shared) | 111 | 111 |
| incremental.ts (shared) | 119 | 119 |
| operations.ts (shared) | 74 | 74 |
| Total physical lines, including blanks | 361 | 361 |

The same implementation is instantiated for either candidate. The stream-selection branch in blocks.ts is one line for A and five for B; shared lines are counted for each, rather than inventing two independent implementations. The layout makes A's ordering simple but changed-range attribution global. B directly identifies the changed segment but must recover each beat's position within a split segment and the segment's position in global order.

## Deterministic fixtures and encoded sizes

The largest canonical fixture is the long demo. large repeats it ten times using the recorder's SCALE id/mark retargeting, with people/tags shared; tests compare the generator with the existing projection lane's generator. Near-limit is the greatest whole number of copies fitting 2 MiB encoded state under both candidates. These are exact byte counts, independent of CPU load; binary blobs are absent.

| Fixture | Copies / beats | Plain file bytes | A encoded bytes | B encoded bytes | A/B | Cheaper | A / B import ratios | Fresh ≤3x plain and ≤2 MiB |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| largest canonical | 1 / 30 | 38432 | 48649 | 50252 | 0.9681x | A fewer by 1603 (3.19%) | 1.266x / 1.308x | yes / yes |
| large | 10 / 300 | 334208 | 427695 | 445329 | 0.9604x | A fewer by 17634 (3.96%) | 1.280x / 1.332x | yes / yes |
| near 2 MiB | 47 / 1410 | 1552544 | 2001642 | 2087457 | 0.9589x | A fewer by 85815 (4.11%) | 1.289x / 1.345x | yes / yes |

## Identity work, counted without a clock

An item visit is one iteration over a Yjs linked-list item, including formatting and deleted items; it is not one character. The counts describe this implementation's public capture/resolve calls. A production binding using those same calls would retain the repeated scans, but an identity index or batched traversal could reduce A's work. This is not an unavoidable production gap or a latency result.

The public relative-position API is used by the projector. To count its actual work, counts.ts builds an ephemeral copy of pinned Yjs source with counters in createRelativePositionFromTypeIndex's forward loop, createAbsolutePositionFromRelativePosition's backward loop, and the struct-store binary-search probes. Original package files are untouched. Instrumented source hashes are committed; exact source needles must match once. This is a diagnostic dependency on pinned library internals, not a private API dependency in the projector. Counters do not establish elapsed time. The two-row literal control requires A capture 8 forward visits and lookup 3 backward + 4 forward verification visits over 2 spans; B requires 2 capture visits and lookup 0 backward + 1 forward verification visit over 1 span. Removing or misplacing a counter fails these controls.

The painted target is the longest live beat in the last quarter of live beat order (ties choose the later beat). Every UTF-16 position/content atom is captured with one public call. Lookup targets the last captured identity, resolves it through the public API, searches its containing text's span list, and verifies that the live identity still matches. Struct probes count the library's actual array reads, including its initial pivot read. These counts include work hidden by the public call, rather than assuming A scans and B does not.

### largest canonical, 0 history operations

Target A/B: r27 / r27; 514 / 514 identities.

| Work | A | B | A/B | Cheaper |
| --- | ---: | ---: | ---: | --- |
| Public capture calls | 514 | 514 | 1.000x | equal |
| Capture forward item visits | 42148 | 514 | 82.000x | B fewer by 41634 (98.78%) |
| Lookup backward item visits | 81 | 0 | B has zero | B fewer by 81 (100.00%) |
| Lookup live-verification forward visits | 82 | 1 | 82.000x | B fewer by 81 (98.78%) |
| Lookup struct-store probes | 12 | 11 | 1.091x | B fewer by 1 (8.33%) |
| Lookup projected spans searched | 27 | 1 | 27.000x | B fewer by 26 (96.30%) |

### large, 0 history operations

Target A/B: r20-9 / r20-9; 602 / 602 identities.

| Work | A | B | A/B | Cheaper |
| --- | ---: | ---: | ---: | --- |
| Public capture calls | 602 | 602 | 1.000x | equal |
| Capture forward item visits | 552636 | 602 | 918.000x | B fewer by 552034 (99.89%) |
| Lookup backward item visits | 917 | 0 | B has zero | B fewer by 917 (100.00%) |
| Lookup live-verification forward visits | 918 | 1 | 918.000x | B fewer by 917 (99.89%) |
| Lookup struct-store probes | 15 | 16 | 0.938x | A fewer by 1 (6.25%) |
| Lookup projected spans searched | 290 | 1 | 290.000x | B fewer by 289 (99.66%) |

### large, 10020 history operations

Target A/B: r20-9 / r20-9; 602 / 602 identities.

| Work | A | B | A/B | Cheaper |
| --- | ---: | ---: | ---: | --- |
| Public capture calls | 602 | 602 | 1.000x | equal |
| Capture forward item visits | 853034 | 602 | 1417.000x | B fewer by 852432 (99.93%) |
| Lookup backward item visits | 1416 | 0 | B has zero | B fewer by 1416 (100.00%) |
| Lookup live-verification forward visits | 1417 | 1 | 1417.000x | B fewer by 1416 (99.93%) |
| Lookup struct-store probes | 15 | 16 | 0.938x | A fewer by 1 (6.25%) |
| Lookup projected spans searched | 390 | 1 | 390.000x | B fewer by 389 (99.74%) |

### large, 25050 history operations

Target A/B: r20-9 / r20-9; 602 / 602 identities.

| Work | A | B | A/B | Cheaper |
| --- | ---: | ---: | ---: | --- |
| Public capture calls | 602 | 602 | 1.000x | equal |
| Capture forward item visits | 1304534 | 602 | 2167.000x | B fewer by 1303932 (99.95%) |
| Lookup backward item visits | 2166 | 0 | B has zero | B fewer by 2166 (100.00%) |
| Lookup live-verification forward visits | 2167 | 1 | 2167.000x | B fewer by 2166 (99.95%) |
| Lookup struct-store probes | 15 | 14 | 1.071x | B fewer by 1 (6.67%) |
| Lookup projected spans searched | 540 | 1 | 540.000x | B fewer by 539 (99.81%) |

### large, 50100 history operations

Target A/B: history-beat-289 / history-beat-289; 592 / 592 identities.

| Work | A | B | A/B | Cheaper |
| --- | ---: | ---: | ---: | --- |
| Public capture calls | 592 | 592 | 1.000x | equal |
| Capture forward item visits | 1880784 | 3552 | 529.500x | B fewer by 1877232 (99.81%) |
| Lookup backward item visits | 3176 | 5 | 635.200x | B fewer by 3171 (99.84%) |
| Lookup live-verification forward visits | 3177 | 6 | 529.500x | B fewer by 3171 (99.81%) |
| Lookup struct-store probes | 16 | 16 | 1.000x | equal |
| Lookup projected spans searched | 780 | 2 | 390.000x | B fewer by 778 (99.74%) |

### near 2 MiB, 0 history operations

Target A/B: r20-46 / r20-46; 602 / 602 identities.

| Work | A | B | A/B | Cheaper |
| --- | ---: | ---: | ---: | --- |
| Public capture calls | 602 | 602 | 1.000x | equal |
| Capture forward item visits | 2668666 | 602 | 4433.000x | B fewer by 2668064 (99.98%) |
| Lookup backward item visits | 4432 | 0 | B has zero | B fewer by 4432 (100.00%) |
| Lookup live-verification forward visits | 4433 | 1 | 4433.000x | B fewer by 4432 (99.98%) |
| Lookup struct-store probes | 17 | 18 | 0.944x | A fewer by 1 (5.56%) |
| Lookup projected spans searched | 1400 | 1 | 1400.000x | B fewer by 1399 (99.93%) |

## Retained writing history

500 writing cycles from fresh large, 50,100 public operations: 37,500 one-character inserts (typing/retyping), 7,500 one-character deletes, 500 splits, 500 joins, 500 semantic join retirements, 600 observed removals, 500 restores, 1,000 causal status writes and 1,500 comment revisions. Per cycle: 60 typing inserts, 15 deletes, 15 retyping inserts, split/join/retire/remove/restore once each, two status writes and three comment changes. Every fifth cycle adds a second removal before restoring the first; 100 beats remain soft-removed. The 300 original beats are visited cyclically. This synthetic mix favors writing and revision while repeatedly exercising retained structures; it is not user telemetry. Default gc=true works for both merged soft-removal mechanisms. No UndoManager retains deleted text; production undo retention adds a cost not represented here.

Each checkpoint is encoded and reloaded into a fresh initialized replica; counts must agree after transfer. The plain denominator removes soft-removed rows from src/proj/toDocument, but keeps comment/registry records. It is a conservative row-filtered file-size proxy, not a fully integrated app export/recovery policy. The hard 2 MiB state cap is directly comparable regardless of that denominator.

### Checkpoint 0

| Count | A | B | A/B | Cheaper |
| --- | ---: | ---: | ---: | --- |
| Encoded bytes | 427695 | 445329 | 0.9604x | A fewer by 17634 (3.96%) |
| Beat records | 300 | 300 | 1.0000x | equal |
| Soft-removed beats | 0 | 0 | equal | equal |
| Removal records | 0 | 0 | equal | equal |
| Join entries | 0 | 0 | equal | equal |
| Retired join ids | 0 | 0 | equal | equal |
| Status events | 0 | 0 | equal | equal |
| Active plain bytes proxy | 334208 | 334208 | 1.0000x | equal |

State / active-file proxy: A 1.280x, B 1.332x. Fresh 3x cap: A within, B within. Hard 2 MiB cap: A within, B within.

### Checkpoint 10020

| Count | A | B | A/B | Cheaper |
| --- | ---: | ---: | ---: | --- |
| Encoded bytes | 1220382 | 1237973 | 0.9858x | A fewer by 17591 (1.42%) |
| Beat records | 400 | 400 | 1.0000x | equal |
| Soft-removed beats | 20 | 20 | 1.0000x | equal |
| Removal records | 120 | 120 | 1.0000x | equal |
| Join entries | 100 | 100 | 1.0000x | equal |
| Retired join ids | 100 | 100 | 1.0000x | equal |
| Status events | 200 | 200 | 1.0000x | equal |
| Active plain bytes proxy | 346533 | 346533 | 1.0000x | equal |

State / active-file proxy: A 3.522x, B 3.572x. Edited 10x proxy cap: A within, B within. Hard 2 MiB cap: A within, B within.

### Checkpoint 25050

| Count | A | B | A/B | Cheaper |
| --- | ---: | ---: | ---: | --- |
| Encoded bytes | 2398278 | 2415709 | 0.9928x | A fewer by 17431 (0.72%) |
| Beat records | 550 | 550 | 1.0000x | equal |
| Soft-removed beats | 50 | 50 | 1.0000x | equal |
| Removal records | 300 | 300 | 1.0000x | equal |
| Join entries | 250 | 250 | 1.0000x | equal |
| Retired join ids | 250 | 250 | 1.0000x | equal |
| Status events | 500 | 500 | 1.0000x | equal |
| Active plain bytes proxy | 366523 | 366523 | 1.0000x | equal |

State / active-file proxy: A 6.543x, B 6.591x. Edited 10x proxy cap: A within, B within. Hard 2 MiB cap: A over, B over.

### Checkpoint 50100

| Count | A | B | A/B | Cheaper |
| --- | ---: | ---: | ---: | --- |
| Encoded bytes | 3338732 | 3356090 | 0.9948x | A fewer by 17358 (0.52%) |
| Beat records | 800 | 800 | 1.0000x | equal |
| Soft-removed beats | 100 | 100 | 1.0000x | equal |
| Removal records | 600 | 600 | 1.0000x | equal |
| Join entries | 500 | 500 | 1.0000x | equal |
| Retired join ids | 500 | 500 | 1.0000x | equal |
| Status events | 1000 | 1000 | 1.0000x | equal |
| Active plain bytes proxy | 401522 | 401522 | 1.0000x | equal |

State / active-file proxy: A 8.315x, B 8.358x. Edited 10x proxy cap: A within, B within. Hard 2 MiB cap: A over, B over.

These growth conclusions hold for this synthetic workload with undo retention omitted. They do not establish general growth behaviour.

## Predictions and budgets

Artifact 8 Y1 / A-H7 / B-H5: the traversal-locality prediction is directly tested by the item counts above. A's public identity pass repeatedly traverses preceding document-wide items; B's pass traverses the target segment. These structural counts alone do not assess elapsed time or the input budget; see the guarded Node follow-up for component timings. They are not app latency results.

A-H2 / Y8 / Y9 and the soft-removal growth open question: both use gc=true and retain soft-removed text and retirement metadata. The encoded checkpoints show that neither mechanism keeps this 50,100-operation history below the provisional 2 MiB bound. This refutes sufficiency of the existing retention mechanisms for that hard cap on this bounded workload; it does not refute correctness of soft removal. test/perf/history.test.ts checks the exact retained counts and encoded reload with default GC. No unbounded-growth or compaction claim is inferred from one history.

Artifact 7 fresh-import 3x and retained-state 2 MiB byte caps can be assessed directly above. These deterministic tables contain no latency or heap result; the guarded Node follow-up below supplies those component measurements. App input/message-to-frame, complete join, reconnect and receipt budgets remain unestablished. The optional Edge attempt imported the slice driver unchanged and held perf/smoke locks, but its CPU guard exceeded 35%, so it was voided and not repeated; no browser timing conclusion is retained. Paint, app derivations, real network and blobs are absent from the Node component measurements.

## Validation and prepared method

Correctness tests cover three literal randomized seeds (240 transactions each per candidate), exact full-document agreement after every transaction, unchanged-row identity, duplicate/reverse delivery, split/restore/deleted-identity controls, 100 versus one projection for unbatched/batched delivery, history counts and fresh encoded reload. The source-hash/method checker validates setup and structural evidence without a timing threshold. Structural-count generation checks the literal instrumented control before accepting its output.

The coordinator has authorized one timed set only after this non-measurement PR is opened. The owner will still be playing a lighter game; the timed report must state that and include each accepted run's background CPU before/after. Keep the ≥3 GiB RAM and ≤35% CPU guards, stop after three consecutive refusals, and allow 30 seconds between retries rather than a tight loop. The source-hashed run will retain all samples/voids, alternate candidates, and apply artifact 7's fixed tolerance. Its timed report is generated separately by timing-report.ts; invalid files are never its default input.

```powershell
node prototypes/collab/src/perf/setup.ts --check
node prototypes/collab/src/perf/run.ts --check
node prototypes/collab/src/perf/report.ts --check
```

## Review controls

The four literal visuals/gallery ownership-transfer controls cover A and B, both affected rows and an unchanged row. Removing old-owner invalidation makes all four fail; restoring it makes all four pass. test/perf/ownership-mutation.json retains the actual mutation output. Two additional controls verify that a one-character projection consumes events without rereading narration streams.

## Guarded timed follow-up

Timed head: 74ed7af06e4859dec5cd3ad84c7195977ca3eac6; prepared SHA-256: 0798cf18c5c228d4995c738ed3cae70de23fbebad052a601592e5e21caf09b60. Post-run changes add controls, reporting corrections and source-audit checks. Machine identifiers and local paths were redacted after the run; no measured value changed. timed-source.json retains original implementation hashes, verifies the hostname-only metadata changes in the perf and projection cost recorders, and separately pins declared post-timing source changes. No case was retimed after review.

Post-timing change (#1406): src/proj/richtext.ts and the new src/proj/stored-html.ts replace normalized export with stored-run export; src/proj/experiment.ts, exclusions.ts and lossless-report.ts add the strict gate/report. No case was retimed. Local/remote character, both remote-burst variants, remote split/join, first full projection and projection-bearing checkpoint/heap/history measurements exercise the changed exporter. Identity capture/resolve, remote status/comment and applyUpdate-only load do not call it inside their timed intervals; setup can. Structural counts and encoded sizes reproduce unchanged. The perf lane's next measurement PR supersedes the affected rows.

These retained rows also predate the shared status-resolution fix (#1376). marks/status-timing-changes.json pins changed files separately from timed hashes. Local/remote character, remote status, remote comment, both remote bursts, remote split and remote join call the changed perfStructureView/statusValue inside their intervals and need retiming for both candidates. Capture/resolve identity do not call it inside their intervals. No timing was run for this fix; export caveats still apply.

Generated by `node src/perf/report.ts --write`. PERF evidence compares the two implementations; it selects no schema.

Machine: AMD Ryzen 9 9950X3D2 16-Core Processor, win32 10.0.26300, x64, 30.91 GiB RAM. Node v24.22.1, Yjs 13.6.33. Source base: 74ed7af06e4859dec5cd3ad84c7195977ca3eac6; the committed source and raw results travel together.

Machine identifiers and local paths were redacted after the run. No measured value, sample, timestamp, load reading or count changed. The recorder now omits host names; transcript redaction emits repository-relative paths or placeholders. Preservation checks cover all 76 comparison rows and all 4,510 samples.

## Method

Five whole-fixture runs per candidate, alternating A/B then B/A each round. Each case warms up three operations and records eleven operations. Tables give the median of the five per-run p50s [minimum–maximum]; p95 is the median of the five per-run p95s. Every sample, projected-beat count, free-RAM reading, CPU reading and void run is in `src/perf/results.json`. No samples are dropped. Locks perf and smoke are held through the wrapper; no own tests run concurrently.

The artifact 7 tolerance is max(base run range, 15% of base median, 0.5 ms). Candidate comparisons apply it in both directions and require a difference larger than both tolerances. Open/projection-load uses the 5 ms floor; heap uses 3% and 0.25 MiB. Byte differences are exact. The tolerance governs comparisons, never erases an absolute CPU budget failure. This is a candidate comparison, not a standalone base/head regression test; no shipping code changed.

The owner is playing a lighter game during this session. Other lanes, browser applications and background processes are running; perf/smoke locks held. Per-run before/after CPU records background load. No own tests concurrent.

Free RAM before accepted runs: 10.55, 10.55, 10.57, 10.35, 10.20, 10.13, 9.18, 8.83, 8.71, 10.17, 10.83, 10.66, 10.82, 10.84, 10.85, 10.51, 10.32, 10.98, 10.75, 10.73, 10.72, 10.82, 10.65, 11.35, 11.15, 11.10, 11.10, 10.75, 11.25, 11.20 GiB. CPU before/after: 25.2/27.8, 21.3/22.5, 25.9/29.0, 26.9/28.6, 26.2/25.0, 27.2/27.9, 28.4/31.1, 34.6/29.8, 24.3/31.5, 31.7/26.4, 27.2/26.8, 22.5/27.4, 20.6/21.0, 22.9/19.4, 19.8/21.0, 22.4/25.9, 28.4/20.6, 20.2/27.8, 26.8/23.8, 29.0/23.9, 22.2/24.1, 29.3/26.8, 24.2/22.3, 21.0/34.6, 27.0/32.2, 27.7/24.2, 24.5/34.6, 26.3/29.0, 9.7/23.5, 14.2/14.3%. Voids retained: 1; refused starts retained: 2. Runs below 3 GiB or with invalid starting conditions are refused before measurement. Other machine load may affect every run.

## Fixtures

| Fixture | Beats | Copies | Plain .splitpage bytes | SHA-256 of input |
| --- | ---: | ---: | ---: | --- |
| largest canonical | 30 | 1 | 38432 | 6f8d5731552da0152bf220596cc4b70cc58820895c5035d05a95af130ca23b34 |
| large | 300 | 10 | 334208 | e204909250840a85564a5f9290b25d442928027e5be588ed4d88532c1dffd10f |
| near 2 MiB | 1410 | 47 | 1552544 | 10246c13b1b26dc945bcd2bc227e77444645e86937a58297ef5a78a892959503 |

### Accepted-run background load

A game was running throughout the accepted set. CPU is the one-second aggregate machine load sampled while the recorder waited, before and after each run; it does not isolate the game from other background processes.

| Round | Fixture | Candidate | Free RAM GiB before | CPU % before | CPU % after |
| ---: | --- | --- | ---: | ---: | ---: |
| 1 | largest canonical | A | 10.55 | 25.2 | 27.8 |
| 1 | largest canonical | B | 10.55 | 21.3 | 22.5 |
| 1 | large | A | 10.57 | 25.9 | 29.0 |
| 1 | large | B | 10.35 | 26.9 | 28.6 |
| 1 | near 2 MiB | A | 10.20 | 26.2 | 25.0 |
| 1 | near 2 MiB | B | 10.13 | 27.2 | 27.9 |
| 2 | largest canonical | B | 9.18 | 28.4 | 31.1 |
| 2 | largest canonical | A | 8.83 | 34.6 | 29.8 |
| 2 | large | B | 8.71 | 24.3 | 31.5 |
| 2 | large | A | 10.17 | 31.7 | 26.4 |
| 2 | near 2 MiB | B | 10.83 | 27.2 | 26.8 |
| 2 | near 2 MiB | A | 10.66 | 22.5 | 27.4 |
| 3 | largest canonical | A | 10.82 | 20.6 | 21.0 |
| 3 | largest canonical | B | 10.84 | 22.9 | 19.4 |
| 3 | large | A | 10.85 | 19.8 | 21.0 |
| 3 | large | B | 10.51 | 22.4 | 25.9 |
| 3 | near 2 MiB | A | 10.32 | 28.4 | 20.6 |
| 3 | near 2 MiB | B | 10.98 | 20.2 | 27.8 |
| 4 | largest canonical | B | 10.75 | 26.8 | 23.8 |
| 4 | largest canonical | A | 10.73 | 29.0 | 23.9 |
| 4 | large | B | 10.72 | 22.2 | 24.1 |
| 4 | large | A | 10.82 | 29.3 | 26.8 |
| 4 | near 2 MiB | B | 10.65 | 24.2 | 22.3 |
| 4 | near 2 MiB | A | 11.35 | 21.0 | 34.6 |
| 5 | largest canonical | A | 11.15 | 27.0 | 32.2 |
| 5 | largest canonical | B | 11.10 | 27.7 | 24.2 |
| 5 | large | A | 11.10 | 24.5 | 34.6 |
| 5 | large | B | 10.75 | 26.3 | 29.0 |
| 5 | near 2 MiB | A | 11.25 | 9.7 | 23.5 |
| 5 | near 2 MiB | B | 11.20 | 14.2 | 14.3 |

An item visit in the structural tables is a linked-list item iteration, including formatting/deleted items, rather than a character. The public-call scan difference belongs to this implementation; a binding using the same calls retains it, while an identity index or batched traversal could reduce A's repeated scans. It is not an unavoidable production gap.


Largest canonical is the imported long demo; large repeats it ten times with the exact SCALE id/mark retargeting used by tools/perf-record.mjs (334,208 file bytes). Near 2 MiB is the greatest whole number of copies whose fresh encoded state fits the 2 MiB cap under both candidates. It is an encoded-state fixture, not a 2 MiB plain file. No binary assets are included.

## Incremental mechanism

Both import the existing fromDocument/toDocument implementation. The only src/proj change is an optional `ProjectionOptions.blocks` input (two lines), letting the same full projector render a supplied subset. A keeps the flow delta, applies the transaction's retain/delete/insert/format events, and walks the cached boundary chunks to identify changed beats. Offsets after the edit are rebuilt without reading all of Y.Text again. B keeps one delta and parsed boundary list per segment; a text event invalidates only its segment, while the order array supplies global order. A split stays inside its original segment under B, so segment-local work can grow with repeated splits. Both traverse the block index and reuse every unchanged projected beat object. Metadata roots invalidate their affected records; comment anchorId and tag registry changes conservatively render all beats.

The common structural measurement pass reads the merged mechanisms' join/retirement/removal/status state and derives narration/visual groups and recovery membership. It includes status frontier scans via the existing statusValue. This pass is deliberately reported as a lower bound: it does not implement full gallery folding, split-descendant recovery attribution, mark crossing repair or the app's derivations. The full document stays equal to src/proj/toDocument, which itself does not integrate those trace readers. No full structural/mark trace pass is newly claimed.

Correctness: test/perf/incremental.test.ts compares every one of 240 transactions for literal seeds 1376, 1306 and 3737844653 under both candidates, with duplicate delivery, marks, splits, comments, visuals, status, removals and joins. Unchanged complete rows must retain object identity. Literal identity/split/remove/restore/deletion controls additionally fail if identity lookup follows a deleted item as live. Existing independent trace checker remains unchanged.

## Per-edit CPU time, milliseconds

Timing starts immediately before local mutation or applyUpdate and ends after synchronous incremental projection and the structural measurement pass. Remote operation construction and encoding are excluded. Local mutation target lookup is prepared before timing, as it is for remote updates; identity capture and reverse lookup are separate cases. The target is the longest beat in the final quarter of the document (ties choose the later beat), a substantial painted beat at a late sequence offset. Identity capture uses its complete current UTF-16 contents, including content atoms, before split trials. Burst delivers 100 individually encoded remote character updates inside one receiving transaction and projects once. Each split trial has an untimed boundary undo so later trials still split substantial text; join undo uses retained cancellation ids. This is CPU work, not key/message-to-frame latency.

### Implementation size

| Source | A physical lines | B physical lines |
| --- | ---: | ---: |
| Shared delta.ts | 57 | 57 |
| Shared blocks.ts | 111 | 111 |
| Shared incremental.ts | 119 | 119 |
| Shared operations.ts | 74 | 74 |

Both instantiate the same implementation: A selects flow; B selects segments/order. A's stream-selection branch is one line; B's is five. These are physical lines including blanks; shared code is counted for each implementation, not presented as separate implementations. The index's public text-to-span map makes B reverse lookup segment-local; A searches the flow's spans after resolving the Yjs position.

### Fresh state and load

| Fixture / measure | A median [range] | B median [range] | A/B | Cheaper | Numeric budget comparison in Node |
| --- | --- | --- | ---: | --- | --- |
| largest canonical: encoded bytes | 48649 [48649–48649] | 50252 [50252–50252] | 0.968x | A by 1603 bytes | 115296: A within, B within |
| largest canonical: load ms | 10.798 [7.753–11.754] | 8.752 [7.232–9.723] | 1.234x | no difference beyond noise (T=5.000) | 3000.0: A within, B within |
| largest canonical: first full projection ms | 11.685 [8.691–12.226] | 10.183 [8.873–13.866] | 1.148x | no difference beyond noise (T=5.000) | 1000.0: A within, B within |
| largest canonical: heap with projection MiB | 12.245 [12.244–12.245] | 12.282 [12.281–12.283] | 0.997x | no difference beyond noise (T=0.368) | 17.1: A within, B within |
| large: encoded bytes | 427695 [427695–427695] | 445329 [445329–445329] | 0.960x | A by 17634 bytes | 1002624: A within, B within |
| large: load ms | 34.076 [28.054–40.267] | 29.433 [28.258–35.938] | 1.158x | no difference beyond noise (T=12.213) | 3000.0: A within, B within |
| large: first full projection ms | 163.676 [127.679–191.119] | 158.596 [146.044–191.270] | 1.032x | no difference beyond noise (T=63.440) | 1000.0: A within, B within |
| large: heap with projection MiB | 17.378 [17.374–17.382] | 17.918 [17.916–17.920] | 0.970x | A cheaper by 0.540 (3.0%) | 29.9: A within, B within |
| near 2 MiB: encoded bytes | 2001642 [2001642–2001642] | 2087457 [2087457–2087457] | 0.959x | A by 85815 bytes | 2097152: A within, B within |
| near 2 MiB: load ms | 107.666 [98.067–110.480] | 103.129 [87.505–111.195] | 1.044x | no difference beyond noise (T=23.691) | 3000.0: A within, B within |
| near 2 MiB: first full projection ms | 3356.876 [3105.123–4497.318] | 3347.141 [2958.892–3549.837] | 1.003x | no difference beyond noise (T=1392.195) | 1000.0: A over, B over |
| near 2 MiB: heap with projection MiB | 37.878 [37.877–37.881] | 40.420 [40.418–40.421] | 0.937x | A cheaper by 2.542 (6.3%) | 29.9: A over, B over; large heap context only, no near-limit heap cap |

The load component is compared with the 3 s join p50 cap; full projection with its 1 s single-task cap. Neither includes the complete join. Heap totals are Node context against browser-session caps, not a shared-app heap pass. Byte caps apply directly.

### largest canonical: local character

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 1.030 [0.812–1.208] | 0.976 [0.759–1.105] | 1.055x | no difference beyond noise (T=0.500) | 1.486 / 1.218 | 5.8 ms local input: A within, B within; 25 ms p95: A within, B within |

### largest canonical: remote character

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 1.088 [0.762–1.135] | 0.881 [0.755–1.008] | 1.235x | no difference beyond noise (T=0.500) | 1.459 / 1.585 | 30 ms remote character: A within, B within; 50 ms p95: A within, B within |

### largest canonical: remote status

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 0.795 [0.687–0.962] | 0.702 [0.691–1.050] | 1.133x | no difference beyond noise (T=0.500) | 1.182 / 1.242 | No dedicated limit; 30 ms remote-character budget is context only |

### largest canonical: remote comment

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 0.718 [0.463–0.784] | 0.696 [0.601–0.816] | 1.032x | no difference beyond noise (T=0.500) | 1.126 / 1.130 | No dedicated limit; 30 ms remote-character budget is context only |

### largest canonical: capture identities

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 0.164 [0.119–0.314] | 0.033 [0.032–0.080] | 5.021x | no difference beyond noise (T=0.500) | 0.443 / 0.089 | No dedicated limit; 30 ms remote-character budget is context only |

### largest canonical: resolve identity

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 0.008 [0.007–0.013] | 0.003 [0.001–0.005] | 2.375x | no difference beyond noise (T=0.500) | 0.043 / 0.008 | No dedicated limit; 30 ms remote-character budget is context only |

### largest canonical: remote burst 100

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 1.437 [1.155–1.552] | 1.419 [1.265–1.641] | 1.013x | no difference beyond noise (T=0.500) | 2.178 / 1.930 | No dedicated limit; 30 ms remote-character budget is context only |

### largest canonical: remote burst 100 individual transactions

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 87.803 [79.985–98.825] | 88.298 [75.247–94.214] | 0.994x | no difference beyond noise (T=18.967) | 100.401 / 101.180 | No dedicated limit; 30 ms remote-character budget is context only |

### largest canonical: remote split

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 0.963 [0.886–1.507] | 1.086 [0.990–1.255] | 0.887x | no difference beyond noise (T=0.620) | 1.409 / 1.419 | 45 ms structural: A within, B within |

### largest canonical: remote join

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 0.850 [0.652–0.957] | 0.845 [0.752–0.885] | 1.006x | no difference beyond noise (T=0.500) | 1.292 / 1.276 | 45 ms structural: A within, B within |

### large: local character

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 5.275 [4.255–6.593] | 4.811 [4.318–5.318] | 1.097x | no difference beyond noise (T=2.338) | 7.686 / 6.235 | 8 ms local input: A within, B within; 40 ms p95: A within, B within |

### large: remote character

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 5.127 [4.139–5.294] | 4.536 [4.181–4.703] | 1.130x | no difference beyond noise (T=1.155) | 5.813 / 5.168 | 30 ms remote character: A within, B within; 50 ms p95: A within, B within |

### large: remote status

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 3.862 [3.306–4.238] | 3.635 [2.753–3.710] | 1.062x | no difference beyond noise (T=0.957) | 4.533 / 4.274 | No dedicated limit; 30 ms remote-character budget is context only |

### large: remote comment

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 4.134 [3.217–4.547] | 3.607 [3.354–4.125] | 1.146x | no difference beyond noise (T=1.331) | 4.776 / 4.224 | No dedicated limit; 30 ms remote-character budget is context only |

### large: capture identities

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 2.236 [1.819–2.484] | 0.078 [0.055–0.085] | 28.561x | B cheaper by 2.158 (96.5%) | 2.576 / 0.152 | No dedicated limit; 30 ms remote-character budget is context only |

### large: resolve identity

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 0.040 [0.033–0.045] | 0.005 [0.004–0.006] | 8.000x | no difference beyond noise (T=0.500) | 0.108 / 0.006 | No dedicated limit; 30 ms remote-character budget is context only |

### large: remote burst 100

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 5.324 [4.515–6.656] | 5.254 [4.266–5.360] | 1.013x | no difference beyond noise (T=2.141) | 6.887 / 6.403 | No dedicated limit; 30 ms remote-character budget is context only |

### large: remote burst 100 individual transactions

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 502.931 [393.063–546.996] | 440.315 [412.884–606.023] | 1.142x | no difference beyond noise (T=193.139) | 525.862 / 469.141 | No dedicated limit; 30 ms remote-character budget is context only |

### large: remote split

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 5.891 [4.667–7.489] | 5.696 [5.165–6.627] | 1.034x | no difference beyond noise (T=2.822) | 6.852 / 7.722 | 300 ms structural: A within, B within |

### large: remote join

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 5.084 [3.562–5.783] | 4.881 [4.087–5.110] | 1.042x | no difference beyond noise (T=2.220) | 5.607 / 5.708 | 300 ms structural: A within, B within |

### near 2 MiB: local character

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 28.575 [24.397–34.223] | 29.362 [25.425–31.880] | 0.973x | no difference beyond noise (T=9.825) | 33.309 / 32.478 | 8 ms local input: A over, B over; 40 ms p95: A within, B within; extrapolated context, no fixture-specific edit cap |

### near 2 MiB: remote character

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 27.762 [26.156–33.841] | 26.458 [23.930–32.401] | 1.049x | no difference beyond noise (T=8.471) | 31.997 / 28.251 | 30 ms remote character: A within, B within; 50 ms p95: A within, B within; extrapolated context, no fixture-specific edit cap |

### near 2 MiB: remote status

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 21.451 [17.983–23.401] | 19.976 [19.315–22.015] | 1.074x | no difference beyond noise (T=5.418) | 24.553 / 22.588 | No dedicated limit; 30 ms remote-character budget is context only; extrapolated context, no fixture-specific edit cap |

### near 2 MiB: remote comment

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 21.291 [17.680–23.829] | 19.904 [16.975–23.004] | 1.070x | no difference beyond noise (T=6.149) | 24.867 / 22.423 | No dedicated limit; 30 ms remote-character budget is context only; extrapolated context, no fixture-specific edit cap |

### near 2 MiB: capture identities

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 18.908 [17.584–24.694] | 0.062 [0.052–0.112] | 303.979x | B cheaper by 18.845 (99.7%) | 21.125 / 0.148 | No dedicated limit; 30 ms remote-character budget is context only; extrapolated context, no fixture-specific edit cap |

### near 2 MiB: resolve identity

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 0.135 [0.075–0.171] | 0.005 [0.005–0.006] | 25.434x | no difference beyond noise (T=0.500) | 0.300 / 0.007 | No dedicated limit; 30 ms remote-character budget is context only; extrapolated context, no fixture-specific edit cap |

### near 2 MiB: remote burst 100

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 29.935 [25.957–35.104] | 28.962 [27.979–32.622] | 1.034x | no difference beyond noise (T=9.147) | 35.006 / 35.290 | No dedicated limit; 30 ms remote-character budget is context only; extrapolated context, no fixture-specific edit cap |

### near 2 MiB: remote burst 100 individual transactions

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 2449.078 [2376.953–2786.383] | 2689.241 [2466.144–2947.942] | 0.911x | no difference beyond noise (T=481.797) | 2905.207 / 2968.507 | No dedicated limit; 30 ms remote-character budget is context only; extrapolated context, no fixture-specific edit cap |

### near 2 MiB: remote split

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 30.726 [28.490–35.446] | 32.755 [25.480–32.882] | 0.938x | no difference beyond noise (T=7.402) | 38.341 / 36.526 | 300 ms structural: A within, B within; extrapolated context, no fixture-specific edit cap |

### near 2 MiB: remote join

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 26.555 [21.539–29.871] | 27.116 [21.903–27.425] | 0.979x | no difference beyond noise (T=8.332) | 29.788 / 30.462 | 300 ms structural: A within, B within; extrapolated context, no fixture-specific edit cap |

### large after 50,100 operations: local character

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 45.287 [38.789–50.306] | 42.949 [42.117–49.154] | 1.054x | no difference beyond noise (T=11.517) | 52.037 / 51.096 | 8 ms local input: A over, B over; 40 ms p95: A over, B over |

### large after 50,100 operations: remote character

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 42.677 [36.841–45.227] | 40.819 [39.732–46.006] | 1.046x | no difference beyond noise (T=8.386) | 44.755 / 45.678 | 30 ms remote character: A over, B over; 50 ms p95: A within, B within |

### large after 50,100 operations: remote status

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 40.653 [34.110–43.750] | 40.315 [36.597–42.200] | 1.008x | no difference beyond noise (T=9.640) | 44.028 / 44.362 | No dedicated limit; 30 ms remote-character budget is context only |

### large after 50,100 operations: remote comment

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 41.312 [35.111–44.866] | 40.571 [37.643–44.759] | 1.018x | no difference beyond noise (T=9.755) | 45.322 / 46.743 | No dedicated limit; 30 ms remote-character budget is context only |

### large after 50,100 operations: capture identities

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 7.597 [6.653–8.140] | 0.028 [0.022–0.054] | 270.359x | B cheaper by 7.569 (99.6%) | 8.627 / 0.080 | No dedicated limit; 30 ms remote-character budget is context only |

### large after 50,100 operations: resolve identity

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 0.075 [0.056–0.136] | 0.005 [0.005–0.007] | 14.113x | no difference beyond noise (T=0.500) | 0.160 / 0.007 | No dedicated limit; 30 ms remote-character budget is context only |

### large after 50,100 operations: remote burst 100

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 44.086 [36.838–48.337] | 44.241 [40.571–46.476] | 0.996x | no difference beyond noise (T=11.499) | 46.908 / 48.664 | No dedicated limit; 30 ms remote-character budget is context only |

### large after 50,100 operations: remote burst 100 individual transactions

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 4565.083 [3889.105–4896.728] | 4213.043 [3946.102–4588.288] | 1.084x | no difference beyond noise (T=1007.624) | 4822.561 / 4704.087 | No dedicated limit; 30 ms remote-character budget is context only |

### large after 50,100 operations: remote split

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 44.736 [42.340–49.052] | 41.542 [39.668–45.712] | 1.077x | no difference beyond noise (T=6.712) | 51.175 / 46.511 | 300 ms structural: A within, B within |

### large after 50,100 operations: remote join

| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |
| --- | --- | ---: | --- | --- | --- |
| 42.745 [38.797–45.823] | 40.039 [36.907–45.251] | 1.068x | no difference beyond noise (T=8.344) | 50.585 / 45.095 | 300 ms structural: A within, B within |

### Identity prediction

A-H7 / expected PERF failure under T02: the near-limit public capture pass is A 18.908 [17.584–24.694] ms and B 0.062 [0.052–0.112] ms; B cheaper by 18.845 (99.7%). A's capture alone exceeds the existing 8 ms input ceiling as a CPU component. This corroborates the repeated-scan risk for these calls, not a production latency result; indexing or batching could change it. B-H5's locality is supported by the counted segment work, with elapsed candidate differences assessed only by the frozen tolerance.

## Growth, load and heap

500 writing cycles on a fresh large import: 60 one-character typing inserts, 15 one-character deletes, 15 retyping inserts, one split, one join, one semantic join retirement, one removal, one restore, two status changes, three comment-body revisions per cycle. Every fifth cycle adds a second observed removal before undoing the first, leaving that beat soft-removed. Total 50,100 public operations: 37,500 inserts, 7,500 deletes, 500 splits, 500 joins, 500 retirements, 600 removals, 500 restores, 1,000 status writes and 1,500 comment revisions. This biases toward normal writing and revision, while exercising each retained mechanism repeatedly; it is a synthetic history, not a user telemetry claim. The original 300 beats are visited cyclically. No active UndoManager retains deleted text: both trace mechanisms work with default gc=true, soft removals keep live text and retirement flags keep join history. A future bounded undo stack adds memory not measured here.

Each checkpoint encodes state then starts a fresh --expose-gc child. Load time is applyUpdate only; first full projection is the child's first toDocument (cold path). Heap is measured after two forced collections, both after replica load and after the plain projection. Total Node heap includes loaded modules; the incremental heap subtracts the child's pre-load module heap. No source/writer/remote replica lives in that child. The encoding buffer remains live. The parent runs no tests during measurements.

### Checkpoint 0 operations

#### Encoded bytes

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 427695 [427695–427695] | 445329 [445329–445329] | 0.960x | A by 17634 bytes (exact) | fresh ≤3x plain; edited ≤10x active plain and ≤2,097,152 bytes |

#### Load ms

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 34.076 [28.054–40.267] | 29.433 [28.258–35.938] | 1.158x | no difference beyond noise (T=12.213) | join p50 3,000 ms / worst 5,000 ms; partial CPU only |

#### First full projection ms

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 163.676 [127.679–191.119] | 158.596 [146.044–191.270] | 1.032x | no difference beyond noise (T=63.440) | same join budget; single-task context 1,000 ms |

#### Heap after load MiB

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 16.745 [16.743–16.748] | 17.298 [17.281–17.298] | 0.968x | A cheaper by 0.553 (3.2%) | large session total ≤29.9 MiB; Node context only |

#### Heap with projection MiB

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 17.378 [17.374–17.382] | 17.918 [17.916–17.920] | 0.970x | A cheaper by 0.540 (3.0%) | large session total ≤29.9 MiB; Node context only |

#### Incremental heap MiB

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 6.534 [6.530–6.539] | 7.074 [7.074–7.079] | 0.924x | A cheaper by 0.540 (7.6%) | no independent increment limit |

| Candidate | Active file bytes | State / active file | Growth cap met in Node | Soft-removed beats | Removal records | Joins / retired ids | Status events |
| --- | ---: | ---: | --- | ---: | ---: | --- | ---: |
| A | 334208 | 1.280x | yes | 0 | 0 | 0 / 0 | 0 |
| B | 334208 | 1.332x | yes | 0 | 0 | 0 / 0 | 0 |

### Checkpoint 10020 operations

#### Encoded bytes

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 1220382 [1220382–1220382] | 1237973 [1237973–1237973] | 0.986x | A by 17591 bytes (exact) | fresh ≤3x plain; edited ≤10x active plain and ≤2,097,152 bytes |

#### Load ms

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 65.259 [50.872–73.912] | 57.204 [49.280–62.197] | 1.141x | no difference beyond noise (T=23.039) | join p50 3,000 ms / worst 5,000 ms; partial CPU only |

#### First full projection ms

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 198.059 [173.707–226.620] | 197.031 [172.366–230.025] | 1.005x | no difference beyond noise (T=57.659) | same join budget; single-task context 1,000 ms |

#### Heap after load MiB

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 19.734 [19.733–19.735] | 20.269 [20.268–20.271] | 0.974x | no difference beyond noise (T=0.608) | large session total ≤29.9 MiB; Node context only |

#### Heap with projection MiB

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 20.354 [20.353–20.356] | 20.894 [20.891–20.894] | 0.974x | no difference beyond noise (T=0.627) | large session total ≤29.9 MiB; Node context only |

#### Incremental heap MiB

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 9.510 [9.509–9.512] | 10.050 [10.047–10.058] | 0.946x | A cheaper by 0.539 (5.4%) | no independent increment limit |

| Candidate | Active file bytes | State / active file | Growth cap met in Node | Soft-removed beats | Removal records | Joins / retired ids | Status events |
| --- | ---: | ---: | --- | ---: | ---: | --- | ---: |
| A | 346533 | 3.522x | yes | 20 | 120 | 100 / 100 | 200 |
| B | 346533 | 3.572x | yes | 20 | 120 | 100 / 100 | 200 |

### Checkpoint 25050 operations

#### Encoded bytes

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 2398278 [2398278–2398278] | 2415709 [2415709–2415709] | 0.993x | A by 17431 bytes (exact) | fresh ≤3x plain; edited ≤10x active plain and ≤2,097,152 bytes |

#### Load ms

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 93.482 [84.949–105.921] | 95.344 [85.945–103.817] | 0.980x | no difference beyond noise (T=20.972) | join p50 3,000 ms / worst 5,000 ms; partial CPU only |

#### First full projection ms

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 250.022 [231.775–279.754] | 272.651 [234.006–291.083] | 0.917x | no difference beyond noise (T=57.077) | same join budget; single-task context 1,000 ms |

#### Heap after load MiB

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 24.068 [24.064–24.085] | 24.603 [24.602–24.604] | 0.978x | no difference beyond noise (T=0.738) | large session total ≤29.9 MiB; Node context only |

#### Heap with projection MiB

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 24.673 [24.668–24.685] | 25.211 [25.209–25.213] | 0.979x | no difference beyond noise (T=0.756) | large session total ≤29.9 MiB; Node context only |

#### Incremental heap MiB

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 13.830 [13.824–13.841] | 14.367 [14.365–14.369] | 0.963x | A cheaper by 0.538 (3.7%) | no independent increment limit |

| Candidate | Active file bytes | State / active file | Growth cap met in Node | Soft-removed beats | Removal records | Joins / retired ids | Status events |
| --- | ---: | ---: | --- | ---: | ---: | --- | ---: |
| A | 366523 | 6.543x | no | 50 | 300 | 250 / 250 | 500 |
| B | 366523 | 6.591x | no | 50 | 300 | 250 / 250 | 500 |

### Checkpoint 50100 operations

#### Encoded bytes

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 3338732 [3338732–3338732] | 3356090 [3356090–3356090] | 0.995x | A by 17358 bytes (exact) | fresh ≤3x plain; edited ≤10x active plain and ≤2,097,152 bytes |

#### Load ms

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 125.264 [104.247–135.757] | 118.191 [111.085–131.327] | 1.060x | no difference beyond noise (T=31.510) | join p50 3,000 ms / worst 5,000 ms; partial CPU only |

#### First full projection ms

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 366.789 [296.377–408.708] | 344.766 [324.347–382.960] | 1.064x | no difference beyond noise (T=112.331) | same join budget; single-task context 1,000 ms |

#### Heap after load MiB

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 28.951 [28.947–28.955] | 29.490 [29.477–29.571] | 0.982x | no difference beyond noise (T=0.885) | large session total ≤29.9 MiB; Node context only |

#### Heap with projection MiB

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 29.531 [29.526–29.533] | 30.064 [30.062–30.065] | 0.982x | no difference beyond noise (T=0.902) | large session total ≤29.9 MiB; Node context only |

#### Incremental heap MiB

| A median [range] | B median [range] | A/B | Cheaper | Budget / context |
| --- | --- | ---: | --- | --- |
| 18.687 [18.682–18.689] | 19.220 [19.218–19.228] | 0.972x | no difference beyond noise (T=0.577) | no independent increment limit |

| Candidate | Active file bytes | State / active file | Growth cap met in Node | Soft-removed beats | Removal records | Joins / retired ids | Status events |
| --- | ---: | ---: | --- | ---: | ---: | --- | ---: |
| A | 401522 | 8.315x | no | 100 | 600 | 500 / 500 | 1000 |
| B | 401522 | 8.358x | no | 100 | 600 | 500 / 500 | 1000 |

These growth conclusions concern this synthetic workload with undo retention omitted; they do not establish general growth behaviour.

## Predictions and practical limits

Y1 / A-H7 and B-H5: public relative-position identity reads are measured as a whole painted-beat pass and one live identity-to-current-position lookup. The tables test the predicted document-wide versus segment-local traversal cost; no private Yjs item/store access is used. A scan is not assumed cheaper or more expensive. The 0.5 ms tolerance still applies even to microsecond operations. A-H2 / Y8 / Y9: soft removals preserve live text with gc=true. Checkpoint growth shows whether the 10x and 2 MiB limits survive this history; removal records and retired joins grow monotonically under both mechanisms, rather than being reclaimed by GC. Literal restore/identity and checkpoint-count tests fail if those mechanisms are removed. This bounded run cannot prove indefinitely bounded growth; there is no compactor in either implementation.

Node CPU being within a numeric cap does not establish any message-to-frame or input budget. Paint, layout, focus/caret restoration, DOM rendering, the app's own derivations/publication, real network, server receipts, persistence, blobs and a real editor buffer are absent. The structural view omits gallery folding and full recovery/mark derivation. Status and comment measurements use merged state formats, but this is not a new concurrency oracle. Reconnect and receipt budgets are unmeasured. No standalone A/B was run because shipping code is unchanged. The browser check, if retained in browser-results.json, adds the same JavaScript workload in Edge only; it still omits all those application and rendering costs.

## Reproduce

Replace the temp and shared lane-tools placeholders with local directories.

```powershell
$env:TEMP = '<temp>/splitpage-lanes/s1a-perf'
$env:TMP = $env:TEMP
& '<lane-tools>/with-lock.ps1' -Lock perf,smoke -Owner s1a-perf -Command 'node --expose-gc prototypes/collab/src/perf/run.ts --write'
node prototypes/collab/src/perf/run.ts --check
node prototypes/collab/src/perf/report.ts --check
node prototypes/collab/src/perf/privacy.ts --transcript '<temp>/mutation.log' '<temp>/mutation-redacted.log'
```
