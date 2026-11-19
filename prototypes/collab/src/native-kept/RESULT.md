# E14 · Keep a removed beat's record and visual cell

**Verdict.** Keeping the containers preserves unseen visual text, visual tags and fields through a cut and undo. A single unseen move also survives, so the beat stays where it was moved. A tag on narration that was cut and restored offline can still be lost. Both versions have the same competing-move failure. Undoing the winning move can leave a beat with no rank even before anyone cuts a row. A later cut of a different beat can then send it across a scene line. Both versions show that failure in all five deliveries. The independent review found no never-acceptable outcome introduced by keeping the containers.

A beat is a script row or a member of a joined row. Its narration shares a segment of text with other beats. Each beat begins at a marker in that text, or at the segment's `head` key. The record holds fields and a rank, the sortable key for its position. An **orphan** is a record or visual cell with no surviving boundary. **Settled** means every copy has received every update.

## Comparison

Both versions use Yjs 13.6.33, separate heading name cells, flat ranks, every E11 reading rule and the default undo delete filter. Each pair starts with the same recorded commands and delivery schedule.

| Case | E11 built | E14 kept |
| --- | ---: | ---: |
| E9 cut with no undo, unseen status writes and visual inserts still stored outside the row | 0 status, 0 visual | 61 status, 61 visual |
| E10 cut with no undo, unseen field and visual insert both still stored | 0 of 8 | 8 of 8 |
| E14 cut with no undo, latest visual, status, lens and visual tag still stored | 0 of 40 each | 40 of 40 each |
| E14 cut undone offline, latest visual, status, lens and visual tag shown | 0 of 40 each | 40 of 40 each |
| E14 cut undone after receiving the unseen edits, same four values shown | 0 of 40 each | 40 of 40 each |
| Same two undo sets, unseen narration tag shown after settling | 0 of 80 | 0 of 80 |
| Same two undo sets, B shown at its unseen drop under H | 0 of 80 | 80 of 80 |
| Undo after the crossing move arrives, restored beat lacks its rank, prior status or prior lens | 40 of 40 each | 0 of 40 each |
| E11's three original rule (e) fixtures need the fallback, across five deliveries | 15 of 15 | 0 of 15 |
| E11 second review's single-move drift after deleting A | 5 of 5 | 0 of 5 |
| Competing moves, winner undoes and B loses its rank before any cut | 5 of 5 | 5 of 5 |
| Same competing moves, later cut of A moves B across the scene line | 5 of 5 | 5 of 5 |

The smallest visual crossing starts at `B: def / 2`. Copy 1 types `Ω` at the end of the visual and copy 0 cuts B. Before sync, each sees its own change. After sync, both have no B row. With E11 the visual is gone. With E14 the orphan reads `2Ω`. If copy 0 undoes its cut before the sync, the two versions settle on `B: def / 2` and `B: def / 2Ω`. Undo after the sync gives the same two readings. The status and lens in the focused tests each overwrite an initial value. The visual tag marks the original `2`. The narration tag marks the original `d`. Undo creates fresh narration letters. A mark on the old letter can appear locally during the exchange and still disappear when copies settle.

### Where B returns

In the E11 second-review fixture the stored order is `A, B, #H`. Copy 0 moves A into H and cuts B. Copy 1 moves B into H before seeing either action. Copy 0 receives that move and undoes its cut. In both versions it sees `#H, A, B`. Copy 0 deletes only A. E11 shows `B, #H`. E14 shows `#H, B` because B still has the rank from copy 1.

The smallest competing-move failure uses two people and the same initial order. It needs no cut before the rank disappears.

1. Copy 0 moves A into H and sends that move to copy 1.
2. At the same moment, copy 0 moves B below A and copy 1 moves B directly under H.
3. Both moves arrive. Copy 1 has the higher client number, so its rank wins and both copies show `#H, B, A`.
4. Copy 1 undoes its move. B has no rank. Rule (e) places it from the nearby stored ranks. After the undo arrives, both copies show `#H, A, B`.
5. Copy 0 deletes only A. Both copies and a fresh copy show `B, #H`. B has changed scene in both versions.

Both moves write the same key on B's record. Yjs keeps the higher client's write and deletes the losing write on arrival. The winner's undo deletes its own write and tries to bring back the old value. Standard undo declines to redo that old entry while the other client's losing entry sits after it in the key's history. The losing write was never part of the winner's undo entry, so the key ends empty. The reviewer confirmed this with a bare `Y.Map`. Undoing the losing move leaves the winner's value in place. The choice of which containers a cut leaves has no effect on this failure. The earlier three-writer case with a cut and undo of B still reproduces the same drift.

Rule (e) is still needed. It also applies to redoing a heading's creation after an unseen scene move. The heading has no rank in either version and its name is still editable. A split of a beat with a valid retained rank copies that rank. A split of a rankless beat still has no rank of its own. The beat record and visual cell were present on every shown beat in these checks. Status, lens and join are editable fields. They can be absent by intent or because an independent undo changed a field.

The reviewer also measured the stock `Y.UndoManager` option `ignoreRemoteMapChanges`, which Yjs labels experimental. It gave zero rankless beats in both versions across all 600 mixed histories and five deliveries. With the default in the same set, five E11 histories and three E14 histories needed rule (e). With the option enabled, undoing the winning competing move put B back before H, giving `B, #H, A`. The later cut of A left B there. The cost was overwriting another person's later change. In the reviewer's status example, copy 0 sets `ready` over `todo`, copy 1 sees that and sets `done`, and copy 0's undo changes `done` to `todo`. Undo can overwrite a later move the same way. These are the reviewer's measurements. E15 compares remedies separately.

### Earlier and new histories

The generated E11 schedules are made with name cells and played unchanged in each design. Delivery modes are forward, reversed, repeated, shuffled and full state. The counts below sum orphan ids at settlement. For E10, E11 and E14, observational counts use the forward run per seed. E9 has 37 named and 2,220 generated runs, spread over the five deliveries in its original schedule.

| Set | Runs per version | E11 orphans | E14 orphans | E11 rankless histories | E14 rankless histories | E11 never acceptable | E14 never acceptable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| E9 named and generated | 2,257 | 0 | 2,440 | 0 | 0 | 0 | 0 |
| E10 named and generated | 1,145 | 0 | 55 | 0 | 0 | 0 | 0 |
| E11 mixed, 600 seeds | 3,000 | 0 | 1,223 | 5 | 3 | 0 | 0 |
| E11 same-moment double split, 200 seeds | 1,000 | 0 | 290 | 1 | 1 | 0 | 0 |
| E14 focused, 360 seeds | 1,800 | 0 | 80 | 40 | 0 | 0 | 0 |
| Named single-move drift | 5 | 0 | 1 per run | 1 | 0 | 5 | 0 |
| Named competing-move drift with cut and undo | 5 | 0 | 1 per run | 1 | 1 | 5 | 5 |
| Named competing-move drift with no prior cut | 5 | 0 | 1 per run | 1 | 1 | 5 | 5 |

There was no narration without an edit route, no missing or repeated beat, no narration copied by a prototype command, no reader or writer throw and no settled disagreement in the generated runs. Five recorded steps are unavailable in E14 because a retained join makes C part of another row. Mixed seed 186 has a move and a join, mixed seed 513 has a join, and double-split seed 186 has a move and a join. The harness skips the joins. It runs the moves and checks that they return false. Those histories stay in the run totals, and all five steps count toward the reported command totals. The harness continues through the recorded schedule. After a skipped or refused step, the kept run no longer matches the E11 run step for step.

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

### Side effects of keeping the containers

**Undo can report success while the screen stays the same.** One person types in A, sets B's status to `ready`, then receives someone else's cut of B. In E14, one undo changes the hidden status back to `todo` and leaves A's typing visible. In E11, the same press passes over the removed status and undoes the earlier visible typing in A.

**The inherited recovery reader lists cut beats with non-empty visuals.** After cutting B, D and F, E14's `recovery()` lists B, D and F as unplaced. E11's list is empty. A product reader for the kept version would need to exclude these orphans from that list. The inherited recovery list is the only reader that loops over the record or visual maps in this setup. The ordinary outline and the by-id orphan query make keyed reads.

## Storage and speed

Each fixture has 30 beats per segment. Each beat starts with 120 narration characters, 48 visual characters, a status and a rank. The edited fixture overwrites the status, inserts a four-character marked visual edit and deletes four other visual characters. Byte counts use standard encoded updates from a fresh receiving copy with garbage collection enabled. The fixture cuts every beat in one transaction. This makes E11's leftover deletion records as small as possible and inflates the ratio between versions. The added bytes per row are the meaningful comparison. They are a low estimate for cells edited over many sessions.

| Deletions | E11 plain bytes | E14 plain bytes | Extra bytes per plain beat | E11 edited bytes | E14 edited bytes | Extra bytes per edited beat |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 30 | 1,089 | 4,023 | 97.8 | 1,089 | 5,881 | 159.7 |
| 300 | 11,689 | 41,859 | 100.6 | 11,693 | 62,985 | 171.0 |
| 900 | 35,749 | 127,019 | 101.4 | 35,753 | 192,545 | 174.2 |

At 900 deletions the editing copy encodes 247,418 plain bytes and 305,927 edited bytes for E11, and 250,777 plain bytes and 316,307 edited bytes for E14. In the fresh state, a marginal breakdown obtained by clearing cell text, then deleting each visual cell, is 53.5 bytes for the record, 1.0 for the cell and 46.9 for its text in the plain case. In the edited case it is 60.5 bytes for the record, 18.6 for the cell and 95.2 for its text. Encoded runs and deletion metadata are shared, so those are effects of the test deletions. The full kept premium at 900 is 0.60 bytes per original narration or visual character for plain beats and 1.04 for edited beats. On this fixture the edits and their retained structure add 72.8 bytes per removed beat to the premium.

Full reads rebuild the outline. A keystroke inserts a plain narration character and updates the affected row. The table gives the range of run medians in milliseconds on Node 24.22.1, from three passes with 51 timed reads and 201 timed keystrokes per pass. Each version has the same 900 live beats and the same deleted segments. E11 has zero orphan cells.

| Prior deletions | E11 full read | E14 full read | E11 key | E14 key |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 11.85–12.22 | 11.48–12.05 | 0.278–0.281 | 0.274–0.283 |
| 900 | 11.64–12.17 | 11.67–12.02 | 0.280–0.281 | 0.276–0.277 |
| 9,000 | 12.26–12.73 | 13.23–14.15 | 0.271–0.276 | 0.274–0.291 |

Instrumentation counts zero scans of the beat-record or visual maps for a full outline read or keystroke, even at 9,000 orphans. The keyed reads are 7,200 built and 6,300 kept on a full read, and 60 in either version for one key. E14 skips the legacy beat-removal flag lookup. A full rebuild still visits the segment list. The full-read gap varied in the independent review. The reviewer measured 7.02 ms for E11 against 7.18 ms for E14 in one run and 7.31 ms against 8.73 ms in another.

## Offline notice and privacy

After the cut and the unseen visual insertion settle, a copy with B's id can read `2Ω`, its marks and its current fields from the shared document. The smallest history also checks a fresh copy. The person who cut B can undo the cut and get the exact current visual and fields without copying someone else's saved reading. A fresh copy can read the same orphan and has no local cut to undo. Reading the orphan cannot reconstruct the cut narration, identify every surviving narration letter's former beat, recover overwritten field values, or tell who should be notified. The ordinary outline ignores the orphan. The explicit orphan query reads the record and cell by id.

E12's separate “put it back” command creates a fresh beat from a saved reading. A command of that kind could use the latest retained visual and fields. It would still need a source for the narration, a position and a fresh id. This experiment exercises only the read and the local undo. [E12 put-back behaviour](../native-notice/RESULT.md#put-it-back)

**Garbage collection is on in both versions.** While the cutter's undo history holds the cut, the cutter's full encoded state still contains the cut beat's narration, visual text, tags and fields. This applies to both versions. A copy without that undo history, such as a server or a fresh joiner, drops the deleted payload through garbage collection. Earlier saved states and updates can still contain those bytes.

In a copy after that collection, E11 leaves only the deleted beat's id readable as a map key in deletion metadata. In E14, the removed beat's status, other fields, rank, visual text and the tags on that text stay readable and reach later copies. The cut narration is gone. A spot check looked for narration, visual text, status, the tag and the beat id in the cutter's encoded state and in a fresh copy's re-encoded state.

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

The expected E9 storage uses E11's plain delete model and E9's allowed merge orders. E14 changes the model by retaining the plain record and visual maps before merging a fork. It moves heading names into separate plain values. The focused model reuses E11's ledger for narration cut and restoration versions. It supplies the initial text, cut members, known deliveries and press targets from the recorded commands. It tracks the retained visual, visual tags, fields and positions independently. It leaves the narration tag open when the tag arrives before undo. The prior E10 and E11 stress replays check invariants when Yjs decides the merge.

| Value read from the implementation | What that limits |
| --- | --- |
| E11 generator's acting rows, offsets, stacks and rule-read split selections | Used to make the prior corpus. It cannot prove the generated intentions were chosen independently of E11. The same recorded steps feed both variants. The new focused generator chooses from its own fixture and commands. |
| Outline, row order, members, status and heading recovery | The actual view under test. Comparing views alone cannot establish which concurrent move a person wanted. Named and focused cases supply exact expected rows. |
| Raw order, head keys, segment and cell deltas, fields and name cells | These check stored content, coverage and settled agreement. Using the library's deltas cannot reveal hidden payloads still held by an older update. |
| E9 settled status and visual readings | The E14 retained counts of 61 status and 61 visual, and the E11 counts of zero status and zero visual, come from the model's predicted settled state. The test asserts that the implementation's settled state matches. |
| Resolved editor spans and narration letter identities | Used to check each stored narration position has a route and prose-preserving commands keep the same letters. These checks do not exercise a browser selection or composition. |
| Rank presence, fallback hits, before and after rank order, and available row heads | These detect missing ranks, unrelated local drift and commands whose old row id is no longer current. They do not independently choose the winner of competing ranks. |
| Boundary presence around cuts and history presses in the mixed audit | The crossing audit takes which beats were cut and restored from the copies' actual readings. It cannot supply an independent expectation for every mixed undo or redo. Candidate selection is narrower than the E11 ledger. |
| Settled narration tags in the focused comparison | The table reports the observed narration-tag outcomes. The focused model leaves the outcome open when the tag arrives before undo. |
| Mark keys and their decoded names, snapshot equality, and stored object identity | Used to check tags, zero writes from orphan reads and the same objects on restore. This shares the mark decoder and does not predict concurrent formatting marker order. |
| Encoded text and decoded map keys in the privacy spot check | These show which sample values remain in the cutter's full state and in a fresh copy's state. The sample does not cover older saved updates. |
| Update packets, encoded state, observed calls, elapsed time and map access counts | These supply delivery, mute targets and measurements. They do not prove effects outside the checked schedules, internal undo call coverage or app rendering cost. |

## Owner question

Which should a beat cut do?

- **(a) Remove the record and visual cell as decided.** One person can cut a row and take back that cut, cancelling their own edit. The restored row can still lose somebody else's unseen visual text, status and visual tags. A later copy loses access to the removed visual and fields after garbage collection.
- **(b) Keep the record and visual cell.** The unseen visual text, status and visual tags come back with the row. An unseen join can make it come back joined. An undo can report success without a visible change. The removed row's visual text and fields stay readable in the stored script, at about 100 to 175 added bytes per removed row in these fixtures. The containers stay for the script's life unless a separate clean-up removes them.

The competing-move rank loss and drift are the same in both choices. The rank can disappear before anyone cuts a row.

The least certain result is how much the 9,000-orphan timing gap depends on the memory layout of this fixture, and how often mixed histories expose the remaining rank failure. Generated counts are observations from these seeds. The two-person competing-move failure is reproducible in every checked delivery.

From `prototypes/collab`, run `npm test` or `node --test "test/native-kept/*.test.ts"`. Run `node src/native-kept/cost.ts` for storage and timing.
