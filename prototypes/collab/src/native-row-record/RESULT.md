# E17: a shown row always has its record

Prototype only. Nothing here ships. Code: `src/native-row-record/`, tests: `test/native-row-record/`. Yjs 13.6.33, Node 24.22.1. Options are opt-in variants on top of E14's kept records (`src/native-kept/`).

## Verdict

**Correction, 2026-11-19.** Three statements in this file said that under R, Bob's undo of his cut shows nothing. That was wrong. After Alice's undo, B is empty on both copies. Bob's undo then shows the narration in B again on both copies: `A: a, B: b`, or with `bcd` as the text, B goes from empty to `bcd`. All three places below are corrected, and `review.test.ts` now pins what every copy shows before and after Bob's undo.

Both new options remove the failure. A row shown without its record or visual cell drops from 30 of 90 runs (K) to 0 of 90 (R and U). In every copy after every step, it drops from 480 of 3,000 to 0.

Scope of the clean result: no lost narration, no row shown twice, no disagreement between copies and no reader failure. That holds in the tested histories, commands and checked readings only:
- the 18 named histories, E15's 21 and the head race;
- the 16 table commands and the follow-up cases below;
- E14's and E16's generated sets.

The options differ in whose intent wins:

- **R, a reading rule.**
  - A boundary without its record or cell is not a row; its text reads as part of the row above. Alice's undo of her split wins, so N stays hidden. Bob's undo of his cut brings the narration back, shown as B's text (`B: b`), so the document looks as it did before the split.
  - R stores nothing extra and changes no figure in any generated set.
  - The hidden boundary stays in the text, though, where B's own text ends. Text typed into B after that point moves into N if Alice later redoes her split.
- **U, creation is not undone at the record.**
  - The record and cell a command creates survive a plain undo of that command. This uses the undo manager's public `deleteFilter`; it is one statement.
  - Bob's undo wins: the row comes back whole, with the status and visual Bob typed. All 16 table commands work on it, and the notice reader lists it, as the row list does.
  - Restoring a cut neighbour from the notice fails while N has no rank, as in K. A remote creation undo no longer reaches the beat-map observer.
  - The row comes back without a rank, so its place follows rule (e). An unrelated cut can move it out of its scene.
  - Cost: about 31 bytes stored for every undone creation.

U also removes the record and visual losses E14's sets still had (192 records or cells in E11 mixed, down to 0). It removes E16's one remaining unseen record loss (1 to 0), and gives back no E16 gain. R moves none of these figures.

No generated history in E9, E10, E11 or E16 produces the failure itself (0 runs with a bare boundary under K). It needs the four-step race below.

This is a measurement, not a recommendation.

## Reported first

- **Writer failure, K only.** After the four steps, 5 of 16 table commands throw after writing:
  - create a heading above N;
  - move the run B through N above A (E16's finding);
  - move B to the top;
  - move A below B;
  - create a heading above B.

  The three moves leave `B, N, A` stored and throw `Missing record b:N`. Five more commands on N throw before writing. Smallest history: the four steps (history 1). R and U have no throw after writing among the 16. R has one throw before writing: join N up to B (`Nothing above N`).
- **Restore from the notice fails, K and U.** Save A's notice entry, play the four steps, cut A, then restore A with `putNoticeBack`. K and U throw `Expected a flat rank` before writing, because N has no rank. R restores A and shows `A2: a, B: b`.
- **Reader disagreement, K only.** After the four steps, K's row list shows N but the notice reader leaves N out (E16's finding). In R both leave N out; in U both show it.
- **Observers differ, U only.** When Alice's creation undo arrives at Bob's copy, K and R report N from both the beat-map removal observer and the row removal observer. U reports it from the row observer only: the record is kept, so the map entry is never deleted.
- **Narration stored twice, all options.**
  - E16's kind "a double delete then a double undo doubles the narration" is 3 under K, R and U alike.
  - The same shape follows from E17's histories 4c and 5c. Both people then cut N without seeing the other's cut, exchange, and each undoes. Every copy and a fresh reader then store four N markers and `bb`, and show one row `N: bb`. This holds under K, R and U, in all five modes.
  - E17 neither causes nor fixes it.
- **Two stored markers for N.** Histories 4c and 5c end with two N markers in the text in all five modes, showing one N and one `b`. A single cut and undo afterwards restores that two-marker, one-letter state. No continuation showed N twice.
- **E16's ledger under U.** In 3 seeds of E16's mixed set, the ledger notes a letter as "typing in a new beat lost when its creator undoes the creation unseen but is shown".
  - The ledger looks for letters in shown cells and in stored hidden visual cells in the same lookup, so "is shown" here means stored.
  - None of the three letters is in the outline. All three are listed by `recovery()` as unplaced visuals (seed 252 N25 `К`, 287 N22 `З`, 367 N12 `Г`).
  - In seed 252 the creator's next redo brings back N25 with its letter. In seeds 287 and 367 the creator's redo changes nothing at the end of the history.

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
  - A command naming the hidden id finds no row and writes nothing (the same path as a cut row). Join has nothing above and throws before writing.
  - Nothing is written to the document, so copies agree by construction.
  - Code: a 4-line opt-in hook in `src/native/variant.ts` (`unopened`), 3 members of `src/native-kept/replica.ts` made `protected`, and about 20 lines in `variants.ts`.
- **U.** `keepCreated = true` switches on the replica's existing `deleteFilter`.
  - **The filter.** It refuses to delete an item whose content is a `Y.ContentType` and whose immediate parent is the root `beats` or `visuals` map. Yjs applies it to every candidate deletion on both undo and redo, with no check of which command made the item.
  - **What stays undoable.** Values inside the record, such as the rank and the creator's initial fields, are not root-map entries. They stay undoable, so the creator's undo still deletes N's rank.
  - **Redo.** After a plain split and undo, redo brings back the rank and the boundary into the kept record and cell. After the four steps, Bob's undo has already brought the boundary back, and Alice's redo restores the rank without adding a second marker. Bob can undo and redo a visual edit he made to N while N is hidden.
  - **Direct deletion of the containers.** This differs from ordinary commands. Delete B's record and cell in one tracked transaction, then undo, then redo. Under K and R the redo deletes them again; under U they stay.
  - Code: about 7 lines in `variants.ts`, effectively one statement.
- **Other routes.** Nesting an untracked transaction inside the tracked command does not work: Yjs keeps the outer origin.
  - A separate, outer, untracked transaction does work with the replica's own undo manager, in K, R and U (`review.test.ts`, point 6). It creates the record and cell first, then a tracked transaction writes the boundary and rank. Undo removes the boundary and rank and keeps the record; redo brings both back.
  - The cost is a second transaction, with its own moment when other copies can see it and its own way to fail half-done. It was not wired into the replica's commands.
  - `deleteFilter` is the smallest change shown here that keeps a creation in one transaction. A smallest solution in general is not established.

## The named histories

Each history was played in five delivery modes: forward, reverse, twice, shuffled and whole state. All modes agree in every history and option. The expected rows come from `test/native-row-record/model.ts`, which imports nothing and follows the library's undo rules (redone links per copy, a redo goes into its parent's replacement only). All 90 runs per option match the model on every copy after every step.

Shown rows at the end, narration after the colon:
- "no rec" means the row is shown without its record or cell.
- "no rank" means it is read by rule (e).
- "a" is the base. "b" adds Alice redo, Bob redo, Alice undo. "c" adds Bob redo, Alice redo, Bob undo.
- The last column counts, in K and in one delivery mode, the copy-steps where some row was shown without its record or cell (both copies, after every step). Over five modes they sum to K's 480. R and U have 0 everywhere.

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

² Two N markers are stored and one N is shown (see "Reported first").

Where `b` is missing (1b, 3b, 4b, 5b, 6b), Bob's redo of his cut deleted it. That is his command, not a loss. In b and c, the end state is the same in all options; only K shows a row without its record on the way.

At settlement N is shown without a rank in 30 of 90 runs under K, 0 of 90 under R (N is hidden there) and 30 of 90 under U.

### In one sentence each

- **1a, 3a to 6a.**
  - K: Bob's undo wins for the text, but his row comes back without a record or cell, so most commands on it fail.
  - R: Alice's undo wins; N is hidden and `b` reads as B's text, as before the split. After Alice's undo B is empty; Bob's undo writes the boundary back and shows `b` in B again on both copies.
  - U: Bob's undo wins; N comes back whole with whatever Bob wrote to it, but without a rank, so its place follows rule (e).
  - Nothing is lost in any option. In 3a, Bob's undo also brings back A and B in all three.
- **2a.** As 1a, but N is empty and `b` never left B. Under R the document looks untouched. Under U an empty N follows B.
- **b continuations.** Bob's redone cut wins in all options; N and `b` are gone by his command.
- **c continuations.** Bob's undo of his redone cut wins in all options; N is back whole with its rank.
- **Bob's edits** (`named.test.ts`): Bob sets N's status and types `v` in its visual cell, then cuts N, and the four steps continue.
  - K: shows `N: b` with neither edit.
  - R: hides N. Alice's undo deleted Bob's edits with N's record and cell; they come back if Alice redoes her split (below).
  - U: shows `N: b / v` with status `done`.
  - N has no rank in all three.
- **E15's 21 histories and the segment-head race** read the same in K, R and U, in every mode, with no failure. History 12 (both delete B offline, both undo, Bob redoes) shows `A:a, B:b` whole in all three: E14 already fixed it. In the head race (both delete A, both undo, Bob redoes), A's head entry is gone and `a` reads into B (`B: ab`) in all options. The record is not what is missing there, so neither option changes it.

## R: where later edits go

`review.test.ts` continues the race on `A: a`, `B: bcd`. R settles `A: a, B: bcd`, stored `[A]a[B][N]bcd`, with no record or cell for N. In every case below, all copies and a fresh reader agree, nothing throws, and no narration is lost, doubled or left unshown.

| Next steps | Shown | Stored |
| --- | --- | --- |
| Alice redoes her split (Bob had set a status and visual on N) | `A: a, B: , N: bcd / v`; N's record, cell, rank and Bob's status come back | `[A]a[B][N]bcd` |
| Bob redoes his cut | `A: a, B: ` | `[A]a[B]` |
| … then Bob undoes | `A: a, B: bcd`, N still without record or cell | `[A]a[B][N]bcd` |
| Bob types `x` in B at 1 | `A: a, B: bxcd` | `[A]a[B][N]bxcd` (after N's marker) |
| … then Alice redoes | `A: a, B: , N: bxcd` | `[A]a[B][N]bxcd` |
| Alice types `x` in B at 1, then Bob redoes his cut | `A: a, B: x` | `[A]a[B]x` |
| Bob splits B at 1 | `A: a, B: b, M: cd` | `[A]a[B][N]b[M]cd` |
| … then Alice redoes | `A: a, B: , N: b, M: cd` | `[A]a[B][N]b[M]cd` |
| Cut B | `A: a` | `[A]a` (both markers and `bcd` gone) |
| … then undo | `A: a, B: bcd` | `[A]a[B][N]bcd` (`bcd` once) |
| Move B above A | `B: bcd, A: a`; only B's rank changes | unchanged |
| Join B to A, then unjoin | `A(A+B): a bcd`, then `A: a, B: bcd`; only B's `joined` field changes | unchanged |

What a person would notice: text typed into B after the race can later appear in N when Alice redoes her split. Cutting B also takes the hidden text.

The seam is the hidden marker. It sits where B's own text ended before the split:
- When B had no text of its own, B shows `bcd`:
  - a letter typed at offset 0 lands before the marker (`B: ybcd`, stored `[A]a[B]y[N]bcd`), and Alice's redo gives `B: y, N: bcd`;
  - a letter typed at the end lands after it, and the redo gives `B: , N: bcdz`.
- When B keeps its own `x` (Alice split `xbcd` at 1), B shows `xbcd`:
  - letters typed at offsets 0 and 1 stay in B after the redo (`B: yx` and `B: xy`);
  - offset 2 and the end go to N (`N: bycd`, `N: bcdz`).
- Typing exactly at the seam stays in B. Every copy agrees in every case.

Bare boundaries elsewhere under R. These were built by seeding N and then removing its record and cell with a write no undo tracks:

| Stored | Shown |
| --- | --- |
| `[N]n[A]a` (N at a segment head) | `A: na` |
| `[A]a` then a segment `[N]n` | `A: an` (the previous beat) |
| a segment `[N]n` first, then `[A]a` | `A: na` (the next beat) |
| `[#H][N]n[B]b` | `#H`, `B: nb`; the heading name is unchanged |
| `[#H][N]n`, no beat anywhere | `n` in the narration-only row above `#H` |

A split inside a leading span is misplaced. Split A at offset 1:
- On `[N]ncd[A]a`, which shows `A: ncda`, it gives `A: ncd, M: a`, stored `[N]ncd[A][M]a`.
- On `[N]n[A]cda` it gives `A: n, M: cda`.

When the split point falls inside text read from a bare boundary, the new boundary goes right after A's own. Nothing is lost and copies agree.

## U: the restored row's place

U first shows `A, B, N` with N's record and cell and no rank. N's place then follows rule (e), as in E15, reached by a new route with an intact record (`review.test.ts`):

| Steps after the race | K | R | U |
| --- | --- | --- | --- |
| move B to the top | `B, N, A` stored, throws | `B, A` | `B, A, N`; the move writes a rank into N |
| scene `A, B, #H, C`: move B after C | throws, nothing moved | `A, #H, C, B` | `A, N, #H, C, B`; N stays before the heading and gets a rank |
| B moved into scene H first; the race settles `A, #H, B, N, C`; then cut only B | `A, N, #H, C` (N without record) | `A, #H, C` | `A, N, #H, C` |
| … then undo the cut | back to `A, #H, B, N, C` | back | back |

In the last case N leaves scene H without being selected; the undo moves it back. Rankless rows in the generated sets: 0, 0, 3 and 1 affected runs (E9, E10, E11 mixed, E11 double split), the same in K, R and U.

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

Outside the table:
- Restoring a cut A through `putNoticeBack` throws `Expected a flat rank` before writing under K and U. R restores it.
- Under K and U, an insert before N lands at the top because N has no rank. That is rule (e). "Move B to the top" and "move A below B" both give `B, A, N` under U, so N no longer follows B.

## Generated sets

### E14's replays of E9, E10 and E11

These use the same seeds and schedules as E14, with defaults unchanged. Under K, E14's figures are reproduced.

| Set | Runs | Hidden beat ids with a record or cell, K and R → U | Records or cells that disappeared, K and R → U | Runs with one, K and R → U |
| --- | --- | --- | --- | --- |
| E9 | 2,257 | 2,440 → 2,440 | 0 → 0 | 0 → 0 |
| E10 | 1,145 | 55 → 63 | 32 → 0 | 8 → 0 |
| E11 mixed | 3,000 | 1,223 → 1,293 | 192 → 0 | 67 → 0 |
| E11 double split | 1,000 | 290 → 303 | 32 → 0 | 13 → 0 |

The hidden-id column counts ids in one settled copy per run: up to 15 % more under U (E10, 55 to 63). It is a count of ids, not a storage ceiling.

Other figures are the same in all options:
- problems 0;
- runs with a bare boundary 0;
- runs with a rankless row 0, 0, 3, 1;
- stale steps 0, 0, 15, 10;
- presses 0, 1,816, 1,104, 259, of which 0, 0, 11, 2 passed over an entry and 0, 8, 0, 0 changed nothing.

R's figures equal K's in every column.

### E16's recount

`test/native-row-record/recount.test.ts` runs E16's loop for its kept variant from `native-kept-recount/losses.test.ts`. It uses the same seeds, modes, `keepCutVisuals`, `skip`, `inspect`, `settled` and crossing reader; only the replica changes.

| Figure (600 mixed + 200 twins) | K | R | U |
| --- | --- | --- | --- |
| unseen record change discarded with a deleted beat | 1 | 1 | **0** |
| unseen visual change discarded with a deleted beat | 0 | 0 | 0 |
| typing in a new beat lost when its creator undoes the creation unseen | 3 | 3 | 3 (stored as unplaced visuals, see above) |
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
- The model's own reading of the four steps is pinned from the commands, separately for K, R and U (`variants.test.ts`). Each case in `review.test.ts` pins K, R and U side by side where they differ.

## Costs

Method: `src/native-row-record/cost.ts`, on E14's fixture of 900 beats, with 30 per segment, 120 narration and 48 visual characters each. The PC was in use by its owner and another lane was running, so timings carry that noise.

- **Bytes kept, U.** One writer creates and undoes 300 times; a fresh copy then loads the result.
  - Splits: the encoding is 270,413 bytes under U against 261,219 under K, so U keeps **30.6 bytes per undone split**.
  - Inserts: **30.8 bytes** per undone insert.
  - The creating command sends the same bytes in all options: 98.4 for a split, 173.6 for an insert.
  - The undo update grows from 6.9 to 9.8 bytes for a split, and from 7.0 to 9.9 for an insert.
- **Bytes kept, R.** None; R writes nothing.
- **Time.** Medians of 3 passes; the range is across passes. "Full read" forces a complete read of one fixture.

  | Measure | K | R | U |
  | --- | --- | --- | --- |
  | full read, 51 samples | 7.01–7.11 ms | 6.81–7.39 | 6.96–7.34 |
  | keystroke, 201 samples | 0.14–0.25 ms | 0.14–0.25 ms | 0.14–0.25 ms |
  | split + undo, 51 samples | 12.6–13.3 ms | 13.3–13.9 | 12.5–13.2 |

  Read and keystroke differences are within the spread between passes. R's split + undo range sits about 0.6 ms above K's.

  R clears every cached segment view whenever an entry is added to or removed from the root beat or visual map. The ongoing cost of those re-reads during editing is not measured.
- **Lines changed.**
  - U: about 7 lines.
  - R: about 20 lines, plus a 4-line hook in `variant.ts` and 3 visibility changes in E14's replica.
  - Tests and harness: about 1,000 lines, new and opt-in. E14's `replay.ts` gained an optional variant, and three helpers moved from `reruns.test.ts` to `sets.ts` unchanged.

## What each option does not cover

- **R**
  - Hides Bob's restored row and the record kept with it. A command on that id writes nothing.
  - The hidden boundary stays in the text. Text later typed into B after it moves into N if Alice redoes her split. Cutting B takes it too.
  - A split inside text read from a bare boundary lands after A's own boundary, not at the requested point.
  - In history 1a and its offline variants, Bob's undo shows his narration again, but as B's text, not as the row he restored. Under K it showed as its own row `N: b`.
  - It changes nothing in any generated set.
- **U**
  - Leaves N without a rank, so N's place follows rule (e). An insert before it lands at the top, an unrelated move gives it a rank, and cutting B can move it across a scene line.
  - Restoring a neighbour from the notice fails with `Expected a flat rank` while N has no rank (as in K).
  - A remote creation undo no longer fires the beat-map delete observer.
  - Keeps about 31 bytes for every undone creation in every copy, for good.
  - The filter also keeps containers that a command deletes directly, on redo.
  - Typing into a new beat's visual cell survives the creator's undo as an unplaced visual.
- **Both**
  - Neither changes the head race.
  - Neither changes narration stored twice after both people cut and both undo.
  - Neither fixes rule (e) placement.
- **Not tried:** R and U together; the outer untracked transaction inside the replica's commands.

## Not measured

- Headings: no history creates and undoes a heading under R or U. E16's heading figure (1) is unchanged.
- The ongoing cost of R's cache clearing during editing.
- The reviewer's variant of seeds 287 and 367 in which the creator's redo stays available until the visual write is delivered.
- R and U combined.
- Anything in the product: no product code was changed.

## Owner question

What should happen when someone undoes the creation of a row that another person has since cut and restored?

- **A. Keep K.** The row comes back without its record or visual cell. Setting its status or typing in its visual fails, some moves near it fail halfway, and the offline notice does not list it.
- **B. R, read it as no row.** The restored narration looks like ordinary text of the row above. If the creator later redoes, that text moves into the row, newer typing included. Cutting the row above takes it with it.
- **C. U, keep what a creation made.** The row and the other person's edits come back at once. It has no place of its own: an unrelated move can give it one, cutting its neighbour can carry it across a scene line, and restoring from the notice fails until it has one.
- **D. U now, and decide on R later.** As C. R would be a second guard for any other route to a missing record; R and U were not measured together.
