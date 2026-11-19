# E12 · The offline-merge notice

**Verdict.** Three readings can flag a changed beat that vanished, text missing from a split, a broken join, and a few other visible changes. They cannot reliably say whose work was lost. In the generated histories, the offline comparison gave 14 false notices and missed 16 losses. The online rule gave 20 false notices and missed 64 losses. The requirement of zero false notices and every loss reported cannot be met by these signals. One seen and one unseen visual edit produced the same three readings, receiving events, state vectors and catch-up update. Ordinary Yjs writes put a saved beat back as one undo step. They can leave duplicate words or duplicate beats.

A reading is a plain list of beats in display order. A beat is one physical member even when several are joined in one displayed row. The comparison needs its stable id, scene id and displayed row id, marked runs for both columns, status, and record fields including the join target. A run is a span with the same marks, or an inline object. Marks include formatting and tag ids. A narration-only row with no beat has a null id. The E9 reader supplied these values through its existing rows and blocks, ordered by E10's flat ranks. The four E11 rules were exercised with hand-written readings.

## Detection

The table gives **hit / false entry / missed** for the 144 generated histories. An entry is right only when the independent command record shows a loss of that kind for that beat and person. Each history contributes at most once to each cell, even if two people or two stretches get that outcome. An online warning is about the beat as a whole. Its hit counts below credit losses on that beat, even when the warning cannot name their cause.

| What clashed | What the offline person would read | Offline | Online |
| --- | --- | ---: | ---: |
| Narration on a deleted beat, including typing in a creation undone out of sight | A beat you changed in narration was removed. Your wording may still be in another row. | 14 / 14 / 0 | 17 / 10 / 0 |
| Visual text on a deleted beat or an undone creation | A beat you changed in the visual column was removed. | 28 / 14 / 0 | 27 / 10 / 0 |
| Formatting or tags on deleted text | A beat you formatted or tagged was removed. | 14 / 0 / 0 | 10 / 0 / 0 |
| Status or other recorded details on a deleted beat or an undone creation | A beat whose details you changed was removed. | 28 / 0 / 0 | 20 / 0 / 0 |
| Join or separation that disappeared or no longer displays under its target | A join or separation you made no longer shows as it did on your copy. | 14 / 0 / 0 | 0 / 0 / 10 |
| Split whose new beat lost its original suffix | Part of the narration is missing from a beat you split off. | 14 / 0 / 0 | 0 / 0 / 10 |
| Move leaves the split-off half behind | The beat you split off is now apart from its first half. | 14 / 0 / 16 | 0 / 0 / 18 |
| Two deletes followed by two undos | This beat's narration changed. Check for repeated or missing words. | 24 / 0 / 0 | 0 / 0 / 18 |
| I deleted a beat and unseen narration now shows above | A beat you removed may have left someone else's narration in the row above. | 16 / 0 / 0 | 0 / 0 / 8 |

When a changed beat vanishes, the comparison checks whether there is wording, an inline object, a mark, a field value or a join change to offer. Erasing text that the deletion already removed gives no entry. For a new beat that survives, the split checks look for missing mine text or for a plausible first half next to it in the offline reading. The person who moved the first half never saw the new id. Their ordinary move can look exactly like a move plus an unrelated addition. An erased beat and an undone creation can both look like a missing changed beat. A new beat may contain someone else's initial words, which the comparison can flag as yours. An ordinary erase or ordinary doubling can also match the undo pattern.

| E11 reading rule | What the hand-written readings report |
| --- | --- |
| A prefix goes to the first beat of its segment, or to the row above if the segment has no beat | The typist gets a missing-beat entry in both cases. The remover's append check can flag a suffix above, but misses the prefix assigned to the first surviving beat below. |
| Stray text in an empty script has its own narration-only row | The typist gets the missing-beat entry. The remover has no earlier beat to compare, so gets no entry. The visible stray row carries no former beat id. |
| Ignore a repeat boundary id | One B shows `defdef`. Comparison flags changed narration even though base and mine both said `def`. With E9 it flags the empty B instead. |
| A join counts only if it names the beat directly above | C now shows on its own when its target B is removed. The comparison flags C from the changed displayed row and saved join target. E9 instead shows C joined to A. |

### False notices and missed losses

A reconnect shows the trial notice only if its comparison yields at least one entry. A false notice is a banner for a person with no loss in that stretch. A false entry can be on a card beside a real loss, so its count can exceed the number of false banners. These counts mark each history once per column. A close-and-reopen check also exercises a second reconnect with a clean comparison.

| Histories | Commands / deliveries | Offline notice / false | Online notice / false |
| --- | ---: | ---: | ---: |
| 79 named, including both roles for the 37 E9 forks | 184 / 162 | 29 / 1 | 18 / 0 |
| 72 generated, two copies | 3,804 / 312 | 57 / 7 | 32 / 10 |
| 72 generated, three copies | 3,828 / 888 | 57 / 7 | 45 / 10 |
| All 223 | 7,816 / 1,362 | 143 / 15 | 95 / 20 |

The named forks ran first. They include deletes on an embedded beat, a segment head, an end beat, a solo segment, a joined row, a run and a scene. They include crossed narration, visual, erase, marks, fields, splits, joins, unjoins, headings, neighbouring inserts and other deletes. Flagged headings retain their edited names. A separately tested real heading deletion falls outside beat-only reporting. The named double undo and two creation-undo forms use the standard manager. The named offline misses were six displaced narrations. The named online misses were one join whose beat survived, four split suffixes and nine displaced narrations. Two false displaced entries in the named set include one on a banner that also had a real loss.

Each generated history had two stretches. Each stretch had 24 other commands and a seeded collision or clean case, with different writers, offsets and delivery orders. It mixed typing in both columns, formatting, tags, status and other fields, split, join, real deletion, heading creation, moves, and undo. There were 288 generated stretches. A third writer sometimes typed into the same target. The command record knows when an edit was forwarded before the delete and when the delete went first. It also knows when an insert was undone by its own writer. Delivery was complete at each checkpoint. All copies and a fresh late copy agreed after each exchange.

The model distinguishes loss of wording from loss of its place. Across all runs, the E9 reading exposed surviving narration somewhere else in 34 histories, hid it in 10, and lost it in two standalone creation undos. The visual container was gone in 54 histories. A split lost its suffix in 32 and a split-off stayed behind after a move in 24. The E9 reader hid both copies of the restored text in 25 histories. These are observed outcomes of the model's recorded races. They are separate from the banner counts.

### Person who stayed online

The smallest tested signal was the public observer on the beat map. A key with a delete action in a remote transaction matched the before/after reading test in every history. Listen for that action on a beat the person edited during the session. A possible line is “A beat you worked on this session was removed.” A before reading or a local copy of that beat is needed to offer put-back. The map event alone only supplies the id.

“Edited this session” includes a reverted edit. That explains the 10 false online narration notices in the generated runs. The other 10 were visual changes the deleter had already received. The signal misses a join whose own record stays live, an empty split half, a split left behind by a move, a double undo with a live key, and the deleter's own displaced narration. These misses follow from the key still being present or the delete being local.

A state vector is a count of known insertions and map writes by writer. It does not timestamp a delete. In the paired visual test the delete allocates no items. In one history the remover received the new letter first. In the other they removed the beat first and received the letter during catch-up. After catch-up both sent the same update to the typist. The typist got the same delete action, remote origin, before and after readings, state vector and encoded snapshot. Even inspecting that update or the resulting deletion set gives the same evidence in this pair. A vector attached to the deletion **when made** would be additional evidence. This experiment adds no message or shared write.

The reverse inference also has a paired test. Someone typing `Ω` at the end of A, and someone typing `Ω` in B as B is removed, both yield `abcΩ` in A. The remover sees the same inputs. The comparison can point at A. It cannot identify B as the donor.

## Base capture

Base is the last acknowledged common reading. In the harness, `inSyncNow` means the starting state and all writes through the checkpoint were received in both directions. Capture it immediately at that point, before including any later local edit. Keep it through the next disconnected stretch. When reconnecting, take **mine** before applying the first part of catch-up, then read **merged** after both directions finish. Use the old base for review before saving the new checkpoint. A connection event alone is insufficient.

The standard candidate signal is the provider's document-synced event together with its unsynced-change counter reaching zero after acknowledgment. The former gives a document sync point and the latter tracks pending local changes. E12 supplies the stronger “both directions acknowledged through this point” as an explicit call. It does not establish that this pair of provider signals gives that guarantee across a disconnect or says what an individual remote writer had actually seen. E13 owns that check. If a local edit happened after the last acknowledged checkpoint, keep the older base even if the edit was sent. If the first catch-up is interrupted, retain the same base and the pre-catch-up mine until that attempt settles.

For close and reopen while offline, the test saves a plain base reading as serialized data and separately saves the existing editable document as an encoded Yjs update. It reloads both, including unsent typing, then finds the clash. An app would persist the base alongside its document identity and completed checkpoint. A second acknowledged stretch replaces that base. A reopen with no previous checkpoint has no known common base.

Saving a full encoded update for base also works. It reloads in a fresh document with the old content intact. A Yjs snapshot contains only a vector and a deletion set. Reconstructing from it requires the original document history with garbage collection disabled. The test recovers the snapshot from that history and gets a refusal with collection enabled.

## Put it back

The prototype copies the saved beat as a new standalone row with a globally fresh beat id supplied by the caller. It writes one ordinary segment and head, marked narration runs and inline objects, an order entry, a beat record with a flat rank, status and content fields, and a separate marked visual cell. The join target and old rank describe the old placement. The copy starts as its own row and gets a rank for its new position. The write does not restore a removed heading, a tag registry entry or an external file. The test checks the marks and tag ids on the runs themselves.

Use the nearest surviving old neighbour on the left in the saved scene. If there is none, use the old neighbour on the right. Otherwise use the end of the old scene, even when it has no beats. Ignore neighbours now in a different scene. If the heading is gone or hidden, use the end of the unheaded part before the first visible heading. A gap in an equal-rank group opens at the end of that group. One local transaction is one ordinary undo step. The receiving copies get the row and no local undo entry.

| Case | What the person sees |
| --- | --- |
| B lost the visual letter `Ω` and the deleter undoes after merge | B returns with its original visual, `2`. The saved `2Ω` remains on the review card. |
| B's narration letter was in A when the deleter undid | In the tested delivery, B comes back as `dΩef`. That entry closes when refreshed. Redo sends the letter back to A and the entry reopens. |
| Put-back followed by undo | The fresh row disappears and the original clash reopens if the original beat still lacks the edit. A local restored-id record closes a card while its fresh row is present. |
| Both undo the same deletion | Before exchange there is no entry on either copy. After exchange E9 shows an empty B with `defdef` stored. The E11 reading shows `defdef` on B. A fresh copy of `def` would store a third copy. |
| Narration is already in the row above | A says `abcΩ`. Put-back creates a separate beat saying `dΩef`. Both rows then show the letter. |
| Both people press put-back | Both new ids survive. In the test one visual says `2Ω` and the other says `2Ψ`. Neither person's undo removes the other's row. |
| The old scene is gone | The copy shows before the first visible heading. The removed heading remains in heading recovery. |
| The person removed the beat and only suspects displaced wording | Their mine has no copy of the beat. The card can show the row above and has no put-back payload. |

The trial rechecks an open card against the relevant saved value or local restored id. An open card can still be stale when the same words return with other edits or at another id. It also stays stale if the screen never consumes later remote updates. A put-back made before the deleter undoes can leave both an old and a fresh beat. For a live split, join, or double-undo card, the tested write offers a separate copy, so it does not repair the original relationship or remove repeated text.

## Reusing file-merge review

| Existing piece | Fit in the prototype |
| --- | --- |
| `mergeListEntries` | Same helper for paired summaries. The adapter groups those details under one beat with one action. It skips equal strings and always returns the outcome “both”. It needs descriptive input for marks, status and join placement. A same-scene split and move with equal summaries gets no item. The helper does not express loss, uncertainty, or put-back. |
| `mergeRowFate` | Its deletion wording assumes a file on disk. For a changed local beat removed by Yjs it says “your version stays”. For a live but displaced or doubled beat it gives no fate. Those need collaboration wording. |
| `mergeDiffPairHtml` | Same escaping and text differences for mine and merged. To show tags, formatting, joins or record fields, supply a readable description as the text. It cannot identify a donor beat from a letter that looks the same. |
| File-merge review in `local-merge.ts` | The group and side layout can show the new data. Replace “Open here” and “On disk” with “Your copy” and “Shared script”. This is review after the shared state changed, so the confirm action becomes one put-back per recoverable beat. |
| File-merge banner | The collaboration copy can count affected beats and say “Some beats changed while you were away.” The current banner says the user's version was kept as a comment and “Review” opens comments. The collaboration button would open the beat list. A removed beat has no row to highlight. The banner already allows hiding “Undo merge”. |
| History panel | Its restore action takes a whole snapshot, with backup and confirmation handling. It can supply the pattern for action feedback, but cannot carry out a shared rollback by restoring only this device's snapshot. |

## Cost

Uncompressed bytes and milliseconds on Node 24.22.1 with Yjs 13.6.33. The fixture has a heading every six beats, two text columns, status and a note, and includes one tag and one deletion. The comparison uses independently cloned readings with one visual clash. The capture times read a fresh loaded document and exclude loading and persisting it. Timings are median / 95th percentile from 101 comparisons and 20 cold captures after warmup.

| Beats | Plain reading bytes | Encoded state bytes | Encoded snapshot bytes | Compare ms | Capture ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 30 | 7,775 | 8,059 | 15 | 0.129 / 0.243 | 0.714 / 16.594 |
| 300 | 78,303 | 82,387 | 17 | 1.053 / 3.704 | 22.338 / 62.223 |
| 900 | 235,503 | 249,088 | 17 | 3.215 / 16.639 | 32.633 / 72.426 |

The comparison and base capture add no shared bytes or work per keystroke. The online trial keeps a local set of edited ids populated by the command harness. It checks deletes as they arrive. The byte table measures only one checkpoint in each format. It excludes the in-memory restore payload, local persistence, and the extra history required by the snapshot option.

## Controls

“Used” means a history had an independently predicted loss and the normal detector found it. The muted run had to fail the same assertion at comparison while keeping every other entry. A throw, changed coverage of other kinds, or surviving assertion is a failed control. Here the counts include the named and generated histories.

| Detection silenced | Used | Effective | Failed |
| --- | ---: | ---: | ---: |
| Narration | 25 | 25 | 0 |
| Visual | 31 | 31 | 0 |
| Marks | 17 | 17 | 0 |
| Record | 31 | 31 | 0 |
| Join | 17 | 17 | 0 |
| Split suffix | 18 | 18 | 0 |
| Split and move | 14 | 14 | 0 |
| Double undo | 25 | 25 | 0 |
| Displaced narration | 19 | 19 | 0 |

For put-back, each silent write was replaced at its Yjs call, one occurrence at a time. The literal stored-state assertion had to fail immediately after that command. A throw or changed count or order of calls failed the control.

| Write silenced | Used | Effective | Failed |
| --- | ---: | ---: | ---: |
| Segment, head, narration cell, order entry, beat record, rank, status, visual cell | 8 | 8 | 0 |
| Narration text runs | 2 | 2 | 0 |
| Narration embed | 1 | 1 | 0 |
| Content fields | 2 | 2 | 0 |
| Visual text runs | 2 | 2 | 0 |
| Visual embed | 1 | 1 | 0 |

## What the checks read from the implementation

| Read in the test | What it limits |
| --- | --- |
| E9 seed encoding, native block offsets, row members, join editing helpers, and E10 ranks | These drive the actual writers. The scheduled ids, offsets, effects and seen sets come from fixtures and deliveries. This experiment does not independently verify every edit route or rank choice. |
| Yjs update bytes, vector and snapshot, observer events and transaction flags | These drive transfers or measure evidence. The ledger advances from the recorded delivery even for an empty update. It does not infer that an individual item was received from its vector. The identical packet is proved for the specified catch-up order. |
| E9 ordered blocks, joined-row membership, visual deltas, record fields and heading flags | These are the actual readings fed to the detector. They also check agreement across copies. Agreement does not prove correctness of a reader rule. The four E11 outcomes are a separate hand-written contract. |
| Raw segment text, live visual and beat keys, and the projected place of unique test letters | These classify surviving, hidden and erased wording and check invariants. The model's loss labels come from commands. The tests do not count arbitrary character identities, attribute ordering or format interleavings. |
| Standard manager's return and stack sizes | These check that the stated presses occurred and the put-back is one step. The model uses its own command stack for the given scripts. It does not predict which item a library undo will skip in other histories. |
| Readings before and after putting back, rank presence, map entries, text deltas and the new id | These check actual output and reacquisition of the saved values. The rich restore check uses a literal expected beat and layout. Rank presence and a handful of placements do not establish all placement collisions. |
| Entry ids, kinds, helper strings, and write-hook calls | These score and control the prototype outcomes. The detector cannot choose the expected loss. Control use is limited to losses found in the normal run. The app helper tests cover the returned details before rendering. |
| Serialized lengths and wall-clock times | These are measurements. They do not establish app latency or size after many real editing sessions. |

## Questions for the owner

1. What should the banner mean when evidence is ambiguous?
   - **A.** Show possible clashes. A seen deletion can give someone a card even though their peer had their edit.
   - **B.** Withhold ambiguous cards. A visual edit can vanish without a notice.
   - **C.** Capture extra proof at deletion time. The affected person could see a more specific card if that proof survives disconnect and delivery.
2. What should put-back do when A already shows part of B?
   - **A.** Copy the whole beat. The person sees `abcΩ` in A and `dΩef` in the new row.
   - **B.** Show both rows and leave it to the person to move the words. The letter stays in A until they edit it.
   - **C.** Move a surviving fragment only when its source is certain. The person sees one letter in B with that proof, or a review prompt without it.
3. What should happen when both people restore, or when a later undo brings the old beat back?
   - **A.** Keep independent copies. Both versions can be visible.
   - **B.** Ask people to agree on one after both appear. Both are visible until someone removes one.
   - **C.** Give recoveries a shared identity. The list can show that someone already recovered the beat. Competing content still needs a choice.
4. What should put-back mean when the old scene is gone or the beat is still live?
   - **A.** Add a separate beat in the nearest eligible scene or before the first heading. Existing text stays visible.
   - **B.** Ask where to put the copy. A person can choose a new scene or use the existing row.
   - **C.** Offer a side-by-side review with no automatic copy. The person can see repeated wording, a failed join or a missed split without adding another row.
5. What would “Undo merge” mean after other people receive the changes?
   - **A.** Hide it. Normal Undo can take back the person's own put-back.
   - **B.** Open the earlier reading as a separate copy for reference. The shared script stays where everyone can see it.
   - **C.** Preview ordinary edits that would reverse selected changes. Everyone sees those edits if the person confirms them.

## Least sure

The largest unknown is whether the provider can mark the same checkpoint the harness assumes, especially for a sent change whose acknowledgment was lost. The measured rates apply to the scheduled collisions in these histories. E11 changes where narration is reachable and how joins display. Its actual readings could change the notice counts. Two indistinguishable readings or catch-up messages can still come from different histories.

Run `node --test test/native-notice/*.test.ts` from the collaboration prototype. It prints the history, control and size tables as text.
