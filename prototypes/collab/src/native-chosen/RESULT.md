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

**With both parts, the combination holds.** No never-acceptable result appeared in any of these sets:

- E9: the 37 named histories and 2,220 generated runs;
- E10: all 229 histories × 5 deliveries;
- 600 new generated histories × 5 deliveries;
- 200 histories with same-moment double splits × 5 deliveries;
- the same 600 step lists replayed with names in cells, apart from 3 commands that copy refuses (see "What part B removes").

In every set:

- copies agreed;
- nothing was stored but shown nowhere;
- no beat was shown twice;
- no split copied narration;
- every command did what it promised on the copy that ran it.

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

Text between a heading's boundary and the next boundary is narration without a beat. Like rule (a), the reader gives it to a beat, and it is edited there.

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

In the 600 histories this happened once, unseen, in both shapes. This is owner question Q3.

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

## Owner questions

**Q1. Which shape for heading names?**

- (a) Name cells (part B). Noticed as: narration typed unseen in a deleted scene shows in the beat below or above, never in a title. A rename typed unseen into a heading whose creation is then undone is lost (1 in 600).
- (b) Names in the segment text (part A only). Noticed as: unseen narration sometimes shows at the end of a scene title (94 letters in 56 of 600 histories). While that heading is removed, the narration shows in no row (27 letters in 19 histories).

**Q2. A split whose caret falls inside text a reading rule shows.** A split never copies narration, so it cannot always split there.

- (a) Split at the nearest point that needs no copy (built). Noticed as: when the caret is before the beat's own words, the split falls at the start of those words. A split went to the nearest point 3 times in 600 histories (8 with name cells).
- (b) Refuse the split there and say why. Noticed as: a message, and the person splits elsewhere.
- (c) Move the beat's own boundary to the caret first, which is an embed delete and insert, not a narration copy, and needs the rule-12 steps. Noticed as: the split falls at the caret; two people doing it at once can each move the boundary.

**Q3. Undoing a heading's creation after an unseen rename (name cells).**

- (a) Keep core Yjs's default. Noticed as: the rename is lost with the heading, 1 in 600.
- (b) Use the editor bindings' filter, which keeps a created text that still holds content. Noticed as: a name with no heading, which needs a place to list it.

**Q4. Fields Yjs does not redo after an unseen overwrite** (status, join, rank).

- (a) Read them as unset (built for status and join; rank uses rule (e)). Noticed as: after an undo, a status set unseen is gone, and a join set unseen is gone, so the row stands alone.
- (b) The undoer's copy writes them back from what it last saw. This is a write on top of the library's undo and needs the rule-12 steps. Noticed as: the row comes back exactly as the undoer saw it.

**Q5. Rule (d) and old joins.** A later move can make an old join count again (11 in 600).

- (a) Keep it. Noticed as: rarely, a moved row merges with the row it was once joined to.
- (b) Clear a join once it stops counting. That is an extra write that only one copy may make. Noticed as: a separated row stays separate.

**Q6. Tags lost through an unseen undo of a deletion** (5 of 845, plain Yjs; bold is the same).

- (a) Accept it as library behaviour.
- (b) The offline notice also compares marks per beat. Noticed as: the person returning is told; the online person still is not.

**Q7. Undo passes over spent items** (16 in 600).

- (a) Keep the library's behaviour. Noticed as: a press occasionally undoes something older.
- (b) One press spends one item. That departs from the library and needs the rule-12 steps.

**Q8. The offline-notice gap.**

- (a) Accept it. Noticed as: a person who stayed online can lose visual text or fields with no message.
- (b) Run the same check on every copy when a large remote change arrives. Noticed as: both people are told.

**Q9. Formatting that depends on delivery order** (marks only; copies agree once everything is delivered).

- (a) Accept it. Noticed as: a mark's exact edge differs between sessions.
- (b) Turn off Yjs's formatting clean-up. That departs from the library.

## What I am least sure of

- **Rule (f)'s placement.** The rows are my choice: the beat below when the next entry is a beat, else the beat above, else the next beat further down. Two headings created at the same place above one beat needed the third fallback, found by a generated history (seed 233), not by design.
- **The ledger.** It agrees with what is shown in every set. However, its beat-version rules were changed twice during this round, and 10 letters remain library-decided.
- **The E2/E5 rule attribution.** These are the review's numbers, not ones I measured again.
- **Cost.** Three runs on a shared PC. Deletion with name cells has one slow run (4.59 ms) that I cannot separate from noise.
- **Same moment or offline.** This depends on the window: at six steps, record losses at the same moment rise from 14 to 20 and visual losses from 19 to 26.
