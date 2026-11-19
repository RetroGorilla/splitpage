# E15: a row's position after competing moves and undo

Prototype only. Nothing here ships. Code: `src/native-rank-undo/`, tests: `test/native-rank-undo/`. Yjs 13.6.33.

## Verdict

The defect is real. As built (A), two people move a beat at once, the winner undoes, and the beat is left with no rank. A later command that never touched it can then move it into another scene; I reproduced this in the reviewer's history and in E11's six-step history, in all five deliveries. Three plain-library alternatives remove it everywhere I looked: no rankless reads, no never-acceptable results and no changed E10 outcomes in 600 + 200 generated histories × 5 deliveries and E10's 229. They differ in what an undo does to someone else's work. B is one stock Yjs setting (`ignoreRemoteMapChanges`); it makes an undo bring back your old value even over another person's later or winning one. That happened in 8 of 1,104 undo and redo presses, and it applies to every field, not just place. C (one entry per move) and D (a list of entries per record) keep Yjs's rule that an undo never overwrites someone else, so after the winner undoes, the other person's move shows. Each costs bytes and code: C keeps 2.4 times A's bytes per move and is about 55% slower to read; D keeps 12% more and reads about 8% slower. None of them fixes a blank status after the same race. This is a measurement, not a recommendation.

## The mechanism

1. A beat's place is one rank, stored as one plain value under one key of its record.
2. Alice and Bob move the same beat at once. Both write the key. Yjs keeps Bob's value (higher client) and drops Alice's on arrival.
3. Bob undoes. Yjs removes his value and would bring back the one from before, but Alice's later value stands after it, and plain undo never overwrites someone else's change. The key is left empty.
4. A beat with no rank is read by rule (e) at its stored place: where its marker sits in the narration, not where anyone moved it.
5. That stored place is not kept up to date by moves, so it can lie in another scene. The rows look right until some later command rebuilds the reading around it.
6. Then the beat shows in the other scene, though that command never touched it. Alice deletes A, and B leaves scene H.

The reviewer's five-step history is history 1 below. With option A it reads `#H, A, B` after Bob's undo and `B, #H` after Alice deletes A. Confirmed in all five deliveries.

## The named histories

Each history was played in five delivery orders (forward, reverse, twice, shuffled, whole state). All five agree in every history and option. The expected rows come from `test/native-rank-undo/model.ts`, a register model with no imports: per option it says which write stands after each part, and each history lists the rows for each standing write. "start" means the place before anyone moved.

Rows are shown part by part, separated by →. Text cells are left out. **Bold** marks a never-acceptable result.

| History | A: as built | B: `ignoreRemoteMapChanges` | C: one entry per move | D: a list per record |
| --- | --- | --- | --- | --- |
| 1. Alice moves A into H; at once Alice moves B below A and Bob moves B under H (Bob wins); Bob undoes; Alice deletes A | `#H,B,A` → `#H,A,B` → **`B,#H`**: B leaves H, moved by a delete that did not touch it | `#H,B,A` → `B,#H,A` → `B,#H` (B left H at Bob's own undo) | `#H,B,A` → `#H,A,B` → `#H,B` | as C |
| 2. Same race; the loser (Alice) undoes; Alice deletes A | `#H,B,A` → `A,#H,B` (her press passes over to her move of A) → `#H,B` | `#H,B,A` → `B,#H,A` (her undo overwrites Bob's winning move) → `B,#H` | `#H,B,A` → `#H,B,A` (her entry goes, Bob's stays) → `#H,B` | as C |
| 3. Same race; Bob undoes, then redoes | `#H,B,A` → `#H,A,B` → `#H,B,A` | `#H,B,A` → `B,#H,A` → `#H,B,A` | `#H,B,A` → `#H,A,B` → `#H,B,A` | as C |
| 4. Three people move B at once (Carol wins); Carol, Bob, Alice undo in turn | `B,A,C,D` → `A,B,C,D` three times (B is rankless, read at its stored place) | `B,A,C,D` → `A,B,C,D` three times (start) | `B,A,C,D` → `A,C,D,B` (Bob's) → `A,C,B,D` (Alice's) → `A,B,C,D` | as C |
| 5. E11's six-step deletion history | `#H,A` → `#H,A,B` → **`B,#H`** | `#H,A` → `B,#H,A` → `B,#H` | as B | as B |
| 6. Alice moves B; Bob sees it and moves B again; Alice undoes | `A,C,B,D` → `A,C,D,B` → `A,C,D,B` (Bob's move stays) | `A,C,B,D` → `A,C,D,B` → `A,B,C,D` (Alice's undo overwrites Bob's seen move) | as A | as A |
| 7. Alice moves B while Bob splits B unseen; Alice undoes | `A,N,C,D,B` → `A,B,N,C,D` | same | same | same |
| 8. Bob moves heading H while Alice moves B into H; each undoes | same three parts in every option | same | same | same |

C was also run with two other reader orders, for the record. With "lowest rank wins" it gives B's rows in histories 1, 2, 4 and 6. With "highest clock wins" the race in history 1 goes to Alice, so who wins depends on how much each person had typed. Neither shows a never-acceptable result. The order used above is "highest stamp wins, then higher client": a stamp is one more than the highest stamp the writer saw, so a move made after seeing another beats it, and two unseen moves go to the higher client, as in Yjs.

## The generated sets

Every history was played in the same five deliveries, with name cells. "Rule (e) read" counts histories where some copy read a rankless beat at its stored place. "Never" counts never-acceptable results; "local" counts broken promises at a command. Each option generated its own E11 histories from its own rows, so every command is one a person could have made on that screen.

| | A: as built | B | C | D |
| --- | ---: | ---: | ---: | ---: |
| E11 mixed, 600: rule (e) read | 5 | 0 | 0 | 0 |
| E11 mixed: never / local / refused | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| E11 mixed: accepted losses (all kinds) | 303 | 295 | 299 | 298 |
| E11 double split, 200: rule (e) read | 3 | 0 | 0 | 0 |
| E11 double split: never / local / refused | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| E11 double split: accepted losses | 129 | 130 | 129 | 129 |
| Copies disagree after settling | 0 | 0 | 0 | 0 |
| A row moved to another scene with one person working (drift) | 0 | 0 | 0 | 0 |
| E10, 229: never / local | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| E10: preferred / other / broken | 167 / 62 / 0 | 167 / 62 / 0 | 167 / 62 / 0 | 167 / 62 / 0 |
| E10: collision outcomes changed from A | — | 0 | 0 | 0 |

In the generated sets, A reads a rankless beat in 8 histories but never moves it across a scene line. The scene change needs the specific later command of history 1 or 5, and the generator did not produce it.

Accepted-loss kinds that changed from A (mixed set):

| Kind | A | B | C | D |
| --- | ---: | ---: | ---: | ---: |
| Undo press passed over an item that no longer changed anything | 16 | 10 | 11 | 11 |
| Undo of a move did nothing visible | 8 | 4 | 8 | 8 |
| Undo press changed only formatting no one can see | 2 | 3 | 2 | 2 |
| Unseen record change discarded with a deleted beat | 131 | 131 | 130 | 130 |
| Unseen visual change discarded with a deleted beat | 106 | 107 | 108 | 107 |

In E10's set, B takes both undo kinds from 8 to 0; C and D take "passed over" from 8 to 0. In the double-split set, B adds one "undo of a move did nothing visible" (2 → 3).

I also replayed A's own command lists under B, C and D. Those lists were made from A's rows, so a few commands do not fit the other options' rows. B refused 1 + 1, C 6 + 4 and D 5 + 3 (mixed + double split), all "Missing row", "Unknown drop" or "Drop inside the moving range". There were two local failures, and I traced both. In B's (seed 209), E sits first under a heading on B's rows, where E11's generator never offers a join. In C's (seed 270), D is joined into C's row, where the generator never offers "heading above D". Rule (e) reads, never results and drift are 0 in every replay too.

### How the rows were checked

E11's harness (`play`, its promises, its reachability and never checks, its ledger and its generator) does the judging, unchanged. E15 adds two checks through a new optional hook. First, a command that types, erases, formats or sets a field leaves every row where it was. Second, in C and D, a command that writes a rank, other than an undo or redo, leaves exactly one live entry.

The first check was added because the longer control run found a gap in E11's harness. When typing into the loose narration above the first scene creates a beat, muting that beat's rank write moves the new row below `#H`. No promise checked that, because the typed text was right.

Controls, 25 generated histories per option: a clean baseline first; then every effective library write is muted once, and must be caught at the command that made it.

| | A | B | C | D |
| --- | ---: | ---: | ---: | ---: |
| Used | 2,274 | 2,274 | 2,476 | 2,542 |
| Effective | 2,213 | 2,213 | 2,416 | 2,481 |
| Caught by a check | 2,152 | 2,152 | 2,358 | 2,423 |
| Caught by a throw | 58 | 58 | 58 | 58 |
| Not caught | 3 | 3 | 0 | 0 |
| A muted call changed which calls followed | 0 | 0 | 0 | 0 |

Throws, in every option: 38 from muting a new heading's record (the command cannot write its rank), 19 from muting a new heading segment's `text`, and 1 from muting a new beat's visual cell. The 3 not caught in A and B are all `move / YMap.set:e10Rank`. Muting that write leaves the rows unchanged, as in E11. The test allows silence for each option's own rank calls only.

What is still read from the implementation:

- Everything on E11's list, because E15 reuses its harness: the acting copy's rows to pick commands, undo stack depths, `Y.snapshot` and stored readings for controls, and the rest.
- `storedRank`, through each option's own reader, for the rankless list and rule (e).
- The E15 checks read rank entries under each option's names (`rank:` keys, the `ranks` list), and the acting copy's row order before and after.
- The overwrite count reads Yjs internals: a map item's writer and a list's item chain. It measures only and judges nothing.
- In the named histories, the model in `model.ts` has no imports. The rows it points to are written by hand in `histories.ts`. That file uses `kit.ts`'s spec builders, which build plain objects, but that module also imports Yjs.

## Costs

`node src/native-rank-undo/cost.ts`, run three times. The fixture is E11's: 300 beats with name cells, then 1,000 moves on E10's schedule. Bytes "kept" are the growth of a fresh copy's encoding per move. Read and move times are medians at 900 beats. The ranges are over the three runs.

| | A: as built | B | C | D |
| --- | ---: | ---: | ---: | ---: |
| Bytes sent per move | 38.32 | 38.32 | 51.77 | 38.32 |
| Bytes kept per move | 9.42 | 9.42 | 22.89 | 10.53 |
| Starting document, 300 beats | 82,175 | 82,175 | 83,999 | 83,695 |
| Full read at 900 beats, ms | 3.74–3.90 | 3.81–4.13 | 5.53–5.84 | 3.97–4.21 |
| One move at 900 beats, ms | 4.11–4.26 | 4.31–4.39 | 7.23–7.77 | 4.71–4.74 |

E10 measured 9.19 bytes kept and about 38 sent. The 9.42 here is the same measure on E11's fixture, which has name cells.

D sends exactly what A sends. I checked one move's update in both. Each is one new item that names its left neighbour, plus one deleted item. Yjs leaves out the key when an item names a neighbour, so the bytes match. D keeps 1.1 bytes more per move; I did not take that encoding apart.

C sends and keeps more because each move writes a new key, and a new key goes out with its record and its name (about 20 characters). Its read and move are slower because every record's keys are scanned for entries.

Typing does not touch ranks in any option, and the extra observers in C and D fire only on rank changes. I did not measure keystrokes.

Code on top of Yjs, in `variants.ts`: B is one setting. C is about 60 lines, including a reader order that had to be chosen. D is about 35 lines; its reader takes the last live element, and its split writes the new beat's rank in a second step.

## What each option changes elsewhere

**A: as built.** Nothing changes. The same race leaves any plain value empty after the winner's undo, not only a rank. I ran each key a command writes in a beat or heading record (`keys.test.ts`): Alice and Bob write at once, everything is delivered, Bob wins and undoes.

| Key | What a person sees after Bob's undo (A, C and D) | With B |
| --- | --- | --- |
| rank | The beat is read at its stored place (history 1) | The place from before the race |
| `status` (was `todo`) | The status cell is blank: not Alice's, not Bob's, not `todo` | `todo` |
| `lens` (was `wide`) | Blank | `wide` |
| `joined` (no value before) | B is not joined, though Alice joined it | Same |
| `removed` on a heading (no value before) | H is back, though Alice removed it | Same |

So a blank status or lens is a lost value, but the rows do not move. Only a rank feeds the reading of order, so only a rank can move a row that nobody touched.

**B: `ignoreRemoteMapChanges: true`.** One line in the undo manager's settings. In Yjs 13.6.33 it changes one branch of `redoItem` in `structs/Item.js`. Without it, before bringing a map value back, Yjs walks right from the old item. If an item from someone else, not deleted by this stack item or the undo or redo stacks, stands after it, the undo does nothing for that key ("it conflicts with a change from another client"). With it, Yjs skips that walk and always writes the old value as a new item after the current one. Yjs marks the setting "Experimental". It covers every map key in the undo scope, not only ranks; text, lists and formatting are untouched.

- Rankless beats go. Rule (e) was read in 0 of 600 mixed and 0 of 200 double-split histories (A: 5 and 3). This confirms the reviewer's figures.
- An undo now overwrites someone else's later value. The reviewer's case confirmed: status `todo`, Alice sets `ready`, Bob sees it and sets `done`, Alice undoes, and the status is `todo`. The same holds for a seen move (history 6) and for the loser's undo in a race (history 2): the undo puts the row back where it was before both moves.
- In the 600 mixed histories, 1,104 undo and redo presses: B changed a rank another person had written 8 times, in 6 histories (7 beat ranks, 1 heading rank). A, C and D: 0. Example, history 127: copy 2 moves A and N11 below C; at the same moment copy 0 moves A below C; copy 2 wins; copy 0 undoes. With B, A jumps back above C and away from N11, undoing copy 2's move too. With A, C and D, copy 2's placement stays.
- Accepted-loss counts fall a little: "undo press passed over an item" 16 → 10 and "undo of a move did nothing visible" 8 → 4 (mixed), and both 8 → 0 in E10's set.

**C: one entry per move.** Ranks only. A move deletes every rank entry it sees and writes one new key, `rank:<stamp>.<client>.<clock>`. Two unseen moves leave two live entries, and the reader picks one. An undo deletes only its own entry, so the other person's entry shows. Other keys keep A's behaviour (the table above). An entry nobody deletes stays live until the next move of that row or heading, which sees and deletes it. At the end of the 600 mixed histories, with every copy merged, 450 records held one extra live entry (464 extra entries in all). They cost bytes, not correctness: the reader still picks one, and every copy picks the same one.

**D: a list per record.** Ranks only. The rank is the last live element of a `Y.Array` in the record. A move deletes the elements it sees and pushes one. An undo brings a deleted element back at its old place, which Yjs does for list items whoever wrote after it, so this is plain Yjs list behaviour. It must be `push`: `insert(0)` puts a new element before deleted ones, so a restored old element would land after the newer one and win. A split writes the new beat's rank into its list after the record exists. Extra entries: 451 records, 466 entries, the same pattern as C.

Earlier prototype modules got options; each default is the old behaviour:

- `native-moves/ranks.ts`: `readFlat`, `writeFlat` and `flatFields` hooks; the defaults read and write the E10 key.
- `native-chosen/replica.ts`: the private rank read became the public `storedRank`, through `readFlat`.
- `test/native-chosen/kit.ts`, `generate.ts`: an optional replica factory; the default is E11's replica.
- `test/native-chosen/play.ts`: optional `make`, `storage` (an extra check before and after each command) and `ownCalls`; it also returns the settled cells. Defaults: none.
- `test/native-chosen/engine.ts`: `watch` also lists `Y.Array.push` (no E11 code calls it) and takes `ownCalls`, default off. With `ownCalls`, a library call made inside another listed call is not listed or muted. E11's control counts are unchanged: 2,233 used, 2,173 effective, 2,112 caught, 58 throws, 3 unchanged; E9: 26,631 used, 122 throws. All 101 E11 tests pass.

## What I did not test

- Product code, the editor, and anything a person clicks. These are prototype replicas driven by commands.
- A segment's `head` key under a race. Two people write it only when making or deleting segments, and I did not build that race.
- Inline heading names. Every E15 run uses name cells, E11's chosen combination.
- An undo manager that merges presses (`captureTimeout` above 0). E11 sets it to 0, and so does every run here.
- Long sessions. Costs are from 1,000 moves on 300 beats. The extra live entries in C and D were counted at the end of 40-step histories, not over weeks.
- Controls on the named histories. The muted-write controls ran on 25 generated histories per option (below); the named histories have a model and fixed rows instead.
- E9's histories under B, C and D. They were only rerun under A, where the counts match E11.
- Keystrokes. Typing writes no rank in any option, but I did not time it.
- B for fields together with C or D for ranks.
- A fifth option. D is the one further plain-library option the brief allows.

## The owner question

When two people move the same row at the same moment and the winner then undoes, where should the row be, and what may an undo do to someone else's later change?

**(a) Keep A, as built.** What a person notices: after that race and undo, the row sits at an old place. Rarely, a later edit nearby, such as deleting the row above, moves it into another scene; that is on the never list. A status or lens set in the same kind of race goes blank. Cost: none.

**(b) B: turn on `ignoreRemoteMapChanges`.** What a person notices: the undo puts the row back where it was before both moves, which also undoes the other person's move. An undo also overwrites a value someone set after seeing yours, for example a status goes back to `todo` after a colleague set `done`. In generated histories, 8 of 1,104 presses did this to a place. A status no longer goes blank after a race. Cost: no bytes and no code, but Yjs calls the setting experimental, and it changes undo for every field.

**(c) C: one entry per move.** What a person notices: after the winner undoes, the other person's move shows, and an undo never overwrites anyone. A status still goes blank after a race. Cost: 22.89 bytes kept per move instead of 9.42, 51.77 sent instead of 38.32, a full read about 55% slower and a move about 70% slower at 900 beats (medians of the three runs). About 60 lines on top of Yjs, including a reader order the project has to choose and keep.

**(d) D: a list per record.** What a person notices: the same as (c). Cost: 10.53 bytes kept per move instead of 9.42, the same bytes sent, a read about 8% slower and a move about 12% slower at 900 beats. About 35 lines on top of Yjs, and a list in every beat and heading record.
