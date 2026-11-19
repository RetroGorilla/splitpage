# E16 · Recount with retained beat records and visual cells

**A shown beat can still lose both containers, and its visual editor throws.** The smallest reproduction I found starts with `A: a` and `B: b` in one segment.

1. Alice splits B at offset 0, creating N. She sends the split to Bob.
2. Bob cuts N and undoes that cut.
3. Alice undoes her split without receiving either Bob command.
4. After full delivery, all copies show `A: a`, an empty B, and `N: b`. N has neither a record nor a visual cell. Typing in N's visual column after delivery throws `Missing visual N`.

The missing containers and the subsequent throw each reproduced in 5 of 5 delivery modes. The first result takes four editing commands plus the delivery that lets Bob see the split. The throw takes one more command after delivery. Removing any one of the four editing commands breaks this reproduction. Bob's undo restores a boundary in the original segment. Alice's creation undo deletes the containers that her split made. Bob's restored boundary survives that undo.

Replaying those same four commands with deleted containers gave N both containers in 5 of 5 delivery modes. In that version Bob's cut and undo restore the containers along with the boundary.

The earlier E11 harness also throws if it asks for the narration marks of an already cut beat. The shortest setup is to cut B and ask the old checker for B's narration marks. The scheduled instance is mixed seed 513. The kept formatting command itself declines the stale request without writing.

The E12 reference uses the earlier reading that hides narration after a double cut and double undo. Its named four-command history shows an empty B with `defdef` stored. The kept reading shows one B with `defdef`. This is the known difference in the reading rules.

## 1. Accepted losses

**The E11 ledger drops from 131 to 1 missing field writes and from 106 to 0 missing visual insertions associated with a cut.** The one field also disappears with the cut removed, because the split that created its beat is undone. The same 5 of 845 production tags are lost. The other five published loss counts are unchanged.

The first seven rows give occurrence counts and the number of affected histories across the same 600 name-cell histories, seeds 1–600, in forward delivery. The tag count uses E11's five-delivery rule, which takes the losses from the first delivery showing any for that seed.

| E11 accepted loss | Deleted containers | Kept containers |
| --- | ---: | ---: |
| Unseen record change discarded with a deleted beat | 131 in 110 of 600 | 1 in 1 of 600 |
| Unseen visual change discarded with a deleted beat | 106 in 94 of 600 | 0 in 0 of 600 |
| Typing lost when an unseen creation undo removes a new beat | 3 in 3 of 600 | 3 in 3 of 600 |
| Typing lost when an unseen creation undo removes a new heading | 1 in 1 of 600 | 1 in 1 of 600 |
| A split half stays behind after an offline move outside the same-moment window | 1 in 1 of 600 | 1 in 1 of 600 |
| A deletion misses a row restored by an unseen undo | 3 in 3 of 600 | 3 in 3 of 600 |
| Double delete and double undo doubles narration | 3 in 1 of 600 | 3 in 1 of 600 |
| Production tag lost | 5 of 845 requests | 5 of 845 requests |

The field exception is seed 497. One copy splits C and creates N05. A second copy writes its lens offline from a third copy's cut of N05 and C. The creator undoes the split. The old ledger counts a missing field against the cut whenever it finds one before checking for a creation undo. In a focused replay, the field was absent in 1 of 1 trials with the cut and 1 of 1 without it. The recount reproduces the published E11 figures using their original definitions.

The next table follows current values through all concurrent cuts in the same forward runs. The commands supply the edit, the cut and what each writer had seen. The counts exclude undone edits, fields superseded by another standing write, and visual characters a standing erase selected. A row can qualify after several cuts, a competing field write, or a press by the same writer. The final reading supplies the visibility and whether the expected value matches. This is a different denominator from the original occurrence ledger.

| Latest value checked | Deleted containers | Kept containers |
| --- | ---: | ---: |
| Field still stored on a row that finishes removed | 0 of 123 | 120 of 121 |
| Visual character still stored on a row that finishes removed | 0 of 103 | 103 of 103 |
| Field shown on a row that returns | 2 of 6 | 6 of 6 |
| Visual character shown on a row that returns | 1 of 8 | 8 of 8 |

Five recorded joins or moves were unavailable with retained joins, as in E14. A sixth step, the formatting command on C in mixed seed 513, targets an orphan after a joined cut of B. E16 runs it and checks that it writes nothing. The old E11 checker tries to look up the orphan's formatting before calling that writer and throws if used unadapted. The adapted replay continues the original schedules. The five tag losses are in seeds 53, 137, 211, 352 and 447 in both versions.

## 2. Offline notice

**Among the 240 generated histories, both comparisons still miss 16 of 30 split-and-move losses.** When hiding an edited row counts as a loss of access, false banners stay at 64 of 240 with an ideal base and 46 of 240 with the journal. When a hidden visual or record edit that remains stored counts as preserved, the same banners give 100 of 240 and 84 of 240 false banners, respectively.

E16 replays E12's 85 named histories and seeds 0–119 for each of two and three copies. The same offline comparisons read the displayed rows. The replay uses E14's cut and heading-flag commands and reads retained values directly for scoring. The comparisons, pending journal and acknowledgment schedule required no change. E12's online row-disappearance observer still runs. Its separate beat-map delete event loses the signal for ordinary cuts.

| Across all 325 histories | E12 deleted containers | Kept, loss of row access counts | Kept, retained visuals and fields count as preserved |
| --- | ---: | ---: | ---: |
| Base banners | 221 of 325 | 199 of 325 | 199 of 325 |
| Base false banners | 64 of 325 | 64 of 325 | 103 of 325 |
| Base misses | 26 of 271 | 25 of 238 | 25 of 189 |
| Journal banners | 210 of 325 | 187 of 325 | 187 of 325 |
| Journal false banners | 46 of 325 | 46 of 325 | 87 of 325 |
| Journal misses | 25 of 271 | 26 of 238 | 26 of 189 |
| Online row-reading false banners | 52 of 325 | 52 of 325 | 89 of 325 |
| Online row-reading misses | 120 of 220 | 92 of 192 | 92 of 148 |
| Online map-event banners | 131 of 325 | 12 of 325 | 12 of 325 |
| Online map-event misses | 120 of 220 | 166 of 192 | 122 of 148 |

Misses are counted by history and kind, as in E12. In the generated set the 16 missed split-and-move histories account for all offline misses in each version. The named set still has 3 of 14 missed narration cases per comparison. Displaced narration misses go from 7 of 12 to 6 of 12 with a base, and from 6 of 12 to 7 of 12 with the journal. With the visibility scoring, the visual, mark and record hits in the generated set fall from 36, 30 and 44 to 28, 22 and 32. False entries for those three kinds stay at 14, 8 and 8 of 240 histories for either comparison. On a restored beat those avoided warnings correspond to edits that the cut no longer removes.

The four seen/unseen pairs from E12 still give identical evidence with kept containers in 4 of 4 cases. The cut leaves the visual text, visual tag, status or other field stored in 8 of 8 trials. Both comparisons still flag 8 of 8 while B is absent, including 4 of 4 seen edits. With an undo added, the same four pairs still match, both comparisons flag 0 of 8, and the edit is present on the returned row in 8 of 8. The tested evidence includes the final readings and storage, beat-map events, receiving delete sets, state vectors, two update encodings and two snapshot encodings.

The tag-and-undo sweep loses and flags 6 of 28 unseen tags versus 7 of 28 in E12. The saved tag is the one visual tag across a cut and undo. Three of seven unseen tags still disappear after a cut and three of seven after erasing the whole column. Erasing the marked range or the first letter loses 0 of 7 unseen tags each. Both versions lose and flag 0 of 28 seen tags.

## 3. Reachability

**The generated sets did not surface the missing containers, but the four-command history at the top does.** E15 histories 12, 17 and 18 keep both containers in 15 of 15 runs across the five delivery modes. They settle on `A,B`, `C,A,B` and `A,#H,B`, respectively. The move and heading creation complete in 10 of 10 runs.

The new checks inspected the acting copy after each edit, receiving copies after deliveries, and settled copies including a fresh reader. They found a shown row with a missing container in 0 of 4,000 E11/E15 generated runs (600 mixed and 200 double-split histories, 40-step generator budget, five delivery modes), and 0 of 240 E12 generated histories (E12's original schedules). The existing E14 suite also exercises its 2,220 generated E9 runs, 1,000 generated E10 runs, 1,800 focused E14 runs and its 28-step-budget double-split replay. Its reachability check includes both containers. The constructed test uses fresh beat IDs. It establishes reachability without an exhaustive search of all possible schedules.

**Segment head.** In 5 of 5 deliveries of E15's head race, A's head entry is gone, B is the only row and shows the editable narration `ab`, and both A's record and its empty visual cell are stored. The recovery list is empty. With A's visual prefilled as `1`, the same 5 of 5 deliveries keep it stored and the inherited recovery reader lists A as `unplaced` with visual `1`.

## Controls

- The crossing ledger expects the command's visual character in the cut row's stored cell. Muting the whole type command changes the count from 1 of 1 retained to 0 of 1, and the command check catches the missing local typing. Feeding the intact run an empty visual reading also changes the count to 0 of 1.
- Muting the status write changes the retained status check from 1 of 1 to 0 of 1 after a cut and undo. Replacing the final B reading with its pre-edit value makes the ideal-base notice flag 8 of 8 returned-row readings that correctly produced 0 of 8 banners.
- Muting the split prevents the creation of N and the split check catches it in 1 of 1 trials.
