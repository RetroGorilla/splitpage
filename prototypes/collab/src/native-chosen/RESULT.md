# E11: the chosen combination

Prototype only. Nothing here ships.

Terms used below:

- **Beat**: one row's worth of script. Its narration lives in a shared `Y.Text` (the segment text), cut into beats by **boundaries** (`{b: id}` markers). Its visual text lives in its own **visual cell** (`Y.Text`), and its fields in a **record** (`Y.Map`).
- **Copy**: one person's replica. **Settled**: every copy has every update.
- **Same moment**: two commands at most three steps apart with no sync between them. Otherwise one of them was made **offline**.
- **Accepted loss**: an outcome the owner said to count, not prevent.
- **Never acceptable**: an outcome that must be zero.

## Verdict

**The combination does not hold as built.** Two never-acceptable kinds remain. Everything else stays inside the owner's lines.

1. **Narration ends up in a removed heading's name.** 19 of 600 generated histories, and E9's named "scene beat" history. Person 1 deletes a scene: its rows are cut and its heading gets the `removed` mark. Person 2, at the same moment, types in one of that scene's beats. The letter lands after the heading's name text, so it belongs to the heading. While the heading is removed, the letter shows in no row. The smallest generated history has 9 steps; the smallest named one has 3 (`undo.test.ts`, last test).
2. **A reader throws "Missing rank".** 5 of 600 histories. Person A deletes a row. Person B, without seeing that, moves the same row. After a sync, A undoes the deletion. Yjs restores the record but will not redo the rank entry that B's newer move overrode. The flat reader then has no rank for that beat and throws. The smallest history has 4 steps (`undo.test.ts`).

Both have owner questions below (Q1, Q2). Nothing else was never-acceptable:

- copies always agreed;
- no beat was shown twice;
- no narration was stored but shown nowhere;
- no beat changed scene when one person worked alone.

These held in the 37 E9 named histories and E9's generated set, all 229 E10 histories × 5 deliveries, and 600 new histories × 5 deliveries.

What the owner asked to see, in short:

- **Accepted losses** are almost all offline. Unseen record changes lost with a deleted beat: 130, of which 13 at the same moment. Unseen visual changes: 106, of which 19 at the same moment.
- **Tags with the decided writer**: 839 requested, 799 kept, 39 undone by their own author, **1 lost**, in 1 of 600 histories. The cause is not the writer: one person's undo restores letters as new copies, and a tag placed at the same moment on the old letters stays on the deleted originals.
- **Undo** is the library's own: one press can pass over spent items to an older one (15 times). Undo of a creation removes everything written into the created beat, seen or not; a redo brings back only what the creator had seen.
- **The offline-notice gap is confirmed**: when the deleter was offline and the typist online, nobody is told.
- **Cost**: reading with the rules costs 4.0 ms against 3.6 ms without, at 900 beats. A keystroke takes 0.12 ms either way. Deletion, split and move are 86–98% row rebuild.

## The reading rules and what a person sees

The rules are an option on the native reader (`NativeRules`; `ALL_RULES` on, `NO_RULES` off). E2, E5, E9 and E10 tests run unchanged with the rules off. Expected rows are hand-written in `rules.test.ts`; a plain model in `test/native-chosen/model.ts`, which imports neither Yjs nor the prototype, reads the same rows.

| Rule | Stored state | What a person sees |
| --- | --- | --- |
| (a) text before a segment's first boundary | `Ω[B]def[C]ghi` with no head beat | `B: Ωdef`. The stray text starts the segment's first beat. |
| (a) with a heading in between | `Ω[#H]mno[E]pqr` | `#H mno`, then `E: Ωpqr`. |
| (a) segment with no beat | `Ω` alone after F's segment | `E: pqrΩ`. The text ends the row above. |
| (a) first segment, nothing above | `Ω` before D's segment | `D: Ωjkl`. |
| (b) empty script with stray letters | `Ωψ`, no beats | One narration-only row, `~stray: Ωψ /` (empty visual). Typing in its visual cell gives it a record first, and the row keeps its place. |
| (c) a repeated boundary | `abc[B][B]defdef` | `B: defdef`. The second boundary is ignored. This is what a double delete followed by a double undo leaves. |
| (d) a stale join | C joined into A, B between them | `C` shows as its own row. A join counts only when its target is the beat directly above. |

Writers find their place through the same rules. `work.test.ts` types, erases, marks, tags, splits, joins, moves and deletes in every rule-made row. Each edit lands where the person saw it, all copies agree, and undo gives back the starting rows.

How often each rule was needed in the 600 generated histories: (a) in 110, (d) in 115, (c) in 1, (b) in none. Rule (b) is exercised only by the named tests.

## Accepted losses

600 generated histories, 20,571 commands. Each has three copies, one of them a late joiner, five delivery modes (forward, reverse, twice, shuffled, whole state), offline stretches of 6 to 15 commands, and every command kind. Counts are occurrences in the forward mode. "Same moment" and "offline" are defined at the top.

| Kind | Count | Same moment | Offline only |
| --- | ---: | ---: | ---: |
| Unseen record change discarded with a deleted beat | 130 | 13 | 117 |
| Unseen visual change discarded with a deleted beat | 106 | 19 | 87 |
| Typing in a new beat lost when its creator undoes the creation unseen | 3 | 0 | 3 |
| Typing in a new heading lost when its creator undoes the creation unseen | 1 | 0 | 1 |
| Typing removed by a creation undo the creator saw | 0 | – | – |
| Record change lost with a creation undo (seen or unseen) | 0 | – | – |
| **Requested production tag missing after everything is delivered** | **1 of 839** | 0 | 1 |
| A split at the same moment as a move left the second half at the old place | 1 (E10: 6 histories) | 0 | 1 |
| Two drops onto each other's rows; neither request met | 0 (E10: 6 histories) | – | – |
| Undo of a move did nothing visible | 7 | | |
| A double delete then a double undo doubles the narration | 3 | | |
| A deletion missed a row that someone's unseen undo had restored | 3 | 0 | 3 |

Further outcomes that lose nothing but that a person may notice:

| Outcome | Count |
| --- | ---: |
| Unseen narration shown at the end of the heading name above | 94 |
| Undo press passed over items that no longer changed anything | 15 |
| A move made an old join count again (rule d) | 11 |
| Library-decided letter: Yjs decides, the ledger cannot know (gone 10, kept 0) | 10 |
| Formatting differs by delivery order, marks only | 10 histories |
| Undo press changed only formatting on letters someone else had erased | 2 |
| A heading's name shown as narration after its creation was undone | 1 |

**Tags, as their own row.** Every requested tag was followed letter by letter to the settled state. A tag counts as lost when a letter it was put on is still shown without it. It is excused when its own author undid it, or when an untag of the same name, made after seeing the tag, covered that letter. Result: 839 requested, 799 kept, 39 undone by their author, **1 lost** (seed 137, every delivery mode). E10's 229 histories: 200 requested, 200 kept. E3b lost 4 of 600 with the re-keying writer; the decided writer loses none through its own writes.

The one loss reduces to 3 steps (`tags.test.ts`):

1. Person A deletes rows B and D, then undoes that, offline.
2. Person B, who saw neither, tags a letter in B.
3. After merging, the undo has brought back new copies of B's letters. The tag is on the deleted originals, so no one sees it.

While the tagger worked, the other copies were deleting, erasing, undoing, typing, moving, splitting and adding headings (copy 0), and formatting and adding headings (copy 2). Bold behaves the same way, so this is how Yjs formatting meets text restored by undo, not a property of the tag writer.

**Creation undo, core default.** Core Yjs's `deleteFilter` deletes everything the undone step created. Undoing a split therefore removes the new beat's visual cell and record with everything in them, whether the creator had seen it or not. Narration typed in the new beat merges back into the beat above and is kept. A redo by the creator brings back only what the creator had seen: the undo deleted it, so the redo restores it. Writes that arrived after the undo stay gone. `undo.test.ts` pins all four cases, seen or unseen with or without redo, for a visual letter and a field. The generated set had 4 unseen cases and no seen ones.

**E10's 22 broken histories**, rerun under the combination:

- 21 now end in an accepted loss: "delete while editing" ×7 (unseen visual and record change), "delete segment head" ×7 and "delete head while typing" ×7 (unseen record change).
- 1, the named "delete head while typing", is now clean.

All 229 histories: 147 preferred → clean; 40 other → clean; 6 preferred and 14 other → accepted loss; never-acceptable 0; broken promises 0.

**Rule (d) against E10.** Rule (d) changed what is shown in 10 histories: "join moving" in 8 (7 that E10 rated preferred, 1 other) and "join next" in 2 (both other). In "join moving", person A moves B below F while person B joins B to A. E10 showed F and B as one row; now B shows as its own row below F. **This is what the rule intends.** B's join names A, and A is no longer directly above. Joining B to F would merge two beats nobody asked to merge. Nothing is lost, and the joiner sees B on its own and can join again. `e10-rerun.test.ts` pins the rows.

## E2 and E5 differences

Rerun through the rules option (`test/native-chosen/rerun-e2-e5.ts`). Data problems stayed at zero throughout: nothing lost, duplicated, disagreeing or crashing.

- **E2 named tests**: 227 → 205 pass. The 22 that changed:
  - split inside a joined row ×5: the join is re-pointed by design;
  - concurrent split and join ×5: rule (d);
  - remove, join and restore ×5: rule (a) alone;
  - restore while the other person joins ×5: by design;
  - the generated contiguous test;
  - the compared readings.
- **E2 generated**: "follow" reading 0 of 1000 changed. "Contiguous" 725 of 1000 changed: re-pointed joins 220, grouping 460, other 45 (removed beats grouped as recovery).
- **E5**: 62 → 34 pass. Delete variant: 745 of 1000 differ, mainly because a removed segment-head heading's name text is now read into the first beat by rule (a); uneditable text fell from 790 to 0. Flag variant: 405 of 1000 differ, through grouping by rule (d) and re-pointing.

**E9 letter locations** against E9's keep-segment result:

| History | E9 keep | E11 |
| --- | --- | --- |
| head narration stranded | stranded | in B |
| sole segment | stranded | in E, the row above |
| only beat | stranded | the narration-only row |
| join below a deleted beat | C in A | C its own row (d) |
| embedded heading delete vs rename | – | hidden heading H |
| head heading delete vs rename | – | hidden heading I |
| cross segment joined | stranded | in E |
| **scene beat** | – | **hidden heading H (the never-acceptable kind)** |

## Undo findings

One standard `Y.UndoManager` per person, `captureTimeout` 0, default delete behaviour. Scope: segments, order, beats, visuals, comments, headings.

E3 checks that still apply all pass (`undo.test.ts`):

- one's own typing is undone and redone around someone else's;
- a new command clears redo; someone else's change leaves one's stacks alone;
- issue 1612: bold undone and redone after an unseen split;
- split undo and redo with typing on both sides (T12);
- join undo and redo (T12 join);
- restore of deleted text around someone's typing (T01), and two restores;
- main's declared limits: double restore gives `abcc`; insert after a deleted run gives `abcX`.

E3's declared result also holds: bold undone after someone typed plain text inside it comes back on the text after that text.

What changes with the library's own undo:

- **Pass-over.** `UndoManager.popStackItem` keeps popping until an item changes something. A status that lost to someone else's has nothing to undo, so the press undoes the typing before it instead. E3's guarded step used up that press with nothing happening. Generated: 15 times.
- **Move after someone else's move.** Undoing a move after another person moved the same row again changes nothing visible. The press passes over to the item before it. Generated: 7 times.
- **Invisible change.** Undoing italics on a letter someone else has since erased changes only hidden formatting. The press is spent with nothing visible. Generated: 2 times.
- **Deletion.** Undo and redo of one's own deletion bring back and remove the row, narration, visual cell and record together.
  - Deleted with unseen typing: rule (a) shows the typed narration in the row above. The undo puts it back in its own beat. Unseen visual text is gone and stays gone.
  - Deleting a segment's first beat: rule (a) gives its unseen narration to the next beat, and the undo returns it.
  - Double delete then double undo: `B: defdef` with one visual cell (rule c).
  - A deletion made without seeing someone's undo of an earlier deletion of the same row misses the restored row, which stays. Generated: 3 times.
- **Rule (d) between a move and its undo.** A joins C into B while B moves C to the top. C shows on its own at the top, because the join no longer counts. B undoes the move, C returns below B, and the join counts again. The redo separates them again.
- **Crash.** See the verdict, item 2.

## Offline notice

The plan says the returning copy compares three plain readings by beat id: the last state both had, the offline copy before merging, and the merged result. The check here reads narration, visual text, fields and scene. It is written from the plan's words and never reads the replica (`notice.test.ts`). The online column shows what the same check would say on the copy that stayed online; the plan does not run it there.

| Case | Lost | Offline person told | Same check on the online copy |
| --- | --- | --- | --- |
| Deleter offline, typist online, visual text | V | nothing | "B you changed is gone, with your visual text" |
| Typist offline, deleter online, visual text | V | "B you changed is gone, with your visual text" | nothing |
| Deleter offline, field setter online | status | nothing | "B you changed is gone, with your fields" |
| Field setter offline, deleter online | status | "B you changed is gone, with your fields" | nothing |
| Deleter offline, typist online, narration | nothing (rule a shows X in A) | nothing | "B gone; your narration now shows in row A" |
| Typist offline, deleter online, narration | nothing (rule a) | "B gone; your narration now shows in row A" | nothing |
| Creator offline undoes a split, typist online draws in the new beat | V | nothing | "N you changed is gone, with your visual text" |
| Typist offline draws in the new beat, creator online undoes | V | "N you changed is gone, with your visual text" | nothing |
| Splitter offline, mover online | nothing; second half stays at the old place | nothing | nothing |
| Two drops onto each other's rows | nothing; rows end C B A, neither order asked for | nothing | nothing |
| Both delete a row, both undo apart | nothing; `defdef` | nothing | nothing |
| Typist offline, scene deleted online | Ω, only in the removed heading's name | "E gone; your narration shows in no row" | nothing |
| Scene deleter offline, typist online | Ω, only in the removed heading's name | nothing | "E gone; your narration shows in no row" |

**The known gap is confirmed and is wider than stated.** It is not only deletion. Whenever the person whose action removed something was offline and the person who lost writes was online, the returning copy's check is silent and the online person runs no check, so nobody is told. That covers deletion against visual text, deletion against fields, a creation undo against typing in the new beat, and a scene deletion against narration. Moves and drops are never noticed, because position is not one of the compared readings.

## Cost

`node src/native-chosen/cost.ts`, one run on a shared PC. Milliseconds, median.

Reading builds every row from nothing. The fixture has 30 beats per segment, a heading at every third segment head, 120 letters of narration and 48 of visual text per beat.

| Beats | Stored bytes | Read, rules on | Read, rules off | Keystroke, rules on | Keystroke, rules off |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 30 | 8,059 | 0.18 | 0.13 | 0.14 | 0.13 |
| 300 | 82,118 | 1.30 | 1.21 | 0.12 | 0.12 |
| 900 | 247,882 | 4.01 | 3.57 | 0.12 | 0.11 |

One command at 900 beats, rules on:

| Command | Yjs write | Row rebuild | Total | Rebuild share |
| --- | ---: | ---: | ---: | ---: |
| Deletion | 0.08 | 4.26 | 4.41 | 98% |
| Split | 0.06 | 4.07 | 4.16 | 98% |
| Move | 0.03 | 3.72 | 4.31 | 86% |

The move's remaining 0.56 ms is finding the drop place before writing. The earlier rebuild share was 75–85%. The writes are now smaller, so the rebuild share is higher; the rebuild itself is about the same as a full read.

## Controls

**Silent-write controls.** Each control mutes one Yjs call, or a whole command, and replays the command. A control is **effective** when the stored state or the rows then differ from the real run. It **fails**, which is what we want, when a check catches the difference: a promise check, a reachability check, or a reader throwing. A throw is counted as caught and listed apart. Coverage loss, meaning the replay made different calls, was 0 everywhere.

| Suite | Used | Effective | Caught by a check | Caught by a throw | Not caught |
| --- | ---: | ---: | ---: | ---: | ---: |
| New generated (25 seeds, 42 groups) | 2,233 | 2,173 | 1,930 | 240 | 3 |
| E9 rerun (60 seeds × 5 modes, 51 groups) | 26,340 | 26,340 | 25,800 | 540 | 0 |

- **Throws** come only from muting writes the reader requires. In the generated set: a segment's `head` key (delete, 31), the `YText.delete` that cuts a row's text (34), a heading's record (39), its rank (39) and its `text` (19), and a split's record (39) and rank (39). In E9: rank writes (420) and heading records (120).
- **The 3 not caught** are `move / YMap.set:e10Rank`. Muting that one rank write changes storage but leaves every row where it was. The test allows this for that key only.
- An effective control exists for every command kind: type, erase, format, field, split, join, unjoin, delete, heading, removeHeading, restoreHeading, move and undo. Redo had one.

**One control per reading rule.** With one rule off, the histories that need it must fail.

| Rule off | Histories that need it | Failed | By reachability | By a throw |
| --- | ---: | ---: | ---: | ---: |
| (a) prefix | 22 | 22 | 21 | 2 |
| (d) adjacent | 25 | 8 | 0 | 8 |
| (b) empty, (c) repeat | not needed in these 150 seeds | | | |

Rule (d) is a grouping rule: without it a stale join still shows everything, only grouped differently. It is caught where the grouping makes a promise fail. Every rule is also switched off against its hand-written state in `rules.test.ts`, and each one then breaks.

**Further controls.**

- `tags.test.ts` checks the tag counter on hand-made inputs. It must flag a missing tag. It must not flag a deleted letter, an untag made after seeing the tag, or an undone tag. It must flag the tag again after a redo.
- The two move counters fire once on their named histories, and not when the move was made after seeing the split.

## Values read from the implementation

Each value below comes from the code under test, not from the model. The claim it would otherwise make false is named.

| Value | Where | Claim it prevents |
| --- | --- | --- |
| The rows the acting copy shows, used to choose commands | `generate.ts`, `shown()` | That a history holds a command no person could make from the screen |
| Undo and redo stack lengths before and after a press | `play.ts` | That the ledger knows which command an undo reverted, and whether it passed over items |
| Letters erased or deleted, read from the acting copy's rows at that moment | `play.ts` | That a deletion removed only what the person saw |
| `replica.block(...).start === 0` for a new heading | `play.ts` | Whether undoing a heading's creation deletes its name or turns it into narration |
| `ruleUse()` counts | generated rule-off test | Which histories need a rule; used only to pick rule-off controls |
| Attribute keys before a tag | `play.ts` | That a tag got a key of its own |
| Letter identities at tagging time, Yjs `redone` links and the settled attributes | `play.ts`, tag counter | Which letters a tag was put on and whether they still carry it |
| `Y.snapshot` before and after an undo | `play.ts` | That an undo changed only hidden formatting rather than nothing |
| Stored readings (`readStyles`) before and after | `play.ts`, controls | Whether a command or a muted control changed storage |
| E10's own run of its histories | `e10-rerun.test.ts` | E10's earlier verdicts (preferred, other, broken) |

## Owner questions

**Q1. Narration typed into a beat while someone deletes its scene lands in the heading's name.** In 94 cases the heading stayed visible and the letters showed at the end of its name. In 19 histories the heading was removed, and the letters showed in no row.

- (a) Accept the visible case, and accept the removed case on condition that the app lists removed headings with their names. Noticed as: odd letters at the end of a scene title, or letters missing until someone opens the removed-heading list.
- (b) A scene deletion also deletes the heading for real, its name and its boundary, instead of marking it removed. That departs from decision 5. Rule (a) then shows the letters in the next beat or the row above. Noticed as: a deleted scene's title cannot be brought back except by undo, but unseen typing shows up in a nearby row.
- (c) A reading rule: text after a removed heading's own name, up to the next boundary, reads as narration of the row above. Noticed as: unseen typing appears at the end of the row above; nothing else changes.

**Q2. The "Missing rank" crash after undoing a deletion that someone else's move touched.**

- (a) The reader orders a beat without a rank by its stored position. Noticed as: the restored row comes back where it originally was, not where the other person moved it.
- (b) After an undo restores a beat without a rank, the copy writes a fresh rank at the place the undoer last saw. This adds a write on top of the library's undo. Noticed as: the row comes back where the undoer expects it.

**Q3. Rule (d) and old joins.** Rule (d) shows B on its own in E10's "join moving", which is intended. The same rule also lets an old join count again when a later move puts the two beats next to each other: 11 times.

- (a) Keep both. Noticed as: rarely, a moved row merges with the row it was once joined to.
- (b) A join is cleared once it stops counting. That is an extra write, and only one copy may write it. Noticed as: a separated row stays separate.

**Q4. One lost tag in 839, through an unseen undo of a deletion.**

- (a) Accept it as library behaviour, which applies to bold too. Noticed as: very rarely, a tag put on text that another person deleted and restored offline is missing.
- (b) The offline notice also compares marks per beat and lists missing tags. Noticed as: the person returning is told and can reapply the tag; the online person is still not told.

**Q5. Undo passes over spent items.**

- (a) Keep the library's behaviour. Noticed as: a press occasionally undoes something older than the person expected (15 in 600 histories).
- (b) One press spends one item, and a spent item shows "nothing to undo". That departs from the library and needs the rule-12 steps. Noticed as: a press that seems to do nothing.

**Q6. Creation undo removes writes the creator had seen.**

- (a) Keep core Yjs's default. Noticed as: undoing a split removes what others drew in the new beat; a redo brings back what the creator had seen.
- (b) Use the editor bindings' filter, which keeps a created text that still holds content. Noticed as: the beat's visual text survives the undo with no row to show it in. That needs a place to list it.

**Q7. The offline-notice gap.**

- (a) Accept it. Noticed as: a person who stayed online can lose visual text or fields with no message.
- (b) Run the same check on every copy when a large remote change arrives. Noticed as: both people are told.

**Q8. Formatting that depends on delivery order** (10 of 600 histories, marks only; Yjs writes its formatting clean-up as a new local change).

- (a) Accept it: copies still agree once everything is delivered. Noticed as: a mark's exact edge differs from one session to another.
- (b) Turn off the clean-up. That departs from the library. Noticed as: nothing visible, but stored marks grow.

## What I am least sure of

- **The ledger.** It is my model of which letters should survive, written from the commands each person saw. It agrees with what is shown in all 600 histories, but I fixed three of its rules during this work: unseen restores, heading creation undo, and an undo restoring new copies. Ten letters remain "library-decided": the ledger cannot know their fate, and Yjs removed them.
- **The two move counters.** They count only when no other command touched the same rows, so the generated numbers (1 and 0) are lower bounds. E10's targeted histories give 6 each.
- **Same moment or offline.** This depends on the three-step window. A wider window would move some cases from offline to same moment.
- **Cost.** One run on a shared PC. The differences between rules on and off are small enough that noise matters at 30 beats.
- **The tag counter.** It covers narration tags only, as the generator makes no visual tags. It follows restored letters through Yjs `redone` links, assuming an offset within a split item carries over.
- **The notice check.** It is my reading of the plan's three readings. It ignores position, so moves are never noticed.
