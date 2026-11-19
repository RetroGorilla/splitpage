# E7: moving beats and scenes

## Status

- **Measured with the old removal rule.** The owner decided today that removing a beat is a real Yjs deletion with no `removed` mark. E7 was built and measured with the mark. Under the new rule, a placement's anchor can disappear. That case is not tested here.
- **Not the only option.** A follow-up experiment compares placement with a smaller rule: a rank at the start of a run of beats, read in Yjs text order. Placement is the fallback if that smaller rule fails.
- **One path is untested.** A move can fall back to pinning every block. That never ran in the generated histories and should not ship untested.

## Verdict

Candidate (d) holds: a placement value on the block's own record.

- A moved beat or heading stores one value, `place = {a, n, u}`, as a plain key on its record in `beats` or `headings`. `a` is the block it is shown after (or none, for the top). `n` is a stamp. `u` is where the beats that travel with it end.
- Text never moves. A move writes only `place` keys, with `Y.Map.set`. Unmoved blocks keep the order they have today: `order`, then text order.
- This is a stored-shape change, but only an addition: one optional key on existing records. Documents without it read as before.
- E2 and E5 tests pass unchanged against the new reader: 455 tests in `test/native` and `test/native-undo`. Neither makes a move, so their results are identical.
- The design draft's appendix D move refusal can go. The movable unit is any run of shown blocks: one row, several rows, or a heading with its beats. A beat in the middle of a shared segment moves without copying, because only its record changes.

The candidates that use plain Yjs patterns fail on reproduced defects (table below). (d) is the smallest thing found on top of the library. It still adds our own reading rule, so under hard rule 12 it needs the owner's decision before anything is built on it.

## How the placement reads

- An unplaced block is shown in natural order.
- A placed block is shown right after its anchor `a`. Several blocks placed after the same anchor are shown newest stamp first, then by id.
- Beats that come after a placed block in its own segment travel with it, up to `u` or the next unplaced heading. That is how a split-off made at the same moment as a move ends up beside the moved beat.
- If placements form a loop, the oldest one in the loop is set aside and the block is shown in natural order.
- An anchor that no longer exists counts as no placement. A removed anchor still counts: it keeps its spot in recovery, and the blocks after it are shown where it was.

A move writes `place` on each moved block. It also writes `place` on any block that only hung on a moved block and must stay behind (a "dependent"). It then checks the result locally and pins any block that is still out of place. In 1,290 generated moves, a move wrote 1.95 keys on average and at most 3 dependents. The "pin everything" fallback never ran.

A split points blocks placed after the split beat at the new second half, so they stay after all of the beat's text. A heading created above a moved beat gets its own `place`, so it appears where the person saw the beat.

## Candidates

200 runs per race, two copies, random delivery. Beats are hydrated with six beats sharing segments. Counts are runs with the defect.

| Candidate | Movable unit; mid-segment beat | 1 Identity | 2 One place | 3 Races | 4 Undo | 5 Cost |
| --- | --- | --- | --- | --- | --- | --- |
| (a) delete and re-insert | the beat's text; copied | fails: typing made during the move stays in the old container, where it is not shown, 200/200; a split-off is left behind 200/200 | fails: two moves store the moved text twice 200/200. The reader shows each beat id once, so a person saw no doubled or missing row (0/200) | fails (see 1) | not tried | 167 update bytes, 92 stored bytes per row move; copies the text |
| (b) number per segment | the segment; a mid-segment beat drags its segment-mates | holds | holds | fails: split then move drags the split-off along 200/200, and so does moving the new beat 200/200 | not tried | small |
| (b) number per block | the block; text stays in its segment | fails: a split-off made at the same moment is left behind 200/200 | holds | fails: two splits come out of typed order 90/200, with this reader (see below) | not tried | small |
| (c) order list of segments | the segment | holds | holds (one entry kept per id) | fails: drags segment-mates 200/200 in both split races | not tried | small |
| (c) order list of blocks | the block | fails: split-off left behind 200/200 | holds | fails: two splits out of typed order 105/200, with this reader (see below) | not tried | small |
| (d) placement on the block | any shown run | holds: 0 in every race; 412 of 416 generated typing cases end in the moved beat, the rest are explained below | holds: 0 | holds: 0 lost, doubled or uneditable in 200 generated histories, each delivered five ways | holds: 7 named undo cases | 36 to 43 update bytes per row move, 16.7 to 18.4 bytes kept per move |

Two notes on the per-block candidates:
- The split-off left behind (200/200) comes from storing a position per block. Text stays in its segment, so a beat split off by someone who has not seen the move stays at the source. A different reader cannot fix that.
- The two splits out of typed order (90 and 105 of 200) depend on the reader. These readers break ties between equal positions by key. An independent analysis read equal positions from the same segment in Yjs text order instead, and that fixed its two-split examples. I did not rerun the 200 races with that reader.

## Numbers

Synthetic script: scenes of 10 beats, 63 narration and 21 visual characters per beat. Layout "own": each beat starts its own segment, as hydration writes it. Layout "scene": each scene is one segment, so every beat is mid-segment. Command: `node src/native-moves/measure.ts --samples=60`. Node 24.22.1, x64.

| Move at 300 beats | Layout | Update bytes | Stored bytes added | Delete and re-insert: update | Delete and re-insert: stored |
| --- | --- | ---: | ---: | ---: | ---: |
| one row | own | 36 | 34 | 167 | 92 |
| run of 5 rows | own | 164 | 162 | | |
| scene of 10 rows | own | 355 | 353 | | |
| one row | scene | 43 | 41 | 104 | 21 |
| run of 5 rows | scene | 199 | 197 | | |
| scene of 10 rows | scene | 425 | 423 | | |

Delete and re-insert stores fewer bytes in the scene layout, because deleted text shrinks to a stub. It still fails on identity.

| 1,000 random row moves at 300 beats | Stored before | Stored after | Kept per move | Blocks placed |
| --- | ---: | ---: | ---: | ---: |
| own | 64,037 | 80,709 | 16.7 | 290 |
| scene | 46,599 | 64,990 | 18.4 | 290 |

What is kept for the document's life: one `place` value per moved block, plus a stub of about 17 bytes for every value it replaced. Nothing grows per keystroke.

Times in ms, median / p95.

| Beats | Layout | Moves first | Read row order | Rebuild every row | One row move | Keystroke, moved beat | Keystroke, unmoved beat |
| ---: | --- | ---: | --- | --- | --- | --- | --- |
| 30 | own | 0 | 0.014 / 0.017 | 0.157 / 0.189 | 0.258 / 0.302 | 0.022 / 0.036 | 0.020 / 0.035 |
| 30 | own | 10 | 0.011 / 0.017 | 0.168 / 0.194 | 0.262 / 0.361 | 0.016 / 0.022 | 0.017 / 0.031 |
| 30 | scene | 0 | 0.012 / 0.013 | 0.150 / 0.180 | 0.200 / 0.303 | 0.053 / 0.085 | 0.076 / 0.088 |
| 30 | scene | 10 | 0.016 / 0.021 | 0.113 / 0.206 | 0.166 / 0.289 | 0.042 / 0.076 | 0.065 / 0.105 |
| 300 | own | 0 | 0.086 / 0.128 | 1.606 / 2.040 | 1.497 / 2.453 | 0.016 / 0.018 | 0.015 / 0.020 |
| 300 | own | 100 | 0.120 / 0.135 | 1.125 / 1.318 | 1.703 / 2.709 | 0.010 / 0.011 | 0.010 / 0.012 |
| 300 | scene | 0 | 0.070 / 0.108 | 1.066 / 1.760 | 1.457 / 1.803 | 0.039 / 0.042 | 0.043 / 0.071 |
| 300 | scene | 100 | 0.110 / 0.202 | 1.641 / 1.844 | 1.561 / 1.961 | 0.040 / 0.044 | 0.069 / 0.084 |
| 900 | own | 0 | 0.273 / 0.442 | 3.413 / 4.059 | 4.789 / 5.711 | 0.010 / 0.014 | 0.010 / 0.014 |
| 900 | own | 300 | 0.436 / 0.690 | 3.713 / 4.468 | 5.202 / 7.123 | 0.017 / 0.039 | 0.019 / 0.027 |
| 900 | scene | 0 | 0.318 / 0.373 | 3.213 / 5.246 | 4.449 / 4.958 | 0.039 / 0.070 | 0.069 / 0.079 |
| 900 | scene | 300 | 0.392 / 0.483 | 4.178 / 5.666 | 5.364 / 6.427 | 0.040 / 0.045 | 0.044 / 0.085 |

- One move at 900 beats: median 4.4 to 5.4 ms, under the proposed 8 ms. The p95 reaches 7.1 ms. About three quarters of it is "rebuild every row", which the reader already does after any structure change (a split or join costs the same). Planning the move itself is about 1 to 1.5 ms.
- Reading the order with 300 placed blocks at 900 beats: 0.4 ms.
- A keystroke never reads the order. Keystroke time is the same in moved and unmoved beats and does not grow with the number of beats or moves.
- One run on one machine. Each row is the median of 60 samples (120 for keystrokes). Differences under about 0.05 ms are noise.

## Generated histories

200 histories, three writers, 30 steps each. Each history is delivered five ways (forward, reverse, twice, shuffled, state) and read by a late joiner from the stored state. The five deliveries of one history give one outcome for a person, so the counts below are per history. The 200 histories hold 4,709 commands. Of those, 662 move one row, 230 move a run, 222 move a scene and 176 move a row into a scene. The rest are typing in narration, visual cells and heading names, plus split, join, unjoin, remove, restore, heading create, rename, remove and restore. The generated histories contain no undo or redo.

| Check | Count |
| --- | ---: |
| Lost characters | 0 |
| Duplicated characters | 0 |
| Characters stored but not editable | 0 |
| Copies that disagree (after settling, including the late joiner) | 0 |
| Blocks not shown exactly once (outline or recovery) | 0 |
| Unmoved blocks out of their natural order | 0 |
| Crashes | 0 |
| Pairs of moves at the same moment that share a block | 640 |

After every command, in every delivery, each copy's stored state, shown order and rows match the model's.

Typing at the same moment as a move of that beat: 416 cases.
- 412 end in the moved beat or in a beat split off it.
- 3 were deleted by a later edit.
- 1 landed in a heading name created at the same spot at the same moment. This is E5's end-of-gap race, not a move effect.

Splits at the same moment as a move of that beat: 234 cases.
- 181: the split-off is shown right after the moved beat.
- 45: someone moved the beat or the split-off again later.
- 6: a heading was created at the same moment between the beat and the split-off, so the split-off sits under that heading.
- 2: two splits at the same spot at the same moment. The other split-off ends the travelling run, so this one stays at the source. Yjs puts the two at the same text position, ordered by client.

Settled rows (forward delivery, one per history): 1,120 rows. 720 have a placed first beat. 984 start inside a shared segment.

### Silent controls

Each control mutes one write at the Yjs call that makes it (`Y.Text.insert`, `insertEmbed`, `delete`, `Y.Map.set` or `delete`, `Y.Array.insert`), only during one command. A control runs in every delivery, so the counts in this table are delivered runs: divide by five for histories. "Used" counts runs whose history has that command. "Effective" counts those where the model says the muted write did something. Every effective run must fail at that same command. A throw or a lost check would count as a failure of the control.

| Command | Muted write | Used | Effective | Failed at that command |
| --- | --- | ---: | ---: | ---: |
| typeBeat | text insert | 990 | 990 | 990 |
| deleteBeat | text delete | 675 | 675 | 675 |
| renameType | text insert | 850 | 850 | 850 |
| renameDelete | text delete | 585 | 585 | 585 |
| create | heading record | 790 | 790 | 790 |
| create | boundary embed, segment and order entry | 790 | 790 | 790 |
| create | name text | 790 | 790 | 790 |
| create | `place` of the new heading | 790 | 380 | 380 |
| removeHeading | flag | 705 | 705 | 705 |
| restoreHeading | flag | 210 | 210 | 210 |
| split | boundary embed | 935 | 935 | 935 |
| split | beat record | 935 | 935 | 935 |
| split | visual cell | 935 | 935 | 935 |
| split | re-pointed `place` | 935 | 365 | 365 |
| join | flag | 900 | 900 | 900 |
| unjoin | flag | 345 | 345 | 345 |
| removeBeat | flag | 715 | 715 | 715 |
| restoreBeat | flag | 220 | 220 | 220 |
| move | `place` of each moved block | 1,000 | 1,000 | 1,000 |
| move | `place` of each dependent | 1,000 | 685 | 685 |

## Named histories

Two copies. Each history runs through all five deliveries plus a late joiner, and must match the model and the literal outline below. Start: `#H0`, B0 "O", B1 "bc", `#H1`, B2 "ef", B3 "gh", B4 "ij". In the first move below, A moves B1 to after B3, and B does the second thing at the same moment.

Requirement 1, identity:
- B types in B1's narration or visual cell: the letter is in B1 at its new place.
- B types in B0, which shares B1's segment: the letter stays in B0, at the source.
- B splits B1: both halves are at the new place, in order.
- B joins B1 up into B0: the person sees B1 joined to B3, the beat now above it.
- A moves B2 below B4. B joins B3 into B2: B3 stays at the source as its own row. Nothing is lost, but the join has no effect.
- A moves B2 and B3 below B4. B joins B3 into B2: the joined row is at the new place.
- Formatting, a tag and a comment added to B1 during the move stay on B1's text at its new place. Both delivery orders and the late joiner agree.

Requirement 2, one place:
- Both move B1, to different places: B1 is in one place, the later writer's.
- Both move B1 to the same place: one place.
- Both move scene H1, to different places: one place.
- A moves scene H1 to the top while B moves scene H0 to the end: the two scenes swap once.
- Overlapping runs (A: B0 and B1 below B3; B: B1, `#H1` and B2 below B4): every block is shown once. Order: `#H0`, B3, B0, B4, B1, `#H1`, B2. Neither person gets quite what they asked for.
- A puts B1 after B3 while B puts B3 after B1: the loop is broken, and B1 ends up after B3.

Requirement 3, races near source and destination:
- B splits B3, the beat B1 lands after: B1 is shown between "g" and "h".
- A moves B2 below B4 while B splits B1, the beat above B2's old place: both halves of B1 stay at the source, and B2 is at its new place.
- B joins B4 into B3: B4 joins B1, which is now the row above it.
- B unjoins a joined row that A moved: both parts are at the new place.
- B removes B1: B1 is in recovery. Restoring it brings it back at its new place.
- B removes B3, the anchor: B1 is shown where B3 was. B3 is in recovery.
- B creates a heading above B1: the heading stays at the source as an empty scene. B1 is at the new place.
- B creates a heading above B4, the beat after B1's new place: the heading is between B1 and B4.
- B renames the heading of a moved scene: the rename shows at the new place.
- B removes the heading of a moved scene: the beats are at the new place with no heading. The heading is in recovery.
- B removes the heading a beat was moved under: the beat is shown after the heading's old spot.

Requirement 4, undo through the E3 layer (one `Y.UndoManager` per person, with `headings` added to its scope):
- A move undoes and redoes as one step.
- A undoes a move after B typed in the beat and split it: both halves go back to the source with B's letter in them.
- A undoes a move after B moved the same beat again: nothing changes. The undo passes over the key B overwrote.
- A undoes a move that left a beat behind (a dependent): both placements are restored. A second undo restores the start.
- A undoes a scene move after B renamed the heading: the scene goes back and keeps the rename. Redo moves it again.
- A undoes a split of the beat another beat sits after: the order goes back, with the moved beat after the whole beat.

Reported by the independent analysis and reproduced here. Each one has a test that pins today's behaviour:
- **A split's re-point wins over a deliberate move.** A first puts B1 after B3, and B sees it. Then, at the same moment, A moves B1 after B4 and B splits B3. B1 ends up after the second half of B3 ("h"), before B4. What a person sees: A's second move does not happen. The split rewrote B1's placement to point at the new half, and that write won.
- **Undoing the split that ended a moved beat's run.** A splits B1 into "b" and "c" (S9). B moves B1 after B3, splits B1 at its start into S10 and joins S10 back into B1. Then A undoes the original split. Afterwards the moved row B1 is empty at its new place, and the source shows "bc". That text also reads as joined into B0's row, because the join is read with whatever row is above it. What a person sees: the moved row is empty and both letters are back where the beat used to be. Nothing is lost.
- **A scene move takes along a beat that was not selected.** At the same moment, A moves the second scene (`#H1`, B2, B3, B4) to the top and B puts B3 after B0. Afterwards the first scene holds B0, B3, B4, B1. What a person sees: B4 followed B3 into the other scene, although B selected only B3. In A's move, B4 was placed after B3, so it goes wherever B3 goes.

## Values read from the implementation

- The literal outlines in `e7-named.test.ts` were printed from a run first, then checked by hand against the rule above before they were written in. They show what a person sees. They do not prove the rule is the right one.
- The control "used" and "effective" counts, the concurrent-case counts and the settled-row counts come from runs. Expected states never do: they come from `e7-model.ts`, which imports neither Yjs nor the prototype.
- The controls find the record to mute with `recordOf(replica, ref)`. That only aims the mute. The parts to mute come from the model's plan.
- The concurrent-split categories were named after looking at the cases. Each category is defined from the history and the model's final state.
- All the numbers in "Numbers" are measured from the implementation.
- The identity and undo outlines in `test/native/e7-identity.test.ts` were written before the first run and passed unchanged. The exception is the case reported by the analysis: its outline was printed from a run and matched against the report.
- The two reported cases in `e7-named.test.ts` were also printed from a run and matched against the report.
- `e7-model.ts` reuses E5's model, including its list-integration rule. E5's caveats carry over.

## What this does not cover

- Cut and paste across rows. Pasting text is still delete and insert, so it has candidate (a)'s problems: typing at the same moment stays at the old place. The result suggests one thing. When a person cuts whole beats and pastes them in the same document, the app could turn that into a placement move, which keeps identity. Text cut out of a beat stays a copy, as in any editor.
- Undo and redo in generated histories. The generated histories contain neither. Undo is covered only by the seven named cases.
- Removal as a real Yjs deletion. The owner has now decided removal works that way, with no `removed` mark. E7 used the mark, so a placement whose anchor is deleted is not tested.
- The "pin every block" fallback. It never ran.
- Presence, drag feedback and screen code.
- More than three writers, and long offline periods with many moves.
- A real script. The measurements use synthetic beats, run once on one machine.

## Questions for the owner

1. B joins a beat up into the row above at the same moment A moves that beat. Should the beat join whatever is above it at its new place?
   - Yes (as built): the beat merges into the row above at the new place, which B never saw.
   - No: B's join would need extra code to notice the move. That code is not built.
2. B joins the next row into a beat at the same moment A moves that beat away. Should that row follow?
   - No (as built): the row stays at the source as its own row, and B's join seems to do nothing.
   - Yes: it would need a second placement write when the join arrives. That is not built.
3. B splits the beat that A's moved beat is landing after. Where should the moved beat go?
   - Between the halves (as built): it lands in the middle of the text B just split.
   - After the second half: it would need the split to re-point placements it has not seen. That is not built.
4. B creates a heading above a beat at the same moment A moves that beat. Should the heading follow?
   - No (as built): an empty scene heading stays at the old place.
   - Yes: the heading would jump away from where B put it.
5. Two overlapping moves at the same moment can give an order neither person asked for, with nothing lost. Is that acceptable within the nine-in-ten guide?

## What I am least sure of

- The reading rule is ours, not the library's. It has five parts: anchor, stamp, travelling run, loop breaking and dependents. A shared misunderstanding could pass both the implementation and the model, since one person wrote both.
- The stamp is "one more than any stamp this copy has seen". Two moves at the same moment can get the same stamp, and then the tie goes by block id. That is consistent but arbitrary.
- `u` (where the travelling run ends) is fixed when the block is first placed. Later edits can make the run shorter or longer than the person saw. The 45 "moved again later" and 2 "same-spot split" cases come from this.
- "Pin every block" is a fallback for when the local check does not settle. It never ran in the generated histories, so its cost and its effect on others' moves are untested. It should not ship untested.
- Last writer wins per key can override a deliberate move. A split's re-point and a scene move's placements both beat or drag a move made at the same moment (see the reported cases above).
- Timing: one move at 900 beats has a p95 near the 8 ms limit. Most of that is the whole-row rebuild, which this experiment did not change.
