# E2: split, join, remove and restore under simultaneous changes

Prototype only; nothing ships. Design: draft PR #1627, section 7 and experiment E2. Yjs 13.6.33, Node 24.22.1.

## Verdict

E2 passes its criterion in every history run, under both join readings below. Three writing copies and a late joiner
agree. Every character typed and not deleted is stored and shown exactly once, in a visible row or in a removed row's
recovery entry. Typing and deleting at sampled shown places lands on the intended character. The spike needed reader
fixes for this (below). The design's reading ("follow": a joined beat goes to the row its `into` names) shows rows out
of stored order in 325 of 1,000 generated histories. A second reading ("contiguous") shows none. Neither loses text.
Recommendation: contiguous, with the costs listed under "Two join readings".

## What changed in the spike

- `variant.ts` reader. A beat joined into a removed beat was in no row and no recovery entry. With the unchanged spike,
  "#1 removes R1; #2 joins R2 to R1" showed R2's narration and visual cell nowhere. Under follow, the beat now goes with
  the nearest removed beat on its chain, and that beat's recovery entry lists the whole group. A loop of join flags is
  broken at its earliest beat, which recovery lists as `loop`. Rows and recovery entries carry `members` and per-beat
  `parts`. `reading` chooses between the two readings, and the stored data is the same under both.
- `rows.ts`, the row commands from design section 7. Typing at the seam, glue included, goes to the end of the earlier
  beat. A deletion across the seam deletes in each beat and keeps the flag. A split at the seam deletes the flag;
  elsewhere it splits the beat holding the place. Join names the last beat of the row above. Under follow, a split
  re-points later beats of the row whose `into` named a beat before the split to the new beat. This is a write to the
  existing flag, not a new record. Under contiguous, remove and restore act on every beat of the row or entry.

## Answers

1. **Races.** There are 21 hand-written histories, each run under both readings and all five deliveries:
   - a split and typing at one gap, in narration and in visual cells;
   - a join while others type in both beats' cells;
   - two people joining the same pair;
   - a chain (1+2 with 2+3 with 3+4); loops of two and three beats;
   - a split inside a joined row, with typing at the seam;
   - a split at the seam, with typing on both sides;
   - a deletion across the seam while the seam is split;
   - a removal while someone splits, joins or types in the same beat;
   - a removal of the row another joins into, with and without a restore;
   - a restore after unseen typing;
   - two removals and a restore.

   The chain, the split inside a joined row and the restore against a join also have concurrent visual-cell typing.
   One more history types on both sides of a seam while it is joined, and again after `Y.UndoManager` undoes the join.
2. **Checks.** All passed in the 21 cases and in 1,000 generated histories per reading (20,090 commands under follow,
   20,135 under contiguous). Some outcomes were correct and still surprising:
   - A removal racing a split leaves the split-off half visible.
   - Of two removals made at once, the library keeps only the higher client's write. A restore that saw only the lower
     client's write leaves the row removed.
   - The join cases in the next section.
3. **Size.** Each schedule ran 1,000 rounds on one copy, on single-beat rows, so the reading does not change the bytes.
   "Stored" means a fresh copy loaded from the encoded state, as the spike's report measures a copy without undo
   history. The base was 3,037 bytes.

   | Schedule | Bytes per round, stored | Per command | Editing copy after 1,000 rounds | Left unreclaimed |
   | --- | --- | --- | --- | --- |
   | Split inside a beat | 54.51 | 54.51 | 57,551 | boundary embed, beat record, visual cell |
   | Split, then join the new beat back | 94.89 | 47.45 | 118,236 | the above plus a live `joined` per rejoined beat |
   | Join, then split at the seam | 0.02 | 0.01 | 22,057 | nothing: deleted flags merge into one range |
   | Remove, then restore | 0.02 | 0.01 | 34,058 | nothing |
   | Split, then delete the boundary (question 4) | 39.79 | 19.90 | 54,723 | a beat record and a visual cell nothing reads |

   A live join costs about 40 bytes, and every split about 55 bytes, for the life of the document, even after a
   rejoin. Flags that were set and then deleted cost almost nothing once undo history is dropped. Under contiguous, a
   removal writes one flag per beat of the row; that cost was not measured.
4. **Shared container.** Deleting a boundary embed joins the narration without a flag, and typing made in the later
   beat meanwhile survives. The later beat's visual cell, with typing made in it meanwhile, belongs to no row. It is
   reachable only as an `unplaced` recovery entry with no restore, and its record is read by nothing. A join flag
   written at the same time is ignored. A beat that heads its own container (every beat loaded from a file) has no
   embed to delete. Joining visual cells by copying loses concurrent typing (design appendix B). The flag stays the only
   join that keeps both cells.

## Two join readings

- **Follow:** a joined beat goes to the row its `into` names.
- **Contiguous:** a joined beat goes to the nearest visible row above it in stored order. A removed joined beat goes
  with the removed beat directly above it. `into` is written but not read for display.

The same 1,000 generated histories ran under each (`test/native/e2-compare.ts`). Problems means lost, duplicated,
stranded or diverging text, a misrouted edit probe, or a mismatch with the model.

| | Follow | Contiguous |
| --- | --- | --- |
| Histories with problems | 0 | 0 |
| Histories with rows out of stored order | 325 | 0 |
| Edit probes, all landed | 9,317 | 9,595 |

680 histories show a person something different under the two readings. Each counts once, under the first kind below
that it shows:

| Kind | Histories | Shortest example | Follow shows | Contiguous shows |
| --- | --- | --- | --- | --- |
| Rows out of order | 325 | #3 joins R3 to R2; at once #1 splits R2 at its end | `R2+R3: def ghi`, then empty S1 | `R2: def`, then `S1+R3: ghi` |
| Shown under one, in recovery under the other | 220 | #2 removes R3; #1 joins R4 to the row above (R2); at once #3 removes R2 | R4 inside R2's recovery entry | R4 merged into R1: `abc jkl` |
| A later command acts on what that reading showed | 40 | #1 removes R3; at once #2 joins R4 to R3; #3 receives both and types | #3 sees one row and types into R1 | #3 sees R4 merged into R1 and types into R4 |
| Recovery entries group beats differently | 95 | #3 splits R3 (S1); at once #2 joins R2 and R3 to R1, then R4 to R1, and removes R1 | one entry `R1+R2+R3+R4` | entries `R1+R2+R3` and `R4`, since S1 lies between |
| Rows group beats differently | 0 | | | |

In plain words:

- Under follow, a beat joined to a row that is then split, removed or restored can show below the beat that followed
  it.
- Under contiguous, rows always follow stored order. A beat joined to a row that someone removes at the same time stays
  visible, merged into whatever row is above it, until the removal is restored. The "acted" kind is that same case met
  mid-history.
- After "removes R2; joins R3 to the row above (R1); restores R2", contiguous shows `R2+R3`: R3 ends up under the row
  above it, which is not the row the person chose.
- Under contiguous, removing a row must flag every beat in it. If the flags were left on the head only, the joined
  beats would attach to the row above.

**Recommendation: contiguous.** Its surprises keep stored order, stay next to a removed row, and undo themselves on
restore. Follow's surprises put text in the wrong order with nothing to undo them. Neither reading is fully clean:
contiguous can show a beat merged into a row nobody joined it to while a removal stands. Neither adds a stored record.

## Evidence and coverage

- **Model.** `test/native/structure-model.ts` builds expected text, beats, flags, rows and recovery from the recorded
  commands. It does not read the code under test, except where noted below.
  - Predicted from the commands alone:
    - which characters survive, in which beat and field;
    - which beats exist;
    - which visual cell belongs to which beat;
    - every order the commands fix: a new element lies between the two it was put between, and a flag write lies
      after the writes it had seen;
    - flag values where the commands decide them: one standing write, or a delete that saw every set.
  - Taken from the first copy that shows them, then held, and checked only for conservation, agreement and
    consistency:
    - the order of concurrent inserts at one place (625 histories under follow, 635 under contiguous);
    - the winner among concurrent flag writes (295 and 275);
    - which stored flag item belongs to which write.

    In those histories, rows are predicted given these held facts, not from the commands alone.
  - Each later generated command picks its row from the model's view, and that view includes the held facts.
  - Hand-written expectations use the library's tie rule: the lower client id goes first.
- **Reach check.** `reach` checks that every live character of every text is shown exactly once. It checks that each
  row and each removed group shows its beats' cells in place. It also checks that the per-beat `parts`, which route
  edits, cover the shown text beat by beat.
- **Edit probes.** Each generated history that passes gets six sampled shown places, in narration or visual cells. At
  each place, one probe types a character and another deletes the character there, each on a fresh copy and through
  the row commands. Each probe checks that the change landed where the model's own placement predicts.
- **Negative controls.** Each of these fails the checks:
  - dropping, misplacing (narration and visual), duplicating or stranding a character;
  - a reader that leaves a joined beat out of recovery;
  - a reader that swaps two rows;
  - parts with zeroed lengths behind unchanged shown text. Both the parts check and the probes catch this; typing `Z`
    at offset 5 of `abc def` then gives `abc Zdef`.
- **Generator.** Each reading ran 1,000 histories of 30 steps: 200 seeds under each of five deliveries. Every update
  a copy holds goes out in one batch: forward, reversed, each twice, shuffled with about 30% repeated, or as a
  state-vector diff. Under follow the commands were 8,470 typings, 4,140 splits (135 at a seam), 2,910 joins, 2,425
  removals, 855 restores and 1,290 deletions, plus 4,235 deliveries. 3,705 steps were skipped because they had no
  target. A shrinker removes steps one at a time to find the shortest examples.
- **Not covered:**
  - undo and redo, apart from one join undone;
  - moves, headings (design Q4), formatting and atoms in these races, beat fields;
  - pastes over beats and new segments;
  - loops made by commands (impossible without moves, so loops were written directly);
  - lost or never-delivered updates;
  - more than three writers, histories over 30 steps, scripts other than four beats.

## Reproduce

```
npm ci --prefix prototypes/collab
cd prototypes/collab
node --test test/native/e2-structure.test.ts
node test/native/e2-size.ts --cycles=1000
node test/native/e2-compare.ts --seeds=200
```
