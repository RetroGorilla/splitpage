# E17: a shown row always has its record

Prototype only. Nothing here ships. Code: `src/native-row-record/`, tests: `test/native-row-record/`. Yjs 13.6.33, Node 24.22.1. Options are opt-in variants on top of E14's kept records (`src/native-kept/`).

## Verdict

Both new options remove the failure. A row shown without its record or visual cell drops from 30 of 90 runs (K) to 0 of 90 (R and U). In every copy after every step, it drops from 480 of 3,000 to 0. No option loses narration, shows a row twice, leaves copies disagreeing or fails a reader in these histories. The options differ in whose intent wins:

- **R, a reading rule.** A boundary without its record or cell is not a row; its text reads as part of the row above. Alice's undo of her split wins, and the document looks as it did before the split. Bob's undo of his cut brings nothing visible back. Commands on that row write nothing. R stores nothing extra. It changes no figure in any generated set.
- **U, creation is not undone at the record.** The record and cell a command creates survive a plain undo of that command. This uses the undo manager's public `deleteFilter`; it is one statement. Bob's undo wins: the row comes back whole, with the status and visual Bob typed. Every command on it works, and the notice reader lists it, as the row list does. Its cost: about 31 bytes stored for every undone creation, and more hidden records. The row it brings back has no rank, because the creator's undo still deletes the rank inside the kept record. It then reads by rule (e): after the block before it.

U also removes the record and visual losses E14's sets still had (192 records or cells in E11 mixed, down to 0). It removes E16's one remaining unseen record loss (1 to 0), and gives back no E16 gain. R moves none of these figures.

No generated history in E9, E10, E11 or E16 produces the failure itself (0 runs with a bare boundary under K). It needs the four-step race below.

This is a measurement, not a recommendation.

## Reported first

- **Writer failure, K only.** After the four steps, 5 of 16 commands throw after writing:
  - create a heading above N;
  - move the run B through N above A (E16's finding);
  - move B to the top;
  - move A below B;
  - create a heading above B.

  The three moves leave `B, N, A` stored and throw `Missing record b:N`. Five more commands on N throw before writing. Smallest history: the four steps (history 1). This is the failure E17 is about. R and U have no throw after writing. R has one throw before writing: join N up to B (`Nothing above N`). U has none.
- **Reader disagreement, K only.** On the same state, K's row list shows N, but the notice reader leaves N out (E16's finding). In R both leave N out; in U both show it.
- **Narration doubled, all options.** E16's kind "a double delete then a double undo doubles the narration" is 3 under K, R and U alike. E17 neither causes nor fixes it.
- **Two stored boundaries for N.** In 2 of 18 histories (marked ² below), N ends with two boundaries in the text. In all options it is shown once and its narration once.
- **E16's ledger under U.** In 3 seeds of E16's mixed set, the ledger expects a letter typed into a new beat to be lost when its creator undoes the creation, but finds it stored. The ledger counts it lost and notes it as "but is shown". All three letters are in a kept visual cell whose row is hidden (seed 252 N25, 287 N22, 367 N12). The letter is stored, not shown. The ledger's expectation was written for K. These 3 notes are reported, not loosened. Whether a later redo shows them was not measured in that set.

## The failure and the four steps

The document is `A: a`, `B: b`. Alice is copy 0, Bob copy 1.

1. Alice splits B at its start, creating N. N takes `b`; B is now empty.
2. Bob cuts N. This deletes N's boundary and its narration `b`.
3. Alice undoes her split. Her undo deletes what the split created: the record, the rank and the visual cell. The boundary is already gone.
4. Bob undoes his cut. His undo brings back the boundary and `b`, but not the record or cell, which his cut never deleted.

In K, N is shown with neither its record nor its visual cell. Each step is delivered before the next. The same happens when steps cross offline.

## The options

- **K, as built.** E14 kept records: a cut keeps the record and cell; a creation undo deletes them.
- **R.** The reader skips a `b:` boundary whose record or cell is missing, like a repeated boundary. Its text joins the row above.
  - At a segment's first block, rule (a) applies: the text reads as the start of the first whole row.
  - A command naming the hidden id finds no row and writes nothing (the same path as a cut row). Join has nothing above and throws before writing.
  - Nothing is written to the document, so copies agree by construction.
  - Code: a 4-line opt-in hook in `src/native/variant.ts` (`unopened`), 3 members of `src/native-kept/replica.ts` made `protected`, and about 20 lines in `variants.ts`.
- **U.** `keepCreated = true`: the existing `deleteFilter` in E14's replica keeps records and cells when a creation is undone, as it already does for a cut. The undo removes the boundary and everything the command wrote inside the record, the rank included.
  - **Redo:** brings back the boundary, and the rank inside the same record. The record and cell were never deleted, so edits others made to them in between stay.
  - Code: about 7 lines in `variants.ts`, effectively one statement.
- **No fourth option.** The other standard route was to create the record and cell in a transaction the undo manager does not track. It was not built: Yjs keeps the outer transaction's origin for a nested `transact`, and split, insert and heading commands create the record inside their own tracked transaction. `deleteFilter` is the library's own hook for this, so U is the standard route.

## The named histories

Each history was played in five delivery modes: forward, reverse, twice, shuffled and whole state. All modes agree in every history and option. The expected rows come from `test/native-row-record/model.ts`, which imports nothing and follows the library's undo rules (redone links per copy, a redo goes into its parent's replacement only). All 90 runs per option match the model on every copy after every step.

Shown rows at the end, narration after the colon. "no rec" means the row is shown without its record or cell. "no rank" means it is read by rule (e). "a" is the base, "b" adds Alice redo, Bob redo, Alice undo, and "c" adds Bob redo, Alice redo, Bob undo. The last column counts, in K and in one delivery mode, the copy-steps where some row was shown without its record or cell (both copies, after every step). Over five modes they sum to K's 480. R and U have 0 everywhere.

| History | K | R | U | K copy-steps missing |
| --- | --- | --- | --- | --- |
| 1a four steps, each delivered | `A:a, B:, N:b` no rec, no rank | `A:a, B:b` | `A:a, B:, N:b` no rank | 5 |
| 1b | `A:a, B:` | same | same | 7 |
| 1c | `A:a, B:, N:b` | same | same | 6 |
| 2a split at the end | `A:a, B:b, N:` no rec, no rank | `A:a, B:b` | `A:a, B:b, N:` no rank | 5 |
| 2b | `A:a, B:b` | same | same | 7 |
| 2c | `A:a, B:b, N:` | same | same | 6 |
| 3a Bob cuts A, B and N together | `A:a, B:, N:b` no rec, no rank | `A:a, B:b` | `A:a, B:, N:b` no rank | 5 |
| 3b | empty | same | same | 7 |
| 3c | `A:a, B:, N:b` | same | same | 6 |
| 4a Alice undoes before Bob cuts | `A:a, B:, N:b` no rec, no rank | `A:a, B:b` | `A:a, B:, N:b` no rank | 5 |
| 4b | `A:a, B:` | same | same | 7 |
| 4c | `A:a, B:, N:b` ² | same ² | same ² | 6 |
| 5a Bob cuts and undoes while Alice undoes, offline | `A:a, B:, N:b` no rec, no rank | `A:a, B:b` | `A:a, B:, N:b` no rank | 3 |
| 5b | `A:a, B:` | same | same | 5 |
| 5c | `A:a, B:, N:b` ² | same ² | same ² | 4 |
| 6a the cut delivered, both undo offline | `A:a, B:, N:b` no rec, no rank | `A:a, B:b` | `A:a, B:, N:b` no rank | 3 |
| 6b | `A:a, B:` | same | same | 5 |
| 6c | `A:a, B:, N:b` | same | same | 4 |

Where `b` is missing (1b, 3b, 4b, 5b, 6b), Bob's redo of his cut deleted it. That is his command, not a loss. In b and c, the end state is the same in all options; only K shows a row without its record on the way.

### In one sentence each

- **1a, 3a to 6a.**
  - K: Bob's undo wins for the text, but his row comes back without a record or cell, so most commands on it fail.
  - R: Alice's undo wins; N is hidden and `b` reads as B's text, as before the split. Bob's undo writes the boundary but shows nothing.
  - U: Bob's undo wins; N comes back whole with whatever Bob wrote to it, and sits after A because it has no rank.
  - Nothing is lost in any option. In 3a, Bob's undo also brings back A and B in all three.
- **2a.** As 1a, but N is empty and `b` never left B. Under R the document looks untouched. Under U an empty N follows B.
- **b continuations.** Bob's redone cut wins in all options; N and `b` are gone by his command.
- **c continuations.** Bob's undo of his redone cut wins in all options; N is back whole with its rank.
- **Bob's edits** (`named.test.ts`): Bob sets N's status and types `v` in its visual cell, then cuts N. Then the four steps continue.
  - K: shows `N: b` with neither edit.
  - R: hides N, and the edits stay unreachable.
  - U: shows `N: b / v` with status `done`. N has no rank in all three.
- **E15's 21 histories and the segment-head race** read the same in K, R and U, in every mode, with no failure. History 12 (both delete B offline, both undo, Bob redoes) shows `A:a, B:b` whole in all three: E14 already fixed it. In the head race (both delete A, both undo, Bob redoes), A's head entry is gone. `a` reads into B (`B: ab`) in all options. The record is not what is missing there, so neither option changes it.

## Commands on the four-step state

The 16 commands in `commands.ts` were run on Alice's copy after history 1a. Each outcome is decided by comparing snapshots before and after the command.

| Command | K | R | U |
| --- | --- | --- | --- |
| type narration in N | done | no write | done |
| type in N's visual cell | throws before writing | no write | done |
| bold N's narration | done | no write | done |
| set N's status | throws before writing | no write | done |
| move N to the top | throws before writing | no write | done |
| split N | throws before writing | no write | done |
| join N up to B | throws before writing | throws before writing | done |
| cut N | done | no write | done |
| insert a row before N | done (the new row lands at the top) | no write | done (at the top) |
| create a heading above N | **throws after writing** | no write | done |
| move B to the top | **throws after writing** | done | done |
| move A below B | **throws after writing** (`B, N, A` stored) | done | done |
| type narration at the start of B | done | done | done |
| cut B | done | done | done |
| create a heading above B | **throws after writing** | done | done |
| move the run B through N above A | **throws after writing** (`B, N, A` stored) | no write | done (`B, N, A`) |
| row list shows N / notice reader shows N | yes / **no** | no / no | yes / yes |

Under K and U, an insert before N lands at the top because N has no rank. That is E15's rule (e), not E17's. The same rule decides where U leaves N when B moves on its own: "move B to the top" and "move A below B" both give `B, A, N`, so N no longer follows B. K stores `B, N, A` before it throws. R has no N to move.

## Generated sets

### E14's replays of E9, E10 and E11

These use the same seeds and schedules as E14, with defaults unchanged. Under K, E14's figures are reproduced.

| Set | Runs | Hidden records or cells, K and R → U | Records or cells that disappeared, K and R → U | Runs with one, K and R → U |
| --- | --- | --- | --- | --- |
| E9 | 2,257 | 2,440 → 2,440 | 0 → 0 | 0 → 0 |
| E10 | 1,145 | 55 → 63 | 32 → 0 | 8 → 0 |
| E11 mixed | 3,000 | 1,223 → 1,293 | 192 → 0 | 67 → 0 |
| E11 double split | 1,000 | 290 → 303 | 32 → 0 | 13 → 0 |

Other figures are the same in all options:
- problems 0;
- runs with a bare boundary 0;
- rankless rows 0, 0, 3, 1;
- stale steps 0, 0, 15, 10;
- presses 0, 1,816, 1,104, 259, of which 0, 0, 11, 2 passed over an entry and 0, 8, 0, 0 changed nothing.

Under U, hidden kept records rise by 0 to 15 % (E10: 55 → 63). These are the records and cells of undone creations. R's figures equal K's in every column.

### E16's recount

`test/native-row-record/recount.test.ts` runs E16's loop for its kept variant from `native-kept-recount/losses.test.ts` (on `main` since #1644). It uses the same seeds, modes, `keepCutVisuals`, `skip`, `inspect`, `settled` and crossing reader, and only the replica changes. The figures were first taken on E16's branch head `460a104` and match the ones on `main`.

| Figure (600 mixed + 200 twins) | K | R | U |
| --- | --- | --- | --- |
| unseen record change discarded with a deleted beat | 1 | 1 | **0** |
| unseen visual change discarded with a deleted beat | 0 | 0 | 0 |
| typing in a new beat lost when its creator undoes the creation unseen | 3 | 3 | 3 (stored in hidden cells, see above) |
| typing in a new heading lost when its creator undoes the creation unseen | 1 | 1 | 1 |
| split at the same moment as a move left the second half behind (offline) | 1 | 1 | 1 |
| a deletion missed a row another person's unseen undo restored | 3 | 3 | 3 |
| a double delete then a double undo doubles the narration | 3 | 3 | 3 |
| crossed edits whose latest value is stored (field / visual, removed rows) | 120 / 103, 1 field missing | same | 121 / 103, none missing |
| crossed edits on shown rows, latest value stored | 6 / 8 | same | same |
| tags requested / lost | 845 / 5 (seeds 53, 137, 211, 352, 447) | same | same |
| never-acceptable problems, missing containers | 0, 0 | 0, 0 | 0, 0 |
| local ledger notes | 0 | 0 | 3 |

K reproduces E16's figures exactly. U's one changed loss is seed 497, step 29: N05's record is now kept with its latest value. No figure gets worse.

## Controls

- **No-op fixes bring the failure back on the set total.**
  - R with the rule switched off (`R0`) and U with a filter that deletes everything (`U0`) both give 30 of 90 runs and 480 of 3,000 copy-steps, as K does. Both match K's model exactly.
  - `U0` also gives back K's figures in all four E14 sets (32, 192 and 32 disappeared) and in E16's whole recount.
- **A deliberately wrong reading is caught.** R that drops a bare boundary's text instead of giving it to the row above (`Rdrop`) mismatches the model in 75 of 90 runs, and the never-acceptable check flags 75.
- **A wrong expectation is caught.** Comparing R against K's model, U against K's, and K against U's mismatches in 90 of 90 runs each.
- The model's own reading of the four steps is pinned from the commands, separately for K, R and U (`variants.test.ts`).

## Costs

Method: `src/native-row-record/cost.ts`, on E14's fixture of 900 beats, with 30 per segment, 120 narration and 48 visual characters each. The PC was in use by its owner and another lane was running, so timings carry that noise.

- **Bytes kept, U.** One writer creates and undoes 300 times; a fresh copy then loads the result.
  - Splits: the encoding is 270,413 bytes under U against 261,219 under K, so U keeps **30.6 bytes per undone split**.
  - Inserts: **30.8 bytes** per undone insert.
  - The creating command sends the same bytes in all options: 98.4 for a split, 173.6 for an insert.
  - The undo update grows from 6.9 to 9.8 bytes for a split, and from 7.0 to 9.9 for an insert.
- **Bytes kept, R.** None; R writes nothing.
- **Time.** Medians of 3 passes; the range is across passes.

  | Measure | K | R | U |
  | --- | --- | --- | --- |
  | full read, 51 samples | 7.01–7.11 ms | 6.81–7.39 | 6.96–7.34 |
  | keystroke, 201 samples | 0.14–0.25 ms | 0.14–0.25 ms | 0.14–0.25 ms |
  | split + undo, 51 samples | 12.6–13.3 ms | 13.3–13.9 | 12.5–13.2 |

  Read and keystroke differences are within the spread between passes. R's split + undo range sits about 0.6 ms above K's. R also re-reads a segment on any change to the records or visuals maps, which this fixture does not stress.
- **Lines changed.**
  - U: about 7 lines.
  - R: about 20 lines, plus a 4-line hook in `variant.ts` and 3 visibility changes in E14's replica.
  - Tests and harness: about 700 lines, new and opt-in. E14's `replay.ts` gained an optional variant, and three helpers moved from `reruns.test.ts` to `sets.ts` unchanged.

## What each option does not cover

- **R**
  - Hides Bob's restored row and the record kept with it. Edits Bob made to that record stay stored but unreachable, and a command on that id writes nothing.
  - It is worse than K in history 1a and its offline variants in one respect: Bob's undo shows no visible effect. Under K it at least showed `N: b`.
  - It changes nothing in any generated set.
- **U**
  - Leaves N without a rank, so N reads by rule (e). An insert before it lands at the top (as in K), and moving B alone leaves N at the end, not under B.
  - Keeps about 31 bytes for every undone creation in every copy, for good. Hidden kept records rise by up to 15 %.
  - Typing into a new beat's visual cell survives the creator's undo, stored but not shown (E16's 3 seeds).
- **Both**
  - Neither changes the head race: a segment that loses its head entry still reads its first row's text into the next.
  - Neither changes the doubled narration of a double delete and double undo.
  - Neither fixes rule (e) placement.
- **Not tried:** R and U together.

## Not measured

- Headings: no history creates and undoes a heading under R or U. E16's heading figure (1) is unchanged.
- Keystroke and read time under R on a document where many records or cells change at once.
- Redo of the 3 E16 seeds whose typed letters U keeps hidden.
- R and U combined.
- Anything in the product: no product code was changed.

## Owner question

What should happen when someone undoes the creation of a row that another person has since cut and restored?

- **A. Keep K.** The row comes back without its record or visual cell; setting its status or typing in its visual fails, some moves near it fail halfway, and the offline notice does not list it.
- **B. R, read it as no row.** The restored row stays invisible and its text joins the row above; the person who restored it sees nothing happen.
- **C. U, keep what a creation made.** The row comes back whole with everyone's edits, placed after the row before it; each undone creation leaves about 31 bytes behind.
- **D. U now, and decide on R later.** As C. R would be a second guard for any other route to a missing record, not measured together.
