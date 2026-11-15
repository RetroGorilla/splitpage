# Stage 2: reconcile stored bytes and repeated working days

## Decision

The earlier figures describe different quantities. Stage 1's **5.94 bytes per typed character** is the entire retained document divided by all typing in a draft and revision. It includes the document's fixed structure. It is not the marginal cost of a key. Stage 2's **320 bytes** is the increase caused by one unformatted key in one particular small state. Its **324,052 bytes per 1,000 keys** is a longer unformatted stream, with longer operation identifiers and native clocks. After 100 mark additions in that cell, the next local key instead adds **5,223–5,224 bytes**. There is no fixed Stage 2 per-character rate.

Replaying the same Stage 1 typing and retyping in the real Stage 2 adapter gives **6,415,088 bytes with two writers** and **6,404,190 with six**. Both contain exactly **11,287 typed characters and 10,478 final characters**, including the prototype's convention for atom labels. Stage 1 at the same point occupies **50,914 bytes**. In the two-writer Stage 2 state, birth ranges, birth observations, writer identity and birth keys/framing dominate. The exact ledger below identifies every encoded byte. The original Stage 1 full block still reproduces **67,095 / 67,096 bytes**; its later structural and production edits are excluded from both sides of the new text comparison.

This measurement does not recommend changing the format yet. A growing run must first demonstrate immediate per-key delivery, selective undo, concurrent marks and recovery. Sharing an observed-mark set may save more than shortening anchors, but changing or truncating that set can change which concurrent formatting applies. Piece C is that correctness trial. None of the 2 MiB, 3x fresh, 10x edited or input gates changes here. **Every Stage 0 local-input result remains not measured.** No timing or browser measurement ran for this record.

Repeated reopenings do not reset the cost. The tables below track 60 reduced-volume sessions on the one- and two-person long script, and 20 on the other cases, each with 10 words of new typing per person. Removal records name observed content, so repeated whole-beat removal/restore keeps substantially more than deletion tombstones. A separate default-volume prefix stops at the first over-cap 100-key block: it establishes a crossing during the first writer's typing phase of **day 1**, before that person's 30,000-key allocation is complete, for either fixture and any requested group size. Full day 1–60 totals below are explicitly extrapolations, too far beyond the reduced-volume sample to certify a capacity promise. A storage recommendation needs the trial's repeated-day results, not a first-day run-length saving alone.

## What was run

Product source is `cafd0a73dfb0cd373b19e84b3503761e5e740840`, fetched from `origin/main`, including #1605 and #1606. Node is 24.22.1, x64 on native Windows x64. Byte counts are deterministic; there are no timing percentiles, speed assertions, heap measurements or browser suites. New files under `tests/collab/measure` drive the real adapter. A byte-only entry beside the original Stage 1 workload captures its text calls; the measurement runner launches it as a subprocess, respecting the prototype import boundary.

`prototypes/collab/measure/byte-replay.ts` executes the unchanged `LifetimeHistory.appendBlock()` for two and six writers. It captures the actual native text inserts, embeds and deletions through the first 30 beats and five half-beat rewrites. It checkpoints before splits, joins, moves, removals, status and review edits. Each UTF-16 unit is still published as a distinct insertion, with the original attributes. Corrections remain one backspace/retype per 55 original characters; rewrites retain the original five-beat, half-narration schedule. The Stage 2 runner applies the same tape through `readOperation` and `executeSharedOperations`. It translates prototype occurrence keys into semantic tag ids, URLs and comment anchors, ignores null/false attribute clears, and asserts character values, mark payloads and visible projected text in every cell. Both writer groups retain one `comment-without-words` recovery entry after the first-five-beat rewrites; recovery counts are recorded. Writer changes occur at the original causal beat/revision boundaries. These are causal, turn-taking writers, not a concurrent-edit correctness demonstration.

The table uses Stage 1's columns. Its text-only denominator includes original typing, correction retyping and rewrite typing. Both sides use the prototype's small writer ids 1–6 and hydration id 100. The separate 320-byte / 1,000-key controls retain the earlier large numeric client ids; id and clock encoding widths are part of the difference, not a universal byte rate. Stage 1's active export uses its `serializeProjection`; Stage 2's uses pretty JSON of `projectSharedDocument`. All beats are active at this checkpoint. Those are each form's plain projection, not identical file serialization contracts: their metadata and HTML normalization differ. The common typed/final character counts establish the text comparison; the export ratios are reported with that qualification. They are not a replacement for the unchanged Stage 0 app-save gate.

## Why the stored forms differ

The change followed two concrete failures that the Stage 1 suite had not exercised. In the [first decision](https://github.com/RetroGorilla/splitpage/issues/1414#issuecomment-6782536861), concurrent italic edits and a deletion could remove italic from a surviving character that nobody unformatted. A unique native attribute per addition still lost a concurrent mark when its original words were deleted. The [chosen design](https://github.com/RetroGorilla/splitpage/issues/1414#issuecomment-6785017521) therefore keeps marks outside native formatting, with immutable anchored additions and observed removals. It requires text inserted concurrently inside a range to keep that mark. The cheaper Stage 1 number predates that correction; reproducing its byte rate alone does not establish an acceptable replacement.

| Stored information | Stage 1 lifetime prototype | Stage 2 writer and reader; introduction and guarantee |
| --- | --- | --- |
| Text and native identity | Native text items, coalesced across consecutive key transactions; native format attributes and embeds | `text-edit.ts` writes native text; `text-history.ts` reads stable identities. Native text is still present. |
| One birth for each insertion | No application birth map entry per key | `text-executor.ts` / `text-description.ts` plan a birth; `mark-store.ts` writes `markRecords`. Immutable anchored mark storage was introduced in [#1444](https://github.com/RetroGorilla/splitpage/pull/1444), hydrated by [#1445](https://github.com/RetroGorilla/splitpage/pull/1445), and written by prepared text execution in [#1448](https://github.com/RetroGorilla/splitpage/pull/1448). `mark-state.ts` excludes additions the insertion had already observed, while retaining unseen concurrent additions. |
| Birth range | No pair of application JSON anchors and born-object fields for every native insertion | `mark-store.ts` writes start/end anchors and the inserted native interval. `mark-state.ts` and `text-history.ts` resolve the range and exact native identity. The anchors and interval support different jobs: geometry and membership after interleaving. |
| Observed mark list | Native attributes, with no historical application list copied onto each character | `text-executor.ts` passes the cell's known addition identities into each birth. `mark-state.ts` uses them to avoid applying an already-seen range mark to newly typed text. Even a mark on other words can remain in this list. The list is retained after deletion. Capping it without a semantic argument gives up that exclusion. |
| Mark additions/removals, copies and retractions | Native formatting in the main lifetime run; no active UndoManager there | Stage 2 records distinguish occurrences and changes. `undo-handlers.ts` and `mark-provenance.ts` retain source identities and retractions for selective undo and restoration, introduced with the [#1481 undo executor](https://github.com/RetroGorilla/splitpage/pull/1481) and later joined-mark handling [#1511](https://github.com/RetroGorilla/splitpage/pull/1511). Stage 1 measured its native UndoManager separately, not in its principal capacity table. |
| Soft structure, retirement and removal observations | Simpler prototype joins/removal records; full structural tail only in its published full-block column | `split-executor.ts`, `undo-split.ts`, `removal-executor.ts`, `undo-creation.ts` and `undo-heading-creation.ts` retain identities and observations. Creation undo [#1590](https://github.com/RetroGorilla/splitpage/pull/1590), heading creation undo [#1609](https://github.com/RetroGorilla/splitpage/pull/1609) and recoverable record removal [#1592](https://github.com/RetroGorilla/splitpage/pull/1592) preserve edits other people made without seeing a removal. These costs are measured in repeated sessions, not attributed to the text-only comparison. |
| Local undo observation copies | Separate native undo control | `undo-executor.ts` captures replacement and keying observations on local `SharedUndoRecord` objects ([#1610](https://github.com/RetroGorilla/splitpage/pull/1610), [#1602](https://github.com/RetroGorilla/splitpage/pull/1602)). Those local copies are not encoded in the document. Their encoded ledger rows are zero; shared mark copies, retirement markers and restored text are charged to their actual stored records. This record does not measure local undo heap. |
| Stamps and production records | Prototype registry/status records | Stage 2 scalar stamps, people, tags, shots, comments and replies remain separate native records. The text tape does not synthesize a timestamp for every key. An actual stamp schedule would add its own cost; the earlier `typed-with-stamps` probe measured that separately. |

The 320-byte key consists of 1 byte of text and 9 bytes of native identity/framing, plus a 310-byte birth: range fields 186 bytes (start 73, end 72, born 41), observed list 11, writer 16, and 97 bytes of keys/object/item framing (type 12, operation 33, object 2, native map entry 50). The writer here is the numeric replica identity, not a copy of the person's display name; display names live in explicit stamps or records. Operation identity is repeated in the birth value and its map key. Writing a metadata struct between keys also prevents the adjacent native text items from coalescing as they do in the Stage 1 stream. Deleting the key leaves the birth and a native tombstone/delete set. Neither “all text was deleted” nor closing the session removes the observation history. The adjacent `stage-2-key-rates.json` reproduces the 324,052 / 325,052-byte fresh-peer streams and records the different local-client rates. A new small-state control with 100 range additions/retractions adds 4,959 bytes for its next key: the same 100-reference effect, with shorter operation names/clocks than the earlier edited checkpoint's 5,223–5,224. The native coalescing control adds 1,016 bytes for 1,000 keys. These are differences, whereas the lifetime table divides the whole retained state.

## Exact accounting method

`retained-bytes.mjs` writes every stored native struct with the actual V1 encoder and measures the resulting byte length. V1 writes do not carry state across items. For a birth's object fields it uses the same `lib0` string and any-value encoders: each key and its complete value are charged exactly once. Start, end and born belong to range; observed belongs to observations; writer belongs to stamp/author. Object headers, operation/type fields, native ids, the map key and item framing belong to birth keys/framing. Field totals plus this remainder equal the actual struct length; no marginal-removal estimate is used.

For live native strings, UTF-8 payload belongs to text content and the remaining native struct bytes to text identity. Embed payloads include their native content encoding; native format structs belong to marks. Deleted native structs and garbage-collected structs belong to deletions, with the delete set encoded and counted separately in the same row. A collected value's former application category cannot be recovered; it is not guessed. Split boundaries and split metadata, retirement observations, removal records and collection records are mutually exclusive. Remaining structures and metadata have explicit structure/rest rows. The bytes outside structs and the delete set form the update-framing row. Pending or incomplete causal checkpoints are refused by the accountant.

The fast test checks the 320/310 headline, deletion retention, a byte-identical encoded reopen, multibyte UTF-8 and the additive total. The stored-data test checks every category sum in the committed JSON. Category totals describe storage, including hidden/soft-removed content; text content here is not the visible export alone.

## Repeated-day parameters and limits

The scripts run the same existing long and ten-copy large audit fixtures, for 1, 2 and 4 writers. Default requested volume is 5,000 words each per working day, six keys per word, counting original typing, correction retyping and rewrite typing. The measured samples allocate 10 words of **new drafting** each per sample day, then add the stated corrections and rewrites. The raw `measuredWordsPerPersonPerDay` field denotes that new-drafting allocation; exact counters distinguish every typing kind. The projection rescales by total keyboard typing, not by the new-drafting count alone. Every new character is a separate real adapter operation. Writers take causal turns under fixed deterministic replica ids 1–4, reused after binary reopening; this is capacity measurement, not evidence about concurrent correctness or a future replica-identity persistence protocol. `capacity-prefix.mjs` separately executes the first writer's typing phase (including corrections), checking encoded size every 100 original keys and stopping after the first over-cap block. It crosses well before the total 30,000-key allowance, even after reserving that day's rewrite share. Later people's input or later structural edits cannot move that first crossing to a later day. The 100-original-key interval, not an exact key index, is reported. This establishes day 1 without allocating every over-cap full day.

The correction schedule is Stage 1's stated one per 55 keys, based on Stage 0's 55-key typing case. Rewriting deletes and individually retypes one twelfth of new text: five of thirty beats, half each, as in the lifetime schedule. Stage 0's edit-workload ratios supply one split and one join per 200 new keys, two removals per 200 keys, and one bold operation per 100 keys. Each structural operation is undone; each bold operation gets one undo/redo pair. Stated additional parameters are one beat creation (undo, redo, undo), comment with anchor mark, B-roll keying and Replace splice per 1,000 new keys. The counters are recorded. Short sampled days can have no threshold event; a full default day includes every family. Undo operations themselves create retained provenance.

Typing rotates through existing beats in 55-key blocks, starting at a different beat for each sample day and writer; two existing beats exercise joins with undo. The initial attempt to put a whole default day in one cell was stopped for run time before producing a cap result; it supplies no tabled number. Additions use the actual segment-create handler; keying uses `sharedBrollKeying`; Replace uses the same `sharedCellTextOperations` splice builder and undo executor as its application command. This bypasses UI search and focus handling, which are not measured. End-of-day local undo objects are released. The exact binary document is encoded, destroyed and reopened through `applySharedUpdate`; its encoded bytes must remain identical. No instance is reconstructed from a plain projection, and no compaction is performed. Stage 2 does not yet ship persisted shared-session reopening: this is the existing adapter's binary round trip, not a claim about a production persistence UI. [Rule 97](https://github.com/RetroGorilla/splitpage/issues/1414#issuecomment-6869752297) keeps saving and cleanup for later stages.

All measured category rows and plain sizes are in the six adjacent `stage-2-working-days-<fixture>-<people>.json` files. The [complete category table](stage-2-working-days-by-category.csv) includes all categories at every requested full-volume horizon, with separate measured and extrapolated rows; the smaller tables below highlight births and removal observations. The one- and two-person long cases were measured through sample day 60. The four-person long case and all large cases stop at sample day 20 under the shared machine's queue and run constraints; later sampled sessions were not run.

Default-volume category projections are in `stage-2-working-days-projections.json`. The fit fixes each measured day-zero intercept and fits nonnegative linear and quadratic growth to the last three checkpoints, separately per category: 10/20/60 for the longer runs, 5/10/20 otherwise. Each original key brings 1/55 correction retypes and 1/12 rewrite keys in the stated schedule. The sample-day multiplier is therefore `5000 / (10 × (1 + 1/55 + 1/12))`, about 453.9, rather than 500. Command-inserted strings (initial beat text, the short B-roll line prepared for keying, and Replace output) are separate operations included in encoded/plain totals, outside the keyboard allowance. The volume assumption is append-heavy: new draft text remains, while the rewrite share deletes and retypes existing text. A steady-length script was not measured; sufficiently long default horizons can exceed 2 MiB even in plain text.

Projected category rows sum exactly to the projected total, but they are **model outputs, not encoded documents**. Residuals, coefficients and exact volume multipliers are included. Word volume, distribution among cells, day boundaries and the increasing observed sets are confounded in this fit. Default day 1 is already 7.6–22.7 times beyond the last measured sample; day 60 is 454–1,362 times beyond it. These extrapolations show why a repeated-day capacity claim is presently unsupported; they do not certify full-volume totals or a safe number of working days. The first-day crossing is established independently by the measured prefix, not by the fit. Measured sample crossing days (where reached) and checkpoint intervals are retained separately in the projection JSON.

## Reproduction

Use Node 24.22.1 and install the locked dependencies. Check out `cafd0a73d` to inspect the product source being measured; the measurement scripts and data are in this PR, so run them on this branch, whose product directories remain at that source. Do not invoke the old timing runner's CLI. There are no speed assertions.

```powershell
(Get-Counter '\Memory\Available MBytes').CounterSamples[0].CookedValue
node tests/collab/measure/reconciliation.mjs
```

For each fixture (`long`, `large`) and group (`1`, `2`, `4`), sequentially:

```powershell
(Get-Counter '\Memory\Available MBytes').CounterSamples[0].CookedValue
node tests/collab/measure/working-days.mjs long 1 10 60 docs/collaboration/stage-2-working-days-long-1.json
```

Use 60 as the final argument before the output file for the one- and two-person long cases, 20 for the four-person long and all large cases. Run `node tests/collab/measure/capacity-prefix.mjs` and `node tests/collab/measure/key-rates.mjs` sequentially for the separate controls, each after its memory check. Keep at least 3,000 MB available. Use the coordinator's external shared lock for heavy runs; its location is deliberately not committed. Each repeated-session command writes a local, ignored encoded checkpoint under `.cache` and resumes it on a later invocation. Remove only the matching local checkpoint to replay from day zero. Do not commit those binary instances. After all six results and both controls exist, `node tests/collab/measure/reconciliation-report.mjs` regenerates the following tables and the clearly labelled projection JSON. Run `node --test tests/collab/measure/retained-bytes.test.mjs` for the fast ledger check.

## Validation

The focused measurement folder passes 16 tests, including the 320/310-byte key, mark-copy accounting, semantic translation and all recorded category sums. Typecheck (all five configurations), dependencies, comments and lint pass. Product directories and both baselines are unchanged. The full verification outcome is reported in the pull request; browser and performance runs are deliberately excluded by the shared-machine instructions.

## Generated comparison and byte ledger

| Form / writers / blocks | Encoded B | B / 1,000 final | B / 1,000 typed | Active export B | Encoded / export | 2 MiB / 10x reported export |
| --- | --- | --- | --- | --- | --- | --- |
| Stage 1 text / 2 / 1 | 50,914 | 4,859.1 | 4,510.9 | 38,382 | 1.3 | within / within |
| Stage 1 text / 6 / 1 | 50,914 | 4,859.1 | 4,510.9 | 38,382 | 1.3 | within / within |
| Stage 2 text / 2 / 1 | 6,415,088 | 612,243.6 | 568,360.8 | 38,292 | 167.5 | over / over |
| Stage 2 text / 6 / 1 | 6,404,190 | 611,203.5 | 567,395.2 | 38,292 | 167.2 | over / over |

### Unformatted typing difference controls

| Control | Fresh peer | Keys | Added B | Added B / key |
| --- | --- | --- | --- | --- |
| short | no | 1000 | 325,057 | 325.1 |
| short | yes | 1000 | 324,052 | 324.1 |
| long | no | 1000 | 328,726 | 328.7 |
| long | yes | 1000 | 325,052 | 325.1 |
| short after 100 range additions and retractions | no | 1 | 4,959 | 4,959 |
| native coalescing control | native only | 1000 | 1,016 | 1 |

### Exact retained-byte ledger at the common text checkpoint

| Exclusive encoded category | Stage 1 / 2 writers B | Stage 2 / 2 writers B | Stage 2 / 6 writers B |
| --- | --- | --- | --- |
| text content | 10,805 | 10,805 | 10,805 |
| text identity | 2,518 | 54,161 | 54,099 |
| birth range | 0 | 1,965,123 | 1,955,143 |
| birth observed marks | 0 | 2,854,447 | 2,854,447 |
| birth stamp or author | 0 | 101,664 | 101,664 |
| birth keys and framing | 0 | 1,073,886 | 1,073,886 |
| mark additions | 3,776 | 321,741 | 321,249 |
| mark removals | 0 | 0 | 0 |
| mark copies | 0 | 0 | 0 |
| deletions | 2,005 | 6,855 | 6,475 |
| split objects | 0 | 0 | 0 |
| retirement observations | 0 | 0 | 0 |
| removal marks | 0 | 0 | 0 |
| structure | 14,403 | 11,966 | 11,966 |
| undo heading observations | 0 | 0 | 0 |
| undo beat observations | 0 | 0 | 0 |
| undo replacement observations | 0 | 0 | 0 |
| undo keying observations | 0 | 0 | 0 |
| people | 216 | 184 | 184 |
| shots | 6,981 | 6,126 | 6,126 |
| tags | 7,254 | 5,879 | 5,879 |
| comments | 2,654 | 2,026 | 2,026 |
| rest | 289 | 212 | 212 |
| update framing | 13 | 13 | 29 |
| TOTAL | 50,914 | 6,415,088 | 6,404,190 |

The birth observed-list row splits exactly as follows. Insertion-bound references name additions whose native-id interval is fixed; range additions have no such restriction. This identifies candidates for the correctness trial and does not remove any observation in Piece R.

| Observed-list component | Stage 2 / 2 writers B | Stage 2 / 6 writers B |
| --- | --- | --- |
| insertion-bound addition references | 2,730,191 | 2,730,191 |
| range addition references | 0 | 0 |
| unknown references | 0 | 0 |
| keys and array framing | 124,256 | 124,256 |

## Measured default-volume capacity crossing

| Fixture | People | First default day over 2 MiB | Original keys at crossing | Bytes before / after block |
| --- | --- | --- | --- | --- |
| long | 1, 2, 4 | 1 | 6701–6800 | 2,087,413 / 2,115,671 |
| large | 1, 2, 4 | 1 | 4801–4900 | 2,093,556 / 2,124,913 |

## Repeated sessions: measured samples

### long, 1 people: measured at 10 new words each per sample day, plus corrections and rewrites

| Sample day | Encoded B | Plain B | Birth B | Removal marks B |
| --- | --- | --- | --- | --- |
| 0 | 66,469 | 38,342 | 0 | 0 |
| 1 | 87,106 | 38,402 | 20,292 | 0 |
| 2 | 149,646 | 38,479 | 37,566 | 43,991 |
| 5 | 260,437 | 38,693 | 89,388 | 98,557 |
| 10 | 419,875 | 39,044 | 187,568 | 152,194 |
| 20 | 742,359 | 40,439 | 373,847 | 271,887 |
| 60 | 2,258,923 | 45,589 | 1,241,713 | 857,345 |

First measured sample day over 2 MiB: 56.

### long, 2 people: measured at 10 new words each per sample day, plus corrections and rewrites

| Sample day | Encoded B | Plain B | Birth B | Removal marks B |
| --- | --- | --- | --- | --- |
| 0 | 66,469 | 38,342 | 0 | 0 |
| 1 | 148,987 | 38,479 | 37,168 | 43,799 |
| 2 | 209,724 | 38,616 | 76,474 | 62,104 |
| 5 | 420,499 | 39,044 | 185,436 | 154,946 |
| 10 | 862,896 | 40,482 | 397,927 | 368,221 |
| 20 | 1,715,693 | 43,129 | 800,532 | 786,694 |
| 60 | 5,534,132 | 54,450 | 2,860,028 | 2,411,973 |

First measured sample day over 2 MiB: 26.

### long, 4 people: measured at 10 new words each per sample day, plus corrections and rewrites

| Sample day | Encoded B | Plain B | Birth B | Removal marks B |
| --- | --- | --- | --- | --- |
| 0 | 66,469 | 38,342 | 0 | 0 |
| 1 | 227,164 | 38,616 | 70,920 | 85,231 |
| 2 | 404,529 | 38,890 | 149,922 | 178,627 |
| 5 | 911,665 | 40,620 | 419,454 | 395,430 |
| 10 | 1,823,180 | 42,919 | 891,406 | 803,573 |
| 20 | 3,574,862 | 47,204 | 1,835,032 | 1,548,182 |

First measured sample day over 2 MiB: 13.

### large, 1 people: measured at 10 new words each per sample day, plus corrections and rewrites

| Sample day | Encoded B | Plain B | Birth B | Removal marks B |
| --- | --- | --- | --- | --- |
| 0 | 632,834 | 333,308 | 0 | 0 |
| 1 | 653,471 | 333,368 | 20,292 | 0 |
| 2 | 716,011 | 333,445 | 37,566 | 43,991 |
| 5 | 826,802 | 333,659 | 89,388 | 98,557 |
| 10 | 986,240 | 334,010 | 187,568 | 152,194 |
| 20 | 1,308,901 | 335,405 | 373,847 | 272,062 |

First measured sample day over 2 MiB: not reached.

### large, 2 people: measured at 10 new words each per sample day, plus corrections and rewrites

| Sample day | Encoded B | Plain B | Birth B | Removal marks B |
| --- | --- | --- | --- | --- |
| 0 | 632,834 | 333,308 | 0 | 0 |
| 1 | 715,352 | 333,445 | 37,168 | 43,799 |
| 2 | 776,089 | 333,582 | 76,474 | 62,104 |
| 5 | 986,864 | 334,010 | 185,436 | 154,946 |
| 10 | 1,429,263 | 335,448 | 397,927 | 368,221 |
| 20 | 2,283,750 | 338,095 | 800,532 | 788,383 |

First measured sample day over 2 MiB: 19.

### large, 4 people: measured at 10 new words each per sample day, plus corrections and rewrites

| Sample day | Encoded B | Plain B | Birth B | Removal marks B |
| --- | --- | --- | --- | --- |
| 0 | 632,834 | 333,308 | 0 | 0 |
| 1 | 793,529 | 333,582 | 70,920 | 85,231 |
| 2 | 970,894 | 333,856 | 149,922 | 178,627 |
| 5 | 1,478,032 | 335,586 | 419,454 | 395,430 |
| 10 | 2,389,548 | 337,885 | 891,406 | 803,573 |
| 20 | 4,143,500 | 342,170 | 1,835,032 | 1,550,450 |

First measured sample day over 2 MiB: 9.

## Full-volume horizons: extrapolations, not observed days

### long, 1 people: extrapolated at 5,000 words each per day

| Working day | Encoded B (fit) | Plain B (fit) | Beyond last measured sample |
| --- | --- | --- | --- |
| 1 | 26,659,052 | 195,914 | 7.6x |
| 2 | 76,322,561 | 590,118 | 15.1x |
| 5 | 363,738,587 | 3,192,517 | 37.8x |
| 10 | 1,304,183,686 | 12,262,481 | 75.7x |
| 20 | 4,915,392,810 | 48,149,773 | 151.3x |
| 60 | 42,431,148,353 | 428,330,470 | 453.9x |

### long, 2 people: extrapolated at 5,000 words each per day

| Working day | Encoded B (fit) | Plain B (fit) | Beyond last measured sample |
| --- | --- | --- | --- |
| 1 | 80,882,316 | 308,936 | 7.6x |
| 2 | 252,613,859 | 922,207 | 15.1x |
| 5 | 1,313,302,641 | 4,818,084 | 37.8x |
| 10 | 4,899,431,151 | 18,164,756 | 75.7x |
| 20 | 18,890,365,169 | 70,558,886 | 151.3x |
| 60 | 165,769,794,605 | 622,812,578 | 453.9x |

### long, 4 people: extrapolated at 5,000 words each per day

| Working day | Encoded B (fit) | Plain B (fit) | Beyond last measured sample |
| --- | --- | --- | --- |
| 1 | 153,814,334 | 241,007 | 22.7x |
| 2 | 461,948,807 | 443,671 | 45.4x |
| 5 | 2,312,671,876 | 1,051,665 | 113.5x |
| 10 | 8,484,942,485 | 2,064,988 | 227x |
| 20 | 32,408,479,316 | 4,091,633 | 453.9x |
| 60 | 282,489,234,754 | 12,198,216 | 1,361.8x |

### large, 1 people: extrapolated at 5,000 words each per day

| Working day | Encoded B (fit) | Plain B (fit) | Beyond last measured sample |
| --- | --- | --- | --- |
| 1 | 24,140,539 | 975,386 | 22.7x |
| 2 | 64,121,570 | 2,861,558 | 45.4x |
| 5 | 282,904,587 | 15,984,647 | 113.5x |
| 10 | 977,009,382 | 62,738,365 | 227x |
| 20 | 3,600,718,122 | 249,552,935 | 453.9x |
| 60 | 30,568,874,962 | 2,240,906,348 | 1,361.8x |

### large, 2 people: extrapolated at 5,000 words each per day

| Working day | Encoded B (fit) | Plain B (fit) | Beyond last measured sample |
| --- | --- | --- | --- |
| 1 | 132,803,545 | 1,250,722 | 22.7x |
| 2 | 462,968,084 | 3,859,080 | 45.4x |
| 5 | 2,641,424,702 | 21,829,821 | 113.5x |
| 10 | 10,232,062,357 | 85,599,945 | 227x |
| 20 | 40,262,875,045 | 339,961,030 | 453.9x |
| 60 | 358,379,957,474 | 3,048,349,833 | 1,361.8x |

### large, 4 people: extrapolated at 5,000 words each per day

| Working day | Encoded B (fit) | Plain B (fit) | Beyond last measured sample |
| --- | --- | --- | --- |
| 1 | 154,418,665 | 535,973 | 22.7x |
| 2 | 462,588,250 | 738,637 | 45.4x |
| 5 | 2,313,399,513 | 1,346,631 | 113.5x |
| 10 | 8,485,759,992 | 2,359,954 | 227x |
| 20 | 32,409,262,361 | 4,386,599 | 453.9x |
| 60 | 282,487,023,897 | 12,493,182 | 1,361.8x |
