# Stage 2: reconcile stored bytes and repeated working days

## Decision

The earlier figures describe different quantities: Stage 1's published 5.94 bytes per typed character divides the entire retained document by typing, while Stage 2's 320 bytes measures one new unformatted key. That distinction does not explain the storage gap. On the same typing/retyping schedule and whole-document basis, Stage 1 is **4,511 B per 1,000 typed characters** and Stage 2 is **568,361 B**, about **126 times larger**. The corresponding unformatted marginal controls are **1,016 B per 1,000 keys** for native coalescing and **320 B for one Stage 2 key**. After 100 mark additions in a cell, a new local key stores **5,223–5,224 B**: its birth names those additions. The rate grows with a cell's marked history.

Replaying the same Stage 1 typing and retyping in the real Stage 2 adapter gives **6,415,088 bytes with two writers** and **6,404,190 with six**. Both contain exactly **11,287 typed characters and 10,478 final characters**, including the prototype's convention for atom labels. Stage 1 at the same point occupies **50,914 bytes**. Three causes explain the difference: every insertion stores a birth (310 B in the one-key control; range and keys/framing together occupy about **3.14 MB** in the replay); interleaved metadata prevents native text coalescing (**2,518 → 54,161 B** of text identity); and each birth copies the cell's known additions into an observed list (**2,854,447 B, 44.5%**). Each marked key creates an addition bound to that insertion, and `text-executor.ts` copies all cell additions into every later birth. The replay has **70,683 references, 6.3 per birth**, with marked typing in **37 of 60 cells**. For marked typing within a cell this makes the copied lists grow quadratically. Writer identity occupies **101,664 B, 1.6%**, a smaller component. The ledger below accounts for every byte. The original Stage 1 full block still reproduces **67,095 / 67,096 B**; its structural and production tail is excluded from both sides of this text comparison.

This measurement does not recommend changing the format yet. A growing run must first demonstrate immediate per-key delivery, selective undo, concurrent marks and recovery. Sharing an observed-mark set may save more than shortening anchors, but changing or truncating that set can change which concurrent formatting applies. Piece C is that correctness trial. None of the 2 MiB, 3x fresh, 10x edited or input gates changes here. **Every Stage 0 local-input result remains not measured.** No timing or browser measurement ran for this record.

Repeated reopenings do not reset the cost. The tables track 60 reduced-volume **sample sessions** on the one- and two-person long script, and 20 on the other cases, with 10 new words per person plus corrections and rewrites (about 66 keys each per session). Whole-beat removal/restore retains observed content as well as tombstones. Every checkpoint is reported with its complete size and with removal marks subtracted, an accounting comparison rather than a run without those commands. A separate default-volume prefix establishes the first over-cap block during the first writer's typing phase of **day 1**, before that person's 30,000-key allocation is complete, for either fixture and any requested group size. No full-volume day total is claimed because the measured samples do not establish growth at that typing volume or distribution. A storage recommendation needs the trial's repeated-session results as well as its run-length savings.

## What was run

Product source is `cafd0a73dfb0cd373b19e84b3503761e5e740840`, fetched from `origin/main`, including #1605 and #1606. Node is 24.22.1, x64 on native Windows x64. Byte counts are deterministic; there are no timing percentiles, speed assertions, heap measurements or browser suites. New files under `tests/collab/measure` drive the real adapter. A byte-only entry outside the pinned Stage 1 lifetime source folder captures its text calls; the measurement runner launches it as a subprocess, respecting the prototype import boundary.

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

The scripts run the same existing long and ten-copy large audit fixtures, for 1, 2 and 4 writers. Default requested volume is 5,000 words each per working day, six keys per word, counting original typing, correction retyping and rewrite typing. The measured samples allocate 10 words of **new drafting** each per sample day, then add the stated corrections and rewrites. The raw `measuredWordsPerPersonPerDay` field denotes that new-drafting allocation; exact counters distinguish every typing kind. Every new character is a separate real adapter operation. Writers take causal turns under fixed deterministic replica ids 1–4, reused after binary reopening; this is capacity measurement, not evidence about concurrent correctness or a future replica-identity persistence protocol. `capacity-prefix.mjs` separately executes the first writer's typing phase (including corrections), checking encoded size every 100 original keys and stopping after the first over-cap block. It crosses well before the total 30,000-key allowance, even after reserving that day's rewrite share. Later people's input or later structural edits cannot move that first crossing to a later day. The 100-original-key interval, not an exact key index, is reported. This establishes day 1 without allocating every over-cap full day.

The correction schedule is Stage 1's stated one per 55 keys, based on Stage 0's 55-key typing case. Rewriting deletes and individually retypes one twelfth of new text: five of thirty beats, half each, as in the lifetime schedule. The Stage 2 growth tool's heavy-use schedule (`stage-2-growth-admission.md`, Measurement method), rather than a measured user rate, supplies one split and one join per 200 new keys, two removals per 200 keys, and one bold operation per 100 keys. Stage 0 supplies the gate counts only. Each structural operation is undone; each bold operation gets one undo/redo pair. Stated additional parameters are one beat creation (undo, redo, undo), comment with anchor mark, B-roll keying and Replace splice per 1,000 new keys. Unlike the growth tool, which removed an untyped beat, `working-days.mjs` removes a beat being typed and rewritten, retaining heavier removal observations. The counters are recorded. Short sampled sessions can have no threshold event; a full default day includes every family. Undo operations themselves create retained provenance.

Typing rotates through existing beats in 55-key blocks, starting at a different beat for each sample day and writer; two existing beats exercise joins with undo. The initial attempt to put a whole default day in one cell was stopped for run time before producing a cap result; it supplies no tabled number. Additions use the actual segment-create handler; keying uses `sharedBrollKeying`; Replace uses the same `sharedCellTextOperations` splice builder and undo executor as its application command. This bypasses UI search and focus handling, which are not measured. End-of-day local undo objects are released. The exact binary document is encoded, destroyed and reopened through `applySharedUpdate`; its encoded bytes must remain identical. No instance is reconstructed from a plain projection, and no compaction is performed. Stage 2 does not yet ship persisted shared-session reopening: this is the existing adapter's binary round trip, not a claim about a production persistence UI. [Rule 97](https://github.com/RetroGorilla/splitpage/issues/1414#issuecomment-6869752297) keeps saving and cleanup for later stages.

All measured category rows and plain sizes remain in the six adjacent `stage-2-working-days-<fixture>-<people>.json` files. Their legacy `day` field counts sample sessions, not full-volume working days. The [complete category table](stage-2-working-days-by-category.csv) contains every measured checkpoint, total bytes with removal marks subtracted, and growth per measured keyboard key for every category. `stage-2-working-days-rates.json` contains the same exact arithmetic and the keys typed at the first measured sample-session crossing. The one- and two-person long cases reach sample session 60; the four-person long case and all large cases stop at session 20 under the shared machine's queue and run constraints. Later sessions were not measured.

The workload is append-heavy: new draft text remains, while the rewrite share deletes and retypes existing text. Command-inserted beat text, the B-roll seed line and Replace output are included in encoded/plain growth but excluded from keyboard-key counts. A steady-length script was not measured. The default-volume first-day crossing is observed independently by the measured prefix. Full-volume totals are not fitted.

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

Use 60 as the final argument before the output file for the one- and two-person long cases, 20 for the four-person long and all large cases. Run `node tests/collab/measure/capacity-prefix.mjs` and `node tests/collab/measure/key-rates.mjs` sequentially for the separate controls, each after its memory check. Keep at least 3,000 MB available. Use the coordinator's external shared lock for heavy runs; its location is deliberately not committed. Each repeated-session command writes a local, ignored encoded checkpoint under `.cache` and resumes it on a later invocation. Remove only the matching local checkpoint to replay from day zero. Do not commit those binary instances. After all six results and both controls exist, `node tests/collab/measure/reconciliation-report.mjs` regenerates the following tables, measured-rate JSON and category CSV. Run `node --test tests/collab/measure/retained-bytes.test.mjs` for the fast ledger check.

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
| long | 1, 2, 4 | 1 | 6701-6800 | 2,087,413 / 2,115,671 |
| large | 1, 2, 4 | 1 | 4801-4900 | 2,093,556 / 2,124,913 |

## Repeated sessions: measured samples

Added rates divide growth since session zero by all recorded keyboard keys, including correction and rewrite typing. They include command-generated edits in the numerator. Subtracting removal marks is exact category accounting, not a rerun with removal disabled; other remove/restore effects remain.

### long, 1 people: 10 new words each per sample session, plus corrections and rewrites

| Sample session | Keys typed | Encoded B | B less removal marks | Plain B | Added B/key | Added B/key less removal marks |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 66,469 | 66,469 | 38,342 | n/a | n/a |
| 1 | 66 | 87,106 | 87,106 | 38,402 | 312.7 | 312.7 |
| 2 | 132 | 149,646 | 105,655 | 38,479 | 630.1 | 296.9 |
| 5 | 330 | 260,437 | 161,880 | 38,693 | 587.8 | 289.1 |
| 10 | 660 | 419,875 | 267,681 | 39,044 | 535.5 | 304.9 |
| 20 | 1,321 | 742,359 | 470,472 | 40,439 | 511.7 | 305.8 |
| 60 | 3,965 | 2,258,923 | 1,401,578 | 45,589 | 553 | 336.7 |

First measured sample session over 2 MiB: 56; 3,701 keys typed.

### long, 2 people: 10 new words each per sample session, plus corrections and rewrites

| Sample session | Keys typed | Encoded B | B less removal marks | Plain B | Added B/key | Added B/key less removal marks |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 66,469 | 66,469 | 38,342 | n/a | n/a |
| 1 | 132 | 148,987 | 105,188 | 38,479 | 625.1 | 293.3 |
| 2 | 264 | 209,724 | 147,620 | 38,616 | 542.6 | 307.4 |
| 5 | 660 | 420,499 | 265,553 | 39,044 | 536.4 | 301.6 |
| 10 | 1,321 | 862,896 | 494,675 | 40,482 | 602.9 | 324.2 |
| 20 | 2,643 | 1,715,693 | 928,999 | 43,129 | 624 | 326.3 |
| 60 | 7,930 | 5,534,132 | 3,122,159 | 54,450 | 689.5 | 385.3 |

First measured sample session over 2 MiB: 26; 3,436 keys typed.

### long, 4 people: 10 new words each per sample session, plus corrections and rewrites

| Sample session | Keys typed | Encoded B | B less removal marks | Plain B | Added B/key | Added B/key less removal marks |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 66,469 | 66,469 | 38,342 | n/a | n/a |
| 1 | 264 | 227,164 | 141,933 | 38,616 | 608.7 | 285.8 |
| 2 | 528 | 404,529 | 225,902 | 38,890 | 640.3 | 302 |
| 5 | 1,321 | 911,665 | 516,235 | 40,620 | 639.8 | 340.5 |
| 10 | 2,643 | 1,823,180 | 1,019,607 | 42,919 | 664.7 | 360.6 |
| 20 | 5,287 | 3,574,862 | 2,026,680 | 47,204 | 663.6 | 370.8 |

First measured sample session over 2 MiB: 13; 3,436 keys typed.

### large, 1 people: 10 new words each per sample session, plus corrections and rewrites

| Sample session | Keys typed | Encoded B | B less removal marks | Plain B | Added B/key | Added B/key less removal marks |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 632,834 | 632,834 | 333,308 | n/a | n/a |
| 1 | 66 | 653,471 | 653,471 | 333,368 | 312.7 | 312.7 |
| 2 | 132 | 716,011 | 672,020 | 333,445 | 630.1 | 296.9 |
| 5 | 330 | 826,802 | 728,245 | 333,659 | 587.8 | 289.1 |
| 10 | 660 | 986,240 | 834,046 | 334,010 | 535.5 | 304.9 |
| 20 | 1,321 | 1,308,901 | 1,036,839 | 335,405 | 511.8 | 305.8 |

First measured sample session over 2 MiB: not reached.

### large, 2 people: 10 new words each per sample session, plus corrections and rewrites

| Sample session | Keys typed | Encoded B | B less removal marks | Plain B | Added B/key | Added B/key less removal marks |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 632,834 | 632,834 | 333,308 | n/a | n/a |
| 1 | 132 | 715,352 | 671,553 | 333,445 | 625.1 | 293.3 |
| 2 | 264 | 776,089 | 713,985 | 333,582 | 542.6 | 307.4 |
| 5 | 660 | 986,864 | 831,918 | 334,010 | 536.4 | 301.6 |
| 10 | 1,321 | 1,429,263 | 1,061,042 | 335,448 | 602.9 | 324.2 |
| 20 | 2,643 | 2,283,750 | 1,495,367 | 338,095 | 624.6 | 326.3 |

First measured sample session over 2 MiB: 19; 2,511 keys typed.

### large, 4 people: 10 new words each per sample session, plus corrections and rewrites

| Sample session | Keys typed | Encoded B | B less removal marks | Plain B | Added B/key | Added B/key less removal marks |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 632,834 | 632,834 | 333,308 | n/a | n/a |
| 1 | 264 | 793,529 | 708,298 | 333,582 | 608.7 | 285.8 |
| 2 | 528 | 970,894 | 792,267 | 333,856 | 640.3 | 302 |
| 5 | 1,321 | 1,478,032 | 1,082,602 | 335,586 | 639.8 | 340.5 |
| 10 | 2,643 | 2,389,548 | 1,585,975 | 337,885 | 664.7 | 360.6 |
| 20 | 5,287 | 4,143,500 | 2,593,050 | 342,170 | 664 | 370.8 |

First measured sample session over 2 MiB: 9; 2,379 keys typed.

## Per-key growth at the measured volumes

Each category is its change from session zero divided by measured keys. Every checkpoint's exact fractions are in the rates JSON and CSV; the final measured checkpoints are below. Displayed rates are rounded.

| Exclusive growth category, B/key | long / 1 people / 3,965 keys | long / 2 people / 7,930 keys | long / 4 people / 5,287 keys | large / 1 people / 1,321 keys | large / 2 people / 2,643 keys | large / 4 people / 5,287 keys |
| --- | --- | --- | --- | --- | --- | --- |
| text content | 1 | 1 | 1 | 1 | 1 | 1 |
| text identity | 5 | 5.6 | 5.3 | 4.5 | 5 | 5.3 |
| birth range | 150.7 | 150.8 | 149.9 | 149.8 | 149.8 | 149.9 |
| birth observed marks | 56.6 | 103.9 | 91.9 | 28 | 47.8 | 91.9 |
| birth stamp or author | 9 | 9 | 9 | 9 | 9 | 9 |
| birth keys and framing | 96.8 | 96.9 | 96.2 | 96.2 | 96.2 | 96.2 |
| mark additions | 4.8 | 4.8 | 4.7 | 4.8 | 4.7 | 4.7 |
| mark removals | 2.5 | 2.5 | 2.5 | 2.5 | 2.5 | 2.5 |
| mark copies | 0.1 | 0.1 | 0.1 | 0.2 | 0.1 | 0.1 |
| deletions | 1.4 | 1.5 | 1.5 | 1.4 | 1.4 | 1.5 |
| split objects | 1.3 | 1.3 | 1.3 | 1.3 | 1.3 | 1.3 |
| retirement observations | 2.8 | 2.8 | 2.8 | 2.8 | 2.8 | 2.8 |
| removal marks | 216.2 | 304.2 | 292.8 | 206 | 298.3 | 293.3 |
| structure | 2.4 | 2.5 | 2.4 | 2.4 | 2.4 | 2.4 |
| undo heading observations | 0 | 0 | 0 | 0 | 0 | 0 |
| undo beat observations | 0.6 | 0.7 | 0.6 | 0.6 | 0.6 | 0.6 |
| undo replacement observations | 0 | 0 | 0 | 0 | 0 | 0 |
| undo keying observations | 0 | 0 | 0 | 0 | 0 | 0 |
| people | 0 | 0 | 0 | 0 | 0 | 0 |
| shots | 0.5 | 0.7 | 0.4 | 0.3 | 0.5 | 0.4 |
| tags | 0 | 0 | 0 | 0 | 0 | 0 |
| comments | 0.1 | 0.1 | 0.1 | 0.1 | 0.1 | 0.1 |
| rest | 1 | 1 | 1 | 1 | 1 | 1 |
| update framing | 0 | 0 | 0 | 0 | 0 | 0 |
| TOTAL growth B/key | 553 | 689.5 | 663.6 | 511.8 | 624.6 | 664 |
| Growth B/key less removal marks | 336.7 | 385.3 | 370.8 | 305.8 | 326.3 | 370.8 |

No full-volume day total is claimed because the samples do not establish growth at that typing volume or distribution.
