# Stage 2: storage and update admission choices

## Decision page

The present costs come from two different choices: storing a rich birth record for every insertion, and copying the entire shared state before accepting every remote update. A first character adds **320 bytes**, of which **310 bytes are the birth record**. The two anchor fields take 145 bytes. Deleting that character leaves 328 bytes behind. These are exact small-state differences, rather than averages from the larger workload.

After this workload, one new **local** key adds **5223–5224 bytes**: its birth names 100 observed mark additions. The earlier 325-byte rate comes from a fresh peer's causal stream and does not bound typing by an edited local writer.

The [previous record](stage-2-growth-admission.md) measured 7.9–9.1 MB after editing, against the 2 MiB ceiling. Its admission p50 was 3.5 ms fresh short/long, 27.5 ms fresh large, and 196–237 ms edited. Those timings are quoted from #1566, on another machine and an earlier source snapshot. The alternatives below are a new experiment; their comparison with #1566 is directional, not a paired speed ratio.

| Storage choice | Measured result | What changes / gives up |
| --- | --- | --- |
| Keep information; shorten its encoding | 226.57 B/key with binary anchors; 155.57 with tuple fields. Tuple births plus native record references still leave 4.24–5.44 MiB edited. | Medium to large: about 8–12 adapter files (`anchors`, `mark-record`, `mark-store`, provenance/history and identity readers) plus format migration/tests. No intended semantic loss; old readers cannot read it. |
| Record insertion runs | 33,008 / 4,198 B for 1,000 characters in runs of 10 / 100. | Larger: `buffered-field.ts`, `buffer-operations.ts`, `text-executor.ts`, `undo-executor.ts`, wiring and tests. Gives up immediate per-key publication unless a new growing-run format is built. |
| Start a fresh document epoch | Fresh sizes: 4,189 / 73,161 / 690,502 B. | Large: `document.ts`, `hydrate.ts`, shared-session entry/switch and future transport protocol. Invalidates old anchors/undo; offline work needs recovery or an explicit rejection policy. |

| Admission choice | Measured result | What changes / gives up |
| --- | --- | --- |
| Standing shadow | p50 0.03–0.06 ms; worst individual 56.44 ms. Extra copy 0.06–30.60 MiB; refused-update rebuild p50 1.98–162.64 ms. | Medium: `document.ts`, `state.ts`, ingress/buffer lifecycle and tests. Keeps native preflight; adds memory and refusal rebuilds. Held-update ordering still needs design. |
| One trial per queued burst | 100 / 1,000 drains: 3.13–172.11 / 23.34–190.21 ms. | Medium: document/ingress drain and buffer tests. Rejects a whole burst; retains a full copy for isolated updates. Long synchronous drains can still block typing. |

I would first use binary anchors and compact record fields, keeping the information used for concurrent formatting and undo. I would use a standing shadow for admission, retaining isolated integration before live mutation. Both require implementation and adversarial tests before adoption. Grouping insertion runs is attractive only if the owner accepts delayed publication or a more involved rewrite of how runs are recorded. A coordinated document epoch is my preferred way to bound long histories, provided the owner accepts its offline-edit and undo policy. The measured compact encodings still exceed the storage ceiling.

The shadow trades CPU for a second copy in memory, and a refused update still requires a full rebuild. Its 56.44 ms outlier fails the 50 ms limit on fresh long; this is not an all-pass result. Burst trials help an existing queue but leave isolated updates with the present copying cost. Decode-only and the additional reference check are fast controls, not safe replacements. **End-to-end input latency remains unmeasured.**

## Scope and reproduction

This change edits only measurement scripts, their focused tests, and this record. No product source, dependency, baseline, or product assertion changes. The implementation stays under `tests/collab/measure/`; the launcher stays at `tools/measure-shared-admission.mjs`. No new file is placed under `tests/adapters/collab/`, whose formatting-monitor rule still applies to the existing measurement tests.

Node is pinned to 24.22.1. The new measurements were completed on 2026-11-14 on an ARM64 computer shared with other work. Each benchmark or test execution was preceded by a separate available-memory check of at least 3,000 MiB. Only one heavy preparation/timing command ran at a time. Timing results are noisy: each cell reports the median and full minimum–maximum of five rounds, with no discarded outliers. Each round uses 500 sequential individual updates, nearest-rank p50/p95/max, then drains of 100 and 1,000 updates. These are the same fixtures, block-of-100 workload, causal sender stream and transaction paths as the earlier record. Initialization is excluded from admission timing.

All three fresh and all three edited states were prepared here, once, using product source `9f7e9ab6017557162deafd0f051167bbe416e1f2` (adapter tree `280bf0cb67334b80a04d2cd7aa2f34006356b486`). The entire projected document equals its entry value for each edited checkpoint. The previous record's timing values are quoted only; no binary checkpoint was transferred.

| Fixture | Fresh bytes | Edited bytes here | Edited plain bytes | 100 undo/redo pairs here |
| --- | --- | --- | --- | --- |
| short | 4,189 | 9,159,062 | 1,734 | 524,974 |
| long | 73,161 | 7,922,046 | 38,432 | 525,074 |
| large | 690,502 | 8,577,933 | 334,208 | 525,074 |

The preparation checkpoint contains binary states and is local only. It checks source/dependency/fixture trees, Node and architecture when reused. Results checkpoints also fingerprint the admission implementation and common measurement module. The output data beside this document contain no binary document checkpoint or local environment paths.

PowerShell reproduction, after `npm ci` (repeat the memory check before every command and wait if its value is below 3,000):

```powershell
(Get-Counter '\Memory\Available MBytes').CounterSamples[0].CookedValue
node tools/measure-shared-admission.mjs --prepare-options "$env:TEMP/splitpage-options-checkpoint.json"
(Get-Counter '\Memory\Available MBytes').CounterSamples[0].CookedValue
node tools/measure-shared-admission.mjs --bytes "$env:TEMP/splitpage-options-bytes.json" "$env:TEMP/splitpage-options-checkpoint.json"
(Get-Counter '\Memory\Available MBytes').CounterSamples[0].CookedValue
node tools/measure-shared-admission.mjs --options "$env:TEMP/splitpage-options-checkpoint.json" "$env:TEMP/splitpage-options-results.json"
```

The preparation reuses the committed workload's `growth` function without replacing commands with plain-object writes. It saves each completed fixture once and resumes from there. The options command saves each completed round and resumes; choose a new result filename after changing its fingerprinted code. The original command without a mode retains its original behavior, including its expensive current-admission drains. Those drains were not repeated here.

## Where one character's bytes go

Every probe starts from the real hydrated short fixture, deterministic client 2166572391 and operation `m1`. Each action uses the real executor and, where requested, its real undo reversal. Full states are encoded before and after. Native structs are decoded, listed with their IDs and parents in the byte data, and individually re-encoded with the V1 encoder. Grouping those actual struct lengths plus the envelope/delete-set difference exactly reconciles to the full encoded-state delta. This is stored-state accounting, not wire-update length or the length of JSON printed for inspection.

| First typed character | Stored bytes | Writer / meaning |
| --- | ---: | --- |
| Native `ContentString` item | 10 | `text-edit.ts:editCollabText`: one literal byte, one string-length byte, one info byte, seven origin-ID bytes |
| Birth item framing and map key | 50 | `mark-store.ts:storeRecord`; includes the escaped `[writer, operation]` map key, parent ID and item/value framing |
| Object envelope | 2 | Native any-value object tag/count |
| `type` | 12 | `birth` discriminator and field name |
| `operation` | 33 | `text-executor.ts:preparePhysicalTextInsertion`: JSON `text-birth` operation identity |
| `writer` | 16 | Numeric client identity and field name; not the display author |
| `start` | 73 | `mark-store.ts:anchoredRecord` and `anchors.ts:encodeCollabTextAnchor`: JSON containing segment and relative-position byte array |
| `end` | 72 | Same, at the opposite affinity |
| `observed` | 11 | Empty array here; names prior mark additions when present |
| `born` | 41 | Object with native client, clock and length |
| **Total** | **320** | **10 native text + 310 birth entry** |

Field costs include field names and value encoding, measured by removing one field from the encoded any-value. They add to 258 bytes plus the two-byte object envelope. The birth framing is separate. The character's own clock comes from the enclosing client block; there is no extra per-character ID field hidden outside this reconciliation. The numeric client appears again in the key, relative anchors, `writer`, and `born`. No `by` display-author string, stamp, general operation log or local undo-description object is stored for this unmarked character. `executeSharedCommand` captures the undo description in local memory; `executeSharedOperations` produces the same shared write.

| Action | Net stored bytes | Exact partition |
| --- | --- | --- |
| One typed character | 320 | text: 10; markRecords:birth: 310 |
| Type then delete | 328 | envelope + delete set: 9; tombstones: 9; markRecords:birth: 310 |
| One undo/redo pair after typing | 362 | envelope + delete set: 9; markRecords:birth: 344; tombstones: 9 |
| One split | 477 | text: 8; segments/b:r1/text: 58; beats/structure_2166572391_006d0031_beat_0: 46; beats/structure_2166572391_006d0031_beat_0/id: 51; beats/structure_2166572391_006d0031_beat_0/segment: 24; beats/structure_2166572391_006d0031_beat_0/splitBy: 31; beats/structure_2166572391_006d0031_beat_0/visual: 57; beats/structure_2166572391_006d0031_beat_0/joins: 16; beats/structure_2166572391_006d0031_beat_0/removals: 19; visuals/structure_2166572391_006d0031_visual_0: 50; visuals/structure_2166572391_006d0031_visual_0/beat: 53; visuals/structure_2166572391_006d0031_visual_0/rank: 27; visuals/structure_2166572391_006d0031_visual_0/text: 15; visuals/structure_2166572391_006d0031_visual_0/markRecords: 22 |
| Undo that split (increment) | 416 | meta/splitRetired:structure_2166572391_006d0031_beat_0: 416 |
| Bold two characters | 278 | markRecords:add: 278 |
| Undo that bold range (increment) | 331 | markRecords:remove: 310; markRecords:ContentAny: 21 |
| One key with a 100-character author | 320 | text: 10; markRecords:birth: 310 |

The simple correction is **type then delete**, with no undo. Its birth record remains, the text item becomes a nine-byte `ContentDeleted` tombstone, and the delete set adds nine bytes. The earlier record's roughly 730 bytes per corrected character also includes undoing and redoing the deletion in each 100-character block; these are different operations. The first undo/redo pair here likewise differs from the earlier record's average over 100 pairs on a heavily edited cell.

A split writes a boundary embed into the segment's text, a beat map and its `id`, `segment`, `splitBy`, `visual`, `joins`, and `removals`, plus an empty visual map with `beat`, `rank`, `text` and `markRecords`. `split-executor.ts:preparePhysicalBeatSplit` writes all of them. The eight extra native-text bytes arise from splitting an existing string struct around the embed. Undo does not remove these structures: `undo-split.ts:prepareSharedSplitRetire` writes a retirement observation under `meta/splitRetired:<beat>`. The observation retains the state against which an unseen later edit can revive the split. It includes the display author in `splitBy`.

Bold writes an `add` entry through `mark-executor.ts` and `mark-store.ts`. Its undo writes a `remove` entry naming the original occurrence and the `provenance` marker through `undo-handlers.ts:prepareSharedMarkRetract`. The original addition remains. Redo of text writes a new birth via `prepareSharedTextRestore`, with a `text-restore` identity connecting it to the deleted unit. This is shared restoration provenance, rather than serialization of the local undo stack.

## Storage alternatives and lifetime

| 1,000-character / operation probe | Net bytes | Bytes per character / operation | Meaning |
| --- | --- | --- | --- |
| real insertion run 1 | 324,052 | 324.052 | Original real individual-key stream, reused from preparation. |
| real insertion run 10 | 33,008 | 33.008 | 100 actual insertion operations; publication/grouping trade-off. |
| real insertion run 100 | 4,198 | 4.198 | 10 actual insertion operations; publication/grouping trade-off. |
| real insertion run 1000 | 1,323 | 1.323 | One actual insertion operation; not 1,000 immediate publications. |
| binary-anchors | 226,570 | 226.570 | Same logical birth data; new anchor encoding/readers required. |
| tuple-record | 155,570 | 155.570 | Same logical birth data; new record schema/readers required. |
| current-writer-id | 346,052 | 346.052 | Re-encoded with the shared-author port's writer/counter prefix; caller suffixes excluded. |
| 36-character-id-prefix | 394,052 | 394.052 | Longer ID control; does not model the present author port. |
| native-text | 1,017 | 1.017 | No app births: loses current formatting/undo semantics. |
| compact-birth | 44,802 | 44.802 | Writer/counter key plus clock/length/observed tuple; incomplete general contract. |
| compact-birth-no-observed | 42,802 | 42.802 | Also loses observed-mark distinction. |
| stamps | 98 | 0.098 | 1,000 stamp operations only; not a per-key interleaving estimate. |
| typed-with-stamps | 336,610 | 336.610 | 1,000 real individual keys, each followed by a changing stamp. |

| Fresh-cell repetition probe | Net bytes | Average bytes/pair |
| --- | --- | --- |
| 1 undo-redo pairs | 362 | 362.00 |
| 10 undo-redo pairs | 3,578 | 357.80 |
| 100 undo-redo pairs | 35,901 | 359.01 |

| Edited local writer | One new key, bytes | Observed marks in its birth | Key with native record references, bytes |
| --- | --- | --- | --- |
| short | 5,223 | 100 | 1,833 |
| long | 5,224 | 100 | 1,834 |
| large | 5,224 | 100 | 1,834 |

| Edited state | Original bytes | Binary birth anchors | Tuple births | Native record references | Tuple births + native references |
| --- | --- | --- | --- | --- | --- |
| short | 9,159,062 | 7,127,876 | 5,707,876 | 9,155,672 | 5,704,486 |
| long | 7,922,046 | 5,867,750 | 4,447,750 | 7,918,656 | 4,444,360 |
| large | 8,577,933 | 6,517,933 | 5,097,933 | 8,574,543 | 5,094,543 |

All compacted edited states above remain over 2 MiB. These encoded-shape probes preserve data for a proposed reader; they do not implement an online migration. The edited local-key probe is distinct from admission's fresh-peer stream: its birth carries 100 observed mark additions from the edited cell. A byte rate for the fresh peer does not bound that local writer. The small author control remains 320 bytes: its display name is not in the birth. Current IDs are generated by `src/bootstrap/wiring/ports/shared-author.ts` as writer plus counter; actual command builders can append further suffixes, so that ID row is a controlled encoding comparison, not a whole-app storage prediction.

The binary-anchor and tuple-record prototypes decode and re-encode the same real 1,000-keystroke state, changing only birth values. Binary anchors keep the segment plus the native relative-position bytes as a byte buffer. The tuple form keeps every logical field, including operation, writer, both anchors, observed marks and born identity, but replaces repeated field names/discriminators with positions. A native document accepts and round-trips each resulting encoded state exactly. Today's application readers do not understand those forms. These are measured format proposals, not a migration or a proof that concurrent behavior is preserved by a completed implementation.

Each proposed encoding is applied to a native document before its stored size is measured. Struct IDs, lengths, content kinds and payloads must survive that application, and a second native encoded transfer must round-trip byte for byte. This canonicalization matters because decoding and rewriting alone can omit redundant map-item flag bits that native integration restores. No size result relies on an unintegrated hand-written wire update.

The edited-state reference prototype replaces each resolvable `observed` name with the referenced map entry's native `[client, clock]` ID, scoped to its physical mark store. The existing entry still carries its original operation/key, so a proposed reader can recover the same logical reference; unresolved names remain unchanged. It adds no dictionary record and does not drop observations. It requires new readers and continued retention of the referenced native entries, and couples another stored field to native struct identity. The combined edited-state column also uses tuple births. It is a size probe, with no product reader or migration implementation.

Compact birth writes each of 1,000 keys as its own transaction, using a writer/counter map key and `[clock,length,observed]`. The smaller variant omits `observed`. These are bounds for a larger redesign: neither represents general mark additions, restoration provenance or the present arbitrary operation IDs. Omitting `observed` loses the current distinction between marks the insertion saw and marks made concurrently. Native-text-only writes each key directly into the existing native text, retaining ordinary CRDT text identities but removing application birth records entirely; it gives up the current concurrent-formatting and selective-undo rules. Neither is proposed as a drop-in optimization.

Actual 10/100/1,000-character insertion runs use the real executor. They preserve one birth interval for that insertion, not one for every keystroke. They are fewer insertion operations, not the original 1,000 immediate publications: adopting that shape needs delayed publication until a run closes, or a new representation for extending a run whose native clocks are interleaved with record writes. The prototype does not implement that representation or measure its tombstones. Transaction batching alone still writes all 1,000 births and does not deliver these savings.

| Stored part | Why it is read now | Retention / avoidable part |
| --- | --- | --- |
| Native text identities and tombstones | Native merge, anchors, `text-history.ts` ordering and selective undo | Required while references or old peer updates can arrive. Default GC removes deleted character content, not the identity and its position. Reclaiming identities needs a coordinated epoch or another proven causal reclamation protocol. |
| Birth range and observed marks | `mark-store.ts` excludes observed additions for newly born text; `text-history.ts` also traces restorations | Information is needed for current concurrent formatting and undo semantics. JSON anchors, repeated field names and repeated IDs are avoidable representation cost. No implemented safe expiry is present. |
| Add/remove/copy records and provenance | `mark-store.ts`, `mark-provenance.ts`, `text-history.ts`; retractions can cancel a copy or an addition arriving later | An undone mark is not merely dead data. Dropping it when local undo expires can change another copy's result. Safe removal needs more than an empty local undo stack. |
| Split objects and retirement observation | `split-retirement.ts` compares current content with the observed shape; `undo-split.ts` checks whether undo/redo is still effective | Needed while an unseen edit can revive the split or an undo entry can use it. There is no measured safe in-session removal point. The repeated snapshot/identifier representation could be shortened. |
| Display author and stamps | `splitBy` names structural authors; `stamp.ts:readSharedStamp` selects the visible edit stamp | Not part of the plain-key 320-byte probe. Stamp writes replace the current writer's register; old values can be GC'd. Shortening display names changes attribution; suppressing stamps changes the shown last edit. |
| Local undo descriptions | `src/application/editing/undo/shared-undo.ts` and `undo-executor.ts` | Not in encoded shared state. Clearing the stack does not reclaim the birth/add/remove records already shared. |

The stamp-only variant uses 1,000 real scalar stamp operations, changing the ISO timestamp on each, with a fixed display name. It measures stamp register growth separately; the #1566 keystroke stream never calls `sharedBeatStamp`. Commit-time writers add stamps in `src/bootstrap/wiring/ports/writer-flow.ts` through `stamp.ts`. Thus these measurements do not silently charge app stamp overhead to the 325-byte key rate, or claim the running app has no such cost.

A projected-document reimport yields fresh shared-state size for this workload, because the workload restores the entire projection to its original value. That is a **new identity space**, not live compaction. Every peer must agree on the epoch; old updates, old anchors and old undo entries cannot be applied to it. Handling an offline writer's old work is a product/protocol decision. No epoch change is implemented here.

## What admission currently refuses

This is an exhaustive list of the explicit branches in `document.ts:applySharedUpdate`, not a claim that it validates the application schema:

1. The write/ingress guard can throw `SharedExecutionWriteError` for forbidden reentry. This is outside the trial.
2. While the buffer hold is active, a previously declined queue or a capacity overflow returns `queue-full`, before allocating a trial.
3. A decoder exception returns `invalid-update`.
4. A decoded struct with non-positive length returns `invalid-update`.
5. An exception while copying the live state into the trial, or integrating the incoming update into that trial, returns `invalid-update`.

Nothing in the trial calls application operation readers, projection/schema validation, authorization, or quota checks. Missing causal dependencies are accepted as pending. Application observer errors on the subsequent live write are not preflighted by the trial, whose observers are only those installed by `CollabDocumentState`.

Existing `tests/adapters/collab/document.test.ts` pins truncated/random bytes, zero-length structs, pending dependencies, duplicate/reversed delivery and encoded late join. `ingress-gate.test.ts` pins immediate invalid-update refusal inside a notification, ordered holds and callback-error behavior; `buffer-gate.test.ts` pins queue capacity. The new focused tests add a positive-length item with an invalid same-client origin, and a valid map-write prefix followed by cyclic incoming origins. Both decode successfully. All references in the cyclic case are present, so the extra reference check passes. Current admission, shadow and batch refuse both without changing live state. Decode-only and the reference control leave the valid prefix live before native integration throws on the cycle. These are integration-specific witnesses, not a classification of every malformed native graph.

| Alternative | Present trial refusals retained | Lost check or changed policy |
| --- | --- | --- |
| Standing shadow | Decode, length and attempted native integration on isolated state | Requires exact synchronization with every live write and pending update. A refused update dirties only the shadow, which must be rebuilt. The prototype does not implement ingress holds/reentry/capacity/callback policy. |
| One trial per drained burst | Decode, length and isolated integration for every member, before any live member is applied | One refusal rejects the whole fixed burst; per-update acceptance is lost. A singleton still copies the whole document. It also needs the existing ingress policy wrapped around it. |
| Decode-only | Decode exceptions and non-positive lengths | All copy/integration exceptions are no longer caught before live mutation. It cannot make the whole-update-before-live promise. |
| Decode plus live references | Same checks, plus every encoded origin/right-origin/ID-parent must resolve to an existing or incoming struct | Catches an absent origin, but misses the tested incoming cycle and permits its partial live write. It also rejects valid out-of-order updates which the product deliberately keeps pending. It does not check parent/content compatibility, simulate ordering, validate delete integration or replay pending native updates. It cannot preserve all integration refusals. |

The reference prototype uses the native client's contiguous stored clock range and the decoded incoming struct ranges. It reads no projected document and creates no native copy. Looking up dependencies can be done without a document scan, but that fact does not establish a complete validator. No additional arbitrary-update validator with the present acceptance policy and a proven document-size-independent cost was found. A restricted operation envelope could validate application commands before emitting native updates, but that changes the wire protocol and is not measured here.

Machine-readable [byte and decoded-struct probes](stage-2-growth-admission-options-bytes.json) and [five-round timing/heap data](stage-2-growth-admission-options-results.json) retain the underlying values. They contain no full binary workload checkpoint.

## Admission measurements

All six cases have five completed timing and heap rounds for all four alternatives. No alternative 1,000 drain was skipped; each finished below one minute. Values below are median [minimum–maximum] across five per-round statistics.

| Case | Method | Single p50 ms | p95 ms | Maximum ms |
| --- | --- | --- | --- | --- |
| short/fresh | Current (#1566, quoted) | 3.51 [3.18–4.07] | 14.43 [5.72–19.55] | 30.78 [8.48–37.03] |
| short/fresh | shadow | 0.03 [0.03–0.03] | 0.05 [0.04–0.06] | 0.25 [0.20–0.74] |
| short/fresh | decode | 0.01 [0.01–0.01] | 0.02 [0.02–0.03] | 0.17 [0.16–0.34] |
| short/fresh | references | 0.01 [0.01–0.01] | 0.02 [0.02–0.03] | 0.16 [0.16–0.37] |
| short/edited | Current (#1566, quoted) | 202.67 [193.24–254.00] | 317.41 [214.29–563.55] | 507.09 [249.42–902.76] |
| short/edited | shadow | 0.03 [0.03–0.05] | 0.04 [0.04–0.18] | 14.77 [13.62–32.00] |
| short/edited | decode | 0.01 [0.01–0.02] | 0.02 [0.02–0.05] | 6.39 [5.97–16.57] |
| short/edited | references | 0.01 [0.01–0.03] | 0.02 [0.02–0.10] | 6.75 [6.52–23.74] |
| long/fresh | Current (#1566, quoted) | 3.48 [3.35–3.58] | 5.77 [5.54–5.96] | 9.59 [8.72–12.14] |
| long/fresh | shadow | 0.06 [0.05–0.06] | 0.10 [0.08–0.28] | 32.94 [0.33–56.44] |
| long/fresh | decode | 0.02 [0.02–0.03] | 0.07 [0.03–0.09] | 0.81 [0.21–9.06] |
| long/fresh | references | 0.03 [0.02–0.03] | 0.05 [0.03–0.06] | 0.29 [0.24–8.99] |
| long/edited | Current (#1566, quoted) | 196.35 [186.32–286.38] | 374.57 [206.23–753.50] | 479.29 [268.77–1110.75] |
| long/edited | shadow | 0.03 [0.03–0.06] | 0.06 [0.05–0.14] | 15.66 [14.61–47.89] |
| long/edited | decode | 0.01 [0.01–0.02] | 0.02 [0.02–0.04] | 7.67 [7.17–16.29] |
| long/edited | references | 0.01 [0.01–0.02] | 0.02 [0.02–0.04] | 7.97 [6.92–15.97] |
| large/fresh | Current (#1566, quoted) | 27.50 [23.94–35.66] | 43.49 [29.54–70.77] | 67.78 [43.74–125.77] |
| large/fresh | shadow | 0.03 [0.03–0.03] | 0.06 [0.05–0.06] | 0.35 [0.28–0.42] |
| large/fresh | decode | 0.02 [0.01–0.02] | 0.03 [0.02–0.03] | 0.24 [0.23–0.38] |
| large/fresh | references | 0.02 [0.02–0.03] | 0.03 [0.03–0.03] | 0.23 [0.22–0.26] |
| large/edited | Current (#1566, quoted) | 236.97 [201.84–356.51] | 448.12 [223.56–826.76] | 554.49 [280.56–1386.76] |
| large/edited | shadow | 0.03 [0.03–0.03] | 0.05 [0.04–0.05] | 15.80 [15.14–16.77] |
| large/edited | decode | 0.01 [0.01–0.01] | 0.02 [0.02–0.02] | 7.98 [7.20–8.92] |
| large/edited | references | 0.01 [0.01–0.01] | 0.02 [0.02–0.02] | 7.93 [7.77–8.07] |

| Case | Method | 100 drain ms | 1,000 drain ms |
| --- | --- | --- | --- |
| short/fresh | Current (#1566, quoted) | 172.44 [108.42–215.38] | 9491.26 [5823.66–10494.96] |
| short/fresh | shadow | 4.52 [3.35–5.80] | 29.37 [27.38–36.20] |
| short/fresh | batch | 3.13 [2.95–4.45] | 23.34 [21.35–26.29] |
| short/fresh | decode | 2.20 [2.01–2.27] | 14.54 [14.24–14.99] |
| short/fresh | references | 1.96 [1.66–2.53] | 14.50 [14.37–15.12] |
| short/edited | Current (#1566, quoted) | 21318.66 [19103.14–29996.84] | 245457.95 [195951.60–296163.71] |
| short/edited | shadow | 16.81 [15.84–37.29] | 42.09 [40.89–116.38] |
| short/edited | batch | 170.36 [147.48–397.88] | 190.21 [170.54–357.36] |
| short/edited | decode | 8.69 [8.13–21.02] | 19.96 [19.83–136.07] |
| short/edited | references | 8.79 [8.42–76.13] | 20.41 [19.96–213.79] |
| long/fresh | Current (#1566, quoted) | 232.14 [225.16–236.23] | 5448.59 [5407.65–5611.96] |
| long/fresh | shadow | 19.86 [7.28–32.32] | 126.46 [85.83–189.04] |
| long/fresh | batch | 11.30 [7.77–13.60] | 68.01 [47.52–141.73] |
| long/fresh | decode | 4.09 [3.71–8.29] | 39.30 [32.56–140.35] |
| long/fresh | references | 4.03 [3.51–4.09] | 38.19 [33.07–69.19] |
| long/edited | Current (#1566, quoted) | 18700.55 [18121.32–22211.73] | 257416.30 [191295.40–317489.93] |
| long/edited | shadow | 21.59 [17.99–46.75] | 52.35 [43.98–88.00] |
| long/edited | batch | 172.11 [150.68–305.55] | 188.36 [167.60–273.29] |
| long/edited | decode | 13.08 [8.93–15.89] | 23.49 [21.37–41.92] |
| long/edited | references | 12.26 [8.82–17.05] | 28.54 [22.58–31.66] |
| large/fresh | Current (#1566, quoted) | 2711.06 [2120.20–4965.40] | 29268.00 [25909.47–49411.22] |
| large/fresh | shadow | 4.54 [4.36–6.43] | 31.07 [30.17–38.22] |
| large/fresh | batch | 21.54 [20.96–22.94] | 40.18 [38.93–44.55] |
| large/fresh | decode | 2.25 [2.09–2.32] | 16.19 [15.72–16.62] |
| large/fresh | references | 2.30 [2.17–2.36] | 16.15 [13.93–16.35] |
| large/edited | Current (#1566, quoted) | 34317.17 [20685.57–47899.55] | 299506.23 [250210.80–322451.16] |
| large/edited | shadow | 20.30 [19.51–21.63] | 41.71 [40.91–43.06] |
| large/edited | batch | 167.85 [165.64–173.45] | 189.37 [186.40–208.32] |
| large/edited | decode | 9.72 [8.70–9.96] | 21.56 [20.88–22.78] |
| large/edited | references | 9.72 [9.19–10.55] | 21.99 [21.52–29.75] |

| Case | Method | Standing retained MiB | Refusal + rebuild ms | 100 peak / retained MiB | 1,000 peak / retained MiB |
| --- | --- | --- | --- | --- | --- |
| short/fresh | shadow | 0.062 [0.062–0.076] | 1.98 [1.85–3.30] | 4.390 [4.368–4.740] / 0.211 [0.208–0.238] | 42.592 [32.517–43.002] / 2.275 [2.227–2.302] |
| short/fresh | batch | 0.000 [-0.016–0.001] | — | 4.106 [4.100–4.234] / 0.121 [0.121–0.121] | 38.666 [9.253–38.691] / 1.192 [1.145–1.239] |
| short/fresh | decode | -0.008 [-0.027–0.000] | — | 2.515 [2.484–2.554] / 0.146 [0.132–0.150] | 24.674 [24.631–24.943] / 1.199 [1.195–1.238] |
| short/fresh | references | -0.005 [-0.166–0.000] | — | 2.578 [2.551–2.661] / 0.146 [0.121–0.151] | 25.352 [25.209–26.216] / 1.201 [1.195–1.237] |
| short/edited | shadow | 28.261 [28.240–28.278] | 144.10 [141.93–314.97] | 12.780 [12.754–12.786] / 0.230 [0.230–0.231] | 51.222 [51.145–51.310] / 2.266 [2.262–2.268] |
| short/edited | batch | 0.000 [-0.005–0.000] | — | 41.507 [41.122–41.615] / 0.119 [0.097–0.174] | 75.914 [75.380–76.214] / 1.175 [1.168–1.222] |
| short/edited | decode | -0.024 [-1.005–0.000] | — | 6.651 [6.643–6.656] / 0.130 [0.118–0.141] | 28.801 [28.772–28.938] / 1.171 [1.167–1.180] |
| short/edited | references | -1.017 [-1.018–-0.001] | — | 6.704 [6.701–6.729] / 0.130 [0.126–0.138] | 29.463 [29.414–29.509] / 1.178 [1.172–1.198] |
| long/fresh | shadow | 0.726 [0.614–0.771] | 9.99 [8.41–33.08] | 4.400 [4.375–4.408] / 0.231 [0.170–0.231] | 42.777 [42.769–42.853] / 2.311 [2.301–2.317] |
| long/fresh | batch | 0.000 [-0.026–0.000] | — | 6.237 [6.215–6.254] / 0.121 [0.120–0.147] | 40.667 [40.515–40.735] / 1.237 [1.192–1.241] |
| long/fresh | decode | -0.003 [-0.116–0.000] | — | 2.479 [2.478–2.484] / 0.134 [0.065–0.156] | 24.588 [24.571–24.621] / 1.194 [1.188–1.198] |
| long/fresh | references | 0.000 [-0.037–0.000] | — | 2.550 [2.544–2.555] / 0.138 [0.134–0.169] | 25.267 [25.209–25.423] / 1.195 [1.193–1.264] |
| long/edited | shadow | 25.331 [25.323–26.327] | 162.64 [142.26–301.80] | 12.788 [12.764–12.917] / 0.230 [0.230–0.230] | 51.233 [51.075–51.301] / 2.267 [2.262–2.300] |
| long/edited | batch | 0.000 [-0.005–0.000] | — | 27.445 [26.650–27.912] / 0.112 [0.103–0.116] | 63.579 [63.059–63.966] / 1.166 [1.159–1.247] |
| long/edited | decode | -0.005 [-0.030–-0.001] | — | 6.650 [6.645–6.659] / 0.142 [0.124–0.143] | 28.818 [28.788–28.843] / 1.180 [1.172–1.196] |
| long/edited | references | -0.001 [-0.004–0.000] | — | 6.722 [6.713–6.738] / 0.142 [0.124–0.145] | 29.440 [29.407–29.479] / 1.178 [1.176–1.250] |
| large/fresh | shadow | 5.978 [5.899–5.979] | 18.91 [17.40–21.71] | 4.444 [4.421–4.449] / 0.207 [0.172–0.231] | 42.894 [42.664–43.112] / 2.276 [2.207–2.282] |
| large/fresh | batch | 0.000 [0.000–0.000] | — | 21.570 [20.680–21.810] / 0.135 [0.047–0.180] | 55.870 [55.046–56.008] / 1.210 [1.086–1.279] |
| large/fresh | decode | 0.000 [-0.006–0.000] | — | 2.510 [2.471–2.533] / 0.139 [0.127–0.160] | 24.566 [24.521–24.647] / 1.197 [1.190–1.224] |
| large/fresh | references | 0.000 [-0.006–0.000] | — | 2.574 [2.562–2.577] / 0.143 [0.136–0.157] | 25.232 [25.218–25.508] / 1.195 [1.081–1.222] |
| large/edited | shadow | 30.605 [30.597–30.611] | 155.51 [149.86–158.91] | 12.763 [12.744–12.767] / 0.230 [0.215–0.230] | 50.511 [50.452–50.692] / 1.219 [1.214–1.265] |
| large/edited | batch | -0.001 [-0.024–0.000] | — | 53.950 [53.772–54.112] / 0.117 [0.117–0.117] | 88.458 [88.194–88.582] / 1.199 [1.164–1.232] |
| large/edited | decode | -0.006 [-0.043–-0.001] | — | 6.647 [6.644–6.648] / 0.143 [0.142–0.143] | 28.809 [28.729–28.844] / 1.178 [1.169–1.265] |
| large/edited | references | -0.000 [-0.038–0.000] | — | 6.711 [6.708–6.721] / 0.142 [0.124–0.146] | 29.369 [29.341–29.531] / 1.181 [1.177–1.181] |

Shadow creation is outside the admission timer. It applies an arriving update there first, then through the same live adapter transaction used by the direct control. A live-update subscription keeps local writes in step; accepted remote updates are not replayed twice into the shadow. On refusal it destroys and rebuilds the shadow from live. Rebuild numbers time a refused one-byte malformed update and its recovery after 100 accepted updates, including encoding/copying the live state. They are not worst-case hostile-update bounds.

These prototypes operate with immediate live application. In the product, a closed ingress gate preflights against live state before holding the bytes; the held list is absent from that trial base. Applying held updates to a standing shadow immediately would put it ahead of live and could change pending-dependency and refusal behavior. Adoption must define that ordering, preserve the execution guard, capacity and notification behavior, and recover from local-write or observer failures. The focused causal-stream and malformed-update tests do not certify the real ingress state machine.

All timing passes compare final encoded bytes with a direct application control, including the 100- and 500-update prefixes. Every 1,000 drain must finish below one minute or the run stops; no speed is asserted in a test. The burst method has no singleton percentile row: a singleton remains a full-state trial, as in the present method. Burst timings are whole synchronous tasks and must not be divided by count and compared with the 50 ms task limit.

Heap is sampled in separate untimed passes, five per method/state/burst size. Second-copy retained heap is after two forced collections immediately after shadow creation, relative to the same live receiver. Peak/retained burst deltas exclude that standing copy. Peak is sampled between updates (or after the whole burst for batch), so it can miss an intra-update or intra-trial peak. Retained is after two collections. External buffers and resident memory are excluded. Small negative values are collection noise. The standing copy is additional to the live adapter's footprint, application state, projection and undo stack. These Node figures cannot certify the Stage 0 browser heap limit.

## Stage 0 screen and limits

| Case | Method | Individual admission | 100 drain task | 1,000 drain task |
| --- | --- | --- | --- | --- |
| short/fresh | shadow | Within admission-only screen | All ≤50 ms | All ≤50 ms |
| short/fresh | batch | Full copy for isolated update; singleton not rerun | All ≤50 ms | All ≤50 ms |
| short/fresh | decode | Within admission-only screen | All ≤50 ms | All ≤50 ms |
| short/fresh | references | Within admission-only screen | All ≤50 ms | All ≤50 ms |
| short/edited | shadow | Within admission-only screen | All ≤50 ms | At least one >50 ms |
| short/edited | batch | Full copy for isolated update; singleton not rerun | At least one >50 ms | At least one >50 ms |
| short/edited | decode | Within admission-only screen | All ≤50 ms | At least one >50 ms |
| short/edited | references | Within admission-only screen | At least one >50 ms | At least one >50 ms |
| long/fresh | shadow | EXCEEDS | All ≤50 ms | At least one >50 ms |
| long/fresh | batch | Full copy for isolated update; singleton not rerun | All ≤50 ms | At least one >50 ms |
| long/fresh | decode | Within admission-only screen | All ≤50 ms | At least one >50 ms |
| long/fresh | references | Within admission-only screen | All ≤50 ms | At least one >50 ms |
| long/edited | shadow | Within admission-only screen | All ≤50 ms | At least one >50 ms |
| long/edited | batch | Full copy for isolated update; singleton not rerun | At least one >50 ms | At least one >50 ms |
| long/edited | decode | Within admission-only screen | All ≤50 ms | All ≤50 ms |
| long/edited | references | Within admission-only screen | All ≤50 ms | All ≤50 ms |
| large/fresh | shadow | Within admission-only screen | All ≤50 ms | All ≤50 ms |
| large/fresh | batch | Full copy for isolated update; singleton not rerun | All ≤50 ms | All ≤50 ms |
| large/fresh | decode | Within admission-only screen | All ≤50 ms | All ≤50 ms |
| large/fresh | references | Within admission-only screen | All ≤50 ms | All ≤50 ms |
| large/edited | shadow | Within admission-only screen | All ≤50 ms | All ≤50 ms |
| large/edited | batch | Full copy for isolated update; singleton not rerun | At least one >50 ms | At least one >50 ms |
| large/edited | decode | Within admission-only screen | All ≤50 ms | All ≤50 ms |
| large/edited | references | Within admission-only screen | All ≤50 ms | All ≤50 ms |

This table screens the valid causal stream only. Edited-state shadow rebuilds after refusal can themselves exceed 50 ms if performed synchronously. They need a separate failure/scheduling policy; passing the valid-update row does not cover hostile or repeatedly refused input.

Shadow individual admissions pass this necessary screen on five of six cases; fresh long fails because of the observed 56.44 ms maximum. Both copy-free controls pass the individual timing screen on all six, but fail the tested whole-update isolation requirement. Every alternative has at least one synchronous drain exceeding 50 ms. Burst trials retain the isolated-update full-copy shape and do not resolve that input case. None of these results certify the complete Stage 0 input gate.

This screen uses the Stage 0 added-p50 allowance of 3 ms on short/long and 2.7 ms on large, p95 caps of 25/40 ms, and the worst observed individual admission against 50 ms. Meeting those numbers for admission alone would still leave the running app's input, projection, notifications and paint to measure. A synchronous drain exceeding 50 ms cannot be certified for the typing path even when its individual admissions are cheap. Scheduling drains in slices or off the main thread is additional work, unmeasured here.

No browser, two-client composed app, end-to-end input latency, network/provider, server validation, 2 MiB join fixture, reconnect, persistence, receipts or complete-format migration was measured. No full verification suite was run, as required for this shared computer. No current-admission timing or heap pass was repeated; all such numbers are explicitly quoted from #1566. Singleton burst-trial percentiles were not rerun: that policy still makes one full-state trial for an isolated update.

Validation: all ten focused measurement tests pass, along with full lint, all five type-check configurations, dependency and comment gates, and the code map. Existing desktop and collaboration-prototype dependencies were installed from their lockfiles for type checking, with installation scripts disabled. No tracked product file, package manifest, lockfile or baseline changed. All preparation and measurement processes exited before handoff.
