# Stage 1a: full reader convergence check — #1376

The reader fixes are further commits after **8efcff798f7d92ab890207d414ec2f416b69f695**, preserved unchanged. **`knownReaderFailures` is empty.** All seven original histories now satisfy their literal results, complete-output convergence and no-throw checks; the archived reader/comparator still reproduces each original failure. No Stage 0 row changed.

## Assumed, for the product review

These are the coordinator's assumptions, not maintainer decisions. Adding an active removal must never take information away from recovery.

- **Edited identities:** list a character if at least one applicable active removal did not observe it. In [history 1](histories/T21-recovery-map-order.md), Alice saw `ax` and Bob saw `a`; every replica now lists `["a1"]`. The alternative was listing only characters observed by no remover, which would hide x after Alice's removal arrived.
- **Split attribution:** show the beat's stored splitter if any applicable removal reaches it through observed identities rather than naming it. A direct removal does not erase that evidence. In [history 2](histories/T21-recovery-map-order.md), every replica retains `splitBy: "Alice"`. The alternative was hiding it whenever a direct removal also applied. Each beat stores one string; if a joined recovery group yields several candidate strings, distinct candidates are ordered by UTF-16 code units and joined with `, `.
- **Removal attribution:** collect all distinct active removers that apply to the row, order their names by UTF-16 code units and join with `, `, yielding `Alice, Bob` in the fixture.

## Repaired readers

Removal readers combine every applicable validated record. `removeWithUndo`/`undoRemoval` demonstrate either writer undoing an identical concurrent removal; cancellation remains visible to late deliveries, consumes only that writer's undo step and leaves earlier edits intact. Native per-writer undo alone is not the coalescing command; binding this command into the app remains Stage 2 work. `edited` is calculated from all observations, not a first record. Split candidates and author names are collected without using removal ids or map order.

Joined beats are grouped before rendering. A source follows its moved target and stays inside its removed target's recovery group, including when the remover observed all group members. Members retain their original identities and one projected glue. A removed source whose target chain is still active becomes a separate recovery root; a source whose target chain is removed stays with that chain. Missing targets are absent links. As a defensive rule for malformed cycles, all links on a cycle are absent; acyclic children may still join the resulting roots. Both graph passes are iterative.

Visual components follow converged beat order, then rank, then componentId. ComponentId remains artifact 8's component identity tie-break. Replies sort by validated creation time then their distinct shared keys; creation times are normalized to finite numeric values, including ISO timestamps, with missing/invalid scalar times treated as zero. Every string tie-break below is total and machine-independent.

| Reader / prior audit row | Current file:line | Comparator / replica-independence |
| --- | --- | --- |
| Recovery authors and edited/split information | `readers/structure.ts:31`, `readers/removals.ts:30` | All applicable records; distinct names/candidates use `compareCodeUnits`. Edited identities follow character order. |
| Structural visual concatenation | `structure-reader.ts:15` | Beat position, `compareCodeUnits(rank)`, `compareCodeUnits(componentId)`. |
| Earlier removal reader | `reader.ts:13` | Uses the same validated recovery/group implementation. |
| Join selection and graph order | `readers/records.ts:180`, `readers/joins.ts:3` | Smallest live join key by `compareCodeUnits`, as artifact 8 specifies; roots/siblings follow converged beat order. No first map entry. |
| Tag acceptance/nesting | `marks/projection.ts:30`, `marks/projection.ts:45` | Numeric extent/position, then `compareCodeUnits(occurrence key)`. |
| Link selection and propagation | `marks/projection.ts:43`, `marks/projection.ts:55`, `proj/richtext.ts:132` | `compareCodeUnits` in the structural reader; native parameterless `Array.sort()` (UTF-16 code units) in the document exporter. Propagation follows character order. |
| Comments/replies and first marked anchor | `marks/projection.ts:72`, `marks/projection.ts:76` | Normalized finite timestamp then shared key using `compareCodeUnits`; comment keys also use it. Anchors follow converged row/character order. |
| Resolve/reopen | `proj/document.ts:163`, `proj/document.ts:248` | Atomic Y.Map resolution value; native converged conflict result, no iteration-based selection. |
| Registries and shot props | `marks/commands.ts:50`, `proj/document.ts:217`, `proj/value.ts:50` | Exact registry identity; ranked records use `compareCodeUnits(rank)` then key. Same-key fields use Yjs's converged value. |
| Gallery first picture/name/poster/link | `structure-reader.ts:30`, `proj/document.ts:228` | Structural beat position/rank/key; full-document slots/links rank/key. All string comparisons use `compareCodeUnits`; stored link arrays preserve agreed sequence order. |
| Repeated segment/boundary | `readers/spans.ts:18`, `proj/document.ts:185`, `perf/blocks.ts:32` | First occurrence in the converged Y.Array/Y.Text sequence. |
| Full-document visual/anchor order | `proj/document.ts:276` | `compareCodeUnits(rank)` then component key; first anchors follow agreed block/character order. |
| Benchmark target selector | `perf/measure.ts:41` | Still a replica-local command selector using the last map key, not shared-content resolution. It remains outside the convergence claim; no new timing uses it. |

No runtime `localeCompare` or `Intl.Collator` remains under `src`; the source test scans TypeScript syntax, while historical archived strings retain the old code. Native parameterless sorts used for status parents/notices are also UTF-16 code-unit sorts. No status value or remover is selected by event-id spelling.

## Raw values and reload checks

The record validators cover beat metadata, joins, removals, visual components, gallery items/slots, comments, replies, structural boundaries, segments, marks, content atoms, ranks/keys and caret positions. They return validated fields, or absence for invalid records; supported scalar/JSON fields are normalized with the pinned wire codec. Both structural readers, the perf structural reader, the lifetime status index, document export, the block cache and the incremental projector consume those results. Invalid roots/segments/atoms no longer throw; invalid atoms retain their source length inside the cache so a following edit still aligns correctly. Missing caret destinations are omitted or use a surviving beat, without writing shared state.

The four retained seeds in both layouts enumerate malformed/valid field values before sampling additional combinations: null/undefined, numbers and infinities, objects/arrays with holes, odd/null prototypes, null coercion methods, binary/non-binary typed arrays, symbols/functions, shared maps/docs/text and long strings. Each accepted/refused write and deletion compares complete writer results with encoded reload through structural/earlier/mark/status/perf/export readers, fresh and observing status indexes, and fresh/observing incremental projections. These produce **14,064 reload checkpoints**, with no reader exception or logged observer error. Yjs storage refusals (null-prototype objects, Uint16Array, ArrayBuffer, symbols and functions) are counted separately. A null text embed is also rejected by Yjs before insertion, asserted in its literal test.

Additional literal controls cover self/reachable join cycles, missing targets, malformed atoms followed by another edit, invalid segment/head/order entries, and empty-string status-target cache invalidation. The generated valid-command test retains all **96 histories / 1,152 command attempts / 384 convergence checkpoints**, now requiring zero known failures. Existing product oracles and every negative control remain.

The reload property found one further in-scope history: [lone-surrogate text](histories/T21-reader-wire-text.md). Writer and late joiner now both project literal U+FFFD; the old structural reader still demonstrates the split. Narration/visual delta strings and exported titles use wire-normalized strings without changing stored Y.Text. Valid export round trips and unchanged-row identity tests remain intact.

Remaining raw reads are writer-side command/capture code, benchmark target selection/instrumentation, and opaque native Yjs text/identity operations. Lossless file extras are parsed JSON and passed through the generic record reader; they are not reinterpreted as status/join/removal events. Historical readers under `test/reader-order/` intentionally retain unsafe reads as controls. There is no unresolved row in the active reader-failure catalog. Stage 2 still inherits the previously recorded status partial-ancestry question, conflict-notice pairwise cost, typed-root initialization requirement, app integration and unmeasured runtime cost.

## Evidence for these commits

No timing, Edge or browser run was made. `readers/source-changes.json` declares **34 changed/new source files**, their exact before/after hashes, original source text, the evidence-commit base, dependency/count digests and all seven current bundle hashes. The original browser bundles rebuild byte-for-byte; old observations, original source archives, timing files and samples remain unchanged. Source audits reject missing/duplicate declarations and damaged before/after chains.

Retiming is needed for lifetime **incremental, structure, component and withIdentity**, both modes at all seven states; earlier A/B local/remote character, status, comment, burst, split and join rows, plus document projection/export, load and heap evidence. Identity capture/resolve and lifetime apply excluding incremental do not execute the changed reader/export work inside their measured intervals. Retained rows are labeled accordingly. The four-file source-size subtotal changes from 361 to 347 lines relative to #1413 (blocks 111→115, incremental 119→124, operations 74→51); it excludes the newly shared reader helpers, which are pinned separately. The preservation test accounts for those seven source-size table rows while preserving every measured row/sample and the original baseline.

Count-only regeneration completed against the pinned current source. Relative to 8efcff79, **293 numeric work counters** move, all in `work.incremental` or `work.structure`, and all are map gets or record visits. [count-changes.json](src/readers/count-changes.json) lists every exact path and before/after value. For example, the first two-writer checkpoint's legacy incremental tag gets go 525→496, visual gets 294→180 and gallery gets 385→126; structural status-event visits go 2,040→2,100 because removed beats are also resolved. Validation/grouping adds some visits while collecting a rank once avoids repeated comparator reads. These are counts, not speed measurements.

Structural-count data and all sensitivity rows are byte-for-byte equivalent as parsed values. Encoded sizes, encoded-state hashes, operation/record totals, cap crossings and every other non-work observation are unchanged. Sensitivity crossings remain 36/31/34/26/36. Only current source metadata, the declared work counters and generated report text change; no retained timing/browser observation is rewritten.

The largest synthetic legacy structural scan literal changes **700,000→800,000 status-event visits**, because all 800 rows are resolved before grouping rather than skipping 100 removed rows; the indexed structural scan remains literal **zero**. Its evidence assertion is updated to that exact count, with the scan-rejection negative control intact.

Final validation: Node 24.22.1, **1,774/1,774 prototype tests pass, zero skipped**; the focused reader/marks/structure/export/incremental set passes **667/667**. All four root gates pass (lint, typecheck, check:comments, check:deps). The mark mutation audit retains 116 baseline passes, 34 detected defects and three previously withdrawn claims; the general canonical-key probe increases detection coverage for reply-order removal. Seven historical bundles reproduce exactly, their current hashes are pinned separately, and privacy/whitespace checks pass. No app code or Stage 0 row changes; no timing or browser run.

## Initial check-only evidence at 8efcff79

The following is the original check-only report, retained as historical evidence; its failing-reader table does not describe the repaired head.

First revision: the general check and literal known-failure table, on merged main after #1413. This revision changes tests and result text only. Reader fixes follow by shrinking the table; green tests below mean the check reproduces and classifies the declared failures, not that these readers converge.

`test/reader-convergence.ts` captures actual authored Yjs updates, replays every delivery order a history's row lists, and creates an encoded-state late joiner for each replay. At every existing structure/marks checkpoint it compares the complete public reader output (all fields, character identities, marks, carets, recovery, records and notices), prohibits reader writes and records every exception. Shared Yjs registry values are compared through their public JSON representation, excluding local document/observer internals. State vectors establish complete delivery; encoded bytes can legitimately differ when an UndoManager retains otherwise collected deleted content. The new minimized histories, which have no such retention, additionally require byte-identical encoded state.

The strict `check` fails on every observed difference or throw. `checkKnown` returns failures and accepts only the literal field/exception catalog in `test/reader-order/known-failures.ts`; an unlisted field or exception fails the gate. Existing independent product oracles remain unchanged and still run. Negative controls reject lost rows, a new status difference, an unknown exception, and the old reply comparator in an ordinary history with no replies. Every checkpoint gets a separate forward/reverse concurrent canonical-equivalent reply probe (`é`, `é`) and its encoded late joiner, so this class is checked without a dedicated matrix.

## Known failing readers, reproduced from real commands

| Case / reader | Literal expected result or open choice | Observed failure | State |
| --- | --- | --- | --- |
| Removal attribution, `structure-reader.ts:111` | One removal, attribution `Alice, Bob` in stable order | Alice/Bob/Bob across writer/writer/late join | Failing |
| Visual concatenation, `structure-reader.ts:133` | Beat order, then rank, then component identity | `X<br>Y` / `Y<br>X` / `Y<br>X` | Failing |
| Replies, `marks/projection.ts:79` (also exposed by readStructure) | Equal-time ids ordered by UTF-16 code units: `["é","é"]` | `["é","é"]` on Alice, reversed on Bob/late join | Failing |
| Recovery edited identities, `structure-reader.ts:106` | Open: observed-set union gives `[]`; “after any removal” gives `["a1"]` | `[]` / `["a1"]` / `["a1"]` | Failing; policy options retained |
| Recovery split attribution, same reader | Open: omit after direct removal, or retain Alice for the inherited removal | absent / Alice / Alice | Failing; policy options retained |
| Join target removed, readStructure and readReplica | Joined source stays inside target's removed group | Both readers throw on every replica | Failing |
| Join target moved, B layout, same readers | Joined source follows target: R1 `ab cd`, R3 `ef` | Both readers throw on every replica | Failing |

`readerHistoryRows` is literal data, including required projection summaries authored before running and exact old observations. The tests require each named failure class to be detected, including exceptions even when all replicas throw. Thirteen layout/history rows run six delivery orders with live and encoded-state replicas. Existing records [T21-other-readers-map-order.md](histories/T21-other-readers-map-order.md) and [T21-reply-collation-order.md](histories/T21-reply-collation-order.md) remain unchanged. New records: [recovery](histories/T21-recovery-map-order.md), [join targets](histories/T21-join-target-unavailable.md).

Four retained seeds (1376, 1413, 1592590337, 1592590338), both layouts and swapped clients generate **96 histories, 1,152 real command attempts and 384 convergence checkpoints**, each replayed through all six orders and encoded late joiners. Commands cover insertion, split, removal, restoration, join and supported B moves. All exceptions/differences belong to the table: join-target exceptions, removal attribution and reply collation. No unlisted reader disagreement was found. This is bounded evidence, not a proof over all command histories.

## Evidence and next fixes

No production or timed source changes in this first revision; no counts, timing audits, pinned browser evidence or timing observations need rewriting. No timing, Edge, browser or development server ran. The #1413 status validator and its write/encode/reload properties are inherited unchanged. Other raw-value readers remain as on main; there are no newly converted production readers yet.

The follow-up fixes will use all validated removal records, visual order from converged beat order/rank/component identity, and UTF-16 code-unit comparison in every shared-state ordering. ComponentId remains artifact 8's final visual tie-break because it identifies a component; it does not resolve a status conflict or choose a remover. Every “sorted” row of the inherited audit will name its comparator. Changed timed sources, counts and retained rows will be declared then, without rewriting historical evidence.

Validation on Node 24.22.1: full prototype **1,709/1,709 tests pass, zero skipped**; the focused structure/marks/general set passes **217/217**. The first revision adds 23 tests, including the 13 literal layout/history rows, two checker controls and eight seeded layout runs. Root lint, typecheck, check:comments and check:deps pass. Existing product oracles, defect histories, mutation evidence, browser bundles, timings and count files are unchanged.
