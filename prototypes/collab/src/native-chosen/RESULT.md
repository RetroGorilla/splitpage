# E11: the chosen combination

Prototype only. Nothing here ships.

Terms used below:

- **Beat**: one row's worth of script. Its narration lives in a shared `Y.Text`, the segment text, which **boundaries** (`{b: id}` markers) cut into beats. Its visual text lives in its own **visual cell** (`Y.Text`). Its fields live in a **record** (`Y.Map`).
- **Name cell**: part B's option. A heading's name lives in its own `Y.Text` in a `names` map, the way a visual cell does. The heading keeps its boundary (`{h: id}`) in the segment text, plus its record, its rank and its `removed` mark. The option is `new ChosenReplica(client, rules, "cells")`; the default, `"inline"`, keeps the name in the segment text.
- **Copy**: one person's replica. **Settled**: every copy has every update.
- **Same moment**: two commands at most three steps apart with no sync between them. A command that is not at the same moment was made **offline**.
- **Accepted loss**: an outcome the owner said to count, not prevent.
- **Never acceptable**: an outcome that must be zero.

## Verdict

**With both parts, the combination holds, except for one thing that rule (e) leaves open.** A beat read by rule (e) has no place of its own: each read works out its place from its stored neighbours. A later command that did not touch that beat can therefore move it, even across a scene line. The smallest history has 6 steps and fails in all five deliveries (`second.test.ts`):

1. Stored order is `A, B, #H`. Alice moves A into H, then deletes B.
2. Bob has not seen that, and moves B into H.
3. Bob's move reaches Alice, and she undoes her deletion. B has no rank, and Alice sees `#H, A, B`.
4. Alice alone deletes A and sees `B, #H`. B has left scene H, and the check reports "B changed scene with one person working".

None of the generated histories did this. A rankless beat appeared in 5 of the 600 histories, and in 5 of the 600 made with name cells. None changed place or scene on a later command, in those sets or in either set of 200 double-split histories. The counter that looks for this fires on the history above. This is owner question Q4; no remedy is built.

**Correction, 2026-11-19.** Rule (e) can also be needed without any deletion. Start at `A, B, #H`. Copy 0 moves A into H and sends that move to copy 1. At the same moment, copy 0 moves B below A and copy 1 moves B directly under H. After both moves arrive, the higher-numbered copy 1 wins. Copy 1 undoes its move. B loses its rank and both copies show `#H, A, B`. Copy 0 receives the undo and deletes only A. Both copies show `B, #H` in all five deliveries, whether cuts remove or keep the beat containers. [E14 rank-loss result](../native-kept/RESULT.md#where-b-returns)

Apart from that, no never-acceptable result appeared in any of these sets:

- E9: the 37 named histories and 2,220 generated runs;
- E10: all 229 histories × 5 deliveries;
- 600 new generated histories × 5 deliveries;
- 200 histories with same-moment double splits × 5 deliveries;
- the same 600 step lists replayed with names in cells, apart from 3 commands that copy refuses (see "What part B removes").

In every set:

- copies agreed;
- nothing was stored but shown nowhere;
- no beat was shown twice;
- **narration shown twice by a command of ours: zero.** No split, or any other writer, copies narration;
- **narration doubled by two people undoing the same deletion: the owner's accepted outcome, counted here** (3 in 600). Yjs restores two separate stored items, which is the bare `Y.Text` behaviour E9 recorded. With one beat `x`, two people each delete it and undo their own deletion, and every copy shows `xx` (`second.test.ts`). This is not the duplication the first review round removed, which came from a split copying text;
- every command did what it promised on the copy that ran it. The exception is a split of a rankless beat, whose new beat also has no rank (item 2 of the second review, below).

**Part A alone does not hold.** With names kept in the segment text, one never-acceptable kind remains: narration shows only inside a removed heading's name. It hits 27 letters in 19 of the 600 histories, 7 of the 200 double-split histories, 60 E9 generated runs and E9's named "scene beat". The smallest generated case has 9 steps:

1. copy 0 removes heading H;
2. a sync;
3. copy 2 opens late;
4. copy 0 deletes row D and joins E;
5. copy 2 types `К` in E, restores H and undoes the restore;
6. copy 0 deletes C.

Part B closes it, so **the owner's choice is part B, or part A with this kind accepted** (Q1).

### What the first version found, and how each was closed

| Found | Where | Closed by |
| --- | --- | --- |
| Narration ends up inside a removed heading's name (first version, item 1) | 19 of 600; E9 "scene beat" | Part B: the name has its own cell, so the segment text holds only narration. Rule (f) shows text after a heading's boundary in a beat. 0 in every set. |
| A reader throws "Missing rank" after an undo restores a beat that someone else moved unseen (first version, item 2) | 5 of 600 | Rule (e): a beat whose record has no rank is read at its stored place, and nothing is written. 0 throws. |
| Two splits at the same moment of a row a rule produced duplicate its narration (found in review) | 3 of 600; 4 commands | The split never copies narration. It writes a boundary, a record and a visual cell, and nothing else (`review.test.ts`). |

## Second review: what is now pinned

No reader or writer changed in this round. Each item below is a named test in `second.test.ts` that pins today's behaviour in all five deliveries, unless it says otherwise.

| Item | History | Today's behaviour |
| --- | --- | --- |
| 1. A rankless beat changes place | See the verdict | `B, #H`: B leaves scene H on Alice's own deletion of A. Generated sets: 0 of 1,600 histories. |
| 2. A rankless beat makes another | Delete F against an unseen move of F; deliver the move; undo the delete; split F | Rows `F: v`, `N: wx`, in the right place. N stores the rank key with no value, because a split copies the old beat's rank and F has none. The split's own check reports "split-off N has no rank". |
| 2. A rankless heading | Create J; Bob, having seen it, moves scene J above I; Alice undoes the creation, receives the move, and redoes | J comes back with no rank and reads at its stored place, `#J` above `#H`. Its name cell is kept and editable (`#J QX`). Run with name cells. |
| 3. The accepted doubling | One beat `x`; two people each delete it and undo their own deletion | `A: xx` on every copy, with and without a sync before the undos. Counted as "a double delete then a double undo doubles the narration". |
| 4. Nearest-point split | Recovered text before or after a beat's own text, then a split at the caret | The break moves by the whole recovered text: 1 or 100 letters (see Q2). |
| 5. Ledger after a redo | Split, undo, redo, undo on one copy | Judged at every step: alive, dead, alive, dead. A control with an unseen command from another copy leaves the redone beat uncertain. |
| 6. Rule (f) across a scene line | `#H, A, #I, B`; delete A against unseen typing in it; move scene I above H | `#H, #I, B: Xb`, then `#I, B: Xb, #H`. The letter follows B though it is stored after H's boundary. Copies agree, and the letter stays editable (`B: XYb`). Run with name cells. See Q3. |

## Part A: the corrections

**1. Splits no longer copy.** The writers copied narration in one place only: a split whose caret fell inside text that a reading rule shows. The split deleted that text and wrote it again on both sides of the new boundary. That place is removed: `copyFreeSplit`, which is on in `ChosenReplica`. Every split's promise check now compares narration letter identities before and after. In every set, no split deleted and rewrote a letter.

Where the caret cannot be expressed without copying, the boundary goes to the nearest point that needs no copy:

| Caret | Where the boundary goes | What the person gets |
| --- | --- | --- |
| Inside text a rule shows before the beat's own text (rule (a) or (f)) | At the start of the beat's own text | The split falls at the start of the beat's own words, not at the caret. The rule-read text stays in the upper row. |
| Inside text a rule shows after the beat's own text | At the caret, in place | Usually exactly what was asked. The new row is directly below, and the reader decides which beat the text belongs to. |

Both cases are counted as an accepted kind:

| Set | Before own text | After own text |
| --- | ---: | ---: |
| 600 generated | 2 | 1 |
| 200 double-split histories | 24 | 5 |
| 600 generated with names in cells | 2 | 6 |
| 200 double-split histories with names in cells | 42 | 15 |

This is owner question Q2.

The reviewer's race is a named test: delete A while another person types `Ψ` in it, sync, then both split B at 0 before seeing each other. `Ψ` now shows once, in rows `B: Ψ`, `M: def`, `N:` (empty), in every delivery. A control turns the copying split back on. It then shows `Ψ` twice, and the letter-identity check fails. The generator now adds same-moment double splits of rule-produced rows: 27 pairs in 200 histories (56 with names in cells).

**2. Rule (e), missing ranks.** Yjs does not redo a map entry that a newer write replaced. So when an undo restores a deleted beat that someone else moved unseen, the record comes back without its rank. Rule (e) reads that beat between the ranked neighbours of its stored place. It writes nothing; a test checks that the state vector is unchanged. A move or a new heading next to that beat writes the shown rank as part of its own write.

Hand-written rows (`review.test.ts`, every delivery):

| History | Rows |
| --- | --- |
| Delete F; someone else moves F above A unseen; sync; undo | F back at its stored place, last |
| The same with C, in the middle of a scene | C back between B and D |
| F moved below D and synced, then deleted; someone else moves F above A unseen; undo | F back at its stored place, last. Not below D, where it was moved, and not above A, at the unseen drop |

With rule (e) off, each of these throws "Missing rank". In the 600 generated histories, rule (e) was needed in 5. All 5 throw without it.

**The same Yjs behaviour applies to other fields:**

- **`status`**: a status set unseen is not redone, so the reader shows no status. The other fields are kept.
- **`joined`**: a join set unseen is not redone, so the beat reads as a row of its own.

The reader writes nothing in either case. Both are pinned in `review.test.ts`. Neither is never-acceptable: the field is absent, not wrong, and the row is shown.

**3. Tags are counted from what the rows show.** A requested tag counts as kept only if every shown letter it was put on still carries it. The exceptions are a tag that its own author undid, and a letter that an untag of the same name covered, made after seeing the tag. The reviewer's split-then-tag history is a named test and is kept.

In the 600 histories: 845 requested, 800 kept, 40 undone by their own author, **5 lost in 5 histories**. Every loss is plain Yjs behaviour, and bold behaves the same way:

| Cause | Losses |
| --- | ---: |
| Letters deleted and brought back by an undo the tagger had not seen. The undo restores new letters; the tag stays on the deleted originals. | 4 |
| A letter shown twice after a double delete and a double undo (rule (c)); the tag is on one of the two | 1 |

E10's 229 histories: 200 requested, 200 kept.

**4. The privacy scan.** The regex literal in `generated.test.ts` is now `/b:[^\s]+/g`. The scanner is unchanged.

**5. Controls.** The storage snapshot that controls compare now includes a segment's `head`.

In the first version, 240 controls were caught only by a throw. 221 of them threw in the command path, while the muted command ran. 19 threw in the snapshot, while the check read storage.

Now, in 25 seeds (42 groups):

- 2,233 controls used, 2,173 effective;
- 2,112 caught by a check;
- **58 caught by a throw**: 39 in the command path, from muting a new heading's record, so the command cannot write its rank; 19 in the check, from muting a new heading segment's `text`;
- 3 not caught, all `move / YMap.set:e10Rank`. Muting that one rank write changes storage but leaves every row where it was. The test allows this for that key only.

E9 rerun: 26,631 controls used, all effective; 26,509 caught by a check and 122 by a throw, all from muting a created heading's record.

**6. The ledger.** The ledger now follows beats by version. A deletion ends the versions its author saw. An undo brings those back as a new version, and a redo ends that version again. A deletion "missed" a row only when a version its author had not seen is left alive. This replaces the shortcut that looked for "any earlier unseen restore". That shortcut ignored a later redo and the letter's real identity.

After the second review, a redo of a creation also brings back the beat versions its undo ended, and an undo of that redo ends them again. The beat is left uncertain only when another copy made a command the redoer had not seen. Before, every creation redo made the beat uncertain, so the ledger stopped judging an ordinary single-copy split, undo, redo, undo.

What remains true of the ledger:

- `ledger.ts` has no imports. It reads only the recorded commands.
- The replay still takes each undo's target from the real Yjs stack depths.
- It models Yjs-style revivals: an undo brings things back as new versions.

So it is good for accounting, and it is a limited independent check on undo.

What the ledger and harness still take from the implementation (the reviewer's list):

| Input | Where |
| --- | --- |
| The initial letters with their roles and beat membership, from the hydrated outline | `play.ts` |
| The acting copy's rows, text and order, used to pick commands and their letters | `generate.ts`, `play.ts` |
| Selected letters and deleted members, read from the acting copy's rows | `play.ts` |
| Undo and redo stack depths before and after a press, and the inferred target | `play.ts` |
| `block().start` for heading placement (inline names only; with name cells, every heading is standalone) | `play.ts` |
| Attribute keys before a format (pre-edit marks) | `play.ts` |
| Tag letter item ids and Yjs `redone` links | `play.ts`, tag counter |
| Settled attributes | tag counter |
| `Y.snapshot` before and after an undo, and stored readings before and after a command | `play.ts`, controls |
| `ruleUse()` counts, used only to pick rule-off controls and to count rule (e) | `play.ts`, `generated.test.ts` |
| Settled order and field presence | `play.ts` |
| E10's own run of its histories, for its earlier verdicts | `e10-rerun.test.ts` |

| Uncertain letters | Count | Settled |
| --- | ---: | --- |
| Letters whose fate the ledger cannot know, because Yjs decides them (`uncertain`) | 10 | all absent |

**7. Counts and wording.**

| Kind | Count | Same moment, 3-step window | Same moment, 6-step window | Offline only, 3-step window |
| --- | ---: | ---: | ---: | ---: |
| Unseen record change discarded with a deleted beat | 131 | 14 | 20 | 117 |
| Unseen visual change discarded with a deleted beat | 106 | 19 | 26 | 87 |

The review measured 19 and 26 at six steps on the first version's 130 record losses. The record count is now 131, because the ledger follows beats by version.

The full accepted-loss table is under Part B, in the "Accepted losses" section.

E2 and E5 differences, by rule (the review's measurement):

- **E2's 22 changed named tests and its 725 changed contiguous readings**: all come from rule (d) alone, and none from rule (a).
- **E5's differences**: 5 come only from rule (a), 13 only from rule (d), and 10 from either.

## Part B: heading names in their own cells

### Rule (f)

Text between a heading's boundary and the next boundary is narration without a beat. Like rule (a), the reader gives it to a beat, and it is edited there. The reader tries these places in order:

1. the beat directly after the heading, if the next entry is a beat;
2. else the nearest beat above;
3. else the next beat further down, **which can be under a different scene**;
4. else the narration-only row.

Step 3 can cross a scene line. With `#H, A, #I, B`, delete A against unseen typing in it, and the letter starts B under I. Move scene I above H, and the letter goes with B, although it is stored after H's boundary. This is owner question Q3.

| The scene… | Where the text shows | Hand-written rows (unseen `Ω` typed in E while E is deleted) |
| --- | --- | --- |
| still has a beat below the heading | At the start of that beat | `#H mno`, `G: Ωyz` |
| has no beat left | At the end of the nearest beat above | `D: jklΩ`, `#H mno` |
| has its heading removed | The same as the two rows above | `D: jklΩ` (scene with no beat); `G: Ωyz` (scene with a beat) |
| has no beat in the scene and none above | At the start of the next beat further down | `#P pp`, `#Q qq`, `B: Ωdef` |
| has no beat anywhere | In the narration-only row (rule (b)) | Not reached by any test; read from the code |

Within the beat that shows it, the text is read in stored order.

The text is editable in the row that shows it. Typing, erasing, bold, splitting before it and deleting the row each land where the person saw them, in `cells.test.ts`. Deleting that row keeps the heading's boundary.

With rule (f) off:

- each hand-written case shows the text nowhere;
- 77 of 77 generated histories that need the rule fail.

### What part B removes

| Measure | Names inline | Names in cells |
| --- | ---: | ---: |
| Narration shown only in a removed heading (never acceptable), 600 histories | 27 letters in 19 histories | 0 |
| The same, 200 double-split histories | 7 histories | 0 |
| The same, E9 generated runs | 60 | 0 |
| The same, E9 named "scene beat" | hidden in H | `D: jklΩ` |
| Unseen narration shown at the end of a live heading's name | 94 letters in 56 histories | 0 |
| A heading's name shown as narration after its creation was undone | 1 | 0 |

The step lists made with names inline, replayed with name cells, give no never-acceptable result. The exception is 3 commands that the cells copy refuses: each asks to type a heading name at an offset that only existed because narration had been shown inside that name.

### E5's heading findings still hold

These histories run with names inline and with name cells in three deliveries, and give the same rows (`cells.test.ts`):

- two people renaming at once;
- rename against remove;
- remove and restore against a rename;
- two people creating a heading at the same place;
- the undo of a rename, of a remove, of a restore, of a creation, and of one of two creations at the same place.

### What undoing a heading's creation loses

A name cell is deleted only by undoing the heading's creation, which is core Yjs's `deleteFilter` default.

| Case | Names inline | Names in cells |
| --- | --- | --- |
| Someone renamed the new heading unseen, then the creator undoes | The letter survives as narration of the row above (`B: defY`) | **The letter is lost**, counted as "typing in a new heading lost when its creator undoes the creation unseen" |
| The creator had seen the rename | Removed by the undo | Removed by the undo |
| …and then redoes | Comes back | Comes back (`#J XY`) |

In the 600 histories this happened once, unseen, in both shapes. This is owner question Q5.

### Reruns with names in cells

- **E9**: the 37 named histories and 2,220 generated runs. Never-acceptable 0, broken promises 0. The accepted losses are 61 unseen record and 61 unseen visual changes discarded with a deleted beat.
- **E10**: 229 histories × 5 deliveries, with the same transitions as names inline. These are 147 preferred → clean, 40 other → clean, 6 preferred and 14 other → accepted loss, and 21 of E10's 22 broken histories → accepted loss with 1 → clean. "join moving" shows the same rows.
- **600 generated**, made with name cells: 20,625 commands. Never-acceptable 0, broken promises 0, refused 0. Rule (f) was needed in 77 histories.
- **200 double-split histories**, made with name cells: never-acceptable 0.

### Accepted losses

600 generated histories, forward delivery, occurrences:

| Kind | Names inline | Names in cells |
| --- | ---: | ---: |
| Unseen record change discarded with a deleted beat | 131 | 131 |
| Unseen visual change discarded with a deleted beat | 106 | 106 |
| Typing in a new beat lost when its creator undoes the creation unseen | 3 | 3 |
| Typing in a new heading lost when its creator undoes the creation unseen | 1 | 1 |
| A split next to a move left the second half at the old place (offline, outside the same-moment window) | 1 | 1 |
| A deletion missed a row that someone's unseen undo had restored | 3 | 3 |
| A double delete then a double undo doubles the narration (rule (c)) | 3 | 3 |
| Production tag lost (plain Yjs; see item 3) | 5 of 845 | 5 of 845 |

Outcomes that lose nothing:

| Outcome | Names inline | Names in cells |
| --- | ---: | ---: |
| A split inside rule-read text placed at the nearest point (Q2) | 3 | 8 |
| Undo press passed over items that no longer changed anything | 16 | 16 |
| A move made an old join count again (rule d) | 11 | 11 |
| Undo of a move did nothing visible | 8 | 8 |
| Library-decided letters (`uncertain`), all absent | 10 | 10 |
| Formatting differs by delivery order, marks only | 10 histories | 8 histories |
| Undo press changed only formatting on letters someone else had erased | 2 | 2 |
| A restored row without a rank read at its stored place (rule e) | 5 histories | 5 histories |

## Undo

There is one standard `Y.UndoManager` per person, with `captureTimeout` 0 and the default delete behaviour. Its scope is segments, order, beats, visuals, comments, headings and names.

The E3 checks that still apply all pass (`undo.test.ts`):

- own typing around someone else's;
- redo cleared by a new command;
- issue 1612;
- split and join undo (T12);
- restore of deleted text (T01);
- main's declared limits.

What the library's undo does differently:

- **Pass-over**: one press can pass over spent items to an older one.
- **Moves**: an undo of a move after someone else's move does nothing visible.
- **Invisible formatting**: an undo can change only formatting that no one can see.
- **Creations**: undoing a creation removes everything written into what was created, whether the creator had seen it or not; a redo brings back what the creator had seen.

The first version's crash ("Missing rank") is now read by rule (e). Without the rule, `undo.test.ts` shows it still throws.

## Offline notice

The check is unchanged from the first version (`notice.test.ts`). Whenever the person whose action removed something was offline and the person who lost writes was online, nobody is told. Moves are never noticed.

The notice test runs with names inline. With name cells, the narration in its two scene-deletion cases shows in a row through rule (f): E9's "scene beat" gives `D: jklΩ`.

## Cost

`node src/native-chosen/cost.ts`, three runs on a shared PC. Times are the median of each run in milliseconds, given as the range across the three runs.

The fixture has:

- 30 beats per segment;
- a heading at every third segment head;
- 120 letters of narration and 48 of visual text per beat.

Each read builds every row from nothing.

| Beats | Names | Stored bytes | Read, rules on | Read, rules off | Keystroke, rules on | Keystroke, rules off |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 30 | inline | 8,059 | 0.16–0.17 | 0.13–0.14 | 0.14 | 0.12 |
| 30 | cells | 8,072 | 0.13 | 0.11 | 0.13 | 0.12 |
| 300 | inline | 82,118 | 1.25–1.28 | 1.15–1.19 | 0.12 | 0.11 |
| 300 | cells | 82,175 | 1.27–1.29 | 1.17–1.19 | 0.12 | 0.11 |
| 900 | inline | 247,882 | 3.65–3.97 | 3.67–3.74 | 0.12 | 0.11 |
| 900 | cells | 248,029 | 3.69–3.96 | 3.48–3.64 | 0.12 | 0.12 |

One command at 900 beats, rules on (total, of which row rebuild):

| Command | Names inline | Names in cells |
| --- | --- | --- |
| Deletion | 3.88–3.98 (97–98% rebuild) | 4.02–4.59 (97–98%) |
| Split | 3.76–3.85 (99%) | 3.87–3.96 (98–99%) |
| Move | 4.23–4.37 (85%) | 4.35–4.39 (84–85%) |

Name cells add 13–15 bytes per heading here and no time that stands out from the noise. The Yjs write itself is 0.02–0.07 ms in every case.

The second review ran the script three times as well. For a 900-beat deletion it measured 3.844–3.885 ms with names inline and 4.047–4.490 ms with name cells. Both reviews see deletion with name cells about 0.2 ms slower at the low end, and both see one slow run near 4.5 ms.

## Owner questions

**Q1. Which shape for heading names?**

- (a) Name cells (part B). Noticed as: narration typed unseen in a deleted scene shows in the beat below or above, never in a title. A rename typed unseen into a heading whose creation is then undone is lost (1 in 600).
- (b) Names in the segment text (part A only). Noticed as: unseen narration sometimes shows at the end of a scene title (94 letters in 56 of 600 histories). While that heading is removed, the narration shows in no row (27 letters in 19 histories).

**Q2. A split whose caret falls inside text a reading rule shows.** A split never copies narration, so it cannot always split there.

What a person sees today, where `|` is the caret and `X` stands for recovered text, which is narration someone typed into a beat that was then deleted:

| Row before | Person asks for | Person gets | Break moved by |
| --- | --- | --- | --- |
| `B: X b`, with X recovered and shown before B's own `b` | `B:` (empty) / `N: X b`, caret before X | `B: X` / `N: b` | the whole of X (1 letter, or 100 with 100 letters) |
| `B: b X`, with X recovered and shown after B's own `b` | `B: b X` / `N:` (empty), caret at the end of the row | `B: b` / `N: X` | the whole of X |

Every copy agrees on these rows. A split went to the nearest point 3 times in 600 histories (8 with name cells).

- (a) Split at the nearest point that needs no copy (built). Noticed as: the break can land the whole recovered text away from the caret. The two pictures above.
- (b) Refuse the split there and say why. Noticed as: a message, and the person splits elsewhere.
- (c) Move the beat's own boundary to the caret first. That is an embed delete and insert, not a narration copy, and needs the rule-12 steps. Noticed as: the split falls at the caret; two people doing it at once can each move the boundary.

**Q3. Where rule (f) shows narration that has no beat in its scene.** The reader tries, in order: the beat directly after the heading; the nearest beat above; the next beat further down; the narration-only row. The third step can cross a scene line. With `#H, A, #I, B`, unseen typing in a deleted A shows at the start of B under I. When scene I is moved above H, the letter goes with B.

- (a) As built. Noticed as: rarely, a few letters someone typed in a deleted scene appear at the start of a row in the next scene, and they move with that row. Copies agree, and the letters stay editable.
- (b) Stay in the scene as a narration-only row under the heading, which typing gives a record, like rule (b). Noticed as: an extra row with no visual under the heading, which someone has to merge or delete.
- (c) The row above, even across a scene line upwards. Noticed as: the letters appear at the end of the last row of the previous scene. When there is no row above, it needs (a) or (b) as well.

**Q4. Fields Yjs does not redo after an unseen overwrite: rank, status and join.** Yjs does not redo a map entry that a newer write replaced. So when an undo restores a deleted beat that someone else changed unseen, the record comes back without that field. What follows from this today, each pinned in a named test:

- **Rank.** The beat is read at its stored place (rule (e)). That place is worked out on every read, so a later command can move the beat, even into another scene (the verdict's history). A split of that beat makes a new beat that also has no rank. A heading created again by a redo after an unseen scene move also has no rank; it reads at its stored place, and its name cell stays editable.
- **Status.** It reads as no status.
- **Join.** It reads as a row of its own.

The options:

- (a) Read at the stored place, and read missing fields as unset (built). Noticed as: the restored row comes back where it was stored. Rarely, after a later unrelated command, it jumps somewhere else, even across a scene line. A status or join set unseen is gone.
- (b) The person who undid writes a position back. Not built. What it would write: the undoing copy, in the same step as its undo press, writes a rank for each beat or heading the undo brought back without one. That rank is the place rule (e) showed it at on that copy at that moment. Status and join could be written back the same way, from what that copy last showed before the deletion. This is a write on top of the library's undo and needs the rule-12 steps. Noticed as: the row stays where the undoer saw it come back, and later commands do not move it. Two people undoing at the same moment each write a rank; the later write wins.
- (c) Something the person can see. Not built. A row read by rule (e) is marked "place not fixed" until someone moves it, and moving it writes a rank. Noticed as: a marker on the row, and the row can still jump until someone moves it.

**Q5. Undoing a heading's creation after an unseen rename (name cells).**

- (a) Keep core Yjs's default. Noticed as: the rename is lost with the heading, 1 in 600.
- (b) Use the editor bindings' filter, which keeps a created text that still holds content. Noticed as: a name with no heading, which needs a place to list it.

**Q6. Rule (d) and old joins.** A later move can make an old join count again (11 in 600).

- (a) Keep it. Noticed as: rarely, a moved row merges with the row it was once joined to.
- (b) Clear a join once it stops counting. That is an extra write that only one copy may make. Noticed as: a separated row stays separate.

**Q7. Tags lost through an unseen undo of a deletion** (5 of 845, plain Yjs; bold is the same).

- (a) Accept it as library behaviour.
- (b) The offline notice also compares marks per beat. Noticed as: the person returning is told; the online person still is not.

**Q8. Undo passes over spent items** (16 in 600).

- (a) Keep the library's behaviour. Noticed as: a press occasionally undoes something older.
- (b) One press spends one item. That departs from the library and needs the rule-12 steps.

**Q9. The offline-notice gap.**

- (a) Accept it. Noticed as: a person who stayed online can lose visual text or fields with no message.
- (b) Run the same check on every copy when a large remote change arrives. Noticed as: both people are told.

**Q10. Formatting that depends on delivery order** (marks only; copies agree once everything is delivered).

- (a) Accept it. Noticed as: a mark's exact edge differs between sessions.
- (b) Turn off Yjs's formatting clean-up. That departs from the library.

## What I am least sure of

- **Rule (f)'s placement.** The order is my choice, and its third step was added after a generated history (seed 233), not by design. That step can cross a scene line (Q3).
- **Rankless beats in the generated sets.** Only 5 of 600 histories hold one, so "0 changed place" says little about how often the verdict's history would happen in real use.
- **The ledger.** It agrees with what is shown in every set. Its beat-version rules were changed in each review round, and 10 letters remain library-decided.
- **The E2/E5 rule attribution.** These are the review's numbers, not ones I measured again.
- **Cost.** Three runs on a shared PC. Deletion with name cells has one slow run (4.59 ms) that I cannot separate from noise.
- **Same moment or offline.** This depends on the window: at six steps, record losses at the same moment rise from 14 to 20 and visual losses from 19 to 26.
