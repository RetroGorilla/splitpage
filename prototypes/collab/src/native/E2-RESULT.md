# E2: split, join, remove and restore under simultaneous changes

Prototype only; nothing ships. Design: draft PR #1627, section 7 and experiment E2. Yjs 13.6.33, Node 24.22.1.

## Verdict

E2 passes its criterion in every history run: three writing copies and a late joiner agree, every character typed and
not deleted is stored and shown exactly once, and each is in a visible row or in a removed row's recovery entry, at a
place an edit reaches. The spike needed reader fixes for this (below). One finding: the design's join reading can show
rows out of stored order. Nothing is lost when that happens.

## What changed in the spike

- `variant.ts` reader. A beat joined into a removed beat was in no row and no recovery entry. With the unchanged spike,
  "#1 removes R1; #2 joins R2 to R1" showed R2's narration and visual cell nowhere. Now the beat goes with the nearest
  removed beat on its chain, and that removed beat's recovery entry lists the whole group. A loop of join flags is
  broken at its beat earliest in order, which is listed in recovery as `loop` (the spike showed R1's text under row R2
  and R2's under R1). Rows and recovery entries now carry `members` and per-beat `parts`.
- `rows.ts`, the row commands from design section 7. Typing at the seam, glue included, goes to the end of the earlier
  beat. A deletion across the seam deletes in each beat and keeps the flag. A split at the seam deletes the flag;
  elsewhere it splits the beat holding the place. Join names the last beat of the row above. Remove and restore set
  and delete `removed`. One interpretation: "the later part keeps its flag" is read as follows. A later beat of the row
  whose `into` named a beat before the split point is re-pointed to the new beat. This is a write to the existing
  flag, not a new record. Without it, a split inside a joined row puts the second half below the next beat.

## Answers

1. **Races.** There are 21 hand-written histories, each run under all five deliveries. They cover: a split and typing
   at one gap, in narration and in visual cells; a join while others type in both beats' cells; two people joining the
   same pair; chains (1+2 with 2+3 with 3+4); loops of two and three; a split inside a joined row with typing at the
   seam; a split at the seam with typing on both sides; a deletion across the seam while the seam is split; a removal
   while someone splits, joins or types into the same beat; a removal of the row another joins into, with and without a
   restore; a restore after unseen typing; two removals and a restore. One more history types on both sides of a seam
   while it is joined and after `Y.UndoManager` undoes the join.
2. **Checks.** All passed in the 21 cases and in 1,000 generated histories with 20,090 commands. Some outcomes were
   correct and still surprising:
   - A removal racing a split leaves the split-off half visible.
   - Removing row X while someone joins the next beat to X hides that beat inside X's recovery entry.
   - Of two removals made at once, the library drops the lower client's write when the two meet. A restore that saw
     only that write leaves the row removed; a restore that saw the other write restores it.
3. **Size.** Each schedule ran 1,000 rounds on one copy. "Stored" means a fresh copy loaded from the encoded state, as
   the spike's report measures a copy without undo history. The base was 3,037 bytes.

   | Schedule | Bytes per round, stored | Per command | Editing copy after 1,000 rounds | Left unreclaimed |
   | --- | --- | --- | --- | --- |
   | Split inside a beat | 54.51 | 54.51 | 57,551 | boundary embed, beat record, visual cell |
   | Split, then join the new beat back | 94.89 | 47.45 | 118,236 | the above plus a live `joined` per rejoined beat (1,000 records and cells no row heads) |
   | Join, then split at the seam | 0.02 | 0.01 | 22,057 | nothing: deleted flags merge into one range |
   | Remove, then restore | 0.02 | 0.01 | 34,058 | nothing |
   | Split, then delete the boundary (question 4) | 39.79 | 19.90 | 54,723 | a beat record and a visual cell that nothing reads, per round |

   A join therefore costs about 40 bytes for as long as the document lives. Every split costs about 55 bytes for as
   long as the document lives, even after it is rejoined. Flags that were set and then deleted cost almost nothing
   once undo history is dropped. Until then the editing copy keeps them (19 to 31 bytes per round here).
4. **Shared container.** Deleting a boundary embed joins the narration without a flag, and typing made in the later
   beat meanwhile survives. The later beat's visual cell, with typing made in it meanwhile, belongs to no row. It is
   reachable only as an `unplaced` recovery entry with no restore, and its record is read by nothing. A join flag
   written at the same time is ignored. A beat that heads its own container (every beat loaded from a file) has no
   embed to delete. Joining visual cells by copying loses concurrent typing (design appendix B). The flag stays the only
   join that keeps both cells.

## Finding: rows out of stored order (240 of 1,000 generated histories)

The reader follows `into` to the row it names. Once a beat appears between the joined beat and the beat its `into`
names, the row is no longer contiguous. Shortest histories (`test/native/e2-structure.test.ts`, cases marked
"finding"):

- Two commands made at once: "#1 joins R2 to R1; #2 splits R1 after `a`". The rows are `R1(R1+R2): a def` and
  `S1: bc`. A person sees the second half of beat 1 under beat 2.
- Three commands by one person: "removes R2; joins R3 to the row above (R1); restores R2". The rows are
  `R1(R1+R3): abc ghi` and `R2: def`. The restored beat shows below the beat that followed it.

Copies agree and every character is reachable; only the reading order is wrong. A command cannot prevent the first
history, because the two writers never saw each other. Naming the beat directly above (here the removed R2) avoids
the second history, but then joining R3 would hide it with R2. One option that needs no new record is for the reader
to attach a joined beat to the nearest visible row above it and ignore `into`. That reading is untested here. The
choice is the owner's.

## Evidence and coverage

- **Model.** `test/native/structure-model.ts` reads the expected stored text, flags and rows from the recorded
  commands only. It never uses the code under test.
- **Order rule.** A new element lies between the two elements it was put between, and a flag write lies after the
  writes it had seen. Where the commands fix nothing, the first order any copy shows is held, and every later reading
  must keep it. Hand-written expectations use the library's order: lower client id first.
- **Flags.** A flag's value is the last write in that held order, absent if a write that saw it deleted it.
- **Reach check.** `reach` scans every live character of every text and checks that each is shown exactly once. It
  also checks that each row and each removed group shows its beats' cells in place.
- **Negative controls.** Each of these fails the checks: dropping, misplacing (narration and visual), duplicating or
  stranding a character; a reader that leaves a joined beat out of recovery; a reader that swaps two rows.
- **Generator.** 1,000 histories of 30 steps: 200 seeds under each of five deliveries. Every update a copy holds goes
  out in one batch: forward, reversed, each twice, shuffled with about 30% repeated, or as a state-vector diff. The
  commands were 8,470 typings, 4,140 splits (135 at a seam), 2,910 joins, 2,425 removals, 855 restores and 1,290
  deletions, plus 4,235 deliveries; 3,705 steps were skipped because they had no target.
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
```
