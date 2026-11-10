# Stage 1a reader-order evidence — #1376

PR #1421 retains evidence commit `8efcff798f7d92ab890207d414ec2f416b69f695` and subsequent fixes at 2085cfc4, 82e15f19 and this final round. No Stage 0 row changes; no timing, Edge or browser run.

## Histories of valid commands

No reader or cache difference was found in the lane's **96 generated histories / 1,152 command attempts / 384 checkpoints**, with four retained seeds in both layouts. The structure/marks harness also checks its existing trace checkpoints, listed delivery variants, duplicate deliveries and encoded late joiners. Independent literal product oracles remain.

The coordinator reports two independent runs: **160 three-writer histories / 640 checkpoints**, and **96 histories / 6,144 command attempts / 1,632 checkpoints**, with no reader/cache disagreement for valid commands. These are review results, not runs performed by this lane. Together the three generated sets cover **352 histories / 2,656 checkpoints**.

## Records of the wrong shape

The property uses seeds 1376, 1413, 0x5eed0001 and 0x5eed0002. It compares fresh and observing document/block/status caches on the writer, complete writer-versus-encoded-load readings, and serialized fresh/observing documents after the generated write and deletion checkpoints.

| Property | Covered scope | Checkpoint executions |
| --- | --- | ---: |
| Wrong-shape values | A: 27 target fields; B: 30 including segment head/text and order entries; 31 factories plus 96 sampled combinations per seed/layout | 15,672 |
| Identity keys | 17 identity collections, B segments where applicable; nine key arrangements, write/delete/recreate | 891 |
| Later fields from a second writer | Covered identity collections; updatedAt/aFuture/zFuture, with object replacements for scalar flags | 33 |

Wrong-shape target maps are removalRecords, visuals, replies, comments, gallery, beats, meta and beat joins; B additionally consumes the segments/order cases. Identity collections also include people/tags/shots, headings, gallery links, shot props, joins/retirements and status/retirements.

Factories include undefined/null, numbers/NaN/infinity, booleans, BigInt, short/long/lone-surrogate strings, nested/sparse arrays and objects, odd/null prototypes and null coercion methods, typed arrays/ArrayBuffer, symbols/functions, shared map/doc/text, valid record shapes, repeated heads and missing-metadata heads. These counts describe those maps and factories only.

Yjs refuses several map writes: null-prototype objects, Uint16Array, ArrayBuffer, symbols and functions. Order insertion additionally refuses undefined, BigInt and array samples containing unsupported elements. Refusals are counted by kind in diagnostics. Accepted Uint8Array/BigInt payloads are absent from the JSON-record view. The null-text-embed refusal remains a literal test.

## Final-round mechanisms and audit

**Output:** validated records use declared literal schema order, followed by UTF-16-sorted forward-compatible fields. Opaque dictionaries use sorted keys. Literal comment/reply key lists cover resolution/updatedAt added by another writer and future-field ordering. Marks, gallery diagnostics and caret dictionaries use declared fields or sorted keys.

**22 object-spread sites in ten reader files** became explicit fields or declared-schema builders. Two stored-record Object.assign merges became declared-field merges. The audited files are marks/projection.ts, perf/blocks.ts, perf/incremental.ts, proj/document.ts, proj/richtext.ts, proj/value.ts, readers/records.ts, readers/structure.ts, readers/spans.ts and structure-reader.ts. Remaining entries/fromEntries uses validate dictionaries, forward sorted unknown fields, inspect anchors, or construct sorted identity dictionaries; input/HTML writers are not output-record assembly.

Public document objects have literal field order. Explicit file-order metadata is retained separately for the existing byte-for-byte file contract, including nested unknown JSON. File evidence compares that serialization boundary; the strict convergence checker compares public objects directly without that conversion. Reused cached rows copy the file metadata too. App-reference bytes, semantic expectations and file-difference baselines remain checked.

**Assembly:** three former paths—fresh document blocks, the observing block index and structural character spans—call assembleReaderBlocks. A segment starts without an active block. A repeated head is ignored, so its prefix text is ignored until a new valid boundary appears; an inline repeated boundary leaves the current block active. Invalid/missing heads use the same prefix rule. A valid head naming a beat without metadata creates that beat with default metadata. The cache records blocked boundaries so an order change can invalidate a previously suppressed head.

The literals pin R1 `a` after R2's head becomes R1, and R1 `a` plus `missing` `b` for a valid unregistered head. [The final review histories](histories/T21-reader-final-round.md) retain the original observations and literal current results.

**Comparison:** array-index descriptors are checked before values are read. An accessor index versus an ordinary item is rejected through check and checkKnown. Missing-property, holes/length, extra own properties, numeric non-index properties, key order and unsupported-kind controls remain. Reader writes are prohibited by the harness.

## Ordering audit retained from the reader fixes

The following names the comparator used at the current head. Source tests reject runtime localeCompare/Intl.Collator in the prototype reader sources.

| Reader | File:line | Ordering or selection |
| --- | --- | --- |
| Recovery authors, edited and split information | readers/structure.ts:19; readers/removals.ts:30 | Applicable validated records; names/split candidates use compareCodeUnits; edited identities follow character order. |
| Structural visual concatenation | structure-reader.ts:16 | Converged beat position, compareCodeUnits(rank), compareCodeUnits(componentId). ComponentId is artifact 8's identity tie-break. |
| Earlier structural reader | reader.ts:13 | Shared recovery/group implementation. |
| Join selection and graph | readers/records.ts; readers/joins.ts:3 | Smallest active join key by compareCodeUnits as artifact 8 specifies; roots/members follow converged beat order. Cycle links are absent. |
| Tag acceptance/nesting | marks/projection.ts:32 | Numeric extent/position, then compareCodeUnits(occurrence key). |
| Link selection/propagation | marks/projection.ts:45; proj/richtext.ts:134 | compareCodeUnits in structural marks; parameterless Array.sort (UTF-16 code units) in export; character-order propagation. |
| Comments/replies and marked anchors | marks/projection.ts:69 | Finite creation time then compareCodeUnits(shared key); anchors follow row/character order. |
| Resolve/reopen | proj/document.ts | Atomic converged Y.Map resolution value, without choosing by iteration. |
| Registries and shot props | proj/value.ts:44; proj/document.ts:203 | Exact identity; compareCodeUnits(rank), then compareCodeUnits(key). |
| Gallery picture/name/poster/link | structure-reader.ts:31; proj/document.ts:213 | Beat position/rank/key or rank/key, using compareCodeUnits; stored link arrays retain sequence order. |
| Repeated boundaries | readers/blocks.ts:29 | First accepted occurrence in converged Y.Array/Y.Text sequence, shared by the three assembly consumers. |
| Full-document visual/anchor order | proj/document.ts | compareCodeUnits(rank), then component key; anchors follow assembled block/character order. |
| Carets, output dictionaries and forwarded unknown fields | readers/structure.ts:109; readers/output.ts:28 | compareCodeUnits(key); known record fields use declared schema order. |
| Benchmark target selector | perf/measure.ts:30 | Replica-local last-key command target, outside shared-content reader claims; no timing uses it in this round. |

Validators cover beat metadata, joins/removals, visuals/gallery, comments/replies, boundaries/segments, marks/atoms, ranks/keys and caret positions. Writer-side capture/commands, benchmark selectors/instrumentation and native Yjs text/identity operations still read raw native state. Historical test readers deliberately retain unsafe reads as negative controls. Opaque file extras pass the wire/JSON reader, without reinterpretation as status/join/removal events. The finite properties above, rather than the validator list alone, establish the reported malformed-record coverage.
## Assumed, for the product review

These are coordinator assumptions, not maintainer decisions. Adding a removal must not remove recovery information. In [recovery history 1](histories/T21-recovery-map-order.md), edited is `["a1"]` when one remover had not observed x; the alternative was `[]` after combining observed sets. In history 2, splitBy Alice survives a direct removal because an inherited removal also applies; the alternative was omitting it. Distinct active remover names use UTF-16 order, joined as `Alice, Bob`. Several splitter candidates in a joined group are deduplicated/ordered the same way. Joined sources stay with removed targets and follow moved targets.

## Evidence

The source audit declares **43 changed/new production sources**, original/current hashes, dependency/count digests and separate current browser-bundle hashes. Historical observations, timing files, samples and original archives are not regenerated. Retained timing rows are labelled as predating these changes. Affected incremental/structure/component/withIdentity and earlier reader/export/load/heap paths still need retiming; count-only observations establish no elapsed cost.

Final validation: **1,808/1,808 prototype tests pass, zero skipped**, from one full-suite run. The strict harness records **1,708 positive checkpoint inspections / 45,080 complete projections / 35,854 comparisons** (executions, including repeated inspections and canonical probes). The separate wire properties record **16,596 reload checkpoints** (15,672 values + 891 keys + 33 later-field cases). No further difference appeared in those cases. The accessor control is the eighth strict-comparison control. The mark mutation audit retains **116 baseline passes / 34 detected defects / 3 withdrawn claims**. Seven historical bundles reproduce exactly; current hashes are separate.

Lint, typecheck, check:comments and check:deps pass. Privacy and git diff --check pass, including the two requested trailing-blank-line removals. Count-only regeneration leaves lifetime work counters, structural-count data and sensitivity rows unchanged from **82e15f19**. The PR retains **321** numeric work-counter deltas from 8efcff79 (the earlier 293 plus 28 metadata-lookup reductions); exact paths are in src/readers/count-changes.json. Current source metadata is refreshed. Sensitivity crossings remain 36/31/34/26/36. The four-file physical-line subtotal is **305** (delta 62, blocks 74, incremental 115, operations 54), excluding shared reader helpers. Retained measured rows and samples are unchanged.

## Not shown

Agreement for every possible stored record is not proven. Three review rounds each found a further case. The finite generators and literal controls establish their stated coverage; they do not certify arbitrary stored-record semantics, complete schema validation, arbitrary serializer cloning, or production cost.

The Stage 2 production reader inherits these requirements:

- Output is built in literal field order from validated records; carried-through unknown fields use UTF-16 order.
- Fresh and patched results come from one assembly function and are compared at each checkpoint.

Stage 2 also retains the status partial-ancestry question, conflict-notice pairwise cost, typed-root initialization, app integration of semantic removal undo and unmeasured runtime cost. The knownReaderFailures catalog is empty for the retained cases; it is not a universal claim.
