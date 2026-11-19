# E14 · Keep a removed beat's record and visual cell

**Verdict.** The cut no longer discards unseen visual text, visual tags or fields. They stay hidden while the beat is gone and come back with the beat. A single unseen move also survives a cut and undo, so the beat stays where it was moved. A tag on narration that was cut and restored offline can still be lost. **The zero-failure requirement is not met.** After two competing moves and an undo of the winning move, a beat can still lose its rank. A later cut of a different beat can then send it across a scene line. Both versions show that failure in all five deliveries.

A beat is a script row or a member of a joined row. Its narration shares a segment of text with other beats. Each beat begins at a marker in that text, or at the segment's `head` key. The record holds fields and a rank, the sortable key for its position. An **orphan** is a record or visual cell with no surviving boundary. **Settled** means every copy has received every update.

## Comparison

Both versions use Yjs 13.6.33, separate heading name cells, flat ranks, every E11 reading rule and the default undo delete filter. Each pair uses the same commands and delivery schedule.

| Case | E11 built | E14 kept |
| --- | ---: | ---: |
| E9 cut with no undo, unseen status / visual insert still stored out of the row, 61 of each | 0 / 0 | 61 / 61 |
| E10 cut with no undo, unseen field and visual insert both still stored, 8 histories | 0 / 8 | 8 / 8 |
| E14 cut with no undo, latest visual / status / lens / visual tag still stored, 40 crossings of each | 0 / 0 / 0 / 0 | 40 / 40 / 40 / 40 |
| E14 cut undone offline, latest visual / status / lens / visual tag shown, 40 crossings of each | 0 / 0 / 0 / 0 | 40 / 40 / 40 / 40 |
| E14 cut undone after receiving the unseen edits, same four values shown | 0 / 0 / 0 / 0 | 40 / 40 / 40 / 40 |
| Same two undo sets, unseen narration tag shown after settling | 0 / 80 | 0 / 80 |
| Same two undo sets, B shown at its unseen drop under H | 0 / 80 | 80 / 80 |
| Undo after the crossing move arrives, restored beat lacks its rank / prior status / prior lens | 40 / 40 / 40 | 0 / 0 / 0 |
| E11's three original rule (e) fixtures need the fallback, across five deliveries | 15 / 15 | 0 / 15 |
| E11 second review's single-move drift after deleting A | 5 / 5 | 0 / 5 |
| E14 competing-move counterexample, drift after deleting A | 5 / 5 | 5 / 5 |

The smallest visual crossing starts at `B: def / 2`. Copy 1 types `Ω` at the end of the visual and copy 0 cuts B. Before sync, each sees its own change. After sync, both have no B row. With E11 the visual is gone. With E14 the orphan reads `2Ω`. If copy 0 undoes its cut before the sync, the two versions settle on `B: def / 2` and `B: def / 2Ω`. Undo after the sync gives the same two readings. The status and lens in the focused tests each overwrite an initial value. The visual tag marks the original `2`. The narration tag marks the original `d`. Undo creates fresh narration letters. A mark on the old letter can appear locally during the exchange and still disappear when copies settle.

### Where B returns

In the E11 second-review fixture the stored order is `A, B, #H`. Copy 0 moves A into H and cuts B. Copy 1 moves B into H before seeing either action. Copy 0 receives that move and undoes its cut. In both versions it sees `#H, A, B`. Copy 0 deletes only A. E11 shows `B, #H`. E14 shows `#H, B` because B still has the rank from copy 1.

The remaining failure uses the same initial order. First move A into H and send that move to all three writers. Copy 0 cuts B. Copy 1 moves B after A and copy 2 moves B directly after H, unaware of that cut. Copy 2 receives copy 1's move and undoes its own winning move. Yjs removes its rank write and does not redo the overwritten entry. Copy 0 receives those updates and undoes the cut. B has a record and a visual cell but no rank. The reader's fallback, rule (e), places B using the neighbouring stored ranks and shows `#H, A, B`. Deleting only A leaves `B, #H`. The copies agree, including a fresh copy. This is a failure of the position requirement.

Rule (e) is still needed. It also applies to redoing a heading's creation after an unseen scene move. The heading has no rank in either version and its name is still editable. A split of a beat with a valid retained rank copies that rank. A split of a rankless beat still has no rank of its own. The beat record and visual cell were present on every shown beat in these checks. Status, lens and join are editable fields. They can be absent by intent or because an independent undo changed a field.

### Earlier and new histories

The generated E11 schedules are made with name cells and played unchanged in each design. Delivery modes are forward, reversed, repeated, shuffled and full state. The counts below sum orphan ids at settlement. For E10, E11 and E14, observational counts use the forward run per seed. E9 has 37 named and 2,220 generated runs, spread over the five deliveries in its original schedule.

| Set | Runs per version | Orphans at settlement, built / kept | Histories that read a beat with no rank, built / kept | Never acceptable, built / kept |
| --- | ---: | ---: | ---: | ---: |
| E9 named and generated | 2,257 | 0 / 2,440 | 0 / 0 | 0 / 0 |
| E10 named and generated | 1,145 | 0 / 55 | 0 / 0 | 0 / 0 |
| E11 mixed, 600 seeds | 3,000 | 0 / 1,223 | 5 / 3 | 0 / 0 |
| E11 same-moment double split, 200 seeds | 1,000 | 0 / 290 | 1 / 1 | 0 / 0 |
| E14 focused, 360 seeds | 1,800 | 0 / 80 | 40 / 0 | 0 / 0 |
| Named single-move drift | 5 | 0 / 1 per run | 1 / 0 | 5 / 0 |
| Named competing-move drift | 5 | 0 / 1 per run | 1 / 1 | 5 / 5 |

There was no narration without an edit route, no missing or repeated beat, no narration copied by a prototype command, no reader or writer throw and no settled disagreement in the generated runs. In E11 mixed seeds 186 and 513, keeping a join makes C part of another row. The old recorded move or join names C as a standalone row. The kept move refuses it and the replay records the two unavailable Join Up selections. The same move and join occur in double-split seed 186. The replays still run the rest of those schedules. No unavailable selection is counted as a successful edit.

E11's earlier ledger counted 131 unseen record losses and 106 unseen visual losses in its wider mixed set. This crossing audit uses the recorded commands and deliveries, plus observed boundaries to identify a cut and whether an undo or redo brought it back. It checks only initial beats cut once in both runs, with the same final visibility. It drops candidates with competing writes to the field, any visual erase on the candidate, or a later undo or redo by the writer.

| E11 audited edit | Eligible | Latest value in E11 | Latest value in E14 |
| --- | ---: | ---: | ---: |
| Mixed, field on a beat that stays removed | 80 | 0 | 80 in orphans |
| Mixed, visual typing on a beat that stays removed | 68 | 0 | 68 in orphans |
| Mixed, field on a beat that returns | 2 | 0 | 2 in rows |
| Mixed, visual typing on a beat that returns | 4 | 0 | 4 in rows |
| Double split, field on a beat that stays removed | 12 | 0 | 12 in orphans |
| Double split, visual typing on a beat that stays removed | 17 | 0 | 17 in orphans |

The standard double undo is counted separately. In the E14 focused set, both deleting B and only one undoing gives one `B: def / 2` in 40 of 40 histories. Both undoing gives one `B: defdef / 2` in 40 of 40. Those counts are the same in both versions. E11's earlier ledger counted three doubling events. The separate stock check saw three extra letters in mixed seed 352 in both versions and zero in the other prior sets. It compares the number of observed letters to the initial letters plus every recorded insertion. It can miss duplicate letters when other copies of the same letter have been removed.

## Other races and writers

The table uses `id: narration / visual`. In the first eight fixtures the unaffected tail is `D: jkl / 4, #H mno, E: pqr / 5, #I stu, F: vwx / 6`. Every copy, including a fresh copy, showed the listed rows in the five deliveries. E11 discards the orphan entries in these rows.

| Race | Rows before the unaffected tail, or complete rows where shown | Data with no visible row in E14 |
| --- | --- | --- |
| Cut B, split B after `d` | `A: abc / 1, N: /, C: ghi / 3` | B's record and `2`. N's boundary survives earlier than C. The cut had already selected `def`. |
| Cut B, split C after `g` | `A: abc / 1, C: g / 3, N: hi /` | B's record and `2` |
| Cut B, join B up to A | `A: abc / 1, C: ghi / 3` | B's record has the join to A and its cell has `2`. After undo in the two-beat fixture, E14 shows one `A+B` row and E11 shows A and B separately. |
| Cut B, join C up to B | `A: abc / 1, C: ghi / 3` | B's record and `2`. C is live and its join to missing B is stored on C without taking effect. |
| Cut the joined row B+C, unjoin C | `A: abc / 1` | B and C's records and `2` and `3`. The join is absent. On undo, E14 shows separate B and C rows. E11 shows the joined row again. |
| Cut A, unjoin neighbouring C from B | `B: def / 2, C: ghi / 3` | A's record and `1` |
| Cut B, move B after C | `A: abc / 1, C: ghi / 3` | B's new rank and `2` |
| Cut B, move C above A | `C: ghi / 3, A: abc / 1` | B's record and `2` |
| Cut scene H, type `Ω` in E's narration and `Ψ` in its visual | `A: abc / 1, B: def / 2, C: ghi / 3, D: jklΩ / 4, #I stu, F: vwx / 6` | E's record and `5Ψ`. H's flagged name remains in heading recovery in both versions. `Ω` is editable in D. |
| Two cuts, one undo, or two cuts and two undos | `A: abc / 1, B: def / 2, C: ghi / 3, #H title` with one undo, `defdef` with two | None at settlement |
| Cut B, undo, receive other people's writes, redo the cut | A, C, H in the focused fixture | B's record with the latest rank and fields and its marked visual. E11 has no B containers after redo. |
| Undo the creation of a split beat, standalone insert or heading | Undoing a split shows `A: abZc / 1`. Undoing an insert shows the original A, B, C and H. Undoing a new heading also shows the original rows. | Neither version leaves the created containers. In 40 split races each, the unseen visual and field go and narration stays. In 40 insert races each, the unseen narration, visual and field all go. In 40 heading races each, the unseen change to the name goes. |

`KeptReplica` uses the existing boundary-based projection. Cutting a row cuts all the narration and beat boundaries it shows, including joined members. A segment and any heading boundary in a displayed narration span stay. A whole scene also flags its heading. No transaction writes an orphan marker.

| Writer | When the id belongs to an orphan |
| --- | --- |
| Type, erase, replace, bold, tag and untag in either column | The command makes no change. Ordinary visual editor lookup treats the cell as missing. |
| Set status or any beat field, join, unjoin | No write. Both ids of a join must avoid orphans. |
| Cut a row or beat | A known orphan is already cut. A bulk cut can still cut its live rows. The old `remove` entry point uses the beat cut. |
| Split, insert, or create a heading above a beat | No write through an orphan target. A new beat also cannot claim an id that already has a record, cell or boundary. The caller still supplies fresh ids. |
| Materialize a narration-only row | An occupied id does not get a new boundary or containers. |
| Move a row or run, or move a scene | A stale row selection is refused. Scene movement resolves current boundaries and can write only the visible selection. |
| Type or erase a heading name, flag or restore a heading | The heading id is looked up in the heading's own data. A beat orphan does not act as a heading. |
| Restore a beat by id | An orphan has nothing for this legacy command to clear. Undoing its cut returns the original id and reuses the very same record and cell. |
| Undo or redo | A standard library press uses its own history. It can still undo or redo an earlier field or visual edit while the beat is absent. A creation undo still deletes the objects that step created. |

## Storage and speed

Each fixture has 30 beats per segment. Each beat starts with 120 narration characters, 48 visual characters, a status and a rank. The edited fixture overwrites the status, inserts a four-character marked visual edit and deletes four other visual characters. Byte counts use standard encoded updates from a fresh receiving copy with garbage collection enabled. The editing copy's undo still holds the cut open, so both versions also encode data needed by its own undo.

| Deletions | Fresh built, plain / edited bytes | Fresh kept, plain / edited bytes | Extra per beat, plain / edited bytes |
| ---: | ---: | ---: | ---: |
| 30 | 1,089 / 1,089 | 4,023 / 5,881 | 97.8 / 159.7 |
| 300 | 11,689 / 11,693 | 41,859 / 62,985 | 100.6 / 171.0 |
| 900 | 35,749 / 35,753 | 127,019 / 192,545 | 101.4 / 174.2 |

At 900 deletions the editing copy encodes 247,418 / 305,927 bytes for E11 and 250,777 / 316,307 bytes for E14. In the fresh state, a marginal breakdown obtained by clearing cell text, then deleting each visual cell, is 53.5 bytes for the record, 1.0 for the cell and 46.9 for its text in the plain case. In the edited case it is 60.5 / 18.6 / 95.2. Encoded runs and deletion metadata are shared, so those are effects of the test deletions. The full kept premium at 900 is 0.60 / 1.04 bytes per original narration or visual character. On this fixture the edits and their retained structure add 72.8 bytes per removed beat to the premium.

Full reads rebuild the outline. A keystroke inserts a plain narration character and updates the affected row. The table gives the range of run medians in milliseconds on Node 24.22.1, from three passes with 51 timed reads and 201 timed keystrokes per pass. Each version has the same 900 live beats and the same deleted segments. E11 has zero orphan cells.

| Prior deletions | E11 full read | E14 full read | E11 key | E14 key |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 11.85–12.22 | 11.48–12.05 | 0.278–0.281 | 0.274–0.283 |
| 900 | 11.64–12.17 | 11.67–12.02 | 0.280–0.281 | 0.276–0.277 |
| 9,000 | 12.26–12.73 | 13.23–14.15 | 0.271–0.276 | 0.274–0.291 |

Instrumentation counts zero scans of the beat-record or visual maps for a read or keystroke, even at 9,000 orphans. The keyed reads are 7,200 built and 6,300 kept on a full read, and 60 in either version for one key. E14 does not look up the legacy beat-removal flag. A full rebuild still visits the segment list. The slower 9,000-orphan full read is measured on this fixture. The counts show it does not come from walking the orphan maps.

## Offline notice and privacy

After the cut and the unseen visual insertion settle, a copy with B's id can read `2Ω`, its marks and its current fields from the shared document. The smallest history also checks a fresh copy. The person who cut B can undo the cut and get the exact current visual and fields without copying someone else's saved reading. A fresh copy can read the same orphan and has no local cut to undo. Reading the orphan cannot reconstruct the cut narration, identify every surviving narration letter's former beat, recover overwritten field values, or tell who should be notified. The ordinary outline ignores the orphan. The explicit orphan query reads the record and cell by id. The inherited recovery view can also list nonempty unplaced visuals on demand.

E12's separate “put it back” command creates a fresh beat from a saved reading. A command of that kind could use the latest retained visual and fields. It would still need a source for the narration, a position and a fresh id. This experiment exercises only the read and the local undo. [E12 put-back behaviour](../native-notice/RESULT.md#put-it-back)

**Removed visual text and field values stay in the shared document and reach every copy that syncs later. Narration removed by real deletion is no longer readable in the shared text.** The author's undo may still restore it. Copies or saved updates that already carried it can retain the earlier bytes.

A later clean-up could delete the orphan record and cell through ordinary Yjs map deletes. It would need an agreement about when no old offline write or undo can still use those containers. Otherwise it can lose unseen edits again or leave an undo with a boundary and no cell. Rebuilding a new shared document from live rows could also drop history. That would invalidate old undo entries and old positions, and old copies would need to start again from the new document. No cleanup is built.

## Controls and evidence

Each selected public Yjs call is replaced with a silent no-op and checked immediately. The focused controls cover each cut, undo of a cut and redo of a cut in the forward schedules. Additional fixtures cover empty heads, disjoint ranges and whole scenes. Counts are calls used, effective mutes and mutes caught by a command assertion. A throw from the command or reader, or a changed call sequence, fails the control. There were none.

| Muted call | Used | Effective | Failed at command |
| --- | ---: | ---: | ---: |
| Cut narration ranges with `Y.Text.delete` | 324 | 324 | 324 |
| Cut the segment head with `Y.Map.delete` | 3 | 3 | 3 |
| Flag the heading in the scene command | 1 | 1 | 1 |
| Undo the cut with the public manager call | 240 | 240 | 240 |
| Redo the cut with the public manager call | 40 | 40 | 40 |
| Remove one component of the orphan lookup | 2 | 2 | 2 |

The lookup has zero write calls. The last two mutes suppress reads. The manager owns its internal replay writes and the controls mute the public press. The off control is E11 built. It loses the visual edit in the three-command offline cut-and-undo case and the rank in the original rule (e) cases. With rank fallback off, the kept version passes those original cut-versus-one-move cases.

The expected E9 storage uses E11's plain delete model and E9's allowed merge orders. E14 changes the model by retaining the plain record and visual maps before merging a fork. It moves heading names into separate plain values. The focused model reuses E11's ledger for narration cut and restoration versions. It supplies the initial text, cut members, known deliveries and press targets from the recorded commands. It tracks the retained visual, tags, fields and positions independently. It leaves the narration tag open when the tag arrives before undo and counts the observed result. The prior E10 and E11 stress replays check invariants when Yjs decides the merge, rather than choosing a winning map write in the model.

| Value read from the implementation | What that limits |
| --- | --- |
| E11 generator's acting rows, offsets, stacks and rule-read split selections | Used to make the prior corpus. It cannot prove the generated intentions were chosen independently of E11. The same recorded steps feed both variants. The new focused generator chooses from its own fixture and commands. |
| Outline, row order, members, status and heading recovery | The actual view under test. Comparing views alone cannot establish which concurrent move a person wanted. Named and focused cases supply exact expected rows. |
| Raw order, head keys, segment and cell deltas, fields and name cells | These check stored content, coverage and settled agreement. Using the library's deltas cannot reveal hidden payloads still held by an older update. |
| Resolved editor spans and narration letter identities | Used to check each stored narration position has a route and prose-preserving commands keep the same letters. These checks do not exercise a browser selection or composition. |
| Rank presence, fallback hits, before and after rank order, and available row heads | These detect missing ranks, unrelated local drift and commands whose old row id is no longer current. They do not independently choose the winner of competing ranks. |
| Boundary presence around cuts and history presses in the mixed audit | Used to classify actual crossings. It cannot supply an independent expectation for every mixed undo or redo. Candidate selection is narrower than the E11 ledger. |
| Mark keys and their decoded names, snapshot equality, and stored object identity | Used to check tags, zero writes from orphan reads and the same objects on restore. This shares the mark decoder and does not predict concurrent formatting marker order. |
| Update packets, encoded state, observed calls, elapsed time and map access counts | These supply delivery, mute targets and measurements. They do not prove effects outside the checked schedules, internal undo call coverage or app rendering cost. |

## Owner question

Which should a beat cut do?

- **(a) Remove the record and visual cell as decided.** Later copies cannot read the removed row's current visual or fields. A person who undoes the cut can get the old cell, miss unseen work and see a rankless beat fall back to its stored place.
- **(b) Keep the record and visual cell.** A cut still removes the row. Undo can bring it back with the current visual, fields, join and unseen move. Those values are still shared while the row is absent. The measured storage grows with deletions. The competing-move drift remains under standard undo.

The least certain result is how much the 9,000-orphan timing gap depends on the memory layout of this fixture, and how often mixed histories expose the remaining rank failure. Generated counts are observations from these seeds. The shortest competing-move failure is reproducible in every checked delivery.

From `prototypes/collab`, run `npm test` or `node --test "test/native-kept/*.test.ts"`. Run `node src/native-kept/cost.ts` for storage and timing.
