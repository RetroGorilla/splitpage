# E15: a row's position after competing moves and undo

Prototype only. Nothing here ships. Code: `src/native-rank-undo/`, tests: `test/native-rank-undo/`. Yjs 13.6.33.

## Verdict

No option is clean. As built (A), a race and the winner's undo leave a row with no rank, and a later command that never touched it can move it into another scene. B, C and D remove that, but B and C let an undo or an older redo replace a placement someone else made later and had seen, and D lets it in one three-person history; D also doubles its stored entries with every round of racing moves and undos. E keeps plain undo and gives a rankless row a fixed place; that place is where the row was created, which can be far from where it stood. In all five, two people deleting the same row offline and undoing leaves it with narration but no record and no visual cell, and most commands on that row then throw. This is a measurement, not a recommendation.

## The mechanism

1. A beat's place is one rank, stored as one plain value under one key of its record.
2. Alice and Bob move the same beat at once. Both write the key. Yjs keeps Bob's value (higher client) and drops Alice's on arrival.
3. Bob undoes. Yjs removes his value and would bring back the one from before, but Alice's value stands after it, and plain undo never overwrites someone else's change. The key is left empty.
4. A beat with no rank is read by rule (e): after the block before it in the narration, wherever that block now is.
5. So the beat follows a neighbour it was never moved with. When that neighbour is deleted or moved, the beat goes with the next one, possibly into another scene.

The same Yjs rule loses whole records. Alice and Bob each delete B offline and each undo. Both undos write B's entry in the `beats` map, so Yjs keeps Bob's (higher client) and deletes Alice's on arrival. Bob then redoes his delete, which deletes his entry. B's narration comes back from the text, which merges, but its record and visual cell are gone in every option (named history 12).

## The options

- **A, as built.** Plain Yjs undo; a rankless block is read by rule (e).
- **B.** A with the stock Yjs setting `ignoreRemoteMapChanges: true`: an undo or redo always writes its old map value back, even over a later one from someone else.
- **C.** One map key per rank write; the reader takes the greatest live entry by stamp, then client, then clock.
- **D.** A `Y.Array` of ranks per record; the reader takes the last live element.
- **E.** A with a fixed place. Each boundary marker (`{b: id}` or `{h: id}`, in the text or in the segment `head` entry) carries an `at`: the rank the block was created with. It is written once, with the marker, and never rewritten. The reader uses it only for a block with no rank or no record; otherwise it reads the rank as A does. Moves write `rank` as in A. Split, insert, a new heading and a stray row's claim write `at` with the block's first rank; hydration writes `at` with each block's initial rank. I could build E without rewriting a marker.

## The named histories

Each history was played in five delivery orders (forward, reverse, twice, shuffled, whole state). All five agree in every history and option. The expected rows are in `test/native-rank-undo/model.ts`, which imports nothing. A register model there follows one stored value (B's rank, H's rank or B's record) under each option's written rules, with what each copy has received, and the file lists the rows for each value it can leave standing. "start" is the place before anyone moved, "fixed" is E's fixed place.

Rows are shown part by part, separated by →. Text cells are left out. **Bold** marks a never-acceptable result. *Italics* mark a press that moved a row or heading that someone else had placed later and the presser had seen.

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
| 10. Three people (review item 1): two top moves of H, both undo, Carol moves H after I, Bob redoes, Carol undoes, Bob's state reaches Carol, Carol redoes | `#H,A,#I` | *`A,#I,#H`* | *`A,#I,#H`* | *`A,#I,#H`* | `#H,A,#I` |
| 11. Start `A,C,D,B` after a seen move; Alice moves B after C while Bob moves B before A; Bob undoes | `A,C,D,B` → `B,A,C,D` → `A,B,C,D` | → `A,C,D,B` | → `A,C,B,D` | as C | → `A,B,C,D` |
| 12. Start `A,B`. Offline, Alice and Bob each delete B and undo; Bob redoes | **`A,B`**, B has no record or visual cell | same | same | same | same |
| 13. Start `A,B,#H`; A is moved into H; then history 12; then Alice deletes A | `B,#H,A` → **`#H,A,B`** → **`B,#H`** | as A | as A | as A | `B,#H,A` → **`B,#H,A`** → `B,#H` |
| 14. History 12, then Alice inserts N before B | **`A,B`** → `N,A,B` | as A | as A | as A | **`A,B`** → `A,N,B` |

(In the test files, history 11 here is "a row moved earlier", and histories 12 to 14 are the record-loss histories; the table puts them in reading order.)

In A and E, the redo in histories 9 and 10 pops its item and changes nothing stored; E11's harness reports that as never-acceptable ("redo popped an item but changed nothing stored"), and the tests list it. In history 13, the bold parts in A to D are B's missing record and then B leaving scene H when only A is deleted. In E, B never enters H: from the record loss on, it reads at its fixed place.

C was also run with two other reader orders, for the record ("lowest rank wins" and "highest clock wins"). Neither shows a never-acceptable result beyond the record loss every option shows.

### A redo or undo against a later, seen placement

A heading move always changes which rows sit under that heading; that is what a heading move is. What is new in histories 9 and 10 is that a redo wins over a later move the presser had seen. In history 9, Bob moved H after I and took it back; Alice saw that and moved H to the top; Bob's older redo puts H after I again. Plain Yjs (A) does not allow this: Bob's redo finds Alice's later write after his and does nothing. B always writes its old value. In C the redone entry is a new key with a higher stamp. In D the redone element comes back at its old place, before Alice's, so Alice's stays last. In history 10, though, Carol had seen Bob's redo, and her own redo brings her element back after Bob's redone one, so her placement wins over his later one.

The press checks (below) flag the same: B in histories 2, 6, 9 and 10, C in 9 and 10, D in 10, A and E never.

### Rows the press did not place

E11's scene check and drift counter skipped undo and redo presses (the scene check ran only for typing, erasing, formatting, fields, split, join, unjoin and delete; the drift counter counted rankless beats only). E15 adds an opt-in check on every press, without changing E11's counts. The press is traced back to the command it takes back or puts back. Every row that command placed is left out: the moved rows, the rows inside a moved range and the headings in it, a moved heading's scene, deleted, split, joined or inserted rows, and a new, removed or restored heading's scene. The check then asks three things. Did any other beat change scene? Did the other rows and headings change order among themselves? And did the press move a row or heading that another person had moved, or redone a move of, after the pressed command, where the presser had seen that change?

In the named histories, no press moves rows it did not place, in any option.

## Record loss (review item 2)

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

Every throw comes before any write; the table checks the stored state before and after. In round 1, D's insert wrote the new row's narration and record and then threw in `Y.Array.push`, leaving N without a visual cell. D now checks for a missing rank before it writes anything. C now writes no entry for a missing rank, as A stores no value. After the fix, N is whole in every option: it has a record and a visual cell, takes typing in its visual cell, and splits. In A to D, though, N shows above A: B has no rank, so N gets none either, and N's segment is read before A's. In E, N takes B's fixed place and shows between A and B.

History 13 is the reviewer's second case. A is moved into H; B then loses its record. In A to D, B is rankless and follows A into H (`#H,A,B`). Deleting only A then sends B above H. In E, B stays at its fixed place above H throughout.

The same race on a segment head (A in `A,B`, whose boundary is the segment's `head` entry) loses the `head` entry too. A is then no row in any option: no boundary, no record, no visual cell. Its narration reads as the start of B's (`B: ab`). In E the fixed place lived in that entry, so the reader has nothing left for A. No command writes a different `head` on an existing segment, so this delete, undo and redo race is the only way I found to race the key.

With E14's kept containers (`KeptReplica`, which never deletes a record or visual cell), the same delete, undo and redo leave B's record and visual cell in place on both copies. Without them (A), both are gone. That is the fact; I did not evaluate E14's other trade-offs.

## The generated sets

Every history was played in the same five deliveries, with name cells. Each option generated its own E11 histories from its own rows, so every command is one a person could have made on that screen. "Never" counts never-acceptable results; "local" counts broken promises at a command. For E, "rankless read" counts fixed-place reads.

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
| Presses checked, mixed / double split / E10 | 1,104 / 389 / 1,800 | 1,104 / 389 / 1,816 | 1,105 / 389 / 1,816 | 1,104 / 389 / 1,816 | 1,104 / 389 / 1,800 |
| Press changed the scene of a row it did not place (histories) | 0 | 0 | 0 | 0 | 0 |
| Press changed the order of rows it did not place (histories) | 1 | 1 | 1 | 1 | 1 |
| Press moved a later, seen placement (histories), mixed / double split / E10 | 0 / 0 / 0 | 2 / 0 / 8 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| E10, 229: never / local | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| E10: preferred / other / broken | 167 / 62 / 0 | 167 / 62 / 0 | 167 / 62 / 0 | 167 / 62 / 0 | 167 / 62 / 0 |

The one press that changed the order of rows it did not place is the same history in every option (mixed, seed 415). Copy 1 moved scene J21 while heading I was removed and sat inside J21's range, so the move carried I with it unseen. Copy 2 then restored I. Copy 1's undo of the move puts I back where it was. The check cannot see that the move placed I, because I was hidden at the time. No row loses or gains a scene.

Accepted-loss kinds that changed from A (mixed set):

| Kind | A | B | C | D | E |
| --- | ---: | ---: | ---: | ---: | ---: |
| Undo press passed over an item that no longer changed anything | 16 | 10 | 11 | 11 | 16 |
| Undo of a move did nothing visible | 8 | 4 | 8 | 8 | 9 |
| Undo press changed only formatting no one can see | 2 | 3 | 2 | 2 | 2 |
| Unseen record change discarded with a deleted beat | 131 | 131 | 130 | 130 | 131 |
| Unseen visual change discarded with a deleted beat | 106 | 107 | 108 | 107 | 106 |

In E10's set, B takes both undo kinds from 8 to 0, and C and D take "passed over" from 8 to 0. E matches A in E10's set. In the double-split set, B and E each add one "undo of a move did nothing visible" (2 → 3).

E10's 229 histories: no never-acceptable or local results in any option. Preferred / other / broken is 167 / 62 / 0 in every option, and no collision outcome changes from A.

I also replayed A's own command lists under B to E. Those lists were made from A's rows, so a few commands do not fit the other options' rows. B refused 1 + 1 (mixed + double split), C 6 + 4, D 5 + 3 and E 1 + 1, all "Missing row", "Unknown drop" or "Drop inside the moving range". The two local failures from round 1 remain (B seed 209 and C seed 270), traced then to commands E11's generator never offers on those rows.

## Overwrites by an undo or redo press

`overwrite.ts` counts, in the 600 mixed histories, the presses that change a value another person wrote. The table in round 1 showed values, not presses. In B, 8 values changed (7 beat ranks and 1 heading rank), across 6 presses in 6 histories, out of 1,104 presses. A, C, D and E: 0 in the generated set. A hand-built case (history 9's steps) shows the counter sees C's redo overwrite H's rank too; the generated histories never produced that.

My round-1 example was wrong. In seed 127, copy 2's step 19 and copy 0's step 30 had not seen each other, but they were 11 steps apart, outside E11's three-step window for "at the same moment". With B, copy 0's undo moves A back above C and away from N11, so it takes back copy 2's placement too. With A, C, D and E, copy 2's placement stays.

The counter reads Yjs internals: the writer id of a map item, and of a list's items. It skips segment text. It treats root entries (a record, a visual cell, a name cell) as present or absent, not by content. It leaves out `false` values, so a field going from `false` to something else is not counted.

## Growth in C and D

Start `A,B,C,D`. Each round, Alice moves B after C while Bob moves B after D; everything is delivered; both undo; everything is delivered again.

| Round | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| D: live entries in B's list | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 |
| C: live entries for B | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |

The rows show `A,B,C,D` throughout. In D, the count after n rounds is 2^n. Each move deletes the n live elements it sees and pushes one. Each undo deletes its own element and brings back the n it deleted, at their old places, so two undos make 2n. An ordinary move that has received every entry deletes them all and leaves one. Its undo brings all 256 back, and eight more redo and undo cycles kept 256. In C, both undos bring back the same deleted key, which Yjs keeps once.

C's reader order is exact: the greatest stamp wins, then the higher client, then the higher clock. A stamp is one more than the highest stamp the writer saw in that record. So two offline moves by Alice (stamps 2 and 3) beat one by Bob (stamp 2), although Bob's client is higher.

## Fields and keys

`keys.test.ts`, now with name cells. Alice and Bob write the same key at once, everything is delivered, Bob wins and undoes:

| Key | A, C, D and E | B |
| --- | --- | --- |
| rank | not one answer: A reads rule (e) (history 1), C and D show Alice's move, E shows the fixed place | the place from before the race |
| `status` (was `todo`) | blank | `todo` |
| `lens` (was `wide`) | blank | `wide` |
| `status` (blank before) | blank | blank |
| `joined` (no value before) | B is not joined, though Alice joined it | same |
| `removed` on a heading | H is back, though Alice removed it | same |

Round 1's table put C and D with A for ranks; that was wrong, as history 1 shows.

A seen replacement: Bob sets the status to `todo`; Alice sees it and sets `done`; Alice undoes, then redoes. Every option shows `todo → done → todo → done`. The same holds for a nested text (a `Y.Text` under a record key) that Alice replaces after seeing Bob's.

## How the rows were checked

E11's harness (`play`, its promises, its reachability and never checks, its ledger and its generator) judges, unchanged. E15 adds, through optional hooks:

- A command that types, erases, formats or sets a field leaves every row where it was.
- In C and D, a rank write other than an undo or redo leaves exactly one live entry.
- The press checks above, opt-in, counted apart from E11's.

### Controls on generated histories

25 generated histories per option: a clean baseline first, then every library write is muted once and must be caught at the command that made it. Totals include muting each whole command. The labels group calls by method and key name, so `YMap.set:e10Rank` covers every block's rank write and `rank entry` every one of C's entries.

| | A | B | C | D | E |
| --- | ---: | ---: | ---: | ---: | ---: |
| Used | 2,274 | 2,274 | 2,476 | 2,542 | 2,274 |
| Effective | 2,213 | 2,213 | 2,416 | 2,481 | 2,213 |
| Caught by a check | 2,152 | 2,152 | 2,358 | 2,423 | 2,151 |
| Threw while the command ran | 39 | 39 | 39 | 39 | 39 |
| Threw in the checks after it | 19 | 19 | 19 | 19 | 19 |
| Not caught | 3 | 3 | 0 | 0 | 4 |

A throw is not a caught control. The 39 throws while running are 38 from muting a new heading's record (the command cannot write its rank) and 1 from muting a new beat's visual cell. The 19 in the checks come from muting a new heading segment's `text`, which the reading code then cannot read.

The 3 not caught in A and B (and 3 of E's 4) are `move / YMap.set:e10Rank`. Each is a range move, seeds 4 and 12 among them. The range contains a removed heading, the move rewrites that heading's rank, and removed headings are not shown, so the rows cannot show the muted write until the heading is restored. E's fourth is `type / YMap.set:e10Rank`: typing into the loose narration claims a stray row and writes its first rank. When that write is muted, E reads the row at its fixed place, which is the same place.

### Controls on the named histories

Every library write of every command in all 14 named histories is muted once (forward delivery). The settled rows are compared with the intended rows in `model.ts`, and the never, local and storage checks look for partly written state.

| | A | B | C | D | E |
| --- | ---: | ---: | ---: | ---: | ---: |
| Used | 107 | 107 | 135 | 136 | 107 |
| Effective | 70 | 70 | 84 | 89 | 70 |
| Caught by a check | 49 | 45 | 56 | 60 | 49 |
| Caught only by the intended rows | 16 | 20 | 19 | 18 | 15 |
| A command threw | 3 | 3 | 3 | 3 | 3 |
| Not caught | 2 | 2 | 6 | 8 | 3 |

The 3 throws, in every option, are in history 14, all at the insert. Muting the cut of Alice's delete, or her whole undo, leaves B no row on her copy, and the insert throws `Missing beat B`. Muting the new segment's `text` makes the insert throw reading it.

Every write not caught is a whole undo or redo press, never a single write inside a command. Muting it leaves the intended rows because another person's command makes the same rows (both undo the same deletion), or later replaces what the press wrote. The stored state differs; the rows cannot show it.

### What is still read from the implementation

- Everything on E11's list, because E15 reuses its harness: the acting copy's rows, used to pick commands; undo stack depths; `Y.snapshot`; and stored readings for controls.
- The hydrated letters and their owners and roles (narration, visual, heading name), read from the seeded copy's rows. The acting copy's row order and members before and after each command. Each row's text and the letters a command selects. The members a delete takes away. Heading offsets for a new heading. The formatting already on the letters a command formats. The real undo and redo stack depths, which tie each press to the command it takes back.
- `storedRank`, through each option's own reader, for the rankless list and rule (e).
- The E15 checks read rank entries under each option's names (`rank:` keys, the `ranks` list).
- The overwrite counter reads Yjs internals: map-item and list-item writer ids. Its blind spots are listed above.
- E's fixed places, through `fixedPlaces()`, only in the segment-head test.
- The named histories' expected rows are written by hand in `model.ts`, which imports nothing. Its register model is a second, independent reading of each option's rule.

## Costs

`node src/native-rank-undo/cost.ts`, run three times on an idle machine. The fixture is E11's: 300 beats with name cells, then 1,000 single-row moves on E10's schedule by one writer. Each boundary is the one the option writes at hydration, so E's carries `at`. "Kept" is the growth of a fresh copy's encoding per move. Read and move times are medians at 900 beats; the ranges are over the three runs.

| | A: as built | B | C | D | E |
| --- | ---: | ---: | ---: | ---: | ---: |
| Starting document, 300 beats, bytes | 82,175 | 82,175 | 83,999 | 83,695 | 86,705 |
| Bytes per row | 273.92 | 273.92 | 280.00 | 278.98 | 289.02 |
| Bytes sent per move | 38.32 | 38.32 | 51.77 | 38.32 | 38.32 |
| Bytes kept per move | 9.42 | 9.42 | 22.89 | 10.53 | 9.42 |
| Full read at 900 beats, ms | 3.80–3.98 | 3.93–4.29 | 5.40–5.77 | 3.90–4.16 | 4.07–4.13 |
| One move at 900 beats, ms | 4.15–4.30 | 4.31–4.44 | 7.06–7.58 | 4.48–4.57 | 4.55–5.03 |

E's read walks every segment's boundaries for fixed places only when some block has no rank. In this fixture every block has one, so its extra read time is the check for that.

The reviewer's fixture-dependence figures, which I reproduced with E added (A / B / C / D / E):

| Run | Bytes per move |
| --- | --- |
| Three alternating writers, synced after each move: sent | 37.59 / 37.59 / 51.21 / 37.59 / 37.59 |
| 1,000 moves in one transaction: sent | 27.73 / 27.73 / 41.20 / 28.84 / 27.73 |
| Garbage collection off, one writer: kept | 27.73 / 27.73 / 41.20 / 28.84 / 27.73 |
| Mine, one writer, garbage collection on: sent / kept | 38.32 / 38.32 / 51.77 / 38.32 / 38.32 sent; 9.42 / 9.42 / 22.89 / 10.53 / 9.42 kept |

So per-move bytes depend on the fixture: batching and garbage collection move them by a quarter or more, but the order between the options stays.

E's cost is in the boundary, not in the move: about 15 bytes more per row. Typing does not touch ranks or boundaries in any option, and I did not time keystrokes.

Code on top of Yjs, in `variants.ts`:

- B is one setting.
- C is about 42 lines, including a reader order that had to be chosen.
- D is about 39 lines. Its split writes the new beat's rank in a second step, and its writer checks for a missing rank before it writes.
- E is about 62 lines, plus about 25 lines of hooks in earlier modules: who writes a boundary, and the first rank of each new block.

## Each option as a person would notice it

**A, as built.**
- After the race and the winner's undo, the row follows the row before it in the narration. That is wherever that row now is, possibly in another scene (history 1: from the top to under H).
- An undo or redo never changes someone else's later, seen change. An older redo that conflicts does nothing visible, and the press is used up.
- A row that comes back with no position follows its narration neighbour; deleting that neighbour later can move it to another scene (never-acceptable). A row with no record shows its narration, but setting a status, moving, splitting or joining it throws, and so does typing in its visual cell.
- Bytes and time: the baseline.
- Code: none.

**B, `ignoreRemoteMapChanges`.**
- After the race and the winner's undo, the row is where it was before the race. The loser's undo does the same, taking back the winner's move too.
- An undo or redo can replace someone else's later, seen change: a moved row, a moved heading, a status. In generated histories, 6 of 1,104 presses did this to 8 places.
- A row with no position: none came back in any set. A row with no record: as A.
- Bytes and time: as A for bytes; a read about 9% and a move about 4% slower at 900 beats (middle of three runs).
- Code: one setting; Yjs marks it experimental, and it applies to every map key in the undo scope.

**C, one entry per move.**
- After the race and the winner's undo, the row is where the other person put it.
- An undo never overwrites, but a redo can replace a later, seen placement (histories 9 and 10).
- A row with no position: none came back. A row with no record: as A.
- Bytes and time: 22.89 bytes kept and 51.77 sent per move; a read about 46% and a move about 70% slower.
- Code: about 42 lines and a reader order to keep.

**D, a list per record.**
- After the race and the winner's undo, the row is where the other person put it.
- In history 10, a redo replaced a later placement: Carol's, over Bob's redo she had seen. The generated sets found none.
- Racing moves and undos double the stored entries each round (256 after 8 rounds); the rows do not show it.
- A row with no position: none came back. A row with no record: as A; inserting before it no longer half-writes.
- Bytes and time: 10.53 bytes kept and 38.32 sent per move; a read about 9% and a move about 7% slower.
- Code: about 39 lines.

**E, a fixed place.**
- After the race and the winner's undo, the row is at the place it was created. In history 1 that is where it stood before the race. In history 11 it is two rows from where it stood, because it had been moved before the race.
- An undo or redo never changes someone else's later, seen change, as in A, and a conflicting older redo does nothing visible, as in A.
- A row that comes back with no position stays at its fixed place. A row with no record does the same, and a row inserted before it lands next to it. Setting a status, moving, splitting or joining it still throws, as in A.
- Bytes and time: about 15 bytes more per row (5.5%); the same bytes per move as A; a read about 8% and a move about 18% slower.
- Code: about 62 lines plus hooks.

**Once a row has no rank, can a later command that does not touch it, other than a heading move, change its scene or its order among unmoved rows?**

- **In E, no.** Its place is the fixed `at` from its boundary. An unmoved row keeps its rank. Ranks and fixed places are unique: each carries the writer's client and a counter, and hydration gives each block its own index. A move writes a rank between the neighbours as read, fixed places included.
- **Evidence:** E11's drift counter and the press scene check are 0 for E in every generated set and in E10's. The one press-order case is a hidden heading, as in every option. History 13 keeps B above H when A is deleted.
- **Two limits.** Creating or removing a heading changes which rows sit under it, for any row. And if any rankless block has no `at`, E falls back to rule (e) for the whole reading. A block from a document written before E would have none. Every block made by these commands and by hydration here has one.
- **In A to D, yes.** In A, after the winner's undo (histories 1 and 5). In A to D, after a record loss (history 13).

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
- `test/native-chosen/play.ts`: optional `pressChecks`, `mute` (one call at one step) and `listCalls`, with their results in new optional fields. `ControlCount.checkThrows` counts throws in the checks after a command. Defaults: off.
- `test/native-chosen/engine.ts`: as in round 1.

E11's control counts are unchanged: 2,233 used, 2,173 effective, 2,112 caught, 58 throws and 3 unchanged.

## What I did not test

- Product code, the editor, and anything a person clicks. These are prototype replicas driven by commands.
- Inline heading names. Every E15 run uses name cells, E11's chosen combination.
- An undo manager that merges presses (`captureTimeout` above 0).
- Long sessions. D's doubling is measured over 8 rounds; nothing longer.
- E on a document with boundaries written without `at`, and E's HTML hydration path.
- Keystrokes.
- B for fields together with C, D or E for ranks.
- What should happen to a row with no record. E14's kept containers keep the record, as stated above; I did not combine them with B to E.

## The owner question

When two people move the same row at once and the winner undoes, where should the row be? May an undo, or an older redo, replace a placement someone else made later and had seen? And what should a person see when a row comes back with no position, or with no record?

- **(a) A, as built.** The row follows its narration neighbour and can later move into another scene with no one touching it. Undo and redo never replace another person's later change; a conflicting redo does nothing. A row with no record shows its narration, but most commands on it throw. No cost.
- **(b) B, `ignoreRemoteMapChanges`.** The row goes back to where it was before the race. Any undo or redo can replace another person's later, seen change, for places and for every other field. A row with no record: as A. No bytes; one experimental setting.
- **(c) C, one entry per move.** The row shows the other person's move. Undo never replaces a later change, but an older redo can. A row with no record: as A. 2.4 times A's bytes kept per move, a read about 46% and a move about 70% slower, and a reader order to keep.
- **(d) D, a list per record.** The row shows the other person's move. An older redo replaced a later placement in one three-person history. Stored entries double with each round of racing moves and undos. A row with no record: as A. About 12% more bytes kept per move; a read about 9% and a move about 7% slower.
- **(e) E, a fixed place.** The row returns to where it was created, which can be far from where it stood; it never moves again unless someone moves it. Undo and redo behave as in A. A row with no record stays in place, but most commands on it still throw. About 15 bytes more per row; a read about 8% and a move about 18% slower.
