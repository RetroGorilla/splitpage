# E15: a row's position after competing moves and undo

Prototype only. Nothing here ships. Code: `src/native-rank-undo/`, tests: `test/native-rank-undo/`. Yjs 13.6.33.

## Verdict

Every option leaves a row in an unexpected place in some history. No option loses narration, shows a beat twice or leaves copies disagreeing, in any named history or generated set. The options differ in three ways:

- how many steps it takes to get a row into an unexpected place;
- whether an undo or redo may replace someone else's later change;
- what it costs.

How each option gets there:

- **A, as built.** Three steps: two people move the same row at once, the winner undoes, and someone deletes a neighbour. The row can then land in another scene.
- **B, C and D.** They avoid that, but each lets a press replace a placement someone else made later and had seen:
  - B: an undo or a redo;
  - C: a redo;
  - D: a redo, in one three-person history.

  D's stored entries also double with every round of racing moves and undos.
- **E.** A row with no rank reads at the place it was created. In the mixed set, that was 0 to 4 rows from where it stood, and in a different scene for 3 of 5 rows; in the double-split set, 2 to 4 rows, and 2 of 3 in a different scene. In the focused cases, ordinary edits to its neighbours did not shift it. It has three limits:
  - undoing a move can relocate a row the press did not select (histories 15 and 16);
  - a command can throw after it has written (histories 17 and 18; all options);
  - one block without a fixed place switches the whole reading back to A's rule (histories 19 and 20). The HTML import writes none.

Two things hold for all five options:

- **A row can lose its whole record** (and its visual cell) when two people delete it offline and both undo. Its narration stays and its rows stay where they are, but most commands on it throw, and a command on another row can throw after writing. E14's kept containers keep the record and the cell.
- **A segment can lose its first row's boundary** the same way. That row then stops being a beat of its own, and its narration reads as the start of the next beat's.

This is a measurement, not a recommendation.

## The mechanism

1. A beat's place is one rank, stored as one plain value under one key of its record.
2. Alice and Bob move the same beat at once. Both write the key. Yjs keeps Bob's value (higher client) and drops Alice's on arrival.
3. Bob undoes. Yjs removes his value and would bring back the one from before, but Alice's value stands after it, and plain undo never overwrites someone else's change. The key is left empty.
4. A beat with no rank is read by rule (e): after the block before it in the narration, wherever that block now is.
5. So the beat follows a neighbour it was never moved with. When that neighbour is deleted or moved, the beat goes with the next one, possibly into another scene.

The same Yjs rule loses whole records. Alice and Bob each delete B offline, and each undoes. Both undos write B's entry in the `beats` map, so Yjs keeps Bob's (higher client) and deletes Alice's on arrival. Bob then redoes his delete, which deletes his entry. B's narration comes back from the text, which merges, but its record and visual cell are gone in every option (named history 12).

## The options

- **A, as built.** Plain Yjs undo; a rankless block is read by rule (e).
- **B.** A with the stock Yjs setting `ignoreRemoteMapChanges: true`: an undo or redo always writes its old map value back, even over a later one from someone else.
- **C.** One map key per rank write; the reader takes the greatest live entry by stamp, then client, then clock.
- **D.** A `Y.Array` of ranks per record; the reader takes the last live element.
- **E.** A with a fixed place.
  - Each boundary marker carries an `at`: the rank the block was created with. Markers are `{b: id}` or `{h: id}`, in the text or in the segment `head` entry.
  - `at` is written once, with the marker, and never rewritten. Split, insert, a new heading and a stray row's claim write it with the block's first rank. Hydration through `hydratedBoundary` writes each block's initial rank.
  - The reader uses `at` only for a block with no rank or no record; otherwise it reads the rank as A does. Moves write `rank` as in A.
  - If any rankless block has no `at`, the reader uses rule (e) for the whole reading.

## The named histories

Each history was played in five delivery orders: forward, reverse, twice, shuffled and whole state. All five agree in every history and option. The expected rows are in `test/native-rank-undo/model.ts`, which imports nothing.

For histories 1 to 14, a register model in that file follows one stored value (B's rank, H's rank or B's record) under each option's written rules, with what each copy has received. The file lists the rows for each value it can leave standing. Histories 15 to 21 involve several rows' ranks at once, so their rows are written by hand per option. "start" is the place before anyone moved; "fixed" is E's fixed place.

Rows are shown part by part, separated by →. Text cells are left out. Marks:
- **Bold**: a never-acceptable result.
- *Italics*: a press moved a row or heading that someone else had placed later and the presser had seen.
- †: a press changed the scene or order of rows the pressed command did not place.

| History | A | B | C | D | E |
| --- | --- | --- | --- | --- | --- |
| 1. Alice moves A into H; at once Alice moves B below A and Bob moves B under H (Bob wins); Bob undoes; Alice deletes A | `#H,B,A` → `#H,A,B` → **`B,#H`** | `#H,B,A` → `B,#H,A` → `B,#H` | `#H,B,A` → `#H,A,B` → `#H,B` | as C | `#H,B,A` → `B,#H,A` → `B,#H` |
| 2. Same race; Alice (the loser) undoes; Alice deletes A | `#H,B,A` → `A,#H,B` → `#H,B` | `#H,B,A` → *`B,#H,A`* → `B,#H` | `#H,B,A` → `#H,B,A` → `#H,B` | as C | as A |
| 3. Same race; Bob undoes, then redoes | `#H,B,A` → `#H,A,B` → `#H,B,A` | `#H,B,A` → `B,#H,A` → `#H,B,A` | as A | as A | as B |
| 4. Three people move B at once (Carol wins); Carol, Bob, Alice undo in turn | `B,A,C,D` → `A,B,C,D` ×3 | as A | `B,A,C,D` → `A,C,D,B` → `A,C,B,D` → `A,B,C,D` | as C | as A |
| 5. E11's six-step deletion history | `#H,A` → `#H,A,B` → **`B,#H`** | `#H,A` → `B,#H,A` → `B,#H` | as B | as B | as B |
| 6. Alice moves B; Bob sees it and moves B again; Alice undoes | `A,C,B,D` → `A,C,D,B` → `A,C,D,B` | `A,C,B,D` → `A,C,D,B` → *`A,B,C,D`* | as A | as A | as A |
| 7. Alice moves B while Bob splits B unseen; Alice undoes | `A,N,C,D,B` → `A,B,N,C,D` | same | same | same | same |
| 8. Bob moves heading H while Alice moves B into H; each undoes | same three parts in every option | same | same | same | same |
| 9. Start `A,#H,#I`. Bob moves H after I and undoes; Alice sees it and moves H to the top; Bob redoes | `A,#H,#I` → `#H,A,#I` → `#H,A,#I` | `A,#H,#I` → `#H,A,#I` → *`A,#I,#H`* | as B | as A | as A |
| 10. Three people: two top moves of H, both undo, Carol moves H after I, Bob redoes, Carol undoes, Bob's state reaches Carol, Carol redoes | `#H,A,#I` | *`A,#I,#H`* | *`A,#I,#H`* | *`A,#I,#H`* | `#H,A,#I` |
| 11. Start `A,C,D,B` after a seen move; Alice moves B after C while Bob moves B before A; Bob undoes | `A,C,D,B` → `B,A,C,D` → `A,B,C,D` | → `A,C,D,B` | → `A,C,B,D` | as C | → `A,B,C,D` |
| 12. Start `A,B`. Offline, Alice and Bob each delete B and undo; Bob redoes | **`A,B`**, B has no record or visual cell | same | same | same | same |
| 13. Start `A,B,#H`; A is moved into H; then history 12; then Alice deletes A | `B,#H,A` → **`#H,A,B`** → **`B,#H`** | as A | as A | as A | `B,#H,A` → **`B,#H,A`** → `B,#H` |
| 14. History 12, then Alice inserts N before B | **`A,B`** → `N,A,B` | as A | as A | as A | **`A,B`** → `A,N,B` |
| 15. Start `A,B,C,D`. B loses its rank (two moves at once, the winner undoes); Alice splits B into B and N; Alice moves D after B; Bob sees it and creates heading H above N; Alice sees that and undoes her move of D | `A,B,C,D` → `A,B,N,C,D` → `A,B,D,N,C` → `A,B,D,#H,N,C` → `A,B,#H,N,C,D` | same until → †`A,B,N,#H,C,D` | `A,C,B,D` → `A,C,B,N,D` → `A,C,B,D,N` → `A,C,B,D,#H,N` → †`A,C,B,N,D,#H` | as C | as B |
| 16. As 15 with a row X after D, and Bob moves X after D instead of creating H | … → `A,B,D,X,N,C` → `A,B,X,N,C,D` | … → †`A,B,N,X,C,D` | … → `A,C,B,D,X,N` → †`A,C,B,N,X,D` | as C | as B |
| 17. Start `A,B,C`. History 12; then Alice moves C to the top | **`A,B,C`** → **`C,A,B`**; the move throws after writing | same | same | same | same |
| 18. History 12; then Alice creates heading H above B | **`A,B`** → **`A,#H,B`**; the heading is made, then the command throws | same | same | same | same |
| 19. Start `A,B,#H,C`, where only C's boundary has no `at`. A is moved into H; history 1's race makes B rankless; history 12 on C; Alice deletes A | `B,#H,A,C` → `#H,A,B,C` → **`#H,C,A,B`** → **`B,#H,C`** | `B,#H,A,C` → `B,#H,A,C` → **`B,#H,C,A`** → **`B,#H,C`** | `B,#H,A,C` → `#H,A,B,C` → **`#H,C,A,B`** → **`#H,C,B`** | as C | `B,#H,A,C` → `B,#H,A,C` → **`#H,C,A,B`** → **`B,#H,C`** |
| 20. History 1 on a document with no `at` anywhere | `#H,B,A` → `#H,A,B` → **`B,#H`** | `#H,B,A` → `B,#H,A` → `B,#H` | `#H,B,A` → `#H,A,B` → `#H,B` | as C | as A |
| 21. Alice moves B after C; Bob sees it and moves the range C to B after D; Alice sees that and undoes | `A,C,B,D` → `A,D,C,B` → `A,D,C,B` | → *`A,B,D,C`* | as A | as A | as A |

Notes on the table:
- **History 13.** In A to D, the bold parts are B's missing record, and then B leaving scene H when only A is deleted. In E, B never enters H: from the record loss on, it reads at its fixed place.
- **History 17.** All five options throw `Missing record b:B` at the move.
- **History 18.** All five options throw `Missing record b:B` after creating the heading.
- **History 19.** The bold parts are C's missing record from part 3, and B's change of scene in A and E at part 4.

C was also run with two other reader orders, "lowest rank wins" and "highest clock wins", for the record. Neither shows a never-acceptable result beyond those listed for C.

### An older redo that is blocked

In A and E, the final redo in histories 9 and 10 is blocked, and the test asserts this in every delivery order:
- the press returns `false`;
- it uses up one redo item and adds no undo item;
- the document snapshot is unchanged.

To the person, the press is used up and nothing changes. E11 lists this among its local command promises ("redo popped an item but changed nothing stored"), apart from its never-acceptable results; the named test now keeps the two lists apart.

In B, C and D, the same press returns `true` and changes the document.

### A redo or undo against a later, seen placement

A heading move always changes which rows sit under that heading; that is what a heading move is. What is new in histories 9 and 10 is that a redo wins over a later move the presser had seen.

In history 9:
- Bob moves H after I and takes it back. Alice sees that and moves H to the top. Bob's older redo puts H after I again.
- Plain Yjs (A) does not allow this: Bob's redo finds Alice's later write after his and does nothing.
- B always writes its old value.
- In C the redone entry is a new key with a higher stamp.
- In D the redone element comes back at its old place, before Alice's, so Alice's stays last.

In history 10, Carol had seen Bob's redo, and her own redo brings her element back after Bob's redone one, so her placement wins over his later one.

History 21 is the reviewer's range case. Bob's range move carries B, and Alice's later undo under B takes B out of Bob's range.

The press checks (below) flag the same options:

| | Histories |
| --- | --- |
| B | 2, 6, 9, 10, 21 |
| C | 9, 10 |
| D | 10 |
| A, E | never |

### Undoing a move can relocate a row the press did not select (histories 15 and 16)

In history 15 under E, the rows go from `A,B,D,#H,N,C` to `A,B,N,#H,C,D`. N leaves scene H, although H stays put and the press was about D. In history 16, the same undo swaps N and X.

The fixed values survive throughout; the markers are never rewritten. The cause is the move planner's side-writes: rank writes to rows the command did not select.
- When B and N read at the same fixed place, Alice's move of D into the gap pins B with a live rank and re-ranks N.
- Alice's undo of the move takes those writes back with D's own.
- B and N are then read at their shared fixed place, which is above H's new rank.

The same steps in A to D:
- **B, C and D** move N too (marked †). In C and D, B started where Alice put it, because the race leaves it there, so the rows differ.
- **A keeps N in place in both histories.** The undo takes back the same side-writes and leaves B and N without a rank. Rule (e) then reads N by the narration: in history 15, after H's new boundary.

The side-writes are the common cause in every option; A's outcome depends on where the narration happens to put the row.

The generated sets never produced this sequence. Their press scene count is 0, and their one order case is the hidden heading in seed 415.

### Rows the press did not place

E11's scene check and drift counter skipped undo and redo presses. The scene check ran only for typing, erasing, formatting, fields, split, join, unjoin and delete; the drift counter counted rankless beats only. E15 adds an opt-in check on every press, without changing E11's counts.

The press is traced back to the command it takes back or puts back. Every row that command placed is left out:
- the moved rows, the rows inside a moved range and the headings in it;
- a moved heading's scene;
- deleted, split, joined or inserted rows;
- a new, removed or restored heading's scene.

The check then asks three things:
1. Did any other beat change scene?
2. Did the other rows and headings change order among themselves?
3. Did the press move a row or heading that another person had moved after the pressed command, where the presser had seen that change? Moving it alone, inside a moved range or with its scene counts, and so does redoing such a move.

In round 2, the third question matched only a later move whose first item and kind were the pressed move's own. It missed a row inside someone else's moved range (history 21).

## Record loss

After history 12, B's narration shows, but its record and visual cell are gone in all five options. Every command on B, done on the copy that sees this:

| Command on B | A | B | C | D | E |
| --- | --- | --- | --- | --- | --- |
| Type narration | done | done | done | done | done |
| Type in the visual cell | throws `Missing visual B` | same | same | same | same |
| Format narration | done | done | done | done | done |
| Set a status | throws `Missing beat record B` | same | same | same | same |
| Move | throws `Missing record b:B` | same | same | same | same |
| Split | throws `Missing record b:B` | same | same | same | same |
| Join | throws `Missing beat record B` | same | same | same | same |
| Delete | done | done | done | done | done |
| Insert a row before it | done | done | done | done | done |

For the commands in this table, every throw comes before any write; the table checks the stored state before and after.

That does not hold for every command. Two commands that do not select B throw after they have written:
- **Moving a healthy row (history 17).** The planner writes C's rank, then tries to give B a live rank, then throws. Every copy settles on `C,A,B`.
- **Creating a heading above B (history 18).** The command creates the heading, then throws. All options show `A,#H,B`.

The requirement this puts on product code: a command checks every part it will write before its first write, and refuses without writing if any part is missing. That includes the records, cells and boundaries of rows it touches, and the ranks of neighbours the planner will write. It is not built here.

In round 1, D's insert wrote the new row's narration and record and then threw in `Y.Array.push`, leaving N without a visual cell. Two fixes followed:
- D now checks for a missing rank before it writes anything.
- C now writes no entry for a missing rank, as A stores no value.

After the fix, N is whole in every option: it has a record and a visual cell, takes typing in its visual cell, and splits. Where N shows depends on the option:
- In A to D, N shows above A: B has no rank, so N gets none either, and N's segment is read before A's.
- In E, N takes B's fixed place and shows between A and B.

History 13 is the reviewer's second case. A is moved into H, then B loses its record. In A to D, B is rankless and follows A into H (`#H,A,B`); deleting only A then sends B above H. In E, B stays at its fixed place above H throughout.

The same race on a segment head loses the segment's `head` entry. In `A,B`, A's boundary is that entry. A is then no row in any option: no boundary, no record, no visual cell. Its narration reads as the start of B's (`B: ab`). In E the fixed place lived in that entry, so the reader has nothing left for A. No command writes a different `head` on an existing segment, so this delete, undo and redo race is the only way I found to race the key.

With E14's kept containers (`KeptReplica`, which never deletes a record or visual cell), the same delete, undo and redo leave B's record and visual cell in place on both copies. Without them (A), both are gone. That is the fact; I did not evaluate E14's other trade-offs.

## E depends on every marker carrying `at`

E reads fixed places only when every rankless block in the reading has one. If any rankless block's marker lacks `at`, E uses rule (e) for the whole reading.

History 19 shows the effect. Only C's marker lacks `at`. While C has a rank, E keeps B at its fixed place (`B,#H,A,C`). Once C loses its record, E reads everything by rule (e): `#H,C,A,B`. Deleting only A then moves B from under H to above it. History 20, with no `at` anywhere, gives A's rows, including history 1's drift.

The HTML import writes no `at` at all, also after `initializeRanks()`. It is `NativeReplica.hydrate` in `src/native/variant.ts`, which writes plain markers. The reviewer imported the same source twice and found that the two copies agreed on first ranks and had no fixed places. My test and cost fixtures write `at` explicitly, through `hydratedBoundary`.

The requirement this puts on product code:
- Conversion writes `at` for every block.
- A reader meeting a marker without `at` still uses the others' fixed places. E as built here does not.

Found by the reviewer and not investigated beyond its source: both imports showed a heading's label blank, with its text at the start of the next beat's narration, when names are in cells. `NativeReplica.hydrate` predates name cells. It writes each heading's name inline into the heading's segment text and makes no `names` cell. So a replica with names in cells reads a blank name, and reads the inline text as narration. This is an import limit inherited from the earlier prototypes, not an E15 finding.

## The generated sets

Every history was played in the same five deliveries, with name cells. Each option generated its own E11 histories from its own rows, so every command is one a person could have made on that screen. In the table:
- "Never" counts never-acceptable results.
- "Local" counts broken promises at a command.
- For E, "rankless read" counts fixed-place reads.

| | A | B | C | D | E |
| --- | ---: | ---: | ---: | ---: | ---: |
| E11 mixed, 600: rankless read (E: fixed place read) | 5 | 0 | 0 | 0 | 5 |
| E11 mixed: never / local / refused | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| E11 mixed: accepted losses (all kinds) | 303 | 295 | 299 | 298 | 304 |
| E11 double split, 200: rankless read | 3 | 0 | 0 | 0 | 3 |
| E11 double split: never / local / refused | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| E11 double split: accepted losses | 129 | 130 | 129 | 129 | 130 |
| Copies disagree after settling | 0 | 0 | 0 | 0 | 0 |
| E11's drift counter: a rankless row moved, or moved to another scene | 0 | 0 | 0 | 0 | 0 |
| Presses checked, mixed / double split / E10 | 1,104 / 389 / 1,800 | 1,104 / 389 / 1,816 | 1,104 / 389 / 1,816 | 1,104 / 389 / 1,816 | 1,104 / 389 / 1,800 |
| Press changed the scene of a row it did not place (histories) | 0 | 0 | 0 | 0 | 0 |
| Press changed the order of rows it did not place (histories) | 1 | 1 | 1 | 1 | 1 |
| Press moved a later, seen placement (histories), mixed / double split / E10 | 0 / 0 / 0 | 3 / 0 / 8 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| E10, 229: never / local | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| E10: preferred / other / broken | 167 / 62 / 0 | 167 / 62 / 0 | 167 / 62 / 0 | 167 / 62 / 0 | 167 / 62 / 0 |

These counts come from the detector that counts range and scene membership. The earlier `2 / 0 / 8` for B came from the narrower detector. With the fix, B's mixed set goes from 2 histories to 3, and nothing else changes in any option or any other row of this table. Round 2's table also showed C with 1,105 presses in the mixed set; the data said 1,104.

The one press that changed the order of rows it did not place is the same history in every option (mixed, seed 415):
1. Copy 1 moved scene J21 while heading I was removed and sat inside J21's range, so the move carried I with it unseen.
2. Copy 2 then restored I.
3. Copy 1's undo of the move put I back where it was.

The check cannot see that the move placed I, because I was hidden at the time. No row lost or gained a scene.

Accepted-loss kinds that changed from A (mixed set):

| Kind | A | B | C | D | E |
| --- | ---: | ---: | ---: | ---: | ---: |
| Undo press passed over an item that no longer changed anything | 16 | 10 | 11 | 11 | 16 |
| Undo of a move did nothing visible | 8 | 4 | 8 | 8 | 9 |
| Undo press changed only formatting no one can see | 2 | 3 | 2 | 2 | 2 |
| Unseen record change discarded with a deleted beat | 131 | 131 | 130 | 130 | 131 |
| Unseen visual change discarded with a deleted beat | 106 | 107 | 108 | 107 | 106 |

The other sets:
- **E10's set.** B takes both undo kinds from 8 to 0, and C and D take "passed over" from 8 to 0. E matches A.
- **Double-split set.** B and E each add one "undo of a move did nothing visible" (2 → 3).
- **E10's 229 histories.** No never-acceptable or local results in any option. Preferred / other / broken is 167 / 62 / 0 in every option, and no collision outcome changes from A.

I also replayed A's own command lists under B to E. Those lists were made from A's rows, so a few commands do not fit the other options' rows. Refused, as mixed + double split:

| B | C | D | E |
| --- | --- | --- | --- |
| 1 + 1 | 6 + 4 | 5 + 3 | 1 + 1 |

All were "Missing row", "Unknown drop" or "Drop inside the moving range". The two local failures from round 1 remain: B seed 209 and C seed 270. They were traced then to commands E11's generator never offers on those rows.

## How far E sends a row back (measured in review, reproduced)

For each row that lost its rank where a fixed place existed, the reviewer compared two positions in the forward replay: the row's position before the first conflicting command, and its first fixed-place reading. I reran the reviewer's script at this head and got the same numbers.

| Set | Rows | Distance, rows | In a different scene |
| --- | ---: | --- | ---: |
| Mixed, 600 | 5 | 2, 4, 3, 2, 0 | 3 of 5 |
| Double split, 200 | 3 | 2, 4, 3 | 2 of 3 |

The double-split set's three rows are the same seeds and rows as three of the mixed set's five, so the sets are not independent.

In the focused cases, ordinary edits to the row's neighbours did not shift a row at its fixed place:
- deleting a neighbour with the same fixed place;
- splitting a ranked neighbour, and moving it;
- inserting before a tied row;
- deleting and restoring the row's own marker.

History 13, where B stays above H when A is deleted, is the named example.

## Overwrites by an undo or redo press

`overwrite.ts` counts, in the 600 mixed histories, the presses that change a value another person wrote.
- **B:** 8 values changed (7 beat ranks and 1 heading rank), across 6 presses in 6 histories, out of 1,104 presses.
- **A, C, D and E:** 0 in the generated set. A hand-built case (history 9's steps) shows the counter does see C's redo overwrite H's rank; the generated histories never produced that.

My round-1 example was wrong. In seed 127, copy 2's step 19 and copy 0's step 30 had not seen each other, but they were 11 steps apart, outside E11's three-step window for "at the same moment". With B, copy 0's undo moves A back above C and away from N11, so it takes back copy 2's placement too. With A, C, D and E, copy 2's placement stays.

The counter reads Yjs internals: the writer id of a map item, and of a list's items. Its blind spots:
- It skips segment text.
- It treats root entries (a record, a visual cell, a name cell) as present or absent, not by content.
- It leaves out `false` values, so a field going from `false` to something else is not counted.

## Growth in C and D

Start `A,B,C,D`. Each round:
1. Alice moves B after C while Bob moves B after D.
2. Everything is delivered.
3. Both undo.
4. Everything is delivered again.

| Round | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| D: live entries in B's list | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 |
| C: live entries for B | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |

The rows show `A,B,C,D` throughout. In D, the count after n rounds is 2^n:
- Each move deletes the live elements it sees and pushes one.
- Each undo deletes its own element and brings back the ones it deleted, at their old places, so after two undos the count doubles.
- An ordinary move that has received every entry deletes them all and leaves one. Its undo brings all 256 back, and eight more redo and undo cycles kept 256.

In C, both undos bring back the same deleted key, which Yjs keeps once.

C's reader order is exact: the greatest stamp wins, then the higher client, then the higher clock. A stamp is one more than the highest stamp the writer saw in that record. So two offline moves by Alice (stamps 2 and 3) beat one by Bob (stamp 2), although Bob's client is higher.

## Fields and keys

`keys.test.ts`, with name cells. Alice and Bob write the same key at once, everything is delivered, and Bob wins and undoes:

| Key | A, C, D and E | B |
| --- | --- | --- |
| rank | not one answer: A reads rule (e) (history 1), C and D show Alice's move, E shows the fixed place | the place from before the race |
| `status` (was `todo`) | blank | `todo` |
| `lens` (was `wide`) | blank | `wide` |
| `status` (blank before) | blank | blank |
| `joined` (no value before) | B is not joined, though Alice joined it | same |
| `removed` on a heading | H is back, though Alice removed it | same |

Round 1's table put C and D with A for ranks; that was wrong, as history 1 shows.

A seen replacement: Bob sets the status to `todo`; Alice sees it and sets `done`; Alice undoes, then redoes. Every option shows `todo → done → todo → done`. The same holds for a nested text (a `Y.Text` under a record key) that Alice replaces after seeing Bob's. The reviewer measured the same sequence in every option.

## How the rows were checked

E11's harness judges, unchanged: `play`, its promises, its reachability and never checks, its ledger and its generator. E15 adds, through optional hooks:

- A command that types, erases, formats or sets a field leaves every row where it was.
- In C and D, a rank write other than an undo or redo leaves exactly one live entry. The one intended exception is pinned in the checker: a new row made from a row with no rank (inserted before it, or split from it) holds no entry.
- The press checks above, opt-in, counted apart from E11's.

### Controls on generated histories

25 generated histories per option. A clean baseline runs first; then every library write is muted once and must be caught at the command that made it. The totals include muting each whole command. The labels group calls by method and key name, so `YMap.set:e10Rank` covers every block's rank write and `rank entry` every one of C's entries.

| | A | B | C | D | E |
| --- | ---: | ---: | ---: | ---: | ---: |
| Used | 2,274 | 2,274 | 2,476 | 2,542 | 2,274 |
| Effective | 2,213 | 2,213 | 2,416 | 2,481 | 2,213 |
| Caught by a check | 2,152 | 2,152 | 2,358 | 2,423 | 2,151 |
| Threw while the command ran | 39 | 39 | 39 | 39 | 39 |
| Threw in the checks after it | 19 | 19 | 19 | 19 | 19 |
| Not caught | 3 | 3 | 0 | 0 | 4 |

A throw is not a caught control. Where the throws come from:
- **39 while the command ran:** 38 from muting a new heading's record (the command cannot write its rank) and 1 from muting a new beat's visual cell.
- **19 in the checks after it:** muting a new heading segment's `text`, which the reading code then cannot read.

Writes not caught:
- **A and B (3), and 3 of E's 4:** `move / YMap.set:e10Rank`. Each is a range move; seeds 4 and 12 are among them. The range contains a removed heading, and the move rewrites that heading's rank. Removed headings are not shown, so the rows cannot show the muted write until the heading is restored.
- **E's fourth:** `type / YMap.set:e10Rank`. Typing into the loose narration claims a stray row and writes its first rank. When that write is muted, E reads the row at its fixed place, which is the same place.

### Controls on the named histories

Every library write of every command in all 21 named histories is muted once, in forward delivery. The settled rows are compared with the intended rows in `model.ts`, and the never, local and storage checks look for partly written state.

Before any mute, the unmuted history must show only what `model.ts` lists for it. So the zero-entry insert in history 14 is no longer a baseline failure that the controls subtract.

Each effective mute goes to the first of these that applies:
1. a check caught it at the muted command;
2. a command threw;
3. a check caught it at a later command;
4. only the intended rows show it;
5. nothing does.

| | A | B | C | D | E |
| --- | ---: | ---: | ---: | ---: | ---: |
| Used | 188 | 186 | 233 | 238 | 188 |
| Effective | 139 | 133 | 164 | 167 | 139 |
| Caught at the muted command | 100 | 93 | 121 | 123 | 102 |
| A command threw | 3 | 3 | 3 | 3 | 3 |
| Caught only at a later command | 0 | 0 | 0 | 0 | 0 |
| Caught only by the intended rows | 28 | 32 | 29 | 28 | 26 |
| Not caught | 8 | 5 | 11 | 13 | 8 |

The throws:
- **History 14, 2 throws.** Muting Alice's whole undo leaves B no row on her copy, and the insert throws `Missing beat B`. Muting the new segment's `text` makes the insert throw reading it.
- **History 18, 1 throw.**

Muting the cut of Alice's delete in history 14 also makes the later insert throw. It is now counted where it is first caught: at her delete.

The writes not caught:
- **Whole undo or redo presses.** Muting one leaves the intended rows when another person's command makes the same rows (both undo the same deletion), or later replaces what the press wrote.
- **3 in A and 2 in E:** a move's rank write in histories 15 and 16, where the final rows come after the mover's undo of that move.

In both cases the stored state differs; the rows cannot show it.

### What is still read from the implementation

- Everything on E11's list, because E15 reuses its harness: the acting copy's rows, used to pick commands; undo stack depths; `Y.snapshot`; and stored readings for controls.
- The hydrated letters and their owners and roles (narration, visual, heading name), read from the seeded copy's rows.
- The acting copy's row order and members before and after each command, and each row's text and the letters a command selects.
- The members a delete takes away, and heading offsets for a new heading.
- The formatting already on the letters a command formats.
- The real undo and redo stack depths, which tie each press to the command it takes back. The press log reads them too, with each press's return value and `Y.snapshot`.
- `storedRank`, through each option's own reader, for the rankless list, rule (e) and the checker's zero-entry case.
- The E15 checks read rank entries under each option's names (`rank:` keys, the `ranks` list).
- The overwrite counter reads Yjs internals: map-item and list-item writer ids. Its blind spots are listed above.
- E's fixed places, through `fixedPlaces()`, only in the segment-head test.
- The named histories' expected rows are written by hand in `model.ts`, which imports nothing. For histories 1 to 14, its register model is a second, independent reading of each option's rule.

## Costs

`node src/native-rank-undo/cost.ts`, run three times on an idle machine.
- The fixture is E11's: 300 beats with name cells, then 1,000 single-row moves on E10's schedule by one writer.
- Each boundary is the one the option writes at hydration, so E's carries `at`.
- "Kept" is the growth of a fresh copy's encoding per move.
- Read and move times are medians at 900 beats; the ranges are over the three runs.

| | A: as built | B | C | D | E |
| --- | ---: | ---: | ---: | ---: | ---: |
| Starting document, 300 beats, bytes | 82,175 | 82,175 | 83,999 | 83,695 | 86,705 |
| Bytes per row | 273.92 | 273.92 | 280.00 | 278.98 | 289.02 |
| Bytes sent per move | 38.32 | 38.32 | 51.77 | 38.32 | 38.32 |
| Bytes kept per move | 9.42 | 9.42 | 22.89 | 10.53 | 9.42 |
| Full read at 900 beats, ms | 3.80–3.98 | 3.93–4.29 | 5.40–5.77 | 3.90–4.16 | 4.07–4.13 |
| One move at 900 beats, ms | 4.15–4.30 | 4.31–4.44 | 7.06–7.58 | 4.48–4.57 | 4.55–5.03 |

Why a move is slower in E with the same bytes (measured in review, reproduced): E adds a rank-checking pass on every read, and a move reads the order several times. In a four-row trace:

| | A | E |
| --- | ---: | ---: |
| Rank-key reads, one full read | 8 | 12 |
| Rank-key reads, one move | 24 | 36 |

The reviewer's fixture-dependence figures, which I reproduced with E added (A / B / C / D / E):

| Run | Bytes per move |
| --- | --- |
| Three alternating writers, synced after each move: sent | 37.59 / 37.59 / 51.21 / 37.59 / 37.59 |
| 1,000 moves in one transaction: sent | 27.73 / 27.73 / 41.20 / 28.84 / 27.73 |
| Garbage collection off, one writer: kept | 27.73 / 27.73 / 41.20 / 28.84 / 27.73 |
| Mine, one writer, garbage collection on: sent | 38.32 / 38.32 / 51.77 / 38.32 / 38.32 |
| Mine, one writer, garbage collection on: kept | 9.42 / 9.42 / 22.89 / 10.53 / 9.42 |

So per-move bytes depend on the fixture: batching and garbage collection move them by a quarter or more, but the order between the options stays.

E's byte cost is in the boundary, not in the move: about 15 bytes more per row. Typing does not touch ranks or boundaries in any option, and I did not time keystrokes.

Code on top of Yjs, in `variants.ts`:

- B is one setting.
- C is about 42 lines, including a reader order that had to be chosen.
- D is about 39 lines. Its split writes the new beat's rank in a second step, and its writer checks for a missing rank before it writes.
- E is about 62 lines, plus about 25 lines of hooks in earlier modules: who writes a boundary, and the first rank of each new block.

## Each option as a person would notice it

**A, as built.**
- **After a race and the winner's undo:** the row follows the row before it in the narration, wherever that row now is. Deleting that neighbour later can move the row to another scene (histories 1 and 5).
- **Undo and redo:** they never change someone else's later, seen change. An older redo that conflicts does nothing visible, and the press is used up.
- **Planner side-writes:** an undo of a move takes them back here too, but in histories 15 and 16 rule (e) happened to leave N where it was.
- **Bytes and time:** the baseline.
- **Code:** none.

**B, `ignoreRemoteMapChanges`.**
- **After a race and the winner's undo:** the row is where it was before the race. The loser's undo does the same, taking back the winner's move too.
- **Undo and redo:** they can replace someone else's later, seen change: a moved row, a row inside a moved range, a moved heading, a status. In the generated mixed set, 6 of 1,104 presses changed 8 values someone else had written, and the press check flags 3 histories.
- **Planner side-writes:** an undo of a move can relocate a row the press did not select (histories 15 and 16).
- **Bytes and time:** as A for bytes; a read about 9% and a move about 4% slower at 900 beats (middle of three runs).
- **Code:** one setting. Yjs marks it experimental, and it applies to every map key in the undo scope.

**C, one entry per move.**
- **After a race and the winner's undo:** the row is where the other person put it.
- **Undo and redo:** an undo never overwrites, but a redo can replace a later, seen placement (histories 9 and 10).
- **Planner side-writes:** as B (histories 15 and 16).
- **Bytes and time:** 22.89 bytes kept and 51.77 sent per move; a read about 46% and a move about 70% slower.
- **Code:** about 42 lines, and a reader order to keep.

**D, a list per record.**
- **After a race and the winner's undo:** the row is where the other person put it.
- **Undo and redo:** in history 10, a redo replaced a later placement: Carol's redo won over Bob's redo, which she had seen. The generated sets found none.
- **Growth:** racing moves and undos double the stored entries each round (256 after 8 rounds); the rows do not show it.
- **Planner side-writes:** as B.
- **Bytes and time:** 10.53 bytes kept and 38.32 sent per move; a read about 9% and a move about 7% slower.
- **Code:** about 39 lines.

**E, a fixed place.**
- **After a race and the winner's undo:** the row is at the place it was created.
  - In history 1, that is where it stood before the race.
  - In history 11, it is two rows away, because the row had been moved before the race.
  - In the generated sets, it was 0 to 4 rows away: in another scene for 3 of 5 rows in the mixed set, and 2 of 3 in the double-split set.
- **Ordinary edits to its neighbours:** they did not shift it in the focused cases.
- **Undo and redo:** they never change someone else's later, seen change, as in A. A conflicting older redo does nothing visible, as in A.
- **Limits:**
  - An undo of a move takes back the planner's side-writes. A row the press did not select can then return to its fixed place: it leaves a scene in history 15, and swaps with another row in history 16.
  - A document with any rankless block lacking `at` reads as A for the whole reading, and the HTML import writes none.
- **Bytes and time:** about 15 bytes more per row (5.5%); the same bytes per move as A; a read about 8% and a move about 18% slower.
- **Code:** about 62 lines, plus hooks.

**For all five options:**
- **A row can lose its whole record.** When two people delete it offline and both undo, the row keeps its narration but loses its record and visual cell. Most commands on it throw. Two commands on other rows throw after they have written: moving a healthy row and creating a heading above it. E14's kept containers keep the record and the cell. Combined with E in a temporary replica (measured in review, reproduced), the row then keeps its record and an editable visual cell, and E still handles the competing-move fallback.
- **A segment can lose its first row's boundary** in the same race. The row then stops being a beat of its own, and its narration stays shown and editable through the next beat. Two people moving different rows to the top never write the `head` key; only the delete, undo and redo race loses it. With kept containers, the row's record and visual cell remain stored, outside the shown rows.

**Once a row has no rank, can a later command that does not touch it, other than a heading move, change its scene or its order among unmoved rows?**

- **In E, yes, in three ways:**
  - An undo of a move that side-wrote its rank (histories 15 and 16).
  - Reading by rule (e) once any rankless block lacks `at` (histories 19 and 20).
  - A command that throws after writing leaves its partial write. In histories 17 and 18 that partial write is the moved row or the new heading; the rankless rows kept their order.
- **What E gets right:** ordinary edits to the row's neighbours did not move it in the focused cases. E11's drift counter and the press scene check are 0 for E in every generated set and in E10's.
- **In A to D, yes:**
  - In A, after the winner's undo (histories 1 and 5).
  - In A to D, after a record loss (history 13).
  - In B to D, through planner side-writes (histories 15 and 16).

## Earlier prototype modules

Each got an option whose default is the old behaviour:

- `native/variant.ts` and `native/headings.ts`: a `marker(kind, id)` hook builds each boundary a command writes; the default is the plain `{b: id}` or `{h: id}`. HTML hydration is unchanged.
- `native-moves/ranks.ts`:
  - The `readFlat`, `writeFlat` and `flatFields` hooks, from round 1.
  - An optional `creating(ref, rank, from)` method that tells the replica each new block's first rank; by default it is absent.
  - `hydratedBoundary(index, kind, id)`; the default is `marker`.
  - `initialRank` is exported.
- `native-chosen/replica.ts`: `storedRank` is public; `materialize` and `insertBeat` call `creating` and `marker`.
- `test/native-chosen/kit.ts`: `seed` writes each boundary through `hydratedBoundary`.
- `test/native-chosen/play.ts`:
  - Optional settings, all off by default:
    - `pressChecks`;
    - `mute` (one call at one step) and `listCalls`;
    - `continueOnThrow`, which records a command that throws in `threw` and keeps playing;
    - `logPresses`, which records each press's return value, stack depths and snapshot equality.
  - Their results go in new optional fields. `ControlCount.checkThrows` counts throws in the checks after a command.
  - `perform` now returns what an undo or redo press returned.
  - The press check's later-placement test counts a row inside a moved range or scene.
- `test/native-chosen/engine.ts`: as in round 1.

E11's control counts are unchanged: 2,233 used, 2,173 effective, 2,112 caught, 58 throws and 3 unchanged.

## What I did not test

- Product code, the editor, and anything a person clicks. These are prototype replicas driven by commands.
- Inline heading names. Every E15 run uses name cells, E11's chosen combination.
- An undo manager that merges presses (`captureTimeout` above 0).
- Long sessions. D's doubling is measured over 8 rounds; nothing longer.
- A reader for E that keeps other blocks' fixed places when one marker lacks `at`, and an import that writes `at`.
- A move planner without side-writes, or one whose side-writes an undo does not take back.
- Commands that check every part before their first write.
- Keystrokes.
- B for fields together with C, D or E for ranks.
- What should happen to a row with no record. E14's kept containers keep the record, as stated above. They were combined with E only in the reviewer's temporary replica, which I reran; not with B, C or D.

## The owner question

Every option leaves a row in an unexpected place in some history, and none loses narration, shows a beat twice or leaves copies disagreeing. So the question is which unexpected place is acceptable, and at what cost.

- When two people move the same row at once and the winner undoes, where should the row be?
- May an undo, or an older redo, replace a placement someone else made later and had seen?
- What should a person see when a row comes back with no position, or with no record?

- **(a) A, as built.**
  - The row follows its narration neighbour, and can later move into another scene with no one touching it.
  - Undo and redo never replace another person's later change; a conflicting redo does nothing and is used up.
  - No cost.
- **(b) B, `ignoreRemoteMapChanges`.**
  - The row goes back to where it was before the race.
  - Any undo or redo can replace another person's later, seen change, for places, for rows inside a moved range and for every other field.
  - An undo can relocate a row the press did not select.
  - No bytes; one experimental setting.
- **(c) C, one entry per move.**
  - The row shows the other person's move.
  - Undo never replaces a later change, but an older redo can.
  - An undo can relocate a row the press did not select.
  - 2.4 times A's bytes kept per move, a read about 46% and a move about 70% slower, and a reader order to keep.
- **(d) D, a list per record.**
  - The row shows the other person's move.
  - An older redo replaced a later placement in one three-person history.
  - Stored entries double with each round of racing moves and undos.
  - An undo can relocate a row the press did not select.
  - About 12% more bytes kept per move; a read about 9% and a move about 7% slower.
- **(e) E, a fixed place.**
  - The row returns to where it was created: 0 to 4 rows from where it stood in the generated sets, in another scene for 3 of 5 rows (mixed) and 2 of 3 (double split).
  - Ordinary edits to its neighbours did not shift it in the focused cases.
  - Undo and redo behave as in A.
  - Three limits:
    - an undo of a move can relocate a row the press did not select;
    - one block without `at` turns the whole reading back into A's, and the import writes none;
    - commands that throw after writing, as in every option.
  - About 15 bytes more per row; a read about 8% and a move about 18% slower.

For every option:
- **A row can lose its whole record.** Most commands on it throw, and some commands on other rows throw after writing. Kept containers keep the record and cell.
- **A segment can lose its first row's boundary.**
